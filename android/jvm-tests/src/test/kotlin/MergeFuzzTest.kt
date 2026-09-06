import hu.breaker.app.core.Focus
import hu.breaker.app.core.FocusSync
import hu.breaker.app.core.ScheduleLogic
import hu.breaker.app.core.SyncMerge
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * Véletlen összefésülések a Kotlin tükrön — a desktop/test/merge-fuzz.test.ts
 * párja, UGYANAZZAL a véletlennel (LCG, azonos képlet, azonos magok), tehát
 * ugyanazokat az eseteket járja be, mint a gép és az iPhone.
 *
 * Nem a szabályokat teszteli, hanem azt, hogy a szabályok EGYÜTT nem hagynak
 * olyan sarkot, ahol a végeredmény a push-sorrendtől függ. Egy ilyen sarok
 * nem összeomlás, hanem két gép, ami örökké egymást írja felül.
 */
class MergeFuzzTest {

    /** Determinisztikus véletlen — bájtra a gépé: `s = s * 1664525 + 1013904223 (mod 2^32)`. */
    private class Lcg(seed: Int) {
        private var s: Int = seed
        fun next(): Double {
            s = s * 1664525 + 1013904223
            return (s.toLong() and 0xFFFFFFFFL).toDouble() / 4294967296.0
        }
    }

    private val hosts = listOf("youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be", "yt.be")
    private val devices = listOf("gep-a", "gep-b", "telefon")

    private fun randomSite(r: Lcg, device: String): SyncMerge.SyncSite {
        val hostnames = hosts.filterIndexed { i, _ -> i == 0 || r.next() < 0.5 }
        val marks = mutableMapOf<String, Int>()
        for (h in hosts.drop(1)) if (r.next() < 0.4) marks[h] = 1 + (r.next() * 5).toInt()
        val pending = if (r.next() < 0.15) 5_000L + (r.next() * 3).toInt() else null
        val limit = if (r.next() < 0.4) 600L * (1 + (r.next() * 3).toInt()) else null
        val alias = if (r.next() < 0.3) "n${(r.next() * 3).toInt()}" else null
        val rev = 1 + (r.next() * 5).toInt()
        val updatedAt = 100L + (r.next() * 5).toInt()
        return SyncMerge.SyncSite(
            id = "site_1", domain = "youtube.com", hostnames = hostnames, addedAt = 1_000,
            pendingDeleteAt = pending, dailyLimitSeconds = limit, alias = alias,
            rev = rev, updatedAt = updatedAt, updatedBy = device,
            hostnameMarks = marks.ifEmpty { null },
        )
    }

    /**
     * A NEVEK és a JELEIK — ezek fésülődnek nevenként. A rekord többi mezője a
     * rekord-szintű nyertesé, és ott a törlésre várás továbbvitele egy olyan
     * köztes rekordot ad, ami egyik eszközön sem létezett — ezt itt nem
     * mérjük, ahogy a gép sem.
     */
    private fun siteKey(s: SyncMerge.SyncSite): String {
        val marks = (s.hostnameMarks ?: emptyMap()).toSortedMap().entries.joinToString(",") { "${it.key}=${it.value}" }
        return "${s.hostnames.sorted().joinToString(",")}|$marks|${s.rev}"
    }

    private val packIds = listOf("p1", "p2", "p3", "p4")
    private val win = ScheduleLogic.Band(setOf(1, 2, 3, 4, 5), 540, 720)

    private fun randomFocus(r: Lcg, device: String): FocusSync.SyncFocus {
        val kept = packIds.filter { r.next() < 0.6 }
        val packs = kept.map { id ->
            val name = "csomag $id v${(r.next() * 3).toInt()}"
            val rec = if (r.next() < 0.4) win else null
            Focus.FocusPack(
                id = id, name = name, allowSites = listOf("quizlet.com"), allowApps = emptyList(),
                defaultMinutes = 50, recurrence = rec,
            )
        }
        val marks = mutableMapOf<String, Int>()
        for (id in packIds) if (r.next() < 0.4) marks[id] = 1 + (r.next() * 5).toInt()
        val rev = 1 + (r.next() * 5).toInt()
        // A jel sosem nagyobb a blob rev-jénél (a bemenet is így tisztít): a
        // csomag nélküli menet lehetetlensége erre épül.
        for (id in marks.keys.toList()) marks[id] = minOf(marks.getValue(id), rev)
        // A menet lejárata és kezdése is csak pár értéket vesz fel: legyen sok
        // döntetlen, mert éppen a döntetlen-lánc az, ami sorrendfüggő tud lenni.
        val run = if (r.next() < 0.4 && packs.isNotEmpty()) {
            val packId = packs[(r.next() * packs.size).toInt()].id
            val startedAt = 10L + 60_000L * (r.next() * 2).toInt()
            val endsAt = 610_000L + 60_000L * (r.next() * 2).toInt()
            Focus.FocusRun(packId, startedAt, endsAt)
        } else null
        val updatedAt = 100L + (r.next() * 5).toInt()
        return FocusSync.SyncFocus(
            packs = packs, run = run, rev = rev.toLong(), updatedAt = updatedAt, updatedBy = device,
            packMarks = marks.ifEmpty { null },
        )
    }

    private fun effectiveMark(f: FocusSync.SyncFocus, id: String): Int {
        val own = f.packMarks?.get(id) ?: 0
        return if (f.run?.packId == id && f.packs.any { it.id == id }) maxOf(own, f.rev.toInt()) else own
    }

    private fun focusKey(f: FocusSync.SyncFocus): String {
        val packs = f.packs.sortedBy { it.id }.joinToString(",") { "${it.id}:${it.name}:${Focus.recurrenceKey(it.recurrence)}" }
        val marks = (f.packMarks ?: emptyMap()).toSortedMap().entries.joinToString(",") { "${it.key}=${it.value}" }
        val run = f.run?.let { "${it.packId}/${it.startedAt}/${it.endsAt}" } ?: "-"
        return "$packs|$marks|$run|${f.rev}"
    }

    @Test
    fun `oldal - szimmetrikus, idempotens, es harom eszkoz barmilyen sorrendben ugyanoda jut`() {
        for (seed in 1..300) {
            val r = Lcg(seed)
            val a = randomSite(r, devices[0])
            val b = randomSite(r, devices[1])
            val c = randomSite(r, devices[2])
            val ab = SyncMerge.mergeSite(a, b)
            assertEquals(siteKey(ab), siteKey(SyncMerge.mergeSite(b, a)), "szimmetria, mag $seed")
            assertEquals(siteKey(SyncMerge.mergeSite(ab, ab)), siteKey(ab), "idempotens, mag $seed")
            val abc = SyncMerge.mergeSite(ab, c)
            val bca = SyncMerge.mergeSite(SyncMerge.mergeSite(b, c), a)
            val cab = SyncMerge.mergeSite(SyncMerge.mergeSite(c, a), b)
            assertEquals(siteKey(abc), siteKey(bca), "három eszköz, más sorrend (bca), mag $seed")
            assertEquals(siteKey(abc), siteKey(cab), "három eszköz, más sorrend (cab), mag $seed")
            // Lazítás jel nélkül nincs: ami mindkét oldalon benne volt, és
            // egyiknek sincs rá jele, az az eredményben is benne van.
            for (h in a.hostnames) {
                val unmarked = (a.hostnameMarks?.get(h) ?: 0) == 0 && (b.hostnameMarks?.get(h) ?: 0) == 0
                if (h in b.hostnames && unmarked) {
                    assertTrue(h in ab.hostnames, "jel nélküli közös név nem tűnhet el: $h, mag $seed")
                }
            }
        }
    }

    @Test
    fun `munkamenet-blob - a csomagok halmaza, a jelek es a menet sorrendtol fuggetlenek`() {
        for (seed in 1..300) {
            val r = Lcg(seed)
            val a = randomFocus(r, devices[0])
            val b = randomFocus(r, devices[1])
            val c = randomFocus(r, devices[2])
            val ab = FocusSync.merge(a, b)
            assertEquals(focusKey(ab), focusKey(FocusSync.merge(b, a)), "szimmetria, mag $seed")
            assertEquals(focusKey(FocusSync.merge(ab, ab)), focusKey(ab), "idempotens, mag $seed")
            val abc = FocusSync.merge(ab, c)
            assertEquals(focusKey(abc), focusKey(FocusSync.merge(FocusSync.merge(b, c), a)), "három eszköz (bca), mag $seed")
            assertEquals(focusKey(abc), focusKey(FocusSync.merge(FocusSync.merge(c, a), b)), "három eszköz (cab), mag $seed")
            // A jeles csomag a nagyobb jel változatában marad: ha az egyik
            // oldalon ablakos csomag áll a nagyobb jellel, az ablak marad. A
            // futó menet csomagja a blob rev-jével számít jeleltnek.
            for (p in a.packs) {
                val ma = effectiveMark(a, p.id)
                val mb = effectiveMark(b, p.id)
                if (ma > mb && p.recurrence != null) {
                    assertNotNull(ab.packs.find { it.id == p.id }?.recurrence, "a nagyobb jel ablaka marad: ${p.id}, mag $seed")
                }
            }
            // Csomag nélküli menet nem születik: a menet csomagja a listán van.
            for (m in listOf(ab, abc)) {
                val run = m.run ?: continue
                assertTrue(m.packs.any { it.id == run.packId }, "a menet csomagja a listán van, mag $seed")
            }
        }
    }
}
