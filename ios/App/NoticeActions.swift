import Foundation
import UserNotifications

/// EGY KOPPINTÁS az értesítésről a menetig: az előjelzés értesítésének
/// „Munkamenet indítása” gombja a legutóbb használt csomagot indítja a
/// szokásos hosszával — ugyanaz az út, mint a kezdőlap kártyájáé. Nem old
/// fel semmit: a menet szigorítás, ingyen van. Futó menet mellett nem indít
/// (egyszerre egy fut); a gomb az appot is előhozza, hogy a koppintás
/// látszódjon.
final class NoticeActions: NSObject, UNUserNotificationCenterDelegate {
    static let shared = NoticeActions()
    static let category = "breaker.peak"
    static let startAction = "breaker.start"

    /// A kategória és a kezelő beállítása — az app indulásakor egyszer.
    func register() {
        let start = UNNotificationAction(identifier: Self.startAction, title: "Munkamenet indítása", options: [.foreground])
        let cat = UNNotificationCategory(identifier: Self.category, actions: [start], intentIdentifiers: [], options: [])
        let center = UNUserNotificationCenter.current()
        center.setNotificationCategories([cat])
        center.delegate = self
    }

    /// A javaslat indítása: a legutóbb használt csomag (napló nélkül az első),
    /// a szokásos hosszal. Futó menet mellett nem indít.
    static func startSuggested() {
        let store = BreakerStore.shared
        let now = Date().timeIntervalSince1970 * 1000
        guard store.runningFocus(now) == nil,
              let pick = Focus.lastUsedPack(store.state.focusPacks ?? [], log: store.state.focusLog ?? []) else { return }
        try? Referee.startFocus(packId: pick.id, minutes: pick.defaultMinutes, now: now)
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        if response.actionIdentifier == Self.startAction { Self.startSuggested() }
        completionHandler()
    }

    /// Előtérben is látszódjon az értesítés — különben a nyitott app csendben elnyelné.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter, willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }
}
