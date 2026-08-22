import Foundation
import Combine

struct Site: Codable, Identifiable, Equatable {
    let id: String
    let domain: String
    let hostnames: [String]
    let addedAt: Double
    var pauseUntil: Double?
    var pendingDeleteAt: Double?
    /// optional weekly schedule; nil = always blocked
    var schedule: ScheduleLogic.Schedule?
}

struct SessionRec: Codable, Equatable, Identifiable {
    let id: String
    let kind: ChallengeEngine.Kind
    let siteId: String
    let minutes: Int?
    var steps: [ChallengeEngine.Step]
    var stepIndex: Int
    let createdAt: Double
}

struct AppState: Codable, Equatable {
    var protectionOn: Bool = false
    var sites: [Site] = []
    var unlockLog: [Double] = []
    var lastCombo: String? = nil
    var session: SessionRec? = nil
}

/// Shared state persisted to a JSON file in the App Group container, so the
/// SwiftUI app and the Packet Tunnel extension read/write the same source of
/// truth. A file coordinator keeps cross-process writes atomic.
final class LakatStore: ObservableObject {

    static let appGroup = "group.hu.lakat.app"
    static let shared = LakatStore()

    @Published private(set) var state = AppState()

    private let fileURL: URL
    private let queue = DispatchQueue(label: "hu.lakat.store")
    private var source: DispatchSourceFileSystemObject?

    private init() {
        let container = FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: LakatStore.appGroup)
            ?? FileManager.default.temporaryDirectory
        fileURL = container.appendingPathComponent("state.json")
        load()
        watch()
    }

    func newId(_ prefix: String) -> String { "\(prefix)_\(UUID().uuidString.prefix(12))" }

    // MARK: - mutate

    @discardableResult
    func mutate(_ fn: (inout AppState) -> Void) -> AppState {
        queue.sync {
            var next = readFromDisk() ?? state
            fn(&next)
            writeToDisk(next)
            DispatchQueue.main.async { self.state = next }
            return next
        }
    }

    func reload() {
        if let disk = readFromDisk() {
            DispatchQueue.main.async { self.state = disk }
        }
    }

    /// hostnames that must be blocked right now (pause + schedule aware)
    func blockedHostnamesNow(_ now: Double) -> Set<String> {
        var out = Set<String>()
        for site in state.sites {
            if ScheduleLogic.isBlockedNow(pauseUntil: site.pauseUntil,
                                          pendingDeleteAt: site.pendingDeleteAt,
                                          schedule: site.schedule, now: now) {
                out.formUnion(site.hostnames)
            }
        }
        return out
    }

    // MARK: - persistence

    private func load() { if let disk = readFromDisk() { state = disk } }

    private func readFromDisk() -> AppState? {
        guard let data = try? Data(contentsOf: fileURL) else { return nil }
        return try? JSONDecoder().decode(AppState.self, from: data)
    }

    private func writeToDisk(_ s: AppState) {
        guard let data = try? JSONEncoder().encode(s) else { return }
        try? data.write(to: fileURL, options: .atomic)
    }

    private func watch() {
        // Refresh @Published state when the other process rewrites the file.
        // Atomic writes replace the inode, which kills a plain fd watch after
        // the first event — so on rename/delete we re-open and re-arm.
        if !FileManager.default.fileExists(atPath: fileURL.path) {
            writeToDisk(state)
        }
        armWatch()
    }

    private func armWatch() {
        source?.cancel()
        source = nil
        let fd = open(fileURL.path, O_EVTONLY)
        guard fd >= 0 else {
            // File momentarily missing mid-replace; retry shortly.
            queue.asyncAfter(deadline: .now() + 0.5) { [weak self] in self?.armWatch() }
            return
        }
        let src = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: fd, eventMask: [.write, .rename, .delete], queue: queue)
        src.setEventHandler { [weak self] in
            guard let self = self else { return }
            let events = src.data
            self.reload()
            if events.contains(.rename) || events.contains(.delete) {
                self.armWatch() // inode replaced -> follow the new file
            }
        }
        src.setCancelHandler { close(fd) }
        src.resume()
        source = src
    }
}

func nowMs() -> Double { Date().timeIntervalSince1970 * 1000 }
