import hu.breaker.app.core.Focus
import hu.breaker.app.core.LockdownLogic
import hu.breaker.app.core.ScheduleLogic
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Véletlen-teszt a zárlat-ablak magjára — a gépé (`lockdown-windows-fuzz.test.ts`) párja.
 *
 * Az ablak ígérete három mondat: a zárlat tőle SOSEM rövidül; amit egyszer
 * kiírt, azt másodszor már nem írja (a kör minden percben fut); és két eszköz
 * ugyanabból a listából ugyanazt a zárlatot állítja elő, akkor is, ha más
 * pillanatban néznek rá. A többi teszt egy-egy esetet néz; ez több ezer
 * véletlen listát, időpontot és futó zárlatot dob a magra, és MINDEN lépés
 * után ellenőrzi a három mondatot. A fésülés és a lazítás szabályát is.
 *
 * A generátor magja rögzített, tehát egy elhasalás visszajátszható: a hiba a
 * magot is kiírja.
 */
class LockdownWindowFuzzTest {

    /** Determinisztikus véletlen: `s = s * 1664525 + 1013904223 (mod 2^32)`. */
    private class Rng(seed: Int) {
        private var s: Int = seed
        fun next(): Double {
            s = s * 1664525 + 1013904223
            return (s.toLong() and 0xFFFFFFFFL).toDouble() / 4294967296.0
        }
    }

    private val HOUR = 3_600_000L
    private val DAY = 24 * HOUR
    /** Egy hétfő éjfél helyi időben; a véletlen pillanatok három hétig innen. */
    private val BASE: Long = java.util.Calendar.getInstance()
        .apply { clear(); set(2026, java.util.Calendar.SEPTEMBER, 7, 0, 0, 0) }.timeInMillis

    /** Egy érvényes ablak: véletlen napok, kezdés, vég — néha egész napos, néha éjfélen átnyúló. */
    private fun randomWindow(r: Rng, id: String): LockdownLogic.LockdownWindow {
        var days = (0..6).filter { r.next() < 0.4 }.toSet()
        if (days.isEmpty()) days = setOf((r.next() * 7).toInt())
        if (r.next() < 0.1) return LockdownLogic.LockdownWindow(id, days, 0, 1440)
        // Kerek órák gyakran, hogy a sávok tényleg találkozzanak és egymásba érjenek.
        val startMin = if (r.next() < 0.6) 60 * (r.next() * 24).toInt() else (r.next() * 1440).toInt()
        val endMin = if (r.next() < 0.6) 60 * (1 + (r.next() * 24).toInt()) else 1 + (r.next() * 1440).toInt()
        return LockdownLogic.LockdownWindow(id, days, startMin, endMin)
    }

    private fun randomWindows(r: Rng, device: String, min: Int = 0): List<LockdownLogic.LockdownWindow> {
        val n = if (r.next() < 0.1) min else maxOf(min, (r.next() * (LockdownLogic.MAX_LOCKDOWN_WINDOWS + 1)).toInt())
        return LockdownLogic.cleanWindows((0 until n).map { i -> randomWindow(r, "w$i@$device") })
    }

    /** Nincs / lejárt / futó zárlat — a futó akár napokig, hogy az ablakot át is fedje. */
    private fun randomLockdown(r: Rng, now: Long): LockdownLogic.Lockdown? {
        val roll = r.next()
        if (roll < 0.4) return null
        if (roll < 0.6) return LockdownLogic.Lockdown(now - 5 * HOUR, now - 1 - (r.next() * 2 * HOUR).toLong())
        return LockdownLogic.Lockdown(now - (r.next() * 3 * DAY).toLong(), now + 1 + (r.next() * 3 * DAY).toLong())
    }

    private fun keys(list: List<LockdownLogic.LockdownWindow>): List<String> =
        list.map { LockdownLogic.windowKey(it.band) }

    /** Véletlen ablak-jelek a két lista tartalmaira — a gép `randomMarks`-e: a nulla nem jel. */
    private fun randomMarks(r: Rng, mine: List<LockdownLogic.LockdownWindow>, other: List<LockdownLogic.LockdownWindow>): Map<String, Int> {
        val out = LinkedHashMap<String, Int>()
        for (w in mine + other) if (r.next() < 0.5) out[LockdownLogic.windowKey(w.band)] = (r.next() * 4).toInt()
        return out.filterValues { it != 0 }
    }

    @Test fun `az ablak-zarlat sosem rovidit, egyszer ir, es ket eszkozon ugyanaz`() {
        for (seed in 1..fuzzSeeds(4000)) {
            val r = Rng(seed)
            val ctx = "mag $seed"
            val windows = randomWindows(r, "a")
            val bands = windows.map { it.band }
            val now = BASE + (r.next() * 21 * DAY).toLong()
            val cur = randomLockdown(r, now)
            val occ = LockdownLogic.dueWindow(bands, now)
            val fw = LockdownLogic.windowLockdown(cur, bands, now)

            if (occ != null) {
                assertTrue(occ.startsAt <= now && now < occ.endsAt, "$ctx: az esedékes előfordulás él")
                // A legkésőbb végződő élő előfordulás — ablakonként nézve egyik sem ér tovább.
                for (w in windows) {
                    val one = LockdownLogic.dueWindow(listOf(w.band), now)
                    assertTrue(one == null || one.endsAt <= occ.endsAt, "$ctx: van tovább érő ablak")
                }
            }

            if (fw == null) {
                // Semmi írnivaló: nincs élő ablak, vagy a futó zárlat már az ablak végéig ér.
                if (occ != null) assertTrue(cur != null && cur.until > now && cur.until >= occ.endsAt, "$ctx: élő ablak zárlat nélkül")
                continue
            }
            val o = assertNotNull(occ, "$ctx: ablak-zárlat élő ablak nélkül")
            assertEquals(o.endsAt, fw.until, "$ctx: a vég az ablak vége")
            assertTrue(fw.until > now, "$ctx: a kiírt zárlat él")
            // Sosem rövidít: a kiírt vég minden korábbi végnél későbbi.
            assertTrue(cur == null || fw.until > cur.until, "$ctx: rövidített")
            if (cur != null && cur.until > now) assertEquals(cur.startedAt, fw.startedAt, "$ctx: a futó zárlat kezdése marad")
            else assertEquals(o.startsAt, fw.startedAt, "$ctx: a kezdés az ablak kezdése")
            assertTrue(fw.startedAt <= now, "$ctx: jövőbeli kezdés")
            assertTrue(LockdownLogic.isWindowLockdown(fw, bands), "$ctx: a kiírt zárlat nem ablaké")
            // Egyszer ír: a kiírt zárlattal a kör már nem ír újat.
            assertNull(LockdownLogic.windowLockdown(fw, bands, now), "$ctx: másodszor is írt")

            // Két eszköz: a másik később nézi meg, zárlat nélkül — ugyanazt kapja, vagy
            // egy közben beért, tovább érő ablakét (ami ezt is ugyanígy kitolná).
            val later = now + (r.next() * (fw.until - now)).toLong()
            val other = assertNotNull(LockdownLogic.windowLockdown(null, bands, later), "$ctx: a másik eszköz nem lát zárlatot")
            assertTrue(other.until >= fw.until, "$ctx: a másik eszköz rövidebbet lát")
            if (other.until == fw.until) assertEquals(o.startsAt, other.startedAt, "$ctx: más kezdés")
            val mine = LockdownLogic.windowLockdown(fw, bands, later)
            assertTrue(mine == null || (mine.startedAt == fw.startedAt && mine.until > fw.until), "$ctx: a saját kör rövidített")

            // Előre az időben: a lánc (kézi zárlat, ablak, következő ablak) csak nő.
            var l: LockdownLogic.Lockdown = fw
            var t = now
            for (k in 0 until 6) {
                t += (r.next() * 8 * HOUR).toLong()
                val n = LockdownLogic.windowLockdown(l, bands, t) ?: continue
                assertTrue(n.until > l.until, "$ctx: a lánc rövidült")
                if (l.until > t) assertEquals(l.startedAt, n.startedAt, "$ctx: a lánc kezdése elmozdult")
                assertTrue(LockdownLogic.isWindowLockdown(n, bands), "$ctx: a lánc tagja nem ablaké")
                l = n
            }
        }
    }

    @Test fun `a fesules tartalmankent - a nagyobb jel dont, egyenlonel unio, plafon, szabad ora, egyedi azonosito`() {
        for (seed in 1..fuzzSeeds(3000)) {
            val r = Rng(seed)
            val ctx = "mag $seed"
            // Néha közös azonosító-séma: két eszköz ugyanazzal az azonosítóval más tartalmat is hozhat.
            val shared = r.next() < 0.3
            val a = randomWindows(r, if (shared) "x" else "a")
            val b = randomWindows(r, if (shared) "x" else "b")
            val sa = LockdownLogic.WindowSet(a, randomMarks(r, a, b))
            val sb = LockdownLogic.WindowSet(b, randomMarks(r, b, a))
            val merged = LockdownLogic.mergeWindowSets(sa, sb)
            val m = merged.windows

            assertTrue(m.size <= LockdownLogic.MAX_LOCKDOWN_WINDOWS, "$ctx: túl sok ablak")
            assertEquals(m.size, m.map { LockdownLogic.windowKey(it.band) }.toSet().size, "$ctx: dupla tartalom")
            assertEquals(m.size, m.map { it.id }.toSet().size, "$ctx: dupla azonosító")
            assertTrue(m.isEmpty() || LockdownLogic.freeMinutesPerWeek(m.map { it.band }) >= LockdownLogic.MIN_FREE_MINUTES_PER_WEEK,
                "$ctx: nincs szabad óra a héten")
            assertEquals(m, LockdownLogic.mergeWindowSets(merged, merged).windows, "$ctx: a fésülés nem idempotens")
            val flipped = LockdownLogic.mergeWindowSets(sb, sa)
            assertEquals(keys(m), keys(flipped.windows), "$ctx: a fésülés nem szimmetrikus")
            assertEquals(merged.marks, flipped.marks, "$ctx: a jelek nem szimmetrikusak")

            val union = (keys(a) + keys(b)).toSet()
            val mKeys = m.map { LockdownLogic.windowKey(it.band) }
            for (w in m) assertTrue(LockdownLogic.windowKey(w.band) in union, "$ctx: ablak a semmiből")
            for (k in union) {
                val ma = sa.marks?.get(k) ?: 0
                val mb = sb.marks?.get(k) ?: 0
                val inA = k in keys(a)
                val inB = k in keys(b)
                val want = if (ma > mb) inA else if (mb > ma) inB else inA || inB
                val got = k in mKeys
                if (!want) assertFalse(got, "$ctx: a jeles levétel ellenére megmaradt: $k")
                // Ami jár, az csak a plafon vagy a szabad óra miatt maradhat ki.
                if (want && !got) {
                    val w = (a + b).first { LockdownLogic.windowKey(it.band) == k }
                    assertTrue(m.size >= LockdownLogic.MAX_LOCKDOWN_WINDOWS ||
                        LockdownLogic.freeMinutesPerWeek((m + w).map { it.band }) < LockdownLogic.MIN_FREE_MINUTES_PER_WEEK,
                        "$ctx: ablak ok nélkül veszett el: $k")
                }
                val mark = maxOf(ma, mb)
                if (mark > 0) assertEquals(mark, merged.marks?.get(k), "$ctx: a jel nem a nagyobbik: $k")
            }
        }
    }

    @Test fun `a lazitas - bovites sosem lazitas, az utolso ablak levetele mindig az`() {
        for (seed in 1..fuzzSeeds(40)) {
            val r = Rng(seed)
            val ctx = "mag $seed"
            val a = randomWindows(r, "a", 1).map { it.band }
            val now = BASE + (r.next() * 21 * DAY).toLong()
            assertEquals(false, LockdownLogic.isWindowsLoosening(a, a, now), "$ctx: ugyanaz a lista lazítás")
            assertEquals(true, LockdownLogic.isWindowsLoosening(a, emptyList(), now), "$ctx: minden ablak levétele nem lazítás")
            assertEquals(false, LockdownLogic.isWindowsLoosening(emptyList(), a, now), "$ctx: az első ablak felvétele lazítás")
            val extra = randomWindow(r, "extra").band
            assertEquals(false, LockdownLogic.isWindowsLoosening(a, a + extra, now), "$ctx: a bővítés lazítás")
            // Egy ablak levétele akkor lazítás, ha van olyan perc a héten, amit csak ő zárt.
            val rest = a.drop(1)
            var uncovered = false
            var i = 0
            while (i < 7 * 24 * 60 && !uncovered) {
                val t = now + i * 60_000L
                if (ScheduleLogic.inAnyBand(a, t) && !ScheduleLogic.inAnyBand(rest, t)) uncovered = true
                i++
            }
            assertEquals(uncovered, LockdownLogic.isWindowsLoosening(a, rest, now), "$ctx: a levétel lazítás-ítélete")
        }
    }
}
