import SwiftUI

@main
struct LakatApp: App {
    @StateObject private var store = LakatStore.shared
    @StateObject private var tunnel = TunnelController()

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
