package hu.breaker.app.core

/**
 * Mikor szóljon az app, hogy egy szünet (feloldás) mindjárt véget ér — a gép
 * `shared/pause-notify.ts`-ének tükre, ugyanazzal a két hallgatási szabállyal:
 * a frissen indított RÖVID szünetre (amit már a figyelmeztetési időn belül
 * látunk először) nem szól, és egy szünetről egyszer szól; ha közben a vége
 * változik (új feloldás), az új szünet új figyelést kap.
 *
 * A feloldás próbatétellel kifizetett idő, és a vége nem lehet meglepetés: a
 * VPN-szolgáltatás köre hívja, tehát akkor is szól, ha az app nincs nyitva.
 */
object PauseNotify {
    /** Ennyivel a szünet vége előtt szól az app. */
    const val PAUSE_END_WARN_MS = 2 * 60_000L

    /** Az értesítés címe — ugyanaz mindhárom platformon. */
    const val TITLE = "Breaker — mindjárt vége a szünetnek"

    /** Amit a lépegető egy oldalról tudni akar; a `label` a megjelenítendő név (fedőnév / rejtett). */
    data class View(val id: String, val label: String, val pauseUntil: Long?)

    data class Notice(val label: String, val until: Long)

    data class Step(val watches: Map<String, Long>, val notices: List<Notice>)

    /** Egy kör: a figyelt szünetekből (oldal → vég) és a mostani oldalakból — mit kell most mondani. */
    fun step(prev: Map<String, Long>, sites: List<View>, now: Long): Step {
        val watches = mutableMapOf<String, Long>()
        val notices = mutableListOf<Notice>()
        for (s in sites) {
            val until = s.pauseUntil ?: continue
            if (until <= now) continue
            if (until - now > PAUSE_END_WARN_MS) {
                watches[s.id] = until // élesítve: a figyelmeztetés idején szólunk
                continue
            }
            if (prev[s.id] == until) notices.add(Notice(s.label, until))
        }
        return Step(watches, notices)
    }

    /** „youtube.com 2 perc múlva újra zárva — a szünet véget ér.” — a perc felfelé kerekít, legalább egy. */
    fun text(label: String, leftMs: Long): String {
        val minutes = maxOf(1L, (leftMs + 59_999L) / 60_000L)
        return "$label $minutes perc múlva újra zárva — a szünet véget ér."
    }
}
