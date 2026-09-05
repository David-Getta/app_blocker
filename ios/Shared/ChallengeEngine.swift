import Foundation

/// Unlock challenge engine — 1:1 mirror of desktop/src/shared/challenges.ts.
/// See docs/challenge-spec.md for the behavioural contract.
enum ChallengeEngine {

    enum Kind: String, Codable { case pause = "PAUSE", delete = "DELETE" }

    enum Step: Codable, Equatable {
        case transcribe(id: String, text: String)
        case mathChain(id: String, problems: [Problem], pos: Int)
        case memory(id: String, code: String, showMs: Int, waitMs: Int, armedAt: Double?)
        case reverse(id: String, text: String)
        case delay(id: String, minutes: Int, claimableAt: Double?, claimWindowMs: Int)

        var id: String {
            switch self {
            case .transcribe(let id, _), .memory(let id, _, _, _, _),
                 .reverse(let id, _), .mathChain(let id, _, _), .delay(let id, _, _, _):
                return id
            }
        }

        /// The same vocabulary the combo keys use.
        var typeName: String {
            switch self {
            case .transcribe: return "TRANSCRIBE"
            case .mathChain: return "MATH_CHAIN"
            case .memory: return "MEMORY"
            case .reverse: return "REVERSE"
            case .delay: return "DELAY"
            }
        }
    }

    struct Problem: Codable, Equatable { let q: String; let a: Int }

    struct Outcome { let ok: Bool; let done: Bool; let step: Step; let message: String? }

    static let claimWindowMs = 10 * 60_000
    static let deletePendingMs = 24 * 3_600_000
    static let sessionMaxAgeMs = 6 * 3_600_000
    /// How long an abandoned attempt keeps its challenge types. Without it,
    /// cancelling was a free re-roll: one could restart until the easiest pair
    /// came up, and friction that can be re-rolled is not friction. Within the
    /// window the same PAIR returns — with fresh content, so nothing is banked.
    static let rerollCooldownMs: Double = 60 * 60_000
    static let pauseChoicesMin = [15, 30, 60]

    private static let transcribeChars = [300, 420, 560, 720]
    private static let mathLen = [3, 5, 7, 9]
    private static let mathFactorMax = [29, 39, 59, 79]
    private static let memoryLen = [8, 10, 12, 14]
    private static let memoryShowMs = [20_000, 18_000, 15_000, 12_000]
    private static let memoryWaitMs = [20_000, 30_000, 40_000, 60_000]
    private static let reverseWords = [4, 6, 8, 10]
    private static let pauseDelayMin = [(10, 20), (20, 40), (30, 60), (45, 90)]
    private static let deleteDelayMin = [(15, 30), (30, 50), (45, 80), (60, 120)]

    private static let words: [String] = (
        "alma bogrács cinege délután erdő füzet gomba határ időjárás jégvirág kanál lámpa " +
        "macska nyár ösvény patak róka sündisznó tenger utazás vándor zászló asztal bicikli " +
        "csillag dallam egér felhő gyertya hajnal iskola játék kavics levél mező napraforgó " +
        "óra pillangó rigó sétány tavasz udvar vonat zongora ablak barlang cipő dombtető " +
        "este fenyő galamb hegység irány kapu liget malom nádas orgona páfrány rönk sátor " +
        "tücsök uszoda vihar zápor bálna cseresznye dinnye eper fahéj gesztenye hínár ibolya " +
        "kagyló lekvár mandula naspolya olajbogyó paprika ribizli szilva tökmag uborka " +
        "vadkörte zeller bagoly csuka delfin egérke fóka gepárd hiúz jaguár kenguru lajhár " +
        "medve nyest orrszarvú pele rozmár sakál teve ürge vidra zebra híd torony kastély " +
        "kikötő könyvtár műhely óváros piactér raktár színház tetőtér várfal zsilip csónak " +
        "ekevas fűrész gereblye horgony iránytű kalapács létra metsző olló reszelő szögmérő " +
        "talicska vödör aranyos borongós csendes derűs egyszerű fényes gyors hűvös illatos " +
        "kerek lassú meleg nyugodt okos pontos ritka sima tiszta vidám zöldes hosszú keskeny " +
        "magas mély széles apró hatalmas kicsi óriási törékeny erős fürge"
    ).split(separator: " ").map(String.init)

    private static let codeAlphabet = Array("ABCDEFGHJKMNPQRSTUVWXYZ23456789")
    private static var seq = 0

    // MARK: - RNG (crypto-quality via SystemRandomNumberGenerator)

    private static func rndInt(_ minIncl: Int, _ maxIncl: Int) -> Int {
        Int.random(in: minIncl...maxIncl)
    }

    private static func stepId() -> String {
        seq = (seq + 1) % 1_000_000
        let ts = String(Int(Date().timeIntervalSince1970 * 1000), radix: 36)
        return "st_\(ts)_\(seq)_\(Int.random(in: 0..<0xFFFFFF))"
    }

    /// Hány napja volt az utolsó feloldás — vagy nil, ha még egy sem volt.
    /// NAPTÁRI napokban, nem huszonnégy órás egységekben: a tegnap esti
    /// feloldás „tegnap”, akkor is, ha tíz órája volt. A `digest.ts` tükre.
    static func daysSinceUnlock(_ unlockLog: [Double], now: Double) -> Int? {
        guard let last = unlockLog.max() else { return nil }
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone.current
        let today = cal.startOfDay(for: Date(timeIntervalSince1970: now / 1000))
        let then = cal.startOfDay(for: Date(timeIntervalSince1970: last / 1000))
        return max(0, Int((today.timeIntervalSince(then) / 86_400).rounded()))
    }

    static func computeTier(_ unlockLog: [Double], now: Double) -> Int {
        let weekAgo = now - 7 * 24 * 3_600_000
        let n = unlockLog.filter { $0 >= weekAgo && $0 <= now }.count
        switch n {
        case 0...1: return 0
        case 2...3: return 1
        case 4...6: return 2
        default: return 3
        }
    }

    static func makeSentence(_ wordCount: Int) -> String {
        var parts: [String] = []
        for i in 0..<wordCount {
            var w = words.randomElement()!
            if i == 0 { w = w.prefix(1).uppercased() + w.dropFirst() }
            else if rndInt(1, 100) <= 12 { w = w.uppercased() }
            if i > 0 && i < wordCount - 1 && rndInt(1, 100) <= 18 { w += "," }
            parts.append(w)
        }
        if rndInt(1, 100) <= 25 { parts.append(String(rndInt(10, 9999))) }
        let punct = [".", ".", ".", "!", "?"]
        return parts.joined(separator: " ") + punct.randomElement()!
    }

    private static func makeTranscription(_ targetChars: Int) -> String {
        var out = ""
        while out.count < targetChars {
            if !out.isEmpty { out += " " }
            out += makeSentence(rndInt(5, 9))
        }
        return out
    }

    private static func makeCode(_ len: Int) -> String {
        String((0..<len).map { _ in codeAlphabet.randomElement()! })
    }

    private static func makeMathProblem(_ factorMax: Int) -> Problem {
        switch rndInt(0, 2) {
        case 0:
            let a = rndInt(12, factorMax), b = rndInt(12, factorMax), c = rndInt(100, 999)
            return Problem(q: "\(a) × \(b) + \(c)", a: a * b + c)
        case 1:
            let a = rndInt(12, factorMax), b = rndInt(12, factorMax), c = rndInt(100, 999)
            return Problem(q: "\(a) × \(b) − \(c)", a: a * b - c)
        default:
            let a = rndInt(23, factorMax + 40), b = rndInt(23, factorMax + 40), c = rndInt(3, 9)
            return Problem(q: "(\(a) + \(b)) × \(c)", a: (a + b) * c)
        }
    }

    static func makeStep(_ type: String, tier: Int, kind: Kind) -> Step {
        let t = max(0, min(3, tier))
        switch type {
        case "TRANSCRIBE":
            return .transcribe(id: stepId(), text: makeTranscription(transcribeChars[t]))
        case "MATH_CHAIN":
            let problems = (0..<mathLen[t]).map { _ in makeMathProblem(mathFactorMax[t]) }
            return .mathChain(id: stepId(), problems: problems, pos: 0)
        case "MEMORY":
            return .memory(id: stepId(), code: makeCode(memoryLen[t]),
                           showMs: memoryShowMs[t], waitMs: memoryWaitMs[t], armedAt: nil)
        case "REVERSE":
            return .reverse(id: stepId(), text: makeSentence(reverseWords[t]))
        case "DELAY":
            let band = (kind == .delete ? deleteDelayMin : pauseDelayMin)[t]
            return .delay(id: stepId(), minutes: rndInt(band.0, band.1),
                          claimableAt: nil, claimWindowMs: claimWindowMs)
        default:
            fatalError("unknown step type \(type)")
        }
    }

    struct Plan { let steps: [Step]; let comboKey: String }

    private static let activePool = ["TRANSCRIBE", "MATH_CHAIN", "MEMORY", "REVERSE"]

    static func comboKeyOf(_ types: [String]) -> String { types.sorted().joined(separator: "+") }

    /// A combo key back into its two challenge types, or nil if this build
    /// cannot serve it (unknown name, wrong arity). Nil means "draw a fresh
    /// plan", never "serve something broken".
    static func parseCombo(_ key: String?) -> [String]? {
        guard let key = key, !key.isEmpty else { return nil }
        let parts = key.components(separatedBy: "+")
        guard parts.count == 2, parts[0] != parts[1] else { return nil }
        guard parts.allSatisfy({ activePool.contains($0) }) else { return nil }
        return parts
    }

    static func generatePlan(kind: Kind, tier: Int, lastCombo: String?, forceCombo: String? = nil) -> Plan {
        var types: [String]? = parseCombo(forceCombo)
        while types == nil {
            let draw = Array(activePool.shuffled().prefix(2))
            if lastCombo == nil || comboKeyOf(draw) != lastCombo { types = draw }
        }
        let chosen = types!
        var steps = chosen.map { makeStep($0, tier: tier, kind: kind) }
        if tier >= 2 || kind == .delete { steps.append(makeStep("DELAY", tier: tier, kind: kind)) }
        return Plan(steps: steps, comboKey: comboKeyOf(chosen))
    }

    static func reverse(_ s: String) -> String { String(s.reversed()) }

    static func applyAnswer(_ step: Step, answer: String, tier: Int, kind: Kind, now: Double) -> Outcome {
        switch step {
        case .transcribe(_, let text):
            if answer == text { return Outcome(ok: true, done: true, step: step, message: nil) }
            return Outcome(ok: false, done: false, step: step,
                message: "Nem egyezik karakterre pontosan. Ellenőrizd az írásjeleket és a kis-/nagybetűket.")

        case .mathChain(let id, let problems, let pos):
            let expected = problems[pos].a
            let cleaned = answer.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: " ", with: "")
            if let given = Int(cleaned), given == expected {
                let next = Step.mathChain(id: id, problems: problems, pos: pos + 1)
                if pos + 1 >= problems.count { return Outcome(ok: true, done: true, step: next, message: nil) }
                return Outcome(ok: true, done: false, step: next, message: nil)
            }
            return Outcome(ok: false, done: false, step: makeStep("MATH_CHAIN", tier: tier, kind: kind),
                message: "Hibás eredmény — a lánc elölről indul, új feladatokkal.")

        case .memory(_, let code, let showMs, let waitMs, let armedAt):
            // Timing is server-authoritative: no answer is accepted before the
            // memorize + forced-wait window has fully elapsed.
            if armedAt == nil || now < armedAt! + Double(showMs + waitMs) {
                return Outcome(ok: false, done: false, step: step,
                    message: "Még tart a memorizálás vagy a várakozás — a kivárást nem lehet megúszni.")
            }
            if answer.trimmingCharacters(in: .whitespaces).uppercased() == code {
                return Outcome(ok: true, done: true, step: step, message: nil)
            }
            return Outcome(ok: false, done: false, step: makeStep("MEMORY", tier: tier, kind: kind),
                message: "Nem ez volt a kód. Új kódot kapsz.")

        case .reverse(_, let text):
            if answer == reverse(text) { return Outcome(ok: true, done: true, step: step, message: nil) }
            return Outcome(ok: false, done: false, step: makeStep("REVERSE", tier: tier, kind: kind),
                message: "Nem pontos a visszafelé gépelés. Új mondatot kapsz.")

        case .delay:
            return Outcome(ok: false, done: false, step: step,
                message: "Ez egy várakozási lépés — itt nincs beírható válasz.")
        }
    }
}
