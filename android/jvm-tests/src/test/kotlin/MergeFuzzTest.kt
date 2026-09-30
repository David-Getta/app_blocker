import hu.breaker.app.core.Focus
import hu.breaker.app.core.FocusSync
import hu.breaker.app.core.KeywordLogic
import hu.breaker.app.core.LockdownLogic
import hu.breaker.app.core.PartnerLogic
import hu.breaker.app.core.ScheduleLogic
import hu.breaker.app.core.SyncMerge
import hu.breaker.app.core.UrlRules
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

    /** Menetrendek, adag-szabályok és részleges szabályok készlete — a gép merge-random.ts párja. */
    private val schedules = listOf(
        ScheduleLogic.Schedule(ScheduleLogic.Mode.SCHEDULED_BLOCK, listOf(ScheduleLogic.Band(setOf(1, 2, 3, 4, 5), 540, 1020))),
        ScheduleLogic.Schedule(ScheduleLogic.Mode.SCHEDULED_ALLOW, listOf(ScheduleLogic.Band(setOf(0, 6), 600, 720))),
        ScheduleLogic.Schedule(ScheduleLogic.Mode.SCHEDULED_BLOCK, listOf(ScheduleLogic.Band(setOf(0, 1, 2, 3, 4, 5, 6), 1320, 360))),
    )
    private val bursts = listOf(600L to 300L, 1200L to 900L)
    private val rulePool = listOf(UrlRules.UrlRule("youtube.com", "/@valaki"), UrlRules.UrlRule("youtube.com", "/shorts"))

    private fun randomSite(r: Lcg, device: String): SyncMerge.SyncSite {
        val hostnames = hosts.filterIndexed { i, _ -> i == 0 || r.next() < 0.5 }
        val marks = mutableMapOf<String, Int>()
        for (h in hosts.drop(1)) if (r.next() < 0.4) marks[h] = 1 + (r.next() * 5).toInt()
        val pending = if (r.next() < 0.15) 5_000L + (r.next() * 3).toInt() else null
        val limit = if (r.next() < 0.4) 600L * (1 + (r.next() * 3).toInt()) else null
        val alias = if (r.next() < 0.3) "n${(r.next() * 3).toInt()}" else null
        val reason = if (r.next() < 0.2) "r${(r.next() * 2).toInt()}" else null
        val rev = 1 + (r.next() * 5).toInt()
        val updatedAt = 100L + (r.next() * 5).toInt()
        // A jel sosem nagyobb a rekord rev-jénél — a bemenet is így tisztít.
        for (h in marks.keys.toList()) marks[h] = minOf(marks.getValue(h), rev)
        // MENETREND, ADAG, RÉSZLEGES SZABÁLYOK — hat húzás, mind feltétel nélkül,
        // ugyanebben a sorrendben a három nyelvben (desktop/test/merge-random.ts).
        val schedDraw = r.next()
        val schedPick = (r.next() * 3).toInt()
        val burstDraw = r.next()
        val burstPick = (r.next() * 2).toInt()
        val rulesDraw = r.next()
        val rulesPick = (r.next() * 3).toInt()
        val schedule = if (schedDraw < 0.4) schedules[schedPick] else null
        val burst = if (burstDraw < 0.3) bursts[burstPick] else null
        val rules = when {
            rulesDraw < 0.25 -> null
            rulesDraw < 0.45 -> emptyList()
            rulesPick == 2 -> listOf(rulePool[0], rulePool[1])
            else -> listOf(rulePool[rulesPick])
        }
        // A SZABÁLYLISTA JELE — két húzás, feltétel nélkül, mint a gépen.
        val rulesMarkDraw = r.next()
        val rulesMarkValue = minOf(1 + (r.next() * 5).toInt(), rev)
        val rulesRev = if (rules != null && rulesMarkDraw < 0.6) rulesMarkValue else null
        return SyncMerge.SyncSite(
            id = "site_1", domain = "youtube.com", hostnames = hostnames, addedAt = 1_000,
            pendingDeleteAt = pending, schedule = schedule, dailyLimitSeconds = limit,
            burstSeconds = burst?.first, cooldownSeconds = burst?.second,
            alias = alias, reason = reason, rules = rules,
            rev = rev, updatedAt = updatedAt, updatedBy = device,
            hostnameMarks = marks.ifEmpty { null },
            rulesRev = rulesRev,
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

    /** Az ablakok készlete — a gép merge-random.ts WINDOWS párja. */
    private val WINDOWS = listOf(
        ScheduleLogic.Band(setOf(1, 2, 3, 4, 5), 540, 1020),
        ScheduleLogic.Band(setOf(1), 1320, 360),
        ScheduleLogic.Band(setOf(0, 6), 0, 1440),
    )

    /** Kulcsszó-készletek és két rögzített megbízott-zár — a gép merge-random.ts-ének párja. */
    private val keywordSets = listOf(listOf("shorts"), listOf("reels"), listOf("shorts", "reels"))
    private val partners = listOf(
        PartnerLogic.PartnerLock("Anna", "QUFBQUFBQUFBQUFBQUFBQQ==", "QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=", 5L),
        PartnerLogic.PartnerLock("Bela", "Q0NDQ0NDQ0NDQ0NDQ0NDQw==", "REREREREREREREREREREREREREREREREREREREREREQ=", 3L),
    )

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
        // A ZÁRLAT ÉS AZ ABLAKOK A JELÜKKEL — kilenc húzás, mind feltétel
        // nélkül, ugyanebben a sorrendben, mint a gép merge-random.ts-e.
        val lockDraw = r.next()
        val lockStart = 100L + (r.next() * 3).toInt()
        val lockEnd = 1_000L + 500L * (r.next() * 3).toInt()
        val lockdown = if (lockDraw < 0.3) LockdownLogic.Lockdown(lockStart, lockEnd) else null
        val hasWindows = r.next() < 0.5
        val drawn = WINDOWS.filter { r.next() < 0.5 }
        val windows = if (hasWindows) {
            drawn.mapIndexed { i, w -> LockdownLogic.LockdownWindow("w${i + 1}@$device", w.days, w.startMin, w.endMin) }
        } else {
            emptyList()
        }
        val markDraw = r.next()
        val markValue = minOf(1 + (r.next() * 5).toInt(), rev)
        val windowsRev = if (windows.isNotEmpty() || markDraw < 0.3) markValue else null
        // A REJTÉS A JELÉVEL — három húzás, mind feltétel nélkül, ugyanebben a
        // sorrendben a három nyelvben (desktop/test/merge-random.ts).
        val hideDraw = r.next()
        val hideMarkDraw = r.next()
        val hideMarkValue = minOf(1 + (r.next() * 5).toInt(), rev)
        val hide = hideDraw < 0.3
        val hideRev = if (hide || hideMarkDraw < 0.2) hideMarkValue else null
        // KULCSSZAVAK ÉS MEGBÍZOTT A JELÜKKEL — nyolc húzás, mind feltétel nélkül,
        // ugyanebben a sorrendben a három nyelvben (desktop/test/merge-random.ts).
        val kwDraw = r.next()
        val kwPick = (r.next() * 3).toInt()
        val kwMarkDraw = r.next()
        val kwMarkValue = minOf(1 + (r.next() * 5).toInt(), rev)
        val keywords = if (kwDraw < 0.4) keywordSets[kwPick] else emptyList()
        val keywordsRev = if (keywords.isNotEmpty() || kwMarkDraw < 0.2) kwMarkValue else null
        val pDraw = r.next()
        val pPick = (r.next() * 2).toInt()
        val pMarkDraw = r.next()
        val pMarkValue = minOf(1 + (r.next() * 5).toInt(), rev)
        val partner = if (pDraw < 0.3) partners[pPick] else null
        val partnerRev = if (partner != null || pMarkDraw < 0.2) pMarkValue else null
        return FocusSync.SyncFocus(
            packs = packs, run = run, rev = rev.toLong(), updatedAt = updatedAt, updatedBy = device,
            packMarks = marks.ifEmpty { null },
            lockdown = lockdown, lockdownWindows = windows, lockdownWindowsRev = windowsRev,
            partner = partner, partnerRev = partnerRev,
            hideSiteList = hide, hideSiteListRev = hideRev,
            keywords = keywords, keywordsRev = keywordsRev,
        )
    }

    private fun effectiveMark(f: FocusSync.SyncFocus, id: String): Int {
        val own = f.packMarks?.get(id) ?: 0
        return if (f.run?.packId == id && f.packs.any { it.id == id }) maxOf(own, f.rev.toInt()) else own
    }

    /**
     * A csomagok halmaza, a jelek, a menet és a rev — és a csomagok VÁLTOZATA
     * is, kivéve azét, amin valamelyik bemenet menete fut: ott három
     * eszköznél a változat a sorrendtől függhet (a jelenlét nem) — a doksi
     * kimondja, a gép fuzzja ugyanígy méri.
     */
    private fun focusKey(f: FocusSync.SyncFocus, runIds: Set<String>): String {
        val packs = f.packs.sortedBy { it.id }.joinToString(",") {
            if (it.id in runIds) it.id
            else "${it.id}:${it.name}:${it.allowSites.sorted()}:${it.allowApps.sorted()}:${it.defaultMinutes}:${Focus.recurrenceKey(it.recurrence)}"
        }
        val marks = (f.packMarks ?: emptyMap()).toSortedMap().entries.joinToString(",") { "${it.key}=${it.value}" }
        val run = f.run?.let { "${it.packId}/${it.startedAt}/${it.endsAt}" } ?: "-"
        val lock = f.lockdown?.let { "${it.startedAt}/${it.until}" } ?: "-"
        val windows = f.lockdownWindows.map { LockdownLogic.windowKey(it.band) }.sorted().joinToString(";")
        return "$packs|$marks|$run|${f.rev}|$lock|$windows|${f.lockdownWindowsRev ?: 0}" +
            "|${if (f.hideSiteList) 1 else 0}|${f.hideSiteListRev ?: 0}" +
            "|${KeywordLogic.keywordsKey(f.keywords)}|${f.keywordsRev ?: 0}|${PartnerLogic.partnerKey(f.partner)}|${f.partnerRev ?: 0}"
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
            val runIds = listOfNotNull(a.run?.packId, b.run?.packId, c.run?.packId).toSet()
            val key = { f: FocusSync.SyncFocus -> focusKey(f, runIds) }
            val ab = FocusSync.merge(a, b)
            assertEquals(key(ab), key(FocusSync.merge(b, a)), "szimmetria, mag $seed")
            assertEquals(key(FocusSync.merge(ab, ab)), key(ab), "idempotens, mag $seed")
            val abc = FocusSync.merge(ab, c)
            assertEquals(key(abc), key(FocusSync.merge(FocusSync.merge(b, c), a)), "három eszköz (bca), mag $seed")
            assertEquals(key(abc), key(FocusSync.merge(FocusSync.merge(c, a), b)), "három eszköz (cab), mag $seed")
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
