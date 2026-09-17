package hu.breaker.app.core

/**
 * Zárlat — a desktop/src/shared/lockdown.ts tükre.
 *
 * Az az időszak, amikor a lazítás nem drága, hanem NEM LÉTEZIK: a bíró el sem
 * indít próbatételt rá. Eddig minden lazításnak volt ára, tehát útja is; ez az
 * egyetlen művelet az egész appban, aminek nincs visszaútja.
 *
 * Indítani ingyen van, hosszabbítani ingyen van. Rövidíteni, visszavonni,
 * kivételt tenni sehogy sem lehet — se gombbal, se próbatétellel.
 *
 * Nem lakatolja le a telefont, és nem is állítjuk, hogy megtenné: az app
 * letörölhető. Az appon BELÜL zár le mindent, vagyis az impulzus ellen véd.
 *
 * Ha itt változtatsz, a TS és a Swift ikren is.
 */
object LockdownLogic {

    /** Egy zárlat legfeljebb ennyi lehet. Ami ennél hosszabb, az már nem döntés. */
    const val MAX_LOCKDOWN_DAYS = 30
    const val MAX_LOCKDOWN_MS = MAX_LOCKDOWN_DAYS * 24 * 3600_000L

    /** A felület gyorsgombjai, percben. A leghosszabb szándékosan egy hét. */
    val LOCKDOWN_CHOICES_MIN = listOf(60, 180, 8 * 60, 24 * 60, 3 * 24 * 60, 7 * 24 * 60)

    /**
     * A futó zárlat. A [startedAt] nem dísz: ebből látszik, mennyi telt el és
     * mennyi van hátra — egy puszta határidő mellett a hosszú zárlat első
     * napja ugyanúgy néz ki, mint az utolsó.
     */
    data class Lockdown(val startedAt: Long, val until: Long)

    /** Tart-e most zárlat. */
    fun isLocked(l: Lockdown?, now: Long): Boolean = l != null && l.until > now

    /** Mennyi van még hátra, ms-ben. Nulla, ha nincs zárlat. */
    fun remainingMs(l: Lockdown?, now: Long): Long = if (isLocked(l, now)) l!!.until - now else 0L

    /**
     * Zárlat indítása vagy hosszabbítása [ms] időre MOSTTÓL.
     *
     * Az eredmény SOSEM rövidebb a mostaninál: ez az egyetlen út a mezőhöz, és
     * így a rövidítés nem elfelejtett ellenőrzés kérdése, hanem
     * megfogalmazhatatlan.
     */
    fun start(cur: Lockdown?, ms: Long, now: Long): Lockdown? {
        if (ms <= 0) return cur
        val want = now + minOf(ms, MAX_LOCKDOWN_MS)
        if (isLocked(cur, now)) {
            return if (want > cur!!.until) Lockdown(cur.startedAt, want) else cur
        }
        return Lockdown(now, want)
    }

    /**
     * Két eszköz zárlata EGGYÉ fésülve: a KÉSŐBBI vég nyer.
     *
     * Nem versenyhelyzet-feloldás, hanem maga a szabály: a zárlat szigorítás,
     * tehát a szinkron sosem viheti vissza. Azonos végnél a korábbi kezdés az
     * igaz — az mutatja a teljes hosszt.
     */
    fun merge(a: Lockdown?, b: Lockdown?): Lockdown? {
        if (a == null) return b
        if (b == null) return a
        if (b.until > a.until) return b
        if (a.until > b.until) return a
        return if (a.startedAt <= b.startedAt) a else b
    }

    /**
     * A dróton érkezett zárlat beolvasása. Minden mező gyanús: másik eszköz
     * írta. Ami nem értelmes, az nincs.
     */
    fun parse(until: Double?, startedAt: Double?): Lockdown? {
        val u = until ?: return null
        if (!u.isFinite() || u <= 0) return null
        val end = u.toLong()
        val s = startedAt?.takeIf { it.isFinite() && it > 0 }?.toLong() ?: end
        return Lockdown(minOf(s, end), end)
    }

    /**
     * Magyar, olvasható hátralévő idő: 6 nap 3 óra, 2 ó 15 p, 4 perc.
     *
     * A zárlat hossza napokban is mérhető, ezért nem a percre pontos alak kell
     * — aki hét napot zárt le, annak a másodpercek csak nézegetnivalót adnának.
     */
    fun formatRemaining(ms: Long): String {
        val total = maxOf(0L, (ms + 999) / 1000)
        val days = total / 86_400
        val hours = (total % 86_400) / 3600
        val mins = (total % 3600) / 60
        if (days > 0) return if (hours > 0) "$days nap $hours óra" else "$days nap"
        if (hours > 0) return if (mins > 0) "$hours ó $mins p" else "$hours óra"
        return "${maxOf(1L, mins)} perc"
    }
}
