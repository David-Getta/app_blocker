import SwiftUI

/// Weekly schedule editor. Mirrors the desktop editor: tightening applies
/// immediately, loosening returns a challenge session id to open.
///
/// A SÁVOK EGY LISTÁBAN, mint a gépen: elöl a mostaniak — a saját sávok is,
/// nem csak a sablonok —, utánuk a még fel nem vett sablonok, mindegyik egy
/// kapcsolóval. Eddig a szerkesztő csak a sablonokat ismerte: egy nem sablon
/// sávot (a gépről, a szinkronon át) az „Alkalmaz” csendben eldobott.
struct ScheduleEditor: View {
    let site: Site
    let onResult: (Result) -> Void

    enum Result { case applied, challenge(String), error(String) }

    @Environment(\.dismiss) private var dismiss

    // Preset bands (0=Sunday..6=Saturday), matching desktop PRESET_BANDS.
    private static let presets: [(label: String, key: String, band: ScheduleLogic.Band)] = [
        ("Munkaidő (H–P 9–17)", "workHours", .init(days: [1, 2, 3, 4, 5], startMin: 9 * 60, endMin: 17 * 60)),
        ("Esti lekapcsolás (22–06)", "evening", .init(days: [0, 1, 2, 3, 4, 5, 6], startMin: 22 * 60, endMin: 6 * 60)),
        ("Hétvége (Szo–V egész nap)", "weekend", .init(days: [0, 6], startMin: 0, endMin: 1440)),
    ]

    /// A szerkesztő egy sora: a sáv és a felirata (sablonnév, vagy a sáv maga).
    private struct Row {
        let label: String
        let band: ScheduleLogic.Band
    }

    private let rows: [Row]
    @State private var mode: ScheduleLogic.Mode
    @State private var checked: [Bool]
    // SAJÁT SÁV: napok és két időpont — ugyanaz, mint a heti ablaknál. Nap
    // nélkül nem számít, így a választók alapértéke nem kerül be magától.
    @State private var customDays = Set<Int>()
    @State private var customStart: Date
    @State private var customEnd: Date
    private let dayNames = ["V", "H", "K", "Sze", "Cs", "P", "Szo"]

    init(site: Site, onResult: @escaping (Result) -> Void) {
        self.site = site
        self.onResult = onResult
        _mode = State(initialValue: site.schedule?.mode ?? .always)
        var out: [Row] = []
        var seen = Set<String>()
        let current: [ScheduleLogic.Band] = site.schedule.map { $0.mode == .always ? [] : $0.bands } ?? []
        for b in current {
            let key = LockdownLogic.windowKey(b)
            if seen.contains(key) { continue }
            seen.insert(key)
            let preset = Self.presets.first { LockdownLogic.windowKey($0.band) == key }
            out.append(Row(label: preset?.label ?? recurrenceLabel(b), band: b))
        }
        let nowOn = out.count
        for p in Self.presets {
            let key = LockdownLogic.windowKey(p.band)
            if seen.contains(key) { continue }
            seen.insert(key)
            out.append(Row(label: p.label, band: p.band))
        }
        rows = out
        _checked = State(initialValue: out.indices.map { $0 < nowOn })
        _customStart = State(initialValue: Self.clock(9 * 60))
        _customEnd = State(initialValue: Self.clock(17 * 60))
    }

    /// Perc-a-napban → a választó dátuma; az 1440 (éjfél mint vég) 00:00.
    private static func clock(_ min: Int) -> Date {
        Calendar.current.date(from: DateComponents(hour: (min % 1440) / 60, minute: min % 60)) ?? Date()
    }

    private func minutes(_ date: Date) -> Int {
        let c = Calendar.current.dateComponents([.hour, .minute], from: date)
        return (c.hour ?? 0) * 60 + (c.minute ?? 0)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Szigorítani (több tiltott idő) azonnal megy. Lazítani ugyanúgy próbatételekbe kerül, mint egy feloldás.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                Section("Mód") {
                    Picker("Mód", selection: $mode) {
                        Text("Mindig tiltva").tag(ScheduleLogic.Mode.always)
                        Text("Sávokban tiltva").tag(ScheduleLogic.Mode.block)
                        Text("Sávokban szabad").tag(ScheduleLogic.Mode.allow)
                    }.pickerStyle(.inline)
                }
                if mode != .always {
                    Section("Sávok") {
                        ForEach(rows.indices, id: \.self) { i in
                            Toggle(rows[i].label, isOn: $checked[i])
                        }
                    }
                    Section("Saját sáv") {
                        HStack(spacing: 6) {
                            ForEach([1, 2, 3, 4, 5, 6, 0], id: \.self) { d in
                                Button(dayNames[d]) {
                                    if customDays.contains(d) { customDays.remove(d) } else { customDays.insert(d) }
                                }
                                .buttonStyle(.bordered)
                                .tint(customDays.contains(d) ? Color.accentColor : Color.secondary)
                                // A kiválasztás ne csak színből derüljön ki: a VoiceOver a teljes
                                // napot mondja, és hogy ki van-e jelölve; hangvezérléssel a látható
                                // rövidítés („Sze”) is megnyomja.
                                .accessibilityLabel(FilterHitLogic.weekdayNames[d])
                                .accessibilityInputLabels([dayNames[d], FilterHitLogic.weekdayNames[d]])
                                .accessibilityAddTraits(customDays.contains(d) ? .isSelected : [])
                            }
                        }
                        DatePicker("Kezdés", selection: $customStart, displayedComponents: .hourAndMinute)
                        DatePicker("Vég", selection: $customEnd, displayedComponents: .hourAndMinute)
                        Text("A nap kijelölése nélkül a saját sáv nem számít.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle("Menetrend: \(AliasLogic.displayName(site))")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Mégse") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Alkalmaz") { apply() } }
            }
        }
    }

    private func apply() {
        var bands: [ScheduleLogic.Band] = []
        if mode != .always {
            for (i, row) in rows.enumerated() where checked[i] { bands.append(row.band) }
            if !customDays.isEmpty {
                // A „00:00” végként az éjfél: a sáv 1440-nel írja le, nem nullával.
                let end = minutes(customEnd)
                let band = ScheduleLogic.Band(
                    days: customDays.sorted(), startMin: minutes(customStart), endMin: end == 0 ? 1440 : end)
                let key = LockdownLogic.windowKey(band)
                if !bands.contains(where: { LockdownLogic.windowKey($0) == key }) { bands.append(band) }
            }
            if bands.isEmpty {
                onResult(.error("Válassz legalább egy sávot, adj meg sajátot, vagy a „Mindig tiltva” módot.")); return
            }
        }
        do {
            let r = try Referee.startScheduleChange(
                siteId: site.id, schedule: ScheduleLogic.Schedule(mode: mode, bands: bands), now: nowMs())
            onResult(r.applied ? .applied : .challenge(r.session?.id ?? ""))
        } catch let e as Referee.RefereeError {
            onResult(.error(e.message))
        } catch {
            onResult(.error("\(error)"))
        }
    }
}
