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
    let now: Double

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

    private var focusNote: String {
        var parts: [String] = []
        if let top = focusWeek.topPack { parts.append("A hét leggyakoribb csomagja: \(top).") }
        // A korai vég szándékosan NEM szégyenpad: ha sokszor fordul elő, nem a
        // csomaggal van baj, hanem a hosszal.
        parts.append(
            focusWeek.stoppedEarly > 0
                ? "\(focusWeek.stoppedEarly) menet ért véget a tervezettnél korábban. "
                    + "Ha ez sokszor fordul elő, nem a csomaggal van baj: rövidebb menetet "
                    + "érdemes indítani."
                : "A héten minden menetet végigvittél."
        )
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
            if focusWeek.sessions > 0 {
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
