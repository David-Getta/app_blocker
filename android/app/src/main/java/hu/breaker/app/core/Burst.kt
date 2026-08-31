package hu.breaker.app.core

/**
 * Adag-szabály oldalanként — a desktop/src/shared/burst.ts tükre.
 *
 * Ennyi HASZNÁLAT után ennyi SZÜNET: például 2 perc Gemini után 10 perc
 * tiltás, aztán az oldal magától kinyílik. A napi keret testvére, más alakú
 * lyukra: a keret a napi összesenről szól, ez arról, hogy egyszerre mennyi
 * fér.
 *
 * A BEÁLLÍTÁS (adag + szünet) a blokklista rekordján utazik a többi eszközre;
 * a SZÁMLÁLÓ eszköz-helyi. A szinkron tízperces körökben jár, egy kétperces
 * adaghoz az túl lassú — ebből nem pontatlan közös számláló lesz, hanem
 * őszintén eszközönkénti. Ha itt változtatsz, a TS ikren is.
 */
object BurstLogic {

    /** Az adag legfeljebb egy nap — ami több, az már a napi keret dolga. */
    const val MAX_BURST_MINUTES = 24 * 60
    /** A szünet is legfeljebb egy nap — ami hosszabb, az sima tiltás legyen. */
    const val MAX_COOLDOWN_MINUTES = 24 * 60

    data class Rule(val burstSeconds: Long, val cooldownSeconds: Long)

    /**
     * Az adag-számláló egy oldalra, EZEN a készüléken. Nem kerül a drótra.
     * A [lastAt] a legutóbb elszámolt minta ideje — ebből derül ki, hogy
     * volt-e egy hűtésnyi pihenő.
     */
    data class State(
        val usedSeconds: Double = 0.0,
        val lastAt: Long = 0,
        val cooldownUntil: Long = 0,
    )

    /**
     * Használható szabály a két értékből, vagy null. A kettő CSAK EGYÜTT
     * értelmes: adag szünet nélkül nem tilt semmit, szünet adag nélkül sosem
     * indul el — fél-kitöltött állapotot nem tárolunk.
     */
    fun normalize(burstSeconds: Long?, cooldownSeconds: Long?): Rule? {
        if (burstSeconds == null || cooldownSeconds == null) return null
        if (burstSeconds <= 0 || cooldownSeconds <= 0) return null
        return Rule(
            burstSeconds.coerceAtMost(MAX_BURST_MINUTES * 60L),
            cooldownSeconds.coerceAtMost(MAX_COOLDOWN_MINUTES * 60L),
        )
    }

    /**
     * Egy mérés-minta elszámolása az adag-számlálóban.
     *
     *   - hűtés alatt a minta NEM számít (a tiltott oldalon mért idő különben
     *     újraindítaná a hűtést a lejárta után);
     *   - ha a minta és az előző közt egy hűtésnyi csend volt, a számláló
     *     tiszta lappal indul;
     *   - a lastAt sosem lép hátra: egy elkésett régi minta nem gyárthat
     *     hamis pihenőt.
     */
    fun noteUsage(rule: Rule, st: State?, seconds: Double, at: Long): State {
        val cur = st ?: State()
        if (!seconds.isFinite() || seconds <= 0) return cur
        if (cur.cooldownUntil > at) return cur
        var used = cur.usedSeconds
        if (cur.lastAt > 0 && at - cur.lastAt >= rule.cooldownSeconds * 1000) used = 0.0
        used += seconds
        val lastAt = maxOf(cur.lastAt, at)
        if (used >= rule.burstSeconds) {
            // Az adag betelt: indul a hűtés, a számláló nulláról jön vissza.
            // A hűtés a MINTA idejétől számít — ha a köteg késett, a
            // különbség már le is telt belőle.
            return State(0.0, lastAt, at + rule.cooldownSeconds * 1000)
        }
        return State(used, lastAt, cur.cooldownUntil)
    }

    /** Tart-e most a hűtés. */
    fun isCoolingDown(st: State?, now: Long): Boolean =
        st != null && st.cooldownUntil > now

    /**
     * Lazítás-e a szabály cseréje — mert a lazítás próbatételbe kerül.
     * Szigorítás (ingyen): felvétel, kisebb adag, hosszabb szünet. Lazítás:
     * levétel, nagyobb adag, rövidebb szünet — vegyesnél a lazító fele dönt.
     */
    fun isLoosening(current: Rule?, next: Rule?): Boolean {
        if (current == null) return false
        if (next == null) return true
        return next.burstSeconds > current.burstSeconds ||
            next.cooldownSeconds < current.cooldownSeconds
    }
}
