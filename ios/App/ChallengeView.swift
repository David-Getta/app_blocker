import SwiftUI

/// Renders the current step of an unlock/delete session. Validation happens in
/// Referee (shared core); this view only displays and forwards answers.
struct ChallengeView: View {
    let session: SessionRec
    let onSuccess: (String) -> Void

    @EnvironmentObject var store: LakatStore
    @Environment(\.dismiss) private var dismiss
    @State private var message: String?
    @State private var now = nowMs()
    private let timer = Timer.publish(every: 0.5, on: .main, in: .common).autoconnect()

    private var live: SessionRec? { store.state.session?.id == session.id ? store.state.session : nil }

    private var doneText: String {
        session.kind == .delete
            ? "Kész. A törlés 24 óra múlva válik véglegessé — addig visszavonhatod."
            : "Sikerült! Az oldal \(session.minutes ?? 0) percre elérhető, utána magától visszazár."
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if let ses = live, ses.stepIndex < ses.steps.count {
                        Text("\(ses.stepIndex + 1)/\(ses.steps.count). próba")
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
            .navigationTitle(session.kind == .delete ? "Végleges törlés" : "Feloldás \(session.minutes ?? 0) p")
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
            MathView(id: id, problem: problems[pos], index: pos, total: problems.count) { submit($0) }
        case .memory(let id, let code, let showMs, let waitMs, let armedAt):
            MemoryView(code: code, showMs: showMs, waitMs: waitMs, armedAt: armedAt, now: now) { submit($0) }
                .id(id)
        case .reverse(let id, let text):
            ReverseView(text: text) { submit($0) }.id(id)
        case .delay(_, let minutes, let claimableAt, let window):
            DelayView(minutes: minutes, claimableAt: claimableAt, windowMs: window, now: now) { claim() }
        }
    }

    private func submit(_ answer: String) {
        do {
            let r = try Referee.submitAnswer(sessionId: session.id, answer: answer, now: nowMs())
            message = r.message
            if r.sessionDone { dismiss(); onSuccess(doneText) }
        } catch let e as Referee.RefereeError { message = e.message } catch { message = "\(error)" }
    }

    private func claim() {
        do {
            let r = try Referee.claimDelay(sessionId: session.id, now: nowMs())
            message = r.message
            if r.sessionDone { dismiss(); onSuccess(doneText) }
        } catch let e as Referee.RefereeError { message = e.message; dismiss() } catch { message = "\(error)" }
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
            Text(text).padding().background(Color.gray.opacity(0.15)).cornerRadius(8)
                .textSelection(.disabled)
            TextEditor(text: $input).frame(height: 150)
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.gray.opacity(0.4)))
                .disableAutocorrection(true)
            let prefixOK = text.hasPrefix(input)
            Text(input.isEmpty ? " "
                 : prefixOK ? "Eddig hibátlan (\(input.count)/\(text.count))"
                 : "Van eltérés — nézd át.")
                .font(.footnote)
                .foregroundStyle(input.isEmpty ? .secondary : (prefixOK ? .green : .red))
            Button("Kész, ellenőrzés") { onSubmit(input) }.buttonStyle(.borderedProminent)
        }
    }
}

private struct MathView: View {
    let id: String; let problem: ChallengeEngine.Problem; let index: Int; let total: Int
    let onSubmit: (String) -> Void
    @State private var input = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Fejszámolás-lánc — \(index + 1)/\(total). feladat").font(.headline)
            Text("Hibás válasznál a teljes lánc elölről indul, új feladatokkal.")
                .font(.footnote).foregroundStyle(.secondary)
            Text("\(problem.q) = ?")
                .font(.title2).frame(maxWidth: .infinity).padding()
                .background(Color.gray.opacity(0.15)).cornerRadius(8)
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
                    .background(Color.gray.opacity(0.15)).cornerRadius(8)
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
            Text(text).padding().background(Color.gray.opacity(0.15)).cornerRadius(8)
            TextField("Visszafelé", text: $input).textFieldStyle(.roundedBorder)
                .disableAutocorrection(true)
            Button("Ellenőrzés") { onSubmit(input) }.buttonStyle(.borderedProminent)
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
