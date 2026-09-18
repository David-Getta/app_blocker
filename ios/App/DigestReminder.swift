import Foundation
import UserNotifications

/// Hétfő reggeli emlékeztető a heti visszatekintésre — a rendszer ütemezi,
/// tehát akkor is szól, ha az app nincs nyitva. A MONDAT nincs benne: az
/// akkor születik, amikor az app hétfő reggel hét után először nyitva van (a
/// napló sorát a felület írja, a statisztika címkézésével). Az értesítés csak
/// odahív: „kész az elmúlt hét mondata”. Egy kérés, hetente, a zárlat-ablakok
/// emlékeztetőitől külön azonosítóval — a 64-es rendszerkeretből egyet visz.
enum DigestReminder {
    static let id = "digest:weekly"

    static func reschedule() {
        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
            guard granted else { return }
            var when = DateComponents()
            when.weekday = 2 // hétfő (a Calendar vasárnappal, 1-től számol)
            when.hour = DigestLogic.digestHour
            when.minute = 5
            let content = UNMutableNotificationContent()
            content.title = "Heti visszatekintés"
            content.body = "Kész az elmúlt hét mondata — nyisd meg a Breakert, a statisztikán vár. Tükör, nem ítélet."
            content.sound = .default
            let trigger = UNCalendarNotificationTrigger(dateMatching: when, repeats: true)
            center.add(UNNotificationRequest(identifier: id, content: content, trigger: trigger))
        }
    }
}
