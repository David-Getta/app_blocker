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
        PartnerLogic.PartnerLock("Cili", "RUVFRUVFRUVFRUVFRUVFRQ==", "RkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkY=", 4L),
    )

    /** Naplósorok készlete és részhalmazai — a gép merge-random.ts LOGS / LOG_SETS párja. */
    private val logs = listOf(
        Focus.FocusLogEntry("p1", "csomag p1", 1_000, 2_000, 2_000, false),
        Focus.FocusLogEntry("p1", "csomag p1", 1_000, 1_500, 2_000, true),
        Focus.FocusLogEntry("p2", "csomag p2", 3_000, 4_000, 4_000, false, window = true),
        Focus.FocusLogEntry("p3", "csomag p3", 500, 4_000, 4_500, false),
        Focus.FocusLogEntry("p1", "csomag p1", 1_000, 2_000, 2_600, false),
    )
    private val logSets = listOf(listOf(0), listOf(1), listOf(0, 2), listOf(1, 2, 3), listOf(4, 3))

    /** A fésülés „most”-ja — a gép merge-random.ts `FOCUS_MERGE_NOW` párja. */
    private val focusMergeNow = 500_000L

    /** Sírkövek: a generált menetekre hivatkozó naplósorok — a gép `TOMBS` párja. */
    private val tombs = listOf(
        Focus.FocusLogEntry("p1", "csomag p1", 10, 300_000, 610_000, true),
        Focus.FocusLogEntry("p2", "csomag p2", 10, 610_000, 610_000, false),
        Focus.FocusLogEntry("p3", "csomag p3", 60_010, 400_000, 610_000, true, cuts = 1),
        Focus.FocusLogEntry("p1", "csomag p1", 60_010, 450_000, 670_000, true, origin = 5),
        Focus.FocusLogEntry("p4", "csomag p4", 10, 900_000, 900_000, false),
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
        // TÁRS-MEGBÍZOTT ÉS A LEVETTEK NYOMA — öt húzás, feltétel nélkül, mint a gépen.
        val coDraw = r.next()
        val coPick = (r.next() * 3).toInt()
        val goneDraw = r.next()
        val gonePick = (r.next() * 3).toInt()
        val goneAt = 1L + (r.next() * 3).toInt()
        val partnerCo = if (coDraw < 0.25) listOf(partners[coPick]) else emptyList()
        val partnersGone = if (goneDraw < 0.2) listOf(PartnerLogic.PartnerGone(PartnerLogic.partnerId(partners[gonePick]), goneAt)) else emptyList()
        // A KULCSSZÓ-JELEK — három húzás, feltétel nélkül, mint a gépen.
        val kmDraw = r.next()
        val kmPick = (r.next() * 2).toInt()
        val kmValue = minOf(1 + (r.next() * 5).toInt(), rev)
        val keywordMarks = if (kmDraw < 0.35) mapOf(listOf("shorts", "reels")[kmPick] to kmValue) else null
        // A NAPLÓ — két húzás, feltétel nélkül, mint a gépen.
        val logDraw = r.next()
        val logPick = (r.next() * 5).toInt()
        val rows = if (logDraw < 0.5) logSets[logPick].map { logs[it] } else emptyList()
        // A MENET JELEI ÉS A SÍRKŐ — négy húzás, feltétel nélkül, mint a gépen:
        // rövidítette-e, eltolta-e az óra (eredeti kezdés 5), van-e sírkő, melyik.
        val cutsDraw = r.next()
        val originDraw = r.next()
        val tombDraw = r.next()
        val tombPick = (r.next() * tombs.size).toInt()
        val marked = run?.copy(
            cuts = if (cutsDraw < 0.25) 1 else 0,
            origin = if (originDraw < 0.2) 5L else null,
        )
        val log = if (tombDraw < 0.3) rows + tombs[tombPick] else rows
        return FocusSync.SyncFocus(
            packs = packs, run = marked, log = log, rev = rev.toLong(), updatedAt = updatedAt, updatedBy = device,
            packMarks = marks.ifEmpty { null },
            lockdown = lockdown, lockdownWindows = windows, lockdownWindowsRev = windowsRev,
            partner = partner, partnerRev = partnerRev, partnerCo = partnerCo, partnersGone = partnersGone,
            hideSiteList = hide, hideSiteListRev = hideRev,
            keywords = keywords, keywordsRev = keywordsRev, keywordMarks = keywordMarks,
        )
    }

    /**
     * A csomagok halmaza, a jelek, a rev, a napló és a többi jeles mező — és a
     * csomagok VÁLTOZATA is, kivéve azét, amin valamelyik bemenet menete fut.
     * A futó menet és a csomagja külön kérdés (a gép merge-fuzz.test.ts-e
     * kimondja): egy leváltott menetet a sírköve más sorrendben más ponton ér
     * el. A `withRun` nélküli kulcs ezeket kihagyja; a menetet a
     * `runSafety` és a sírkő nélküli esetek mérik.
     */
    private fun focusKey(f: FocusSync.SyncFocus, runIds: Set<String>, withRun: Boolean = true): String {
        val packs = f.packs.filter { withRun || it.id !in runIds }.sortedBy { it.id }.joinToString(",") {
            if (it.id in runIds) it.id
            else "${it.id}:${it.name}:${it.allowSites.sorted()}:${it.allowApps.sorted()}:${it.defaultMinutes}:${Focus.recurrenceKey(it.recurrence)}"
        }
        val marks = (f.packMarks ?: emptyMap()).toSortedMap().entries.joinToString(",") { "${it.key}=${it.value}" }
        val run = if (!withRun) "*" else f.run?.let { "${it.packId}/${it.startedAt}/${it.endsAt}/${it.cuts}/${it.origin}" } ?: "-"
        val lock = f.lockdown?.let { "${it.startedAt}/${it.until}" } ?: "-"
        val windows = f.lockdownWindows.map { LockdownLogic.windowKey(it.band) }.sorted().joinToString(";")
        return "$packs|$marks|$run|${f.rev}|$lock|$windows|${f.lockdownWindowsRev ?: 0}" +
            "|${if (f.hideSiteList) 1 else 0}|${f.hideSiteListRev ?: 0}" +
            "|${KeywordLogic.keywordsKey(f.keywords)}|${f.keywordsRev ?: 0}|${KeywordLogic.keywordMarksKey(f.keywordMarks)}" +
            "|${PartnerLogic.partnerKey(f.partner)}|${f.partnerRev ?: 0}" +
            "|" + f.partnerCo.joinToString(";") { PartnerLogic.partnerKey(it) } +
            "|" + f.partnersGone.joinToString(";") { "${it.id}@${it.at}" } +
            "|" + f.log.joinToString(";") {
                "${it.packId}/${it.startedAt}/${it.endedAt}/${it.plannedEndsAt}/${if (it.stopped) 1 else 0}/${if (it.window) 1 else 0}" +
                    "/${it.cuts}/${it.origin}"
            }
    }

    /** A fésült menet biztonsága: egy bemeneté, a csomagja a listán, a fésült napló nem zárja le. */
    private fun runSafety(m: FocusSync.SyncFocus, inputs: List<FocusSync.SyncFocus>, seed: Int) {
        val run = m.run ?: return
        assertTrue(inputs.any { it.run == run }, "a menet egy bemeneté, mag $seed")
        assertTrue(m.packs.any { it.id == run.packId }, "a menet csomagja a listán van, mag $seed")
        assertEquals(run, FocusSync.merge(m, m.copy(run = null), focusMergeNow).run, "a fésült napló nem zárja le, mag $seed")
    }

    /** Sorrendtől független-e a menet: nincs rövidítés, eltolás, és a menetre szóló sírkő. */
    private fun plainRuns(fs: List<FocusSync.SyncFocus>): Boolean =
        fs.all { it.run == null || (it.run!!.cuts == 0 && it.run!!.origin == null) } &&
            fs.none { f -> f.log.any { e -> fs.any { g -> g.run?.let { Focus.sameRun(e, it) } ?: false } } }

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
    fun `munkamenet-blob - a csomagok halmaza es a jelek sorrendtol fuggetlenek, a menet biztonsagos`() {
        for (seed in 1..300) {
            val r = Lcg(seed)
            val a = randomFocus(r, devices[0])
            val b = randomFocus(r, devices[1])
            val c = randomFocus(r, devices[2])
            val runIds = listOfNotNull(a.run?.packId, b.run?.packId, c.run?.packId).toSet()
            val full = { f: FocusSync.SyncFocus -> focusKey(f, runIds) }
            val noRun = { f: FocusSync.SyncFocus -> focusKey(f, runIds, withRun = false) }
            val now = focusMergeNow
            val ab = FocusSync.merge(a, b, now)
            assertEquals(full(ab), full(FocusSync.merge(b, a, now)), "szimmetria, mag $seed")
            assertEquals(full(FocusSync.merge(ab, ab, now)), full(ab), "idempotens, mag $seed")
            val abc = FocusSync.merge(ab, c, now)
            val bca = FocusSync.merge(FocusSync.merge(b, c, now), a, now)
            val cab = FocusSync.merge(FocusSync.merge(c, a, now), b, now)
            assertEquals(noRun(abc), noRun(bca), "három eszköz (bca), mag $seed")
            assertEquals(noRun(abc), noRun(cab), "három eszköz (cab), mag $seed")
            // Sírkő, rövidítés és eltolás nélkül a menet is sorrendtől független.
            if (plainRuns(listOf(a, b, c))) {
                assertEquals(abc.run, bca.run, "három eszköz, a menet (bca), mag $seed")
                assertEquals(abc.run, cab.run, "három eszköz, a menet (cab), mag $seed")
            }
            // A jeles csomag a nagyobb jel változatában marad: ha az egyik
            // oldalon ablakos csomag áll a nagyobb jellel, az ablak marad — a
            // futó menet csomagjánál is (csak a fehérlistája metszet).
            for (p in a.packs) {
                val ma = a.packMarks?.get(p.id) ?: 0
                val mb = b.packMarks?.get(p.id) ?: 0
                if (ma > mb && p.recurrence != null) {
                    assertNotNull(ab.packs.find { it.id == p.id }?.recurrence, "a nagyobb jel ablaka marad: ${p.id}, mag $seed")
                }
            }
            for (m in listOf(ab, abc, bca, cab)) runSafety(m, listOf(a, b, c), seed)
        }
    }
}
