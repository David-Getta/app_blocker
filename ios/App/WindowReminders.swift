import Foundation
import UserNotifications

/// Heti emlékeztető minden zárlat-ablak kezdésére — a rendszer ütemezi, tehát
/// akkor is szól, ha az app nincs nyitva, és a szűrő bővítménye nem adhatna.
///
/// Az ütemezett lista az ablakok listáját követi: az app minden nyitásakor és
/// a lista minden változásakor (a szinkronból jött változásnál is, amíg az
/// app nyitva van) újraírja. Őszinte határ: ami zárt app mellett, a szűrő
/// szinkronjával jön, az a következő megnyitáskor kerül be. Ablakonként és
/// naponként egy kérés — legfeljebb 7 × 7, a rendszer 64-es plafonja alatt.
enum WindowReminders {
    private static let prefix = "lockdown-window:"
    /// Két egymás utáni ütemezés ne írja egymást felül félkészen: a régebbi
    /// csak akkor tesz fel kéréseket, ha közben nem jött újabb lista.
    private static var generation = 0

    static func reschedule(_ windows: [LockdownLogic.LockdownWindow]) {
        generation += 1
        let mine = generation
        let center = UNUserNotificationCenter.current()
        center.getPendingNotificationRequests { pending in
            DispatchQueue.main.async {
                guard mine == generation else { return }
                let old = pending.map(\.identifier).filter { $0.hasPrefix(prefix) }
                center.removePendingNotificationRequests(withIdentifiers: old)
                guard !windows.isEmpty else { return }
                center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
                    DispatchQueue.main.async {
                        guard granted, mine == generation else { return }
                        for w in windows { for day in w.days { center.add(request(w, day)) } }
                    }
                }
            }
        }
    }

    private static func request(_ w: LockdownLogic.LockdownWindow, _ day: Int) -> UNNotificationRequest {
        var when = DateComponents()
        when.weekday = day + 1 // a Calendar 1-től számol, vasárnappal
        when.hour = w.startMin / 60
        when.minute = w.startMin % 60
        let minutes = (w.endMin - w.startMin + 1440) % 1440
        let content = UNMutableNotificationContent()
        content.title = "Zárlat a heti ablak szerint"
        content.body = "Beért a heti ablak: még \(LockdownLogic.formatRemaining(Double(minutes == 0 ? 1440 : minutes) * 60_000)) "
            + "(eddig: \(clock(w.endMin))). Amíg tart, semmilyen lazítás nem indítható — próbatétellel sem."
        content.sound = .default
        let trigger = UNCalendarNotificationTrigger(dateMatching: when, repeats: true)
        return UNNotificationRequest(identifier: "\(prefix)\(w.id):\(day)", content: content, trigger: trigger)
    }

    private static func clock(_ min: Int) -> String {
        String(format: "%02d:%02d", (min % 1440) / 60, min % 60)
    }
}
