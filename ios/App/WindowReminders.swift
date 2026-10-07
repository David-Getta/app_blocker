import Foundation
import UserNotifications

/// Heti emlékeztető minden zárlat-ablak kezdésére — és tíz perccel minden heti
/// ablakos munkamenet előtt. A rendszer ütemezi, tehát akkor is szól, ha az
/// app nincs nyitva, és a szűrő bővítménye nem adhatna.
///
/// Az ütemezett lista az ablakok és a csomagok listáját követi: az app minden
/// nyitásakor és a lista minden változásakor (a szinkronból jött változásnál
/// is, amíg az app nyitva van) újraírja. Őszinte határ: ami zárt app mellett,
/// a szűrő szinkronjával jön, az a következő megnyitáskor kerül be. A két
/// terv egy keretből él (a rendszer 64-es plafonja): a zárlat-ablaké az elsőbb,
/// a menetek előjelzése abból kap, ami marad (`Focus.windowReminderPlan`).
enum WindowReminders {
    /// Két egymás utáni ütemezés ne írja egymást felül félkészen: a régebbi
    /// csak akkor tesz fel kéréseket, ha közben nem jött újabb lista.
    private static var generation = 0

    static func reschedule(_ windows: [LockdownLogic.LockdownWindow], packs: [Focus.Pack]) {
        generation += 1
        let mine = generation
        let center = UNUserNotificationCenter.current()
        center.getPendingNotificationRequests { pending in
            DispatchQueue.main.async {
                guard mine == generation else { return }
                let old = pending.map(\.identifier).filter {
                    $0.hasPrefix(LockdownLogic.reminderIdPrefix) || $0.hasPrefix(Focus.windowReminderIdPrefix)
                }
                center.removePendingNotificationRequests(withIdentifiers: old)
                // A tervet a mag adja (és a tesztek nézik); itt csak rendszer-kérés lesz belőle.
                let lockPlan = LockdownLogic.reminderPlan(windows)
                let plan = lockPlan + Focus.windowReminderPlan(packs, used: lockPlan.count)
                guard !plan.isEmpty else { return }
                center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
                    DispatchQueue.main.async {
                        guard granted, mine == generation else { return }
                        for r in plan { center.add(request(r)) }
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
