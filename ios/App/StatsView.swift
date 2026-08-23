import SwiftUI

/// Statistics on iOS/macOS.
///
/// Honest scope: Apple gives no API for measuring how long the user spends in
/// *other* apps or on *other* websites (the Screen Time / DeviceActivity
/// framework needs a separate, Apple-approved entitlement aimed at parental
/// controls). So instead of pretending, this screen says so plainly and shows
/// the data Breaker genuinely owns: the user's own blocking history.
struct StatsView: View {
    @EnvironmentObject var store: BreakerStore
    let now: Double

    private func unlocks(inLastDays days: Int) -> Int {
        let from = now - Double(days) * 24 * 3_600_000
        return store.state.unlockLog.filter { $0 >= from }.count
    }

    private var blockedCount: Int {
        store.state.sites.filter {
            ScheduleLogic.isBlockedNow(pauseUntil: $0.pauseUntil,
                                       pendingDeleteAt: $0.pendingDeleteAt,
                                       schedule: $0.schedule, now: now)
        }.count
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Statisztika").font(.headline)

            HStack(spacing: 10) {
                tile("\(store.state.sites.count)", "figyelt oldal")
                tile("\(blockedCount)", "épp blokkolva")
            }
            HStack(spacing: 10) {
                tile("\(unlocks(inLastDays: 7))", "feloldás / 7 nap")
                tile("\(unlocks(inLastDays: 30))", "feloldás / 30 nap")
            }

            Divider()

            Text("Miért nincs képernyőidő-mérés itt?")
                .font(.subheadline).fontWeight(.semibold)
            Text("""
                 Az iOS nem enged semmilyen appnak hozzáférést ahhoz, hogy más appokban \
                 vagy weboldalakon mennyi időt töltesz — ez rendszerszintű korlát, nem a \
                 Breaker hiányossága. A részletes „mire megy el az idő” statisztika ezért \
                 az asztali és az Android verzióban érhető el. Az iPhone beépített \
                 Képernyőidő funkciója tud hasonlót mutatni.
                 """)
                .font(.footnote).foregroundStyle(.secondary)

            // Ugyanez a korlát egy funkciót is elvisz. Jobb kimondani, mint hogy a
            // felhasználó a másik gépén meglássa, és azt higgye, itt elrontottuk.
            Text("""
                 Emiatt a napi időkeret („legfeljebb napi 20 perc erre az oldalra”) sem \
                 érhető el iPhone-on: a keret mért aktív időből fogyna, mérés nélkül \
                 pedig sosem fogyna el. Egy ilyen keret úgy nézne ki, mintha védene, \
                 közben semmit nem csinálna. Az oldal teljes tiltása és a heti menetrend \
                 itt is ugyanúgy működik.
                 """)
                .font(.footnote).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
        .background(Color.gray.opacity(0.12))
        .cornerRadius(10)
    }

    private func tile(_ value: String, _ label: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(value).font(.title2).fontWeight(.bold)
            Text(label).font(.caption).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(Color.gray.opacity(0.12))
        .cornerRadius(8)
    }
}
