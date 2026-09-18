import Foundation
import UserNotifications

/// ELŐJELZÉS a csúcs-óra előtt: tíz perccel a hét csúcs-órája előtt szól a
/// rendszer — naponta, amíg a csúcs áll. A tunnel nem értesít, ezért az app
/// ütemezi, amikor nyitva van, és a csúcs változásakor átütemezi (ugyanaz az
/// azonosító: a régi kérés kiesik). Ha nincs csúcs, a kérést visszavonja.
/// Tükör időzítéssel: ilyenkor jár a kéz magától. Nem tilt, nem ítél. A tíz
/// perc és a küszöb a magé (`FilterHitLogic`), a gépével és az Androidéval
/// azonos.
enum PeakReminder {
    static let id = "hits:peak"

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
            // Tíz perccel a csúcs-óra előtt: az előző óra ötvenedik perce.
            when.hour = (peak.hour + 23) % 24
            when.minute = 60 - Int(FilterHitLogic.peakWarnLeadMs / 60_000)
            let content = UNMutableNotificationContent()
            content.title = "Mindjárt a csúcs-óra"
            content.body = FilterHitLogic.peakWarnText(peak)
            content.sound = .default
            // EGY KOPPINTÁS az értesítésről a menetig: a gomb a legutóbbi csomagot indítja.
            if canStart { content.categoryIdentifier = NoticeActions.category }
            let trigger = UNCalendarNotificationTrigger(dateMatching: when, repeats: true)
            center.add(UNNotificationRequest(identifier: id, content: content, trigger: trigger))
        }
    }
}
