import SwiftUI

/// Renders the current step of an unlock/delete session. Validation happens in
/// Referee (shared core); this view only displays and forwards answers.
struct ChallengeView: View {
    let session: SessionRec
    let onSuccess: (String) -> Void
    /// A kísérlet ELSZÁLLT (lecsúszott átvétel, ötödik rossz jelmondat): a lap
    /// bezárul, és az ok a hívóé — különben a bezárt lappal a mondat is elveszne.
    var onDropped: ((String) -> Void)? = nil

    @EnvironmentObject var store: BreakerStore
    @Environment(\.dismiss) private var dismiss
    @State private var message: String?
    @State private var now = nowMs()
    private let timer = Timer.publish(every: 0.5, on: .main, in: .common).autoconnect()

    private var live: SessionRec? { store.state.session?.id == session.id ? store.state.session : nil }

    private var doneText: String {
        if session.kind == .delete {
            return "Kész. A törlés 24 óra múlva válik véglegessé — addig visszavonhatod."
        }
        if session.pendingPartnerRemoval == true { return "Kész. A megbízott lekerült." }
        if session.pendingLockdownWindows != nil { return "Kész. A zárlat-ablak lazítása életbe lépett." }
        if session.pendingFocusEnd != nil { return "Kész. A munkamenet a kért módon zárult." }
        if session.pendingSchedule != nil { return "Kész. A menetrend a kért módon változott." }
        return "Sikerült! Az oldal \(session.minutes ?? 0) percre elérhető, utána magától visszazár."
    }

    /// A fejléc azt mondja, MI a tét — a menet leállítása vagy egy ablak
    /// levétele nem „feloldás 0 percre”.
    private var titleText: String {
        if session.kind == .delete { return "Végleges törlés" }
        if session.pendingPartnerRemoval == true { return "A megbízott levétele" }
        if session.pendingLockdownWindows != nil { return "Zárlat-ablak lazítása" }
        if session.pendingFocusEnd != nil { return "Munkamenet leállítása" }
        if session.pendingSchedule != nil { return "Menetrend lazítása" }
        return "Feloldás \(session.minutes ?? 0) p"
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    // Az indok — pont most kell elolvasni, mielőtt a próbákba belefog az ember.
                    if session.pendingLockdownWindows == nil, session.pendingFocusEnd == nil,
                       session.pendingPartnerRemoval != true,
                       let reason = store.state.sites.first(where: { $0.id == session.siteId })?.reason {
                        Text("Ezért tiltottad le: „\(reason)”").font(.subheadline).italic()
                    }
                    if let ses = live, ses.stepIndex < ses.steps.count {
                        // A PONTOS SZÁM NEM MEGY KI: a „2/4. próba” azt üzente,
                        // hogy mindjárt kész — és pont ez a lendület visz át a
                        // feloldáson. Ami marad, mindig igaz, de nem mondja meg,
                        // hol a vége.
                        Text(ChallengeEngine.remainingHint(
                            stepIndex: ses.stepIndex, stepCount: ses.steps.count
                        ) == .many ? "Legalább 3 feladat van még hátra" : "Van még hátra feladat")
                            .font(.subheadline).foregroundStyle(Color.accentColor)
                        stepView(ses.steps[ses.stepIndex])
                        if let m = message { Text(m).foregroundStyle(.red).font(.footnote) }
                        Text("A feladás nem sorsol könnyebb feladatot: egy órán belül ugyanezeket a próbatípusokat kapod vissza, csak friss tartalommal.")
                            .font(.caption).foregroundStyle(.secondary)
                    } else {
                        Text("Nincs aktív lépés.")
                    }
                }.padding()
            }
            .navigationTitle(titleText)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Feladom") { Referee.abandon(sessionId: session.id); dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Vissza") { dismiss() }
                }
            }
        }
        .onReceive(timer) { _ in now = nowMs() }
    }

    @ViewBuilder
    private func stepView(_ step: ChallengeEngine.Step) -> some View {
        // .id(step.id) resets each step view's local @State when the referee
        // regenerates a step after a wrong answer (new id -> fresh view).
        switch step {
        case .transcribe(let id, let text):
            TranscribeView(text: text) { submit($0) }.id(id)
        case .mathChain(let id, let problems, let pos):
            MathView(id: id, problem: problems[pos], index: pos) { submit($0) }
        case .memory(let id, let code, let showMs, let waitMs, let armedAt):
            MemoryView(code: code, showMs: showMs, waitMs: waitMs, armedAt: armedAt, now: now) { submit($0) }
                .id(id)
        case .reverse(let id, let text):
            ReverseView(text: text) { submit($0) }.id(id)
        case .delay(_, let minutes, let claimableAt, let window):
            DelayView(minutes: minutes, claimableAt: claimableAt, windowMs: window, now: now) { claim() }
        case .partner(let id, let name):
            PartnerView(name: name) { submit($0) }.id(id)
        }
    }

    private func submit(_ answer: String) {
        do {
            let r = try Referee.submitAnswer(sessionId: session.id, answer: answer, now: nowMs())
            message = r.message
            if r.sessionDone { dismiss(); onSuccess(doneText) }
        } catch let e as Referee.RefereeError {
            // Az ötödik rossz jelmondat a kísérletet viszi el: a lap bezárul, az
            // ok a hívóé — a bezárt lapon senki nem olvasná el.
            if e.code == "PARTNER_TRIES" { dismiss(); onDropped?(e.message) } else { message = e.message }
        } catch { message = "\(error)" }
    }

    private func claim() {
        do {
            let r = try Referee.claimDelay(sessionId: session.id, now: nowMs())
            message = r.message
            if r.sessionDone { dismiss(); onSuccess(doneText) }
        } catch let e as Referee.RefereeError {
            message = e.message; dismiss(); onDropped?(e.message)
        } catch { message = "\(error)" }
    }
}

// MARK: - step views

private struct TranscribeView: View {
    let text: String
    let onSubmit: (String) -> Void
    @State private var input = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Gépeld át pontosan az alábbi szöveget").font(.headline)
            Text("Karakterre pontosan: kis-/nagybetű, írásjelek, számok.")
                .font(.footnote).foregroundStyle(.secondary)
            Text(text).padding().background(BreakerStyle.surfaceNested, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
                .textSelection(.disabled)
            TextEditor(text: $input).frame(height: 150)
                .overlay(RoundedRectangle(cornerRadius: 11, style: .continuous).strokeBorder(BreakerStyle.hairline))
                .disableAutocorrection(true)
            let prefixOK = text.hasPrefix(input)
            Text(input.isEmpty ? " "
                 : prefixOK ? "Eddig hibátlan (\(input.count)/\(text.count))"
                 : "Van eltérés — nézd át.")
                .font(.footnote)
                .foregroundStyle(input.isEmpty ? Color.secondary : (prefixOK ? Color.green : Color.red))
            Button("Kész, ellenőrzés") { onSubmit(input) }.buttonStyle(.borderedProminent)
        }
    }
}

private struct MathView: View {
    let id: String; let problem: ChallengeEngine.Problem
    /// Csak a nézet azonosításához kell (új feladatnál friss mező) — a lánc
    /// hosszát szándékosan nem kapja meg, nehogy kiírható legyen.
    let index: Int
    let onSubmit: (String) -> Void
    @State private var input = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            // A lánc hossza sem megy ki — ugyanaz a lendület, mint a hátralévő lépések száma.
            Text("Fejszámolás-lánc").font(.headline)
            Text("Hibás válasznál a teljes lánc elölről indul, új feladatokkal.")
                .font(.footnote).foregroundStyle(.secondary)
            Text("\(problem.q) = ?")
                .font(.title2).frame(maxWidth: .infinity).padding()
                .background(BreakerStyle.surfaceNested, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
            TextField("Eredmény", text: $input)
                .textFieldStyle(.roundedBorder)
                #if os(iOS)
                .keyboardType(.numbersAndPunctuation)
                #endif
            Button("Ellenőrzés") { onSubmit(input); input = "" }.buttonStyle(.borderedProminent)
        }
        .id(id + "\(index)")
    }
}

private struct MemoryView: View {
    let code: String; let showMs: Int; let waitMs: Int
    /// server-armed timestamp: leaving and re-entering does NOT restart the show phase
    let armedAt: Double?
    let now: Double
    let onSubmit: (String) -> Void
    @State private var input = ""

    var body: some View {
        let armed = armedAt ?? now
        let showEnd = armed + Double(showMs)
        let waitEnd = showEnd + Double(waitMs)
        return VStack(alignment: .leading, spacing: 8) {
            Text("Memória-próba").font(.headline)
            if now < showEnd {
                Text("Jegyezd meg a kódot! Hamarosan végleg eltűnik.").font(.footnote).foregroundStyle(.secondary)
                Text(code).font(.system(.largeTitle, design: .monospaced))
                    .kerning(6).frame(maxWidth: .infinity).padding()
                    .background(BreakerStyle.surfaceNested, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
                Text("Eltűnik: \(fmtRemain(showEnd - now))").frame(maxWidth: .infinity)
            } else if now < waitEnd {
                Text("Most várni kell — közben ne írd le sehova!").font(.footnote).foregroundStyle(.secondary)
                Text("Beírható: \(fmtRemain(waitEnd - now))").frame(maxWidth: .infinity)
            } else {
                Text("Írd be a kódot emlékezetből:").font(.footnote).foregroundStyle(.secondary)
                TextField("Kód", text: $input).textFieldStyle(.roundedBorder)
                    .disableAutocorrection(true)
                Button("Ellenőrzés") { onSubmit(input) }.buttonStyle(.borderedProminent)
            }
        }
    }
}

private struct ReverseView: View {
    let text: String
    let onSubmit: (String) -> Void
    @State private var input = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Gépeld be visszafelé").font(.headline)
            Text("A teljes mondatot fordítva, írásjelekkel együtt. Példa: „Kis fa.” → „.af siK”")
                .font(.footnote).foregroundStyle(.secondary)
            Text(text).padding().background(BreakerStyle.surfaceNested, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
            TextField("Visszafelé", text: $input).textFieldStyle(.roundedBorder)
                .disableAutocorrection(true)
            Button("Ellenőrzés") { onSubmit(input) }.buttonStyle(.borderedProminent)
        }
    }
}

/// A megbízott lépése: a jelmondatot Ő írja be. Nincs beillesztés-őr, mint a
/// gépelős próbáknál — a jelmondat nem gyakorlat, hanem másvalaki döntése.
private struct PartnerView: View {
    let name: String
    let onSubmit: (String) -> Void
    @State private var input = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Utolsó lépés: \(name) jelmondata").font(.headline)
            Text("Kérd meg a megbízottadat (\(name)), hogy ő írja be a jelmondatát — ez az ő döntése is. Ha a jelmondat nálad van, a párban zárolás csak egy jelszó. Ötször rossz jelmondat után a kísérlet elölről kezdődik, minden lépéssel.")
                .font(.footnote).foregroundStyle(.secondary)
            SecureField("a jelmondat (négy szó)", text: $input)
                .textFieldStyle(.roundedBorder)
                .disableAutocorrection(true)
            Button("Ellenőrzés") { onSubmit(input); input = "" }.buttonStyle(.borderedProminent)
        }
    }
}

private struct DelayView: View {
    let minutes: Int; let claimableAt: Double?; let windowMs: Int; let now: Double
    let onClaim: () -> Void

    var body: some View {
        let at = claimableAt ?? .infinity
        let inWindow = now >= at && now <= at + Double(windowMs)
        return VStack(alignment: .leading, spacing: 8) {
            Text("Kötelező várakozás: \(minutes) perc").font(.headline)
            Text("A visszaszámlálás akkor is megy, ha kilépsz. Amikor lejár, 10 perced van átvenni a feloldást — ha lecsúszol róla, elölről kezdődik.")
                .font(.footnote).foregroundStyle(.secondary)
            Text(now < at ? "Átvehető: \(fmtRemain(at - now)) múlva"
                 : inWindow ? "Átvehető még: \(fmtRemain(at + Double(windowMs) - now))"
                 : "Az átvételi ablak lejárt.")
                .font(.title3).frame(maxWidth: .infinity)
            Button("Feloldás átvétele") { onClaim() }
                .buttonStyle(.borderedProminent).disabled(!inWindow)
        }
    }
}

private func fmtRemain(_ ms: Double) -> String {
    let total = Int(max(0, ceil(ms / 1000)))
    let h = total / 3600, m = (total % 3600) / 60, s = total % 60
    if h > 0 { return "\(h) ó \(String(format: "%02d", m)) p" }
    return "\(m):\(String(format: "%02d", s))"
}
