import SwiftUI

/// Weekly schedule editor. Mirrors the desktop editor: tightening applies
/// immediately, loosening returns a challenge session id to open.
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

    @State private var mode: ScheduleLogic.Mode
    @State private var selected: Set<String>

    init(site: Site, onResult: @escaping (Result) -> Void) {
        self.site = site
        self.onResult = onResult
        _mode = State(initialValue: site.schedule?.mode ?? .always)
        var initial = Set<String>()
        let bands = site.schedule?.bands ?? []
        for p in Self.presets where bands.contains(p.band) { initial.insert(p.key) }
        _selected = State(initialValue: initial)
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
                        ForEach(Self.presets, id: \.key) { p in
                            Toggle(p.label, isOn: Binding(
                                get: { selected.contains(p.key) },
                                set: { on in if on { selected.insert(p.key) } else { selected.remove(p.key) } }
                            ))
                        }
                    }
                }
            }
            .navigationTitle("Menetrend: \(site.domain)")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Mégse") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Alkalmaz") { apply() } }
            }
        }
    }

    private func apply() {
        let bands = mode == .always ? []
            : Self.presets.filter { selected.contains($0.key) }.map { $0.band }
        if mode != .always && bands.isEmpty {
            onResult(.error("Válassz legalább egy sávot, vagy a „Mindig tiltva” módot.")); return
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
