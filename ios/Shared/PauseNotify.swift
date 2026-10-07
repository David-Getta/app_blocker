import Foundation

/// Mikor szóljon az app, hogy egy szünet (feloldás) mindjárt véget ér — a gép
/// `shared/pause-notify.ts`-ének tükre. iPhone-on az app nem fut a háttérben,
/// ezért itt nem lépegetünk, hanem ELŐRE ütemezünk: minden szünetre, ami
/// hosszabb a figyelmeztetésnél, egy helyi értesítés a vége előtt két perccel
/// (`plan`). A frissen indított rövid szünetre ugyanúgy nem szól, mint a gépen;
/// és arról sem, ami a szünet végén nem zárul (`closes` — a
/// `LimitLogic.closesAfterPause` döntése): a „mindjárt újra zárva” hamis volna.
enum PauseNotify {
    /// Ennyivel a szünet vége előtt szól az app.
    static let pauseEndWarnMs: Double = 2 * 60_000

    /// Az értesítés címe — ugyanaz mindhárom platformon.
    static let title = "Breaker — mindjárt vége a szünetnek"

    /// Az ütemezett értesítések azonosító-előtagja: az újraírás ezeket veszi le.
    static let reminderIdPrefix = "pause-end-"

    struct Reminder: Equatable {
        let id: String
        /// mikor szóljon (epoch ms): a szünet vége előtt két perccel
        let fireAt: Double
        let body: String
    }

    /// Egy oldal a tervhez; a `label` a megjelenítendő név (fedőnév / rejtett).
    struct View {
        let id: String
        let label: String
        let pauseUntil: Double?
        /// zárul-e az oldal a szünet végén — ha nem, nincs miről szólni
        let closes: Bool
    }

    /// Az ütemezendő értesítések: minden szünet, aminek a figyelmeztetése még a
    /// jövőben van. Ami már a figyelmeztetési időn belül jár, arról nem szól —
    /// a gép `stepPauseNotices`-ének első hallgatási szabálya.
    static func plan(_ sites: [View], now: Double) -> [Reminder] {
        sites.compactMap { s in
            guard let until = s.pauseUntil, until.isFinite, until - now > pauseEndWarnMs, s.closes else { return nil }
            return Reminder(
                id: reminderIdPrefix + s.id,
                fireAt: until - pauseEndWarnMs,
                body: text(s.label, leftMs: pauseEndWarnMs))
        }
    }

    /// „youtube.com 2 perc múlva újra zárva — a szünet véget ér.” — a perc felfelé kerekít, legalább egy.
    static func text(_ label: String, leftMs: Double) -> String {
        let minutes = max(1, clampedInt((leftMs / 60_000).rounded(.up)))
        return "\(label) \(minutes) perc múlva újra zárva — a szünet véget ér."
    }
}
