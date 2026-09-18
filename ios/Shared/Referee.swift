import Foundation

/// Session referee — mirrors desktop/src/helper/referee.ts. All transitions go
/// through BreakerStore.mutate so they persist atomically across processes.
enum Referee {

    struct RefereeError: Error { let message: String; let code: String }

    struct SubmitResult { let accepted: Bool; let sessionDone: Bool; let message: String? }

    static func effectiveTier(_ state: AppState, kind: ChallengeEngine.Kind, now: Double) -> Int {
        let base = ChallengeEngine.computeTier(state.unlockLog, now: now)
        return kind == .delete ? min(3, base + 1) : base
    }

    /// A MOST érvényes zárlat: a futó, vagy amit egy élő ablak épp megkövetel —
    /// akkor is, ha a kör még nem írta be. Az ablak kezdése és az első kör
    /// közti másodpercek nem lehetnek rés. A desktop `currentLockdown` tükre.
    static func currentLockdown(_ state: AppState, _ now: Double) -> LockdownLogic.Lockdown? {
        let bands = (state.lockdownWindows ?? []).map { $0.band }
        return LockdownLogic.windowLockdown(state.lockdown, bands, now)
            ?? LockdownLogic.live(state.lockdown, now)
    }

    /// A ZÁRLAT ŐRE. Amíg zárlat van, a lazítás nem drágább — nincs.
    ///
    /// Nem hibaüzenet-ízesítés: ez a különbség a nehéz és a lehetetlen között.
    /// A próbatétel drágít, tehát utat is kínál; a zárlat alatt nincs mit
    /// teljesíteni. A desktop `assertUnlocked` tükre.
    private static func requireUnlocked(_ state: AppState, _ now: Double) -> RefereeError? {
        guard let lock = currentLockdown(state, now) else { return nil }
        let left = LockdownLogic.formatRemaining(lock.until - now)
        let text = "Zárlat van érvényben, " + left + " van hátra. Amíg tart, semmilyen lazítás "
            + "nem indítható — próbatétellel sem."
        return RefereeError(message: text, code: "LOCKDOWN")
    }

    /// MINDEN lazító próbatétel terve ezen az egy kapun megy ki.
    ///
    /// Azért egyetlen helyen, mert a visszatérő hibánk nem a rossz logika,
    /// hanem a KIHAGYOTT hívás: több belépési pontra több külön ellenőrzésből
    /// egy előbb-utóbb lemaradna, és a hiányt semmi nem mutatná meg — egy nem
    /// hívott ellenőrzés érvényes kód.
    /// A hibát KIÍRJA, nem dobja: a `BreakerStore.mutate` zárványa nem dobhat,
    /// ezért az egész bíró ezt az alakot használja — a hívó a kör végén dobja.
    private static func planLoosening(
        _ state: AppState, _ kind: ChallengeEngine.Kind, _ comboSiteId: String?, _ now: Double,
        _ thrown: inout RefereeError?
    ) -> ChallengeEngine.Plan? {
        if let e = requireUnlocked(state, now) { thrown = e; return nil }
        let tier = effectiveTier(state, kind: kind, now: now)
        let forced = comboSiteId == nil ? nil : forcedCombo(state, comboSiteId!, now)
        let plan = ChallengeEngine.generatePlan(kind: kind, tier: tier,
                                                lastCombo: state.lastCombo, forceCombo: forced)
        // PÁRBAN ZÁROLÁS: ha van megbízott, az utolsó szó az övé — MINDEN
        // lazításnál, mert mind ezen az egy kapun jön ki. A várakozás UTÁN áll.
        guard let partner = state.partner else { return plan }
        return ChallengeEngine.Plan(
            steps: plan.steps + [.partner(id: BreakerStore.shared.newId("st"), name: partner.name)],
            comboKey: plan.comboKey
        )
    }

    struct PartnerSetup { let name: String; let phrase: String }
    struct PartnerChangeResult { let applied: Bool; let session: SessionRec? }

    /// Megbízott felvétele — INGYEN, mert szigorítás. A jelmondatot itt
    /// sorsoljuk, és EGYSZER adjuk vissza: a felület megmutatja, a felhasználó
    /// átadja; a tár csak a lenyomatot tartja meg. A desktop `setPartner` tükre.
    @discardableResult
    static func setPartner(name rawName: String, now: Double) throws -> PartnerSetup {
        var out: PartnerSetup?
        var thrown: RefereeError?
        BreakerStore.shared.mutate { state in
            if state.partner != nil {
                thrown = RefereeError(
                    message: "Már van megbízott. Előbb vedd le — az próbatétel, az ő jelmondatával.",
                    code: "PARTNER_SET"); return
            }
            guard let name = PartnerLogic.normalizePartnerName(rawName) else {
                thrown = RefereeError(message: "Adj a megbízottnak egy nevet.", code: "BAD_NAME"); return
            }
            let phrase = ChallengeEngine.makePartnerPhrase()
            state.partner = PartnerLogic.makeLock(name: name, phrase: phrase, now: now)
            out = PartnerSetup(name: name, phrase: phrase)
        }
        if let e = thrown { throw e }
        return out!
    }

    /// A megbízott levétele — próbatétel, a terv végén az ő jelmondatával: a
    /// levételhez is ő kell. A desktop `startPartnerRemoval` tükre.
    @discardableResult
    static func startPartnerRemoval(now: Double) throws -> PartnerChangeResult {
        var result: PartnerChangeResult?
        var thrown: RefereeError?
        BreakerStore.shared.mutate { state in
            if state.partner == nil {
                result = PartnerChangeResult(applied: true, session: nil); return
            }
            if state.session != nil {
                thrown = RefereeError(message: "Előbb fejezd be a folyamatban lévő kísérletet.", code: "BUSY"); return
            }
            guard let plan = planLoosening(state, .pause, nil, now, &thrown) else { return }
            var steps = plan.steps
            armCurrent(&steps, 0, now)
            let session = SessionRec(id: BreakerStore.shared.newId("ses"), kind: .pause, siteId: "partner",
                                     minutes: nil, steps: steps, stepIndex: 0, createdAt: now,
                                     pendingSchedule: nil, pendingFocusEnd: nil,
                                     pendingLockdownWindows: nil, pendingPartnerRemoval: true)
            state.session = session
            state.lastCombo = plan.comboKey
            result = PartnerChangeResult(applied: false, session: session)
        }
        if let e = thrown { throw e }
        return result!
    }

    /// Drops the running attempt and remembers WHAT it was, so restarting
    /// within the cooldown gets the same challenge types back. Cancelling is
    /// always allowed — it just must not be a cheaper route than finishing.
    private static func dropSession(_ state: inout AppState, _ now: Double) {
        guard let s = state.session else { return }
        // A megbízott lépése nem sorsolt próba: a kombináció-kulcsba nem számít.
        let combo = ChallengeEngine.comboKeyOf(
            s.steps.filter { $0.typeName != "DELAY" && $0.typeName != "PARTNER" }.map { $0.typeName })
        // The cooldown runs from the FIRST time this pair was given up on, not
        // from the latest restart — otherwise every restart would push the
        // deadline out and the pair would stick to the site for ever.
        let live = liveAbandons(state, now)
        let prev = live.first { $0.siteId == s.siteId }
        let at = (prev != nil && prev!.comboKey == combo) ? prev!.at : now
        state.abandons = live.filter { $0.siteId != s.siteId }
            + [AbandonRec(siteId: s.siteId, kind: s.kind, comboKey: combo, at: at)]
        // A FÉLBEMARADT kísérlet is könyvelés: a visszatekintés ebből mondja,
        // hányszor indult el a lazítás, és maradt félbe. Harminc napig, mint
        // a feloldások.
        state.droppedAttempts = (state.droppedAttempts ?? []).filter { $0 > now - 30 * 24 * 3_600_000 } + [now]
        state.session = nil
    }

    /// How many sites may carry a debt at once — cancels cannot grow the state.
    private static let maxAbandons = 64

    /// Debts still inside their cooldown, bounded in number.
    private static func liveAbandons(_ state: AppState, _ now: Double) -> [AbandonRec] {
        let live = (state.abandons ?? []).filter {
            now >= $0.at && now - $0.at <= ChallengeEngine.rerollCooldownMs
        }
        return live.count > maxAbandons ? Array(live.suffix(maxAbandons)) : live
    }

    /// The combo an abandoned attempt still owes, while the cooldown holds.
    ///
    /// The KIND is deliberately not compared: pause and delete draw from the
    /// same pool, so letting a cancelled delete hand back a fresh pair for the
    /// pause flow would just be the re-roll with an extra click.
    private static func forcedCombo(_ state: AppState, _ siteId: String, _ now: Double) -> String? {
        liveAbandons(state, now).first { $0.siteId == siteId }?.comboKey
    }

    /** Stamps timing state when a step becomes current (DELAY target, MEMORY show window). */
    private static func armCurrent(_ steps: inout [ChallengeEngine.Step], _ index: Int, _ now: Double) {
        guard index < steps.count else { return }
        if case let .delay(id, minutes, claimableAt, window) = steps[index], claimableAt == nil {
            steps[index] = .delay(id: id, minutes: minutes,
                                  claimableAt: now + Double(minutes) * 60_000, claimWindowMs: window)
        }
        if case let .memory(id, code, showMs, waitMs, armedAt) = steps[index], armedAt == nil {
            steps[index] = .memory(id: id, code: code, showMs: showMs, waitMs: waitMs, armedAt: now)
        }
    }

    @discardableResult
    static func startSession(kind: ChallengeEngine.Kind, siteId: String,
                             minutes: Int?, now: Double) throws -> SessionRec {
        var created: SessionRec?
        var thrown: RefereeError?
        BreakerStore.shared.mutate { state in
            guard let site = state.sites.first(where: { $0.id == siteId }) else {
                thrown = RefereeError(message: "Ismeretlen oldal.", code: "NO_SITE"); return
            }
            if kind == .pause {
                guard let m = minutes, ChallengeEngine.pauseChoicesMin.contains(m) else {
                    thrown = RefereeError(message: "Érvénytelen szünet-hossz.", code: "BAD_MINUTES"); return
                }
                if (site.pauseUntil ?? 0) > now {
                    thrown = RefereeError(message: "Ez az oldal most éppen fel van oldva.", code: "ALREADY_PAUSED"); return
                }
            }
            if kind == .delete && site.pendingDeleteAt != nil {
                thrown = RefereeError(message: "Ennek az oldalnak már folyamatban van a törlése.", code: "ALREADY_DELETING"); return
            }
            // A new attempt drops any previous one — progress is never banked,
            // and its challenge types are remembered so this is not a way to
            // shop for an easier pair.
            dropSession(&state, now)
            guard let plan = planLoosening(state, kind, siteId, now, &thrown) else { return }
            var steps = plan.steps
            armCurrent(&steps, 0, now)
            let session = SessionRec(id: BreakerStore.shared.newId("ses"), kind: kind, siteId: siteId,
                                     minutes: minutes, steps: steps, stepIndex: 0, createdAt: now,
                                     pendingSchedule: nil, pendingFocusEnd: nil)
            state.session = session
            state.lastCombo = plan.comboKey
            created = session
        }
        if let e = thrown { throw e }
        return created!
    }

    /// Egy menet lezárása a naplóba — a statisztika ebből lesz.
    ///
    /// A csomag NEVÉT is elmentjük, nem csak az azonosítóját: a csomag azóta
    /// átnevezhető vagy törölhető, és egy statisztika, ami „ismeretlen csomag”-ot
    /// ír ki a múlt hétre, semmit nem ér.
    private static func logFocusEnd(
        _ state: inout AppState, endedAt: Double, stopped: Bool
    ) {
        guard let run = state.focusRun else { return }
        let name = (state.focusPacks ?? []).first { $0.id == run.packId }?.name
            ?? "Ismeretlen csomag"
        // Az ablakból indult-e: a naplósor viszi, a statisztika és a heti mondat mondja.
        let entry = Focus.closeRun(run, packName: name, endedAt: endedAt, stopped: stopped,
                                   window: Focus.isWindowRun(run, packs: state.focusPacks ?? []))
        let rows: [Focus.LogEntry] = (state.focusLog ?? []) + [entry]
        state.focusLog = Array(rows.suffix(Focus.maxFocusLog))
    }

    private static func finish(_ state: inout AppState, _ s: SessionRec, _ now: Double) {
        // A MEGBÍZOTT LEVÉTELE: nem oldalhoz tartozik. Idáig csak próbatétellel
        // lehet eljutni — a végén az ő jelmondatával, tehát ő is bólintott.
        if s.pendingPartnerRemoval == true {
            state.partner = nil
            state.unlockLog = state.unlockLog.filter { $0 > now - 30 * 24 * 3_600_000 } + [now]
            state.session = nil
            state.abandons = (state.abandons ?? []).filter { $0.siteId != s.siteId }
            return
        }
        // A MUNKAMENET nem egy oldalhoz tartozik, hanem az egész készülékhez:
        // ezért áll itt, az oldal-keresés ELŐTT. A -1 azt jelenti: állítsd le
        // most.
        if let pending = s.pendingFocusEnd {
            if pending < 0 {
                // A naplót ITT írjuk: csak innen derül ki, hogy a menet
                // PRÓBATÉTELLEL ért véget, nem magától. A kettő nem ugyanaz a
                // mondat, és a statisztikában sem ugyanaz a sor.
                logFocusEnd(&state, endedAt: now, stopped: true)
                state.focusRun = nil
            } else if var run = state.focusRun {
                run = Focus.Run(packId: run.packId, startedAt: run.startedAt, endsAt: pending)
                state.focusRun = run
            }
            state.unlockLog = state.unlockLog.filter { $0 > now - 30 * 24 * 3_600_000 } + [now]
            state.session = nil
            state.abandons = (state.abandons ?? []).filter { $0.siteId != s.siteId }
            return
        }
        // A KULCSSZAVAK sem oldalhoz tartoznak: a listát itt cseréljük, mert
        // idáig csak próbatétellel lehet eljutni — a levétel ára ez a menet volt.
        if let words = s.pendingKeywords {
            state.keywords = words.isEmpty ? nil : words
            state.unlockLog = state.unlockLog.filter { $0 > now - 30 * 24 * 3_600_000 } + [now]
            state.session = nil
            state.abandons = (state.abandons ?? []).filter { $0.siteId != s.siteId }
            return
        }
        // A ZÁRLAT-ABLAKOK sem oldalhoz tartoznak. Idáig csak próbatétellel
        // lehet eljutni — a levétel vagy a szűkítés ára ez a menet volt. A futó
        // zárlathoz nem nyúl: a zárlat sosem rövidül; de ide csak ablakon
        // kívülről lehet eljutni, mert bent a kapu nem enged próbatételt.
        if let windows = s.pendingLockdownWindows {
            state.lockdownWindows = windows.isEmpty ? nil : windows
            state.unlockLog = state.unlockLog.filter { $0 > now - 30 * 24 * 3_600_000 } + [now]
            state.session = nil
            state.abandons = (state.abandons ?? []).filter { $0.siteId != s.siteId }
            return
        }
        state.sites = state.sites.map { site in
            guard site.id == s.siteId else { return site }
            var copy = site
            if let sched = s.pendingSchedule { copy.schedule = sched } // gated loosening
            else if s.kind == .pause { copy.pauseUntil = now + Double(s.minutes ?? 15) * 60_000 }
            else { copy.pendingDeleteAt = now + Double(ChallengeEngine.deletePendingMs) }
            return copy
        }
        state.unlockLog = state.unlockLog.filter { $0 > now - 30 * 24 * 3_600_000 } + [now]
        state.session = nil
        // Solved: this site's debt is paid, its next attempt draws freely again.
        // Other sites keep theirs.
        state.abandons = (state.abandons ?? []).filter { $0.siteId != s.siteId }
    }

    struct ScheduleChangeResult { let applied: Bool; let session: SessionRec? }

    struct WindowsChangeResult { let applied: Bool; let session: SessionRec? }

    struct KeywordsChangeResult { let applied: Bool; let session: SessionRec? }

    /// A kulcsszavak beállítása: a TELJES lista jön, és a tárolt lista ezt
    /// követi. Felvenni ingyen (szigorítás: több cím zárva); levenni
    /// próbatétel — különben a kulcsszó egy kikapcsolóval érne fel. Az iPhone
    /// nem érvényesít (a szűrő a címet nem látja), de szerkeszt és hordoz: a
    /// fiókon át a gépi böngésző tilt vele. A desktop `setKeywords` tükre.
    @discardableResult
    static func setKeywords(_ input: [String], now: Double) throws -> KeywordsChangeResult {
        var result: KeywordsChangeResult?
        var thrown: RefereeError?
        BreakerStore.shared.mutate { state in
            if input.count > KeywordLogic.maxKeywords {
                thrown = RefereeError(message: "Legfeljebb \(KeywordLogic.maxKeywords) kulcsszó fér el.",
                                      code: "TOO_MANY_KEYWORDS"); return
            }
            let next = KeywordLogic.cleanKeywords(input)
            if next.count != input.count {
                thrown = RefereeError(
                    message: "Érvénytelen kulcsszó: \(KeywordLogic.minKeywordLength)–\(KeywordLogic.maxKeywordLength) "
                        + "karakter, szóköz nélkül — és minden szó csak egyszer.",
                    code: "BAD_KEYWORD"); return
            }
            let current = state.keywords ?? []
            if KeywordLogic.sameKeywords(current, next) {
                result = KeywordsChangeResult(applied: true, session: nil); return
            }
            if !KeywordLogic.isKeywordsLoosening(current, next) {
                // Futó levétel közben a felvétel is ingyen — és a levétel VÉGÉN
                // sem veszhet el: a függő lista is megkapja, ami közben jött.
                state.keywords = next
                if var s = state.session, let pending = s.pendingKeywords {
                    s.pendingKeywords = KeywordLogic.cleanKeywords(pending + next.filter { !current.contains($0) })
                    state.session = s
                }
                result = KeywordsChangeResult(applied: true, session: nil); return
            }
            if state.session != nil {
                thrown = RefereeError(message: "Előbb fejezd be a folyamatban lévő kísérletet.", code: "BUSY"); return
            }
            guard let plan = planLoosening(state, .pause, nil, now, &thrown) else { return }
            var steps = plan.steps
            armCurrent(&steps, 0, now)
            var session = SessionRec(id: BreakerStore.shared.newId("ses"), kind: .pause, siteId: "keywords",
                                     minutes: nil, steps: steps, stepIndex: 0, createdAt: now,
                                     pendingSchedule: nil, pendingFocusEnd: nil, pendingLockdownWindows: nil)
            session.pendingKeywords = next
            state.session = session
            state.lastCombo = plan.comboKey
            result = KeywordsChangeResult(applied: false, session: session)
        }
        if let e = thrown { throw e }
        return result!
    }

    /// A zárlat-ablakok beállítása: a TELJES lista jön, és a tárolt lista ezt
    /// követi. Felvenni és bővíteni ingyen; levenni vagy szűkíteni próbatétel —
    /// és csak ablakon kívül, mert bent a kapu zárlatot lát. Az egész hét nem
    /// zárható le. Az azonosító nélküli ablak új: itt kap azonosítót. A
    /// desktop `setLockdownWindows` tükre.
    @discardableResult
    static func setLockdownWindows(_ windows: [LockdownLogic.LockdownWindow], now: Double) throws -> WindowsChangeResult {
        var result: WindowsChangeResult?
        var thrown: RefereeError?
        BreakerStore.shared.mutate { state in
            let items = windows.map { w in
                w.id.isEmpty
                    ? LockdownLogic.LockdownWindow(id: BreakerStore.shared.newId("lw"), days: w.days,
                                                   startMin: w.startMin, endMin: w.endMin)
                    : w
            }
            if items.contains(where: { LockdownLogic.cleanWindow($0) == nil }) {
                thrown = RefereeError(message: "Érvénytelen ablak: legalább egy nap kell, és egy kezdés meg egy vég.",
                                      code: "BAD_WINDOW"); return
            }
            if items.count > LockdownLogic.maxLockdownWindows {
                thrown = RefereeError(message: "Legfeljebb \(LockdownLogic.maxLockdownWindows) ablak fér el.",
                                      code: "TOO_MANY_WINDOWS"); return
            }
            let next = LockdownLogic.cleanWindows(items)
            if !LockdownLogic.weekHasFreeTime(next.map { $0.band }, now) {
                thrown = RefereeError(
                    message: "Az egész hét nem zárható le: legalább egy szabad óra kell a héten az ablakok "
                        + "mellett — különben az ablakot sosem lehetne levenni.",
                    code: "NO_FREE_TIME"); return
            }
            let current = state.lockdownWindows ?? []
            if LockdownLogic.sameWindows(current.map { $0.band }, next.map { $0.band }) {
                result = WindowsChangeResult(applied: true, session: nil); return
            }
            if !LockdownLogic.isWindowsLoosening(current.map { $0.band }, next.map { $0.band }, now) {
                // A meglévő ablak azonosítója marad; a sorrend az új listáé.
                let kept = next.map { n in
                    current.first { LockdownLogic.windowKey($0.band) == LockdownLogic.windowKey(n.band) } ?? n
                }
                state.lockdownWindows = kept
                result = WindowsChangeResult(applied: true, session: nil); return
            }
            if state.session != nil {
                thrown = RefereeError(message: "Előbb fejezd be a folyamatban lévő kísérletet.", code: "BUSY"); return
            }
            guard let plan = planLoosening(state, .pause, nil, now, &thrown) else { return }
            var steps = plan.steps
            armCurrent(&steps, 0, now)
            let session = SessionRec(id: BreakerStore.shared.newId("ses"), kind: .pause, siteId: "lockdown:windows",
                                     minutes: nil, steps: steps, stepIndex: 0, createdAt: now,
                                     pendingSchedule: nil, pendingFocusEnd: nil, pendingLockdownWindows: next)
            state.session = session
            state.lastCombo = plan.comboKey
            result = WindowsChangeResult(applied: false, session: session)
        }
        if let e = thrown { throw e }
        return result!
    }

    /// Change a site's weekly schedule. Tightening applies immediately; loosening
    /// requires the same challenges as a pause (mirrors desktop startScheduleChange).
    @discardableResult
    static func startScheduleChange(siteId: String, schedule: ScheduleLogic.Schedule,
                                    now: Double) throws -> ScheduleChangeResult {
        var result: ScheduleChangeResult?
        var thrown: RefereeError?
        BreakerStore.shared.mutate { state in
            guard let site = state.sites.first(where: { $0.id == siteId }) else {
                thrown = RefereeError(message: "Ismeretlen oldal.", code: "NO_SITE"); return
            }
            if state.session != nil {
                thrown = RefereeError(message: "Előbb fejezd be a folyamatban lévő kísérletet.", code: "BUSY"); return
            }
            let next = ScheduleLogic.normalize(schedule)
            let current = ScheduleLogic.normalize(site.schedule ?? ScheduleLogic.always)
            if !ScheduleLogic.isLoosening(current, next, now) {
                state.sites = state.sites.map { site in
                    guard site.id == siteId else { return site }
                    var copy = site
                    copy.schedule = next
                    return copy
                }
                result = ScheduleChangeResult(applied: true, session: nil)
                return
            }
            guard let plan = planLoosening(state, .pause, siteId, now, &thrown) else { return }
            var steps = plan.steps
            armCurrent(&steps, 0, now)
            let session = SessionRec(id: BreakerStore.shared.newId("ses"), kind: .pause, siteId: siteId,
                                     minutes: nil, steps: steps, stepIndex: 0, createdAt: now,
                                     pendingSchedule: next, pendingFocusEnd: nil)
            state.session = session
            state.lastCombo = plan.comboKey
            result = ScheduleChangeResult(applied: false, session: session)
        }
        if let e = thrown { throw e }
        return result!
    }

    static func submitAnswer(sessionId: String, answer: String, now: Double) throws -> SubmitResult {
        var result: SubmitResult?
        var thrown: RefereeError?
        BreakerStore.shared.mutate { state in
            guard var s = state.session, s.id == sessionId else {
                thrown = RefereeError(message: "Nincs ilyen aktív feloldási kísérlet.", code: "NO_SESSION"); return
            }
            if now - s.createdAt > Double(ChallengeEngine.sessionMaxAgeMs) {
                dropSession(&state, now)
                thrown = RefereeError(message: "A feloldási kísérlet lejárt, kezdd elölről.", code: "SESSION_EXPIRED"); return
            }
            let step = s.steps[s.stepIndex]
            if case .delay = step {
                thrown = RefereeError(message: "Ez a lépés várakozás — a Feloldás átvétele gombbal zárható.", code: "DELAY_STEP"); return
            }
            if case .partner = step {
                // A jelmondat a lenyomattal összevetve. Rossz jelmondat nem
                // sorsol újat, csak számol; a plafonnál a kísérlet elszáll —
                // elölről, minden lépéssel. Ha a megbízott közben (a
                // szinkronból) lekerült, a lépés tárgytalan: átmegy.
                if let lock = state.partner, !PartnerLogic.verify(lock, answer) {
                    let tries = (s.partnerTries ?? 0) + 1
                    if tries >= PartnerLogic.maxPartnerTries {
                        dropSession(&state, now)
                        thrown = RefereeError(
                            message: "\(PartnerLogic.maxPartnerTries)-ször nem ez volt a jelmondat — "
                                + "a kísérlet érvénytelen, elölről kell kezdeni.",
                            code: "PARTNER_TRIES")
                        return
                    }
                    s.partnerTries = tries
                    state.session = s
                    result = SubmitResult(accepted: false, sessionDone: false,
                                          message: "Nem ez a jelmondat. Kérd meg a megbízottadat, hogy ő írja be.")
                    return
                }
                s.stepIndex += 1
                if s.stepIndex >= s.steps.count {
                    state.session = s
                    finish(&state, s, now)
                    result = SubmitResult(accepted: true, sessionDone: true, message: nil)
                    return
                }
                armCurrent(&s.steps, s.stepIndex, now)
                state.session = s
                result = SubmitResult(accepted: true, sessionDone: false, message: nil)
                return
            }
            let tier = effectiveTier(state, kind: s.kind, now: s.createdAt)
            let outcome = ChallengeEngine.applyAnswer(step, answer: answer, tier: tier, kind: s.kind, now: now)
            s.steps[s.stepIndex] = outcome.step
            if outcome.ok && outcome.done {
                s.stepIndex += 1
                if s.stepIndex >= s.steps.count {
                    state.session = s
                    finish(&state, s, now)
                    result = SubmitResult(accepted: true, sessionDone: true, message: nil)
                    return
                }
                armCurrent(&s.steps, s.stepIndex, now)
                state.session = s
                result = SubmitResult(accepted: true, sessionDone: false, message: nil)
                return
            }
            // A failed answer can hand back a REGENERATED step (new memory code,
            // new sentence). It must be armed too, or a MEMORY step would have no
            // armedAt: the code is never shown and every answer is refused as
            // premature — the challenge becomes unsolvable.
            armCurrent(&s.steps, s.stepIndex, now)
            state.session = s
            result = SubmitResult(accepted: outcome.ok, sessionDone: false, message: outcome.message)
        }
        if let e = thrown { throw e }
        return result!
    }

    static func claimDelay(sessionId: String, now: Double) throws -> SubmitResult {
        // Expiry clears the session in its own committed mutation first.
        if let pre = BreakerStore.shared.state.session, pre.id == sessionId,
           case let .delay(_, _, claimableAt?, window) = pre.steps[pre.stepIndex],
           now > claimableAt + Double(window) {
            BreakerStore.shared.mutate { state in dropSession(&state, now) }
            throw RefereeError(
                message: "Lecsúsztál az átvételi ablakról — a feloldási kísérlet érvénytelen, elölről kell kezdeni.",
                code: "CLAIM_EXPIRED")
        }
        var result: SubmitResult?
        var thrown: RefereeError?
        BreakerStore.shared.mutate { state in
            guard var s = state.session, s.id == sessionId else {
                thrown = RefereeError(message: "Nincs ilyen aktív feloldási kísérlet.", code: "NO_SESSION"); return
            }
            guard case let .delay(_, _, claimableAt?, _) = s.steps[s.stepIndex] else {
                thrown = RefereeError(message: "Most nem várakozási lépés van.", code: "NOT_DELAY"); return
            }
            if now < claimableAt {
                let remainMin = Int(ceil((claimableAt - now) / 60_000))
                result = SubmitResult(accepted: false, sessionDone: false, message: "Még \(remainMin) percet várni kell.")
                return
            }
            s.stepIndex += 1
            if s.stepIndex >= s.steps.count {
                state.session = s
                finish(&state, s, now)
                result = SubmitResult(accepted: true, sessionDone: true, message: nil)
                return
            }
            armCurrent(&s.steps, s.stepIndex, now)
            state.session = s
            result = SubmitResult(accepted: true, sessionDone: false, message: nil)
        }
        if let e = thrown { throw e }
        return result!
    }

    static func abandon(sessionId: String) {
        let now = Date().timeIntervalSince1970 * 1000
        BreakerStore.shared.mutate { state in
            if state.session?.id == sessionId { dropSession(&state, now) }
        }
    }

    /// housekeeping: re-lock ended pauses, run due deletions, drop dead sessions
    /// A gap bigger than this between two housekeeping ticks is not elapsed
    /// time: the loop runs every second, so anything past a couple of minutes
    /// is either the clock being moved or the device having been asleep.
    static let clockJumpThresholdMs: Double = 2 * 60_000

    /// Milyen ritkán írjuk ki az alapvonalat. Minden körben menteni pazarlás
    /// lenne, viszont el kell férnie az ugrás-küszöb alatt: így a késleltetett
    /// kiírás önmagában sosem látszik óra-ugrásnak.
    private static let tickSaveIntervalMs: Double = 60_000

    /// Mikor írtuk ki utoljára — csak a ritkításhoz; az alapvonal a lemezen van.
    private static var lastTickSavedAt: Double = 0

    /// Waiting IS the challenge here, and a challenge a clock change defeats is
    /// not a challenge: with the system clock moved forward a DELAY step would
    /// be claimable at once and a pending deletion would run early. So the
    /// deadlines that PROTECT (the waiting target, a pending deletion, the age
    /// of the attempt) are pushed by whatever the wall clock jumped — they
    /// measure elapsed time, not a date. Sleep looks identical from here and is
    /// treated the same: the wait does not run while the device is off.
    ///
    /// pauseUntil is deliberately left alone: a jump that ends an unlock early
    /// blocks more, and tightening never needs protecting.
    ///
    /// AZ ALAPVONAL A LEMEZRŐL JÖN (BreakerStore.loadLastTick), nem a
    /// memóriából. Amíg memóriában élt, az app kilövése után az első kör csak
    /// új alapvonalat vett fel: a folyamat leállítása + óra-előreállítás ingyen
    /// megrövidítette a várakozást. A gépen ez a szám mindig a mentett
    /// állapotban volt; most itt is túléli az újraindítást.
    /// - Returns: a FRISS állapot. Nem díszítés: a `BreakerStore.state` a fő
    ///   sorra dobva frissül, tehát közvetlenül egy mentés után még a RÉGI
    ///   értéket adja. A kör pedig pont ilyenkor döntene — az elnyelés utáni
    ///   pillanatban —, és a döntést a még el nem tolt határidőkre hozná.
    @discardableResult
    private static func absorbClockJump(_ now: Double) -> AppState {
        let last = BreakerStore.shared.loadLastTick()
        let fresh = last == 0
        let jump = fresh ? 0 : now - last
        let jumped = jump > clockJumpThresholdMs
        // Kiírjuk: az első körben, ugráskor, visszafelé állított óránál,
        // egyébként ritkítva.
        if fresh || jumped || now < lastTickSavedAt || now - lastTickSavedAt >= tickSaveIntervalMs {
            lastTickSavedAt = now
            BreakerStore.shared.saveLastTick(now)
        }
        guard jumped else { return BreakerStore.shared.state }
        let shift = jump - clockJumpThresholdMs

        return BreakerStore.shared.mutate { state in
            if var s = state.session, s.steps.indices.contains(s.stepIndex) {
                if case let .delay(id, minutes, claimableAt?, window) = s.steps[s.stepIndex] {
                    s.steps[s.stepIndex] = .delay(id: id, minutes: minutes,
                                                  claimableAt: claimableAt + shift, claimWindowMs: window)
                }
                s.createdAt += shift // …so the jump cannot age the attempt out either
                state.session = s
            }
            state.sites = state.sites.map { site in
                var copy = site
                if let d = copy.pendingDeleteAt { copy.pendingDeleteAt = d + shift }
                return copy
            }
            // A FUTÓ MUNKAMENET IS ELTOLÓDIK — enélkül az óra előreállítása
            // ingyen leállítaná, a számláló léptetne, és a szinkron ezt szét is
            // vinné a többi eszközre.
            //
            // A SZABÁLY EGY MONDAT: amennyi hátra volt, annyi van hátra. Ugyanez
            // a válasz a felfüggesztett készülékre is: a kettőt nem tudjuk
            // megkülönböztetni, de nem is kell.
            //
            // A kezdés is tolódik, nem csak a vég: enélkül a naplóba egy
            // ötvenperces menet órásként kerülne be, és a statisztika hazudna.
            //
            // Az ABLAK-menet kivétel: annak a vége az ablak vége, nem tolódik a
            // készülék alvásával (Focus.isWindowRun) — különben a telefon és a
            // gép két különböző menetet látna ugyanarról a délelőttről.
            if let run = state.focusRun, !Focus.isWindowRun(run, packs: state.focusPacks ?? []) {
                state.focusRun = Focus.Run(
                    packId: run.packId,
                    startedAt: run.startedAt + shift,
                    endsAt: run.endsAt + shift
                )
            }
            // A ZÁRLAT VÉGE IS TOLÓDIK. Enélkül az óra előreállítása ingyen
            // befejezné — pont azt az egyetlen dolgot, aminek szándékosan nincs
            // visszaútja. Amennyi hátra volt, annyi van hátra.
            //
            // Az ABLAK-ZÁRLAT kivétel, ugyanazzal az indokkal, mint az
            // ablak-menet: annak a vége az ablak vége. A telefon alvása nem
            // hosszabbítja a hétköznapot (LockdownLogic.isWindowLockdown).
            if let lock = state.lockdown,
               !LockdownLogic.isWindowLockdown(lock, (state.lockdownWindows ?? []).map { $0.band }) {
                state.lockdown = LockdownLogic.Lockdown(
                    startedAt: lock.startedAt + shift, until: lock.until + shift
                )
            }
        }
    }

    /// Zárlat indítása vagy hosszabbítása. Ez a MÁSIK irány: ingyen van.
    ///
    /// A zárlat a folyamatban lévő lazításokat is visszaveszi, különben az
    /// indítás pillanata maga lenne a kibúvó: a futó próbatétel elszáll, a
    /// feloldott oldalak visszazárnak, a folyamatban lévő törlések
    /// visszavonódnak. A futó munkamenethez nem nyúl: az fehérlista, vagyis
    /// maga is szigorítás.
    @discardableResult
    static func startLockdown(ms: Double, now: Double) throws -> LockdownLogic.Lockdown {
        var out: LockdownLogic.Lockdown?
        var thrown: RefereeError?
        BreakerStore.shared.mutate { state in
            guard let next = LockdownLogic.start(state.lockdown, ms, now) else {
                thrown = RefereeError(message: "Érvénytelen zárlat-hossz.", code: "BAD_LOCKDOWN")
                return
            }
            dropSession(&state, now)
            state.sites = state.sites.map { site in
                var copy = site
                copy.pauseUntil = nil
                copy.pendingDeleteAt = nil
                return copy
            }
            state.lockdown = next
            out = next
        }
        if let e = thrown { throw e }
        return out!
    }

    /// Az ismétlődés-vizsgálat utolsó tizenöt másodperces szelete (lásd a tick-et).
    private static var lastDueSlot = -1

    static func tick(now: Double) {
        // A FRISS állapoton döntünk, nem a közzétetten: az elnyelés épp most
        // tolta el a határidőket, a `BreakerStore.state` viszont csak a fő sor
        // következő körében követi. Enélkül a kör az EL NEM TOLT lejáratot
        // látná — vagyis pont azon a körön, ahol az óra-ugrás történt,
        // működhetne az, ami ellen a védelem szól.
        let st = absorbClockJump(now)
        var sessionDead = false
        if let s = st.session {
            if case let .delay(_, _, claimableAt?, window) = s.steps[s.stepIndex],
               now > claimableAt + Double(window) { sessionDead = true }
            if now - s.createdAt > Double(ChallengeEngine.sessionMaxAgeMs) { sessionDead = true }
        }
        // AZ ABLAK ZÁRLATOT ÍR. Ha él egy zárlat-ablak, és a futó zárlat vége az
        // ablak végénél korábbi (vagy nincs zárlat), az ablak végéig szóló
        // zárlat kerül az állapotba — pontosan az, amit kézzel is lehet.
        // Tizenöt másodpercenként nézzük (mint az ablak-menetet); a kapu az
        // ablakot a kör előtt is látja (currentLockdown).
        let slot = Int(now / 15_000)
        let slotDue = slot != lastDueSlot
        if slotDue { lastDueSlot = slot }
        let windowLock: LockdownLogic.Lockdown? = slotDue
            ? LockdownLogic.windowLockdown(st.lockdown, (st.lockdownWindows ?? []).map { $0.band }, now)
            : nil
        // A ZÁRLAT MÁSIK ESZKÖZRŐL is megérkezhet, a kör közepén: a szinkron
        // lehozza, és onnantól itt sem maradhat feloldott oldal, kifizetett
        // törlés vagy futó kísérlet. Enélkül a gépen indított zárlat az
        // iPhone-on nem jelentene semmit — és pont az lenne a kibúvó.
        let locked = LockdownLogic.isLocked(windowLock ?? st.lockdown, now)
        let lockedSession = locked && st.session != nil
        let pauseEnded = st.sites.contains { site in
            guard let p = site.pauseUntil else { return false }
            return locked || p <= now
        }
        let deleteDue = st.sites.contains { site in
            guard let d = site.pendingDeleteAt else { return false }
            return locked || d <= now
        }
        // A MAGÁTÓL lejárt menet is lezárul — enélkül csak a próbatétellel
        // leállított menetek kerülnének a statisztikába, vagyis pont azok
        // hiányoznának, amiket a felhasználó VÉGIGVITT. Az a statisztika
        // rosszabb a semminél: azt mondaná, hogy sosem sikerül.
        let focusEnded: Bool = {
            guard let run = st.focusRun else { return false }
            return run.endsAt <= now
        }()
        // MENETREND SZERINTI INDÍTÁS. Az ablakban, ha nem fut semmi, és a napló
        // szerint ebben az ablakban még nem indult, a csomag menete magától
        // indul. Tizenöt másodpercenként nézzük, nem minden körben — az ablak
        // percekben él, nem másodpercekben.
        var focusDue = false
        if slotDue {
            focusDue = Focus.dueRecurrence(
                st.focusPacks ?? [], run: st.focusRun, log: st.focusLog ?? [], now: now
            ) != nil
        }
        guard sessionDead || lockedSession || pauseEnded || deleteDue || focusEnded || focusDue
            || windowLock != nil
        else { return }

        BreakerStore.shared.mutate { state in
            // Az ablak zárlata a FRISS állapotból, a takarítás előtt — a többi
            // lépés ugyanazt a mezőt nézi, mint kézi zárlatnál.
            if let lock = LockdownLogic.windowLockdown(
                state.lockdown, (state.lockdownWindows ?? []).map { $0.band }, now
            ) {
                state.lockdown = lock
            }
            // Sitting out the claim window ends an attempt too: same bookkeeping,
            // so it is not an escape hatch from a pair one dislikes.
            if sessionDead || lockedSession { dropSession(&state, now) }
            state.sites = state.sites.compactMap { site in
                var copy = site
                if let p = copy.pauseUntil, locked || p <= now { copy.pauseUntil = nil }
                // Zárlat alatt a kifizetett törlés is visszavonódik: az oldal
                // marad, a kivárt idő elvész. A szigorúbb irány, és a zárlat ára.
                if locked { copy.pendingDeleteAt = nil }
                if let d = copy.pendingDeleteAt, d <= now { return nil }
                return copy
            }
            if let closed = Focus.closeIfEnded(
                state.focusRun, packs: state.focusPacks ?? [],
                log: state.focusLog ?? [], now: now
            ) {
                state.focusRun = closed.run
                state.focusLog = closed.log
            }
            // Az ablak kezdésével és végével — a gép ugyanezt a menetet állítja
            // elő, a szinkron a kettőt egynek látja.
            if let due = Focus.dueRecurrence(
                state.focusPacks ?? [], run: state.focusRun, log: state.focusLog ?? [], now: now
            ) {
                // Egy MÁSIK csomag kézi menete az ablak kezdetén véget ér — az
                // ablak az ígéret. A naplóba a saját idejével, nem leállítottként.
                if let running = state.focusRun, Focus.isRunning(running, now: now) {
                    let name = (state.focusPacks ?? []).first { $0.id == running.packId }?.name ?? "Ismeretlen csomag"
                    let entry = Focus.closeRun(running, packName: name, endedAt: now, stopped: false,
                                               window: Focus.isWindowRun(running, packs: state.focusPacks ?? []))
                    let rows: [Focus.LogEntry] = (state.focusLog ?? []) + [entry]
                    state.focusLog = Array(rows.suffix(Focus.maxFocusLog))
                }
                state.focusRun = Focus.Run(packId: due.pack.id, startedAt: due.startsAt, endsAt: due.endsAt)
            }
        }
    }

    // MARK: - munkamenet

    struct FocusChangeResult { let applied: Bool; let session: SessionRec? }

    /// Munkamenet indítása. INGYEN van — ez a szigorítás iránya.
    ///
    /// Egyszerre egy menet fut. Enélkül a leállítás próbatételét meg lehetne
    /// kerülni: indítok egy „minden engedve” csomagot, és kész.
    static func startFocus(packId: String, minutes: Int, now: Double) throws {
        var thrown: RefereeError?
        BreakerStore.shared.mutate { state in
            guard let pack = (state.focusPacks ?? []).first(where: { $0.id == packId }) else {
                thrown = RefereeError(message: "Ismeretlen csomag.", code: "NO_PACK"); return
            }
            if Focus.isRunning(state.focusRun, now: now) {
                thrown = RefereeError(message: "Már fut egy munkamenet.", code: "FOCUS_RUNNING"); return
            }
            guard let mins = Focus.normalizeMinutes(Double(minutes)) else {
                thrown = RefereeError(message: "Érvénytelen hossz.", code: "BAD_MINUTES"); return
            }
            state.focusRun = Focus.Run(
                packId: pack.id, startedAt: now, endsAt: now + Double(mins) * 60_000
            )
        }
        if let e = thrown { throw e }
    }

    /// CSOMAG FELVÉTELE az iPhone-on: név, engedett oldalak, szokásos hossz.
    /// Csak felvétel — az nem lazít semmit: a csomag addig nem tesz semmit,
    /// amíg menetet nem indítasz vele. Szerkeszteni, törölni, az ablakot
    /// cserélni a gépen lehet. A csomag jelét a következő léptetés írja. Az
    /// androidos `addFocusPack` tükre.
    @discardableResult
    static func addFocusPack(name: String, allowSites: [String], defaultMinutes: Int) throws -> Focus.Pack {
        let words = name.split(whereSeparator: { $0.isWhitespace }).map(String.init)
        let cleanName = String(words.joined(separator: " ").prefix(Focus.maxPackName))
        if cleanName.isEmpty { throw RefereeError(message: "Adj nevet a csomagnak.", code: "BAD_NAME") }
        var sites: [String] = []
        for s in allowSites {
            guard let n = Focus.normalizeAllowSite(s), !sites.contains(n), sites.count < Focus.maxAllowEntries else { continue }
            sites.append(n)
        }
        guard let mins = Focus.normalizeMinutes(Double(defaultMinutes)) else {
            throw RefereeError(message: "Érvénytelen hossz.", code: "BAD_MINUTES")
        }
        let pack = Focus.Pack(
            id: "pack_" + String(UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(12)).lowercased(),
            name: cleanName, allowSites: sites, allowApps: [], defaultMinutes: mins
        )
        var thrown: RefereeError?
        BreakerStore.shared.mutate { state in
            if (state.focusPacks ?? []).count >= FocusSync.maxPacks {
                thrown = RefereeError(message: "Legfeljebb \(FocusSync.maxPacks) csomag fér el.", code: "TOO_MANY_PACKS"); return
            }
            state.focusPacks = (state.focusPacks ?? []) + [pack]
        }
        if let e = thrown { throw e }
        return pack
    }

    /// ABLAK A CSÚCS-ÓRÁRA az iPhone-ról: heti ablak egy ablak NÉLKÜLI csomagra.
    ///
    /// Felvenni ingyen (szigorítás: több idő, amikor a fehérlista él). A telefon
    /// CSAK felvesz: cserélni, szűkíteni, levenni a gépen lehet, próbatétellel —
    /// a lazítás kérdése ott dől el. A futó csomag itt is befagy, mint a gépen.
    /// A csomag jelét a következő léptetés írja (SyncRevisions.bumpFocus), hogy
    /// a fésülésben ez a változat nyerjen. Az androidos `addFocusWindow` tükre.
    static func addFocusWindow(packId: String, band: ScheduleLogic.Band, now: Double) throws {
        var thrown: RefereeError?
        BreakerStore.shared.mutate { state in
            var packs = state.focusPacks ?? []
            guard let i = packs.firstIndex(where: { $0.id == packId }) else {
                thrown = RefereeError(message: "Ismeretlen csomag.", code: "NO_PACK"); return
            }
            if Focus.isRunning(state.focusRun, now: now), state.focusRun?.packId == packId {
                thrown = RefereeError(message: "Ez a csomag épp fut — amíg tart, az ablaka sem szerkeszthető.",
                                      code: "FOCUS_RUNNING"); return
            }
            if packs[i].recurrence != nil {
                thrown = RefereeError(message: "Ennek a csomagnak már van heti ablaka — a gépen szerkeszthető.",
                                      code: "HAS_WINDOW"); return
            }
            guard let next = Focus.cleanRecurrence(band) else {
                thrown = RefereeError(message: "Érvénytelen ablak: legalább egy nap kell, és legfeljebb nyolc óra.",
                                      code: "BAD_RECURRENCE"); return
            }
            let p = packs[i]
            packs[i] = Focus.Pack(id: p.id, name: p.name, allowSites: p.allowSites, allowApps: p.allowApps,
                                  defaultMinutes: p.defaultMinutes, recurrence: next)
            state.focusPacks = packs
        }
        if let e = thrown { throw e }
    }

    /// A futó menet vége odébb tolva — vagy a leállítása.
    ///
    /// HOSSZABBÍTANI ingyen van, RÖVIDÍTENI és LEÁLLÍTANI próbatételbe kerül.
    /// Ugyanaz a szabály, mint mindenhol: enélkül a munkamenet egy „mégsem”
    /// gomb lenne, és pont az a lényeg, hogy ne az legyen.
    ///
    /// - Parameter nextEndsAt: az új vég, vagy nil = állítsd le most
    @discardableResult
    static func changeFocus(nextEndsAt: Double?, now: Double) throws -> FocusChangeResult {
        var result: FocusChangeResult?
        var thrown: RefereeError?
        BreakerStore.shared.mutate { state in
            guard let run = state.focusRun, Focus.isRunning(run, now: now) else {
                thrown = RefereeError(message: "Nem fut munkamenet.", code: "NO_FOCUS"); return
            }
            let next = nextEndsAt ?? now
            if !Focus.isSessionLoosening(currentEndsAt: run.endsAt, nextEndsAt: next) {
                state.focusRun = Focus.Run(
                    packId: run.packId, startedAt: run.startedAt, endsAt: next
                )
                result = FocusChangeResult(applied: true, session: nil)
                return
            }
            if state.session != nil {
                thrown = RefereeError(
                    message: "Előbb fejezd be a folyamatban lévő kísérletet.", code: "BUSY"
                )
                return
            }
            dropSession(&state, now)
            guard let plan = planLoosening(state, .pause, nil, now, &thrown) else { return }
            var steps = plan.steps
            armCurrent(&steps, 0, now)
            let session = SessionRec(
                id: BreakerStore.shared.newId("ses"), kind: .pause,
                // A munkamenet nem oldalhoz tartozik; a jelölés mégis kell, mert
                // a feladott kísérletek nyilvántartása oldalanként megy.
                siteId: "focus:" + run.packId,
                minutes: nil, steps: steps, stepIndex: 0, createdAt: now,
                pendingSchedule: nil,
                // A -1 a „állítsd le most”; a nulla érvényes időpont lenne.
                pendingFocusEnd: nextEndsAt ?? -1
            )
            state.session = session
            state.lastCombo = plan.comboKey
            result = FocusChangeResult(applied: false, session: session)
        }
        if let e = thrown { throw e }
        return result!
    }
}
