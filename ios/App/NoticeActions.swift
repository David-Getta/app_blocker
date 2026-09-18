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
    /// EGY KOPPINTÁS az értesítésről az ablakig: a kategória az ablak gombjával is — ha az órára ablak tehető.
    static let categoryWithWindow = "breaker.peak.window"
    static let windowAction = "breaker.window"
    static let packIdKey = "packId"
    static let hourKey = "hour"

    /// A kategória és a kezelő beállítása — az app indulásakor egyszer.
    func register() {
        let start = UNNotificationAction(identifier: Self.startAction, title: "Munkamenet indítása", options: [.foreground])
        let window = UNNotificationAction(identifier: Self.windowAction, title: "Heti ablak erre az órára", options: [.foreground])
        let cat = UNNotificationCategory(identifier: Self.category, actions: [start], intentIdentifiers: [], options: [])
        let catWindow = UNNotificationCategory(identifier: Self.categoryWithWindow, actions: [start, window], intentIdentifiers: [], options: [])
        let center = UNUserNotificationCenter.current()
        center.setNotificationCategories([cat, catWindow])
        center.delegate = self
    }

    /// EGY KOPPINTÁS az ablakig: heti ablak a csomagra az óra egy órájában, minden
    /// napra — a bíró dönt, csak felvétel; ablakos csomagra nemet mond. Az óra és a
    /// csomag az értesítésé (a kérés adta), a sáv a magé.
    static func addWindow(userInfo: [AnyHashable: Any]) {
        guard let packId = userInfo[packIdKey] as? String, let hour = userInfo[hourKey] as? Int, (0...23).contains(hour) else { return }
        try? Referee.addFocusWindow(packId: packId, band: Focus.peakWindowBand(hour), now: Date().timeIntervalSince1970 * 1000)
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
        if response.actionIdentifier == Self.windowAction { Self.addWindow(userInfo: response.notification.request.content.userInfo) }
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
