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
                let old = pending.map(\.identifier).filter { $0.hasPrefix(LockdownLogic.reminderIdPrefix) }
                center.removePendingNotificationRequests(withIdentifiers: old)
                guard !windows.isEmpty else { return }
                center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
                    DispatchQueue.main.async {
                        guard granted, mine == generation else { return }
                        // A tervet a mag adja (és a tesztek nézik); itt csak rendszer-kérés lesz belőle.
                        for r in LockdownLogic.reminderPlan(windows) { center.add(request(r)) }
                    }
                }
            }
        }
    }

    private static func request(_ r: LockdownLogic.Reminder) -> UNNotificationRequest {
        var when = DateComponents()
        when.weekday = r.weekday // a Calendar 1-től számol, vasárnappal
        when.hour = r.hour
        when.minute = r.minute
        let content = UNMutableNotificationContent()
        content.title = r.title
        content.body = r.body
        content.sound = .default
        let trigger = UNCalendarNotificationTrigger(dateMatching: when, repeats: true)
        return UNNotificationRequest(identifier: r.id, content: content, trigger: trigger)
    }
}
