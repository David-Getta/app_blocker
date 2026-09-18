import Foundation
import UserNotifications

/// ELŐJELZÉS a menet-óra előtt: tíz perccel a négy hét menet-órája előtt szól
/// a rendszer — naponta, amíg a menet-óra áll. A csúcs-óra előjelzésének
/// (`PeakReminder`) tükre: az app ütemezi, amikor nyitva van, a menet-óra
/// változásakor átütemezi, menet-óra nélkül (vagy ha az a csúcs-óra — kétszer
/// ugyanazt nem) a kérést visszavonja. A tíz perc és a küszöb a magé
/// (`FilterHitLogic`), a gépével és az Androidéval azonos. Nem tilt, nem ítél.
enum FocusHourReminder {
    static let id = "focus:hour"

    /// A `canStart` a gomb: van-e csomag, amit a koppintás indíthat — üres ígéret helyett nincs gomb.
    static func reschedule(peak: (hour: Int, count: Int)?, canStart: Bool = false) {
        let center = UNUserNotificationCenter.current()
        guard let peak, peak.count >= FilterHitLogic.peakWarnMinCount else {
            center.removePendingNotificationRequests(withIdentifiers: [id])
            return
        }
        center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
            guard granted else { return }
            var when = DateComponents()
            // Tíz perccel a menet-óra előtt: az előző óra ötvenedik perce.
            when.hour = (peak.hour + 23) % 24
            when.minute = 60 - Int(FilterHitLogic.peakWarnLeadMs / 60_000)
            let content = UNMutableNotificationContent()
            content.title = "Mindjárt a menet-óra"
            content.body = Focus.hourWarnText(peak)
            content.sound = .default
            // EGY KOPPINTÁS az értesítésről a menetig: a gomb a legutóbbi csomagot indítja.
            if canStart { content.categoryIdentifier = NoticeActions.category }
            let trigger = UNCalendarNotificationTrigger(dateMatching: when, repeats: true)
            center.add(UNNotificationRequest(identifier: id, content: content, trigger: trigger))
        }
    }
}
