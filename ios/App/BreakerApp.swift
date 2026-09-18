import SwiftUI

@main
struct BreakerApp: App {
    @StateObject private var store = BreakerStore.shared
    @StateObject private var tunnel = TunnelController()

    init() {
        // EGY KOPPINTÁS az értesítésről a menetig: a gomb kezelője az indulástól él.
        NoticeActions.shared.register()
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(store)
                .environmentObject(tunnel)
        }
        #if os(macOS)
        .defaultSize(width: 720, height: 780)
        #endif
    }
}
