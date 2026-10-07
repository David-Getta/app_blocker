import Foundation
import UserNotifications

/// A szünet vége előre — iPhone-on ELŐRE ütemezve: az app nem fut a háttérben,
/// tehát a vége előtt két perccel nem tud „észrevenni” semmit; a rendszer
/// viszont az ütemezett helyi értesítést akkor is kiadja, ha az app zárva van.
///
/// A terv a magé (`PauseNotify.plan`, tesztekkel); itt csak rendszer-kérés lesz
/// belőle. A kérések a szünetek listáját követik: a főképernyő minden körében
/// összeveti, és ha változott (új feloldás, visszakapcsolás, lejárat), újraírja.
/// Őszinte határ: a szinkronból jött szünet (egy másik eszközön megváltott
/// feloldás) csak akkor kerül be, amikor az app legközelebb nyitva van.
enum PauseReminders {
    /// Két egymás utáni ütemezés ne írja egymást felül félkészen: a régebbi
    /// csak akkor tesz fel kéréseket, ha közben nem jött újabb lista.
    private static var generation = 0

    static func reschedule(_ views: [PauseNotify.View], now: Double) {
        generation += 1
        let mine = generation
        let plan = PauseNotify.plan(views, now: now)
        let center = UNUserNotificationCenter.current()
        center.getPendingNotificationRequests { pending in
            DispatchQueue.main.async {
                guard mine == generation else { return }
                let old = pending.map(\.identifier).filter { $0.hasPrefix(PauseNotify.reminderIdPrefix) }
                center.removePendingNotificationRequests(withIdentifiers: old)
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

    private static func request(_ r: PauseNotify.Reminder) -> UNNotificationRequest {
        let content = UNMutableNotificationContent()
        content.title = PauseNotify.title
        content.body = r.body
        content.sound = .default
        // Az ütemezés óta eltelt idő miatt legalább egy másodperc: a rendszer a
        // nullát nem fogadja el.
        let seconds = max(1, (r.fireAt - nowMs()) / 1000)
        let trigger = UNTimeIntervalNotificationTrigger(timeInterval: seconds, repeats: false)
        return UNNotificationRequest(identifier: r.id, content: content, trigger: trigger)
    }
}
