import SwiftUI

/// Statistics on iOS/macOS.
///
/// Honest scope: Apple gives no API for measuring how long the user spends in
/// *other* apps or on *other* websites (the Screen Time / DeviceActivity
/// framework needs a separate, Apple-approved entitlement aimed at parental
/// controls). So instead of pretending, this screen says so plainly and shows
/// the data Breaker genuinely owns: the user's own blocking history.
struct StatsView: View {
    @EnvironmentObject var store: BreakerStore
    /// A könyv törlésének első koppintása: a második töröl.
    @State private var clearArmed = false
    /// A csúcs-óra gombjának hibája — a bíró szava, ha nem vette fel.
    @State private var windowError: String?
    let now: Double
    /// A címke-tölcsér a főnézetből: rejtett listánál sorszám, fedőnévnél a
    /// fedőnév — a napló sem szivárogtathat ki olyan címet, amit a lista elrejt.
    let siteLabel: (String) -> String

    private func unlocks(inLastDays days: Int) -> Int {
        let from = now - Double(days) * 24 * 3_600_000
        return store.state.unlockLog.filter { $0 >= from }.count
    }

    private var blockedCount: Int {
        // A napi keret is számít: ha a gépen elfogyott, ez az oldal itt is
        // zárva van, és a számnak azt kell mutatnia, ami tényleg igaz.
        store.state.sites.filter {
            LimitLogic.isBlockedNowWithLimit($0, UsageStats.State(), store.state.sharedToday, now)
        }.count
    }

    /// A mai nap kezdete HELYI idő szerint.
    ///
    /// Nem `now - 24 óra`: az reggel nyolckor a tegnap esti menetet is mainak
    /// mondaná. Ugyanaz a számítás, mint a gépen és az androidos appban.
    private func startOfDay(_ ms: Double) -> Double {
        let day = Calendar.current.startOfDay(for: Date(timeIntervalSince1970: ms / 1000))
        return day.timeIntervalSince1970 * 1000
    }

    private var focusToday: Focus.Summary {
        Focus.summarizeFocus(store.state.focusLog ?? [], since: startOfDay(now), now: now)
    }

    private var focusWeek: Focus.Summary {
        Focus.summarizeFocus(
            store.state.focusLog ?? [],
            since: startOfDay(now) - 6 * 24 * 3_600_000, now: now
        )
    }

    /// Az előző hét — a hét az előző héthez képest, irány, nem ítélet.
    private var focusPrevWeek: Focus.Summary {
        Focus.summarizeFocusPrevWeek(store.state.focusLog ?? [], now: now)
    }

    private var focusNote: String {
        var parts: [String] = []
        if let top = focusWeek.topPack { parts.append("A hét leggyakoribb csomagja: \(top).") }
        // A NULLA HÉT kimondva — a blokk csak azért áll, mert az előző héten volt menet.
        if focusWeek.sessions == 0 { parts.append("A héten nem volt menet.") }
        // AZ ELŐZŐ HÉT a menetek mellett — irány, nem ítélet. Üres előző hét nem
        // összehasonlítás: akkor nincs mondat.
        if focusPrevWeek.sessions > 0 {
            parts.append("Az előző héten \(focusPrevWeek.sessions) menet (\(UsageStats.formatDuration(focusPrevWeek.totalMs / 1000))).")
        }
        // A korai vég szándékosan NEM szégyenpad: ha sokszor fordul elő, nem a
        // csomaggal van baj, hanem a hosszal.
        if focusWeek.sessions > 0 { parts.append(
            focusWeek.stoppedEarly > 0
                ? "\(focusWeek.stoppedEarly) menet ért véget a tervezettnél korábban. "
                    + "Ha ez sokszor fordul elő, nem a csomaggal van baj: rövidebb menetet "
                    + "érdemes indítani."
                : "A héten minden menetet végigvittél."
        ) }
        // A HETI ABLAKBÓL indult menetek: dolgozik-e az ablak — tény, nem ítélet.
        if focusWeek.windowRuns > 0 { parts.append("\(focusWeek.windowRuns) menet a heti ablakból indult, magától.") }
        // MINDEN ESZKÖZ menete beleszámít, és ezt ki kell mondani: a mérés
        // eszközönként külön áll, a munkamenet viszont a fiók egészére szól.
        parts.append("Minden eszközöd menete beleszámít.")
        return parts.joined(separator: " ")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionLabel("Statisztika")

            HStack(spacing: 10) {
                tile("\(store.state.sites.count)", "figyelt oldal")
                tile("\(blockedCount)", "épp blokkolva")
            }
            HStack(spacing: 10) {
                tile("\(unlocks(inLastDays: 7))", "feloldás / 7 nap")
                tile("\(unlocks(inLastDays: 30))", "feloldás / 30 nap")
            }

            // MUNKAMENETEK. Ez az EGYETLEN idő-statisztika, ami iPhone-on is
            // igazi: nem az Apple-től kellene kérni, hanem a mi naplónkból jön
            // — a menet lezárásakor mi írjuk. A menetet itt is lehet indítani
            // és leállítani, tehát itt is meg kell mutatni; enélkül aki a
            // telefonján dolgozik, azt látná, hogy a héten le sem ült.
            //
            // Nulla menetnél nem áll itt üres doboz: egy minden nap ott lévő
            // nullás sor nem információ, csak zaj.
            // Nulla menetnél nincs üres blokk — kivéve, ha az előző héten volt menet.
            if focusWeek.sessions > 0 || focusPrevWeek.sessions > 0 {
                Divider()
                SectionLabel("Munkamenetek")
                HStack(spacing: 10) {
                    tile("\(focusToday.sessions)", "menet ma")
                    tile(UsageStats.formatDuration(focusToday.totalMs / 1000), "fókuszban ma")
                }
                HStack(spacing: 10) {
                    tile("\(focusWeek.sessions)", "menet a héten")
                    tile(UsageStats.formatDuration(focusWeek.totalMs / 1000), "fókuszban a héten")
                }
                Text(focusNote)
                    .font(.footnote).foregroundStyle(.secondary)
                // A hét alakja a menetekre: egyenletesen jött-e össze, vagy egy
                // napból. iPhone-on ez az EGYETLEN diagram, mert csak a menetek
                // adata igazi itt. Üresen nincs.
                let days = Focus.daySeries(store.state.focusLog ?? [], now: now, count: 7)
                if days.contains(where: { $0.seconds > 0 }) {
                    Text("Fókuszban, naponta")
                        .font(.caption).fontWeight(.semibold).foregroundStyle(.secondary)
                        .padding(.top, 4)
                    FocusWeekBars(series: days)
                }
                // A MENET-NAP: melyik napon ülsz le a legtöbbször — négy hétből, a csúcs-nap
                // tükre; a sáv az alakja, hétfőtől. Menet nélkül nincs.
                let focusByDay = Focus.byWeekday(store.state.focusLog ?? [], now: now)
                if let fwd = FilterHitLogic.peakWeekday(focusByDay) {
                    Text(Focus.weekdayText(fwd)).font(.footnote).foregroundStyle(.secondary)
                    WeekdayStrip(days: focusByDay, peakDay: fwd.day, peakCount: fwd.count)
                }
                // A MENET-ÓRA: mikor ülsz le a legtöbbször — négy hétből, az indulás órája
                // szerint; a csúcs-óra tükre, az órák sávjával. Menet nélkül nincs.
                let focusByHour = Focus.byHour(store.state.focusLog ?? [], now: now)
                if let fh = Focus.peakHour(focusByHour) {
                    Text(Focus.hourText(fh)).font(.footnote).foregroundStyle(.secondary)
                    HourStrip(hours: focusByHour, peakHour: fh.hour, peakCount: fh.count)
                }
                // A MEGAKADÁSOK napról napra — a tunnel könyve: ugyanaz a rajz,
                // darabban. Üresen nincs.
                let hitDays = FilterHitLogic.daySeries(store.state.filterHits ?? [:], now: now, count: 7)
                // A NULLA HÉT is mondat, ha volt mihez mérni: az előző hét mellett a blokk marad.
                if hitDays.contains(where: { $0.seconds > 0 }) || FilterHitLogic.hitsPrev7d(store.state.filterHits ?? [:], now: now) > 0 {
                    Text("Megakadások a szűrőben, naponta")
                        .font(.caption).fontWeight(.semibold).foregroundStyle(.secondary)
                        .padding(.top, 4)
                    FocusWeekBars(series: hitDays, format: { "\(Int($0)) megakadás" })
                    // A HÓNAP alakja is — csak ha a hét előtt is volt mit rajzolni.
                    let hitMonth = FilterHitLogic.daySeries(store.state.filterHits ?? [:], now: now, count: 30)
                    if FilterHitLogic.monthHasOlderHits(hitMonth) {
                        Text("Megakadások a szűrőben, 30 nap")
                            .font(.caption).fontWeight(.semibold).foregroundStyle(.secondary)
                        MonthBars(series: hitMonth)
                    }
                    // MIKOR jár a kéz magától: a hét csúcs-órája — tény, nem ítélet.
                    if let peak = FilterHitLogic.peakHour(store.state.filterHitHours ?? [:], now: now) {
                        Text("A hét csúcsa: \(FilterHitLogic.hourLabel(peak.hour)) (\(peak.count) megakadás) — akkor jár a kéz magától.")
                            .font(.footnote).foregroundStyle(.secondary)
                        // AZ ÓRÁK SÁVJA: a nap 24 rekesze a hét megakadásaival — a csúcs a
                        // mondat, a sáv az alakja (mikor jár a kéz magától, és mikor nem).
                        HourStrip(hours: FilterHitLogic.byHour(store.state.filterHitHours ?? [:], now: now),
                                  peakHour: peak.hour, peakCount: peak.count)
                        // LE VAN-E FEDVE: ha egy csomag heti ablaka a csúcs-órát fedi, a menet
                        // magától indul, amikor a kéz indulna — a statisztika kimondja.
                        if let pack = Focus.packCoveringHour(store.state.focusPacks ?? [], hour: peak.hour), let band = pack.recurrence {
                            Text("A csúcs-órában magától indul: \(pack.name) (\(recurrenceLabel(band))).")
                                .font(.footnote).foregroundStyle(.secondary)
                        } else if let pick = Focus.peakWindowPick(store.state.focusPacks ?? [], log: store.state.focusLog ?? [],
                                                                  run: store.state.focusRun, peakHour: peak.hour, now: now) {
                            // ABLAK A CSÚCS-ÓRÁRA: a gépi gomb tükre — a legutóbbi csomagra, a
                            // csúcs egy órájában, minden napra. Felvenni ingyen; levenni a gépen,
                            // próbatétellel — a gomb ezt nem rejti.
                            Button("Heti ablak a csúcs-órára: \(pick.pack.name), \(recurrenceLabel(pick.band))") {
                                do {
                                    try Referee.addFocusWindow(packId: pick.pack.id, band: pick.band, now: Date().timeIntervalSince1970 * 1000)
                                    windowError = nil
                                } catch {
                                    windowError = (error as? Referee.RefereeError)?.message ?? "Nem sikerült felvenni az ablakot."
                                }
                            }
                            .buttonStyle(.bordered)
                            if let windowError {
                                Text(windowError).font(.footnote).foregroundStyle(.red)
                            }
                        }
                    }
                    // A CSÚCS-NAP: melyik napon akad meg a kéz a legtöbbször — négy hétből; tény, nem ítélet.
                    let byDay = FilterHitLogic.byWeekday(store.state.filterHits ?? [:], now: now)
                    if let wd = FilterHitLogic.peakWeekday(byDay) {
                        Text(FilterHitLogic.peakWeekdayText(wd)).font(.footnote).foregroundStyle(.secondary)
                        // A HÉT NAPJAINAK SÁVJA a mondat alatt: hétfőtől vasárnapig, a csúcs-nap kiemelve.
                        WeekdayStrip(days: byDay, peakDay: wd.day, peakCount: wd.count)
                    }
                    // MELYIK oldal akaszt meg a legtöbbször: a hét csúcs-oldala — a lista címkézésével.
                    if let top = FilterHitLogic.topSite(store.state.filterHitHosts ?? [:], now: now) {
                        Text("A legtöbbször: \(siteLabel(top.site)) (\(top.count)×).")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                    // MELYIK szabály dolgozik: a hét okonként (lista, kulcsszó) — a gépi sor tükre.
                    let reasons = FilterHitLogic.byReason(store.state.filterHitReasons ?? [:], now: now)
                    if !reasons.isEmpty {
                        Text("Ebből: \(FilterHitLogic.reasonLine(reasons)).")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                    // MELYIK kulcsszó dolgozik: a hét kulcsszavanként — a gépi kártya tükre.
                    let kws = FilterHitLogic.keywordsWeek(store.state.filterHitKeywords ?? [:], now: now)
                    if !kws.isEmpty {
                        Text("Kulcsszavanként: \(FilterHitLogic.keywordLine(kws)).")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                    // A LISTA SZAVAI, amelyek a héten nem fogtak — a tükör másik fele.
                    let idle = FilterHitLogic.idleKeywords(store.state.keywords ?? [], rows: kws)
                    if !idle.isEmpty {
                        Text("A héten nem fogott: \(idle.joined(separator: ", ")).")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                    // A HÉT AZ ELŐZŐ HÉTHEZ KÉPEST: a két szám egymás mellett — irány,
                    // nem ítélet. Előző hét nélkül nincs: egy nulla nem összehasonlítás.
                    let trend = FilterHitLogic.trendText(
                        FilterHitLogic.hits7d(store.state.filterHits ?? [:], now: now),
                        prev: FilterHitLogic.hitsPrev7d(store.state.filterHits ?? [:], now: now)
                    )
                    if !trend.isEmpty {
                        Text(trend).font(.footnote).foregroundStyle(.secondary)
                    }
                    // HA NEM KÉRED, csendben marad: az előjelzés a csúcs-óra előtt
                    // kikapcsolható — a lap kártyája akkor is mondja.
                    Toggle("Szóljon a csúcs-óra előtt", isOn: Binding(
                        get: { store.state.quietSuggestions != true },
                        set: { on in store.mutate { $0.quietSuggestions = !on } }
                    ))
                    .font(.footnote)
                    // A KÖNYV TÖRLÉSE: a megakadások könyve a tiéd — törölhető. Két koppintás.
                    Button(clearArmed ? "Biztos? Törlés" : "A könyv törlése") {
                        if clearArmed {
                            store.mutate {
                                $0.filterHits = nil
                                $0.filterHitHours = nil
                                $0.filterHitHosts = nil
                                $0.filterHitReasons = nil
                                $0.filterHitKeywords = nil
                            }
                            clearArmed = false
                        } else {
                            clearArmed = true
                        }
                    }
                    .font(.footnote)
                }
            }

            // A HETI NAPLÓ. iPhone-on értesítés nincs; a hét sora akkor íródik,
            // amikor az app azon a héten először nyitva van hétfő reggel után.
            // Fölötte az, ami most szólna — mérés híján a menetekről és a
            // feloldásokról. Üresen (se sor, se mondat) a blokk nincs.
            let digestNow = DigestLogic.text(DigestLogic.inputFor(store.state, now: now), labelOf: siteLabel)
            let journal = store.state.digestLog ?? []
            if digestNow != nil || !journal.isEmpty {
                Divider()
                SectionLabel("Heti napló")
                if let digestNow {
                    Text("Így szólna a visszatekintés most: \(digestNow)")
                        .font(.footnote).foregroundStyle(.secondary)
                    // A MONDAT MEGOSZTHATÓ, ahogy van — egy megbízottnak, egy naplóba.
                    ShareLink(item: digestNow) {
                        Label("A mondat megosztása", systemImage: "square.and.arrow.up")
                    }
                    .font(.footnote)
                }
                // A régi sor is a MOSTANI címkézéssel: a fedőnév és a rejtés
                // visszamenőleg is fed.
                let sites = store.state.sites.map { (domain: $0.domain, hostnames: $0.hostnames) }
                ForEach(journal, id: \.week) { e in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(DigestLogic.weekLabel(e.week)).font(.footnote).foregroundStyle(.secondary)
                        Text(DigestLogic.relabel(e.text, sites: sites, labelOf: siteLabel)).font(.footnote)
                    }
                }
            }

            Divider()

            Text("Miért nincs képernyőidő-mérés itt?")
                .font(.subheadline).fontWeight(.semibold)
            Text("""
                 Az iOS nem enged semmilyen appnak hozzáférést ahhoz, hogy más appokban \
                 vagy weboldalakon mennyi időt töltesz — ez rendszerszintű korlát, nem a \
                 Breaker hiányossága. A részletes „mire megy el az idő” statisztika ezért \
                 az asztali és az Android verzióban érhető el. Az iPhone beépített \
                 Képernyőidő funkciója tud hasonlót mutatni.
                 """)
                .font(.footnote).foregroundStyle(.secondary)

            // Ugyanez a korlát egy funkciót is elvisz. Jobb kimondani, mint hogy a
            // felhasználó a másik gépén meglássa, és azt higgye, itt elrontottuk.
            Text("""
                 Emiatt a napi időkeret („legfeljebb napi 20 perc erre az oldalra”) sem \
                 érhető el iPhone-on: a keret mért aktív időből fogyna, mérés nélkül \
                 pedig sosem fogyna el. Egy ilyen keret úgy nézne ki, mintha védene, \
                 közben semmit nem csinálna. Az oldal teljes tiltása és a heti menetrend \
                 itt is ugyanúgy működik.
                 """)
                .font(.footnote).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
        .background(BreakerStyle.surfaceNested)
        .cornerRadius(10)
    }

    private func tile(_ value: String, _ label: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(value).font(.title2).fontWeight(.bold)
            Text(label).font(.caption).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(BreakerStyle.surfaceNested)
        .cornerRadius(8)
    }
}

/// A HARMINC NAP oszlopai: egy szín, a legnagyobb a teljes magasságon, a két
/// szélső nap felirata alul — a gépi napi rajz tükre, darabban.
private struct MonthBars: View {
    let series: [(day: String, seconds: Double)]

    var body: some View {
        let top = series.map { $0.seconds }.max() ?? 0
        VStack(spacing: 4) {
            HStack(alignment: .bottom, spacing: 2) {
                ForEach(Array(series.enumerated()), id: \.offset) { _, item in
                    RoundedRectangle(cornerRadius: 2, style: .continuous)
                        .fill(item.seconds > 0 ? Color.accentColor : Color.secondary.opacity(0.25))
                        .frame(height: top > 0 ? Swift.max(2, 60 * item.seconds / top) : 2)
                        .frame(maxWidth: .infinity)
                }
            }
            .frame(height: 60, alignment: .bottom)
            HStack {
                Text(series.first?.day ?? "").font(.caption2).foregroundStyle(.secondary)
                Spacer()
                Text(series.last?.day ?? "").font(.caption2).foregroundStyle(.secondary)
            }
        }
    }
}

/// AZ ÓRÁK SÁVJA: huszonnégy rekesz egy színnel (a rekesz nem kategória), a
/// csúcs teljes erővel, a többi halványan — a gépi statisztika és a bővítmény
/// sávjának tükre, ugyanabban a mértékben (a csúcs a teljes magasság).
private struct HourStrip: View {
    let hours: [Int]
    let peakHour: Int
    let peakCount: Int

    var body: some View {
        if hours.count == 24 && peakCount > 0 {
            VStack(spacing: 2) {
                HStack(alignment: .bottom, spacing: 2) {
                    ForEach(0..<24, id: \.self) { hour in
                        RoundedRectangle(cornerRadius: 2, style: .continuous)
                            .fill(Color.accentColor.opacity(hour == peakHour ? 1 : 0.45))
                            .frame(height: Swift.max(2, 28 * Double(hours[hour]) / Double(peakCount)))
                            .frame(maxWidth: .infinity)
                    }
                }
                .frame(height: 30, alignment: .bottom)
                // Az óra-tengely a sáv alatt: öt szám, hogy a rekeszeket órára lehessen olvasni.
                HStack(spacing: 0) {
                    ForEach([0, 6, 12, 18, 24], id: \.self) { h in
                        Text("\(h)").font(.caption2).foregroundStyle(.secondary)
                        if h != 24 { Spacer() }
                    }
                }
            }
        }
    }
}

/// A HÉT NAPJAINAK SÁVJA: a négy hét megakadásai a hét hét napjára osztva,
/// hétfőtől — a csúcs-nap a mondat, a sáv az alakja (melyik napon jár a kéz
/// magától, és melyiken nem). Csúcs nélkül nincs sáv.
private struct WeekdayStrip: View {
    let days: [Int]
    let peakDay: Int
    let peakCount: Int
    /// Hétfőtől vasárnapig — a csúcs-nap holtversenye is a hét elejétől számít.
    private static let order = [1, 2, 3, 4, 5, 6, 0]
    private static let dayShort = ["V", "H", "K", "Sze", "Cs", "P", "Szo"]

    var body: some View {
        if days.count == 7 && peakCount > 0 {
            VStack(spacing: 2) {
                HStack(alignment: .bottom, spacing: 2) {
                    ForEach(Self.order, id: \.self) { day in
                        RoundedRectangle(cornerRadius: 2, style: .continuous)
                            .fill(Color.accentColor.opacity(day == peakDay ? 1 : 0.45))
                            .frame(height: Swift.max(2, 28 * Double(days[day]) / Double(peakCount)))
                            .frame(maxWidth: .infinity)
                    }
                }
                .frame(height: 30, alignment: .bottom)
                // A napok tengelye a sáv alatt: hét címke, egy-egy a rekesz alá középre.
                HStack(spacing: 2) {
                    ForEach(Self.order, id: \.self) { day in
                        Text(Self.dayShort[day]).font(.caption2).foregroundStyle(.secondary).frame(maxWidth: .infinity)
                    }
                }
            }
        }
    }
}

/// A hét alakja a menetekre — ugyanaz a rajz, mint a gépen és Androidon: egy
/// szín (az oszlop nem kategória), a mai nap a feliratával kiemelve, szám csak
/// a mai és a legnagyobb oszlopon, a többi mutatásra mondja.
private struct FocusWeekBars: View {
    let series: [(day: String, seconds: Double)]
    /// Az érték felirata: idő (a menetek) vagy darab (a megakadások).
    var format: (Double) -> String = { UsageStats.formatDuration($0) }
    private static let dayShort = ["V", "H", "K", "Sze", "Cs", "P", "Szo"]

    var body: some View {
        let top = series.map { $0.seconds }.max() ?? 0
        let today = UsageStats.dayKey(Date())
        let peak = top > 0 ? (series.firstIndex { $0.seconds >= top } ?? -1) : -1
        HStack(alignment: .bottom, spacing: 6) {
            ForEach(Array(series.enumerated()), id: \.offset) { i, item in
                let isToday = item.day == today
                let labelled = (isToday || i == peak) && item.seconds > 0
                VStack(spacing: 4) {
                    // A szám sora akkor is foglal, ha üres: az oszlopok alja egy vonalban marad.
                    Text(labelled ? format(item.seconds) : " ")
                        .font(.caption2).lineLimit(1).minimumScaleFactor(0.7)
                    ZStack(alignment: .bottom) {
                        Color.clear.frame(height: 96)
                        RoundedRectangle(cornerRadius: 4, style: .continuous)
                            .fill(item.seconds > 0 ? Color.accentColor : Color.secondary.opacity(0.25))
                            .frame(height: top > 0 ? Swift.max(2, 96 * item.seconds / top) : 2)
                    }
                    Text(isToday ? "ma" : Self.dayShort[Self.weekday(item.day)])
                        .font(.caption2)
                        .fontWeight(isToday ? .bold : .regular)
                        .foregroundStyle(isToday ? Color.primary : Color.secondary)
                }
                .frame(maxWidth: .infinity)
            }
        }
    }

    /// `YYYY-MM-DD` → 0 = vasárnap … 6 = szombat.
    private static func weekday(_ key: String) -> Int {
        let parts = key.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3,
              let d = Calendar.current.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
        else { return 0 }
        return Calendar.current.component(.weekday, from: d) - 1
    }
}
