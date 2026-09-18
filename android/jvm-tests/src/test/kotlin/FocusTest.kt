import hu.breaker.app.core.Focus
import hu.breaker.app.core.ScheduleLogic
import java.util.Calendar
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * A munkamenet magja Androidon.
 *
 * A telefonon a fehérlistát a DNS-szűrő érvényesíti, tehát ez a néhány függvény
 * dönti el, mi jön be és mi nem. Két hibafajta van, és mindkettő rossz:
 *
 *   - túl SZŰK: a telefon használhatatlan lesz (nem jön értesítés, a rendszer
 *     hálózati hibát jelez), és a felhasználó az appot fogja hibásnak tartani;
 *   - túl TÁG: a munkamenet nem ér semmit, mert a `notgoogle.com` átcsúszik.
 */
class FocusTest {

    private fun pack(vararg sites: String) = Focus.FocusPack(
        id = "pack_1",
        name = "Nyelvtanulás",
        allowSites = sites.toList(),
        allowApps = listOf("Word"),
        defaultMinutes = 50,
    )

    private val noBlocklist = emptyList<String>()

    @Test fun `a legutobb hasznalt csomag - a naplo szerint, torolt csomag nelkul, kulonben az elso`() {
        val a = pack("a.com").copy(id = "pack_a", name = "A")
        val b = pack("b.com").copy(id = "pack_b", name = "B")
        fun entry(id: String, at: Long) = Focus.FocusLogEntry(id, id, at, at + 60_000L, at + 60_000L, false)
        assertNull(Focus.lastUsedPack(emptyList(), emptyList()), "csomag nélkül nincs mit indítani")
        assertEquals(a, Focus.lastUsedPack(listOf(a, b), emptyList()), "napló nélkül az első")
        assertEquals(b, Focus.lastUsedPack(listOf(a, b), listOf(entry("pack_a", 1000L), entry("pack_b", 2000L))), "a legfrissebb sor")
        assertEquals(a, Focus.lastUsedPack(listOf(a, b), listOf(entry("pack_a", 1000L), entry("pack_x", 2000L))), "a törölt csomag sora nem számít")
    }

    // ---------------------------------------------------------- heti ablak
    //
    // A `focus-recurrence.test.ts` tükre: az ablak az ígéret (a kezdés mindig
    // az ablak kezdete, hogy a gép és a telefon ugyanazt a menetet állítsa
    // elő), és a napló az őr (ami ebben az ablakban egyszer indult, nem indul
    // újra — különben a leállítás próbatétele egy percig érne).

    /** Helyi idő — a mag is helyi időben gondolkodik, mint a menetrend. */
    private fun localMs(y: Int, m: Int, d: Int, h: Int, min: Int): Long =
        Calendar.getInstance().apply { clear(); set(y, m - 1, d, h, min) }.timeInMillis

    private val weekdays = ScheduleLogic.Band(setOf(1, 2, 3, 4, 5), 9 * 60, 12 * 60)
    private fun windowed(id: String = "pack_1") = pack("github.com").copy(id = id, recurrence = weekdays)

    @Test
    fun `az ablak mostani elofordulasa helyi idoben, a veg mar nincs benne`() {
        // 2026. szeptember 7. hétfő.
        val occ = Focus.occurrenceAt(weekdays, localMs(2026, 9, 7, 9, 30))!!
        assertEquals(localMs(2026, 9, 7, 9, 0), occ.startsAt)
        assertEquals(localMs(2026, 9, 7, 12, 0), occ.endsAt)
        assertNull(Focus.occurrenceAt(weekdays, localMs(2026, 9, 7, 12, 0)), "a vég perce már nincs benne")
        assertNull(Focus.occurrenceAt(weekdays, localMs(2026, 9, 6, 10, 0)), "vasárnap nem")
        // Éjfélen át: a hétfő esti ablak a kedd hajnalt is fedi.
        val night = ScheduleLogic.Band(setOf(1), 22 * 60, 6 * 60)
        val dawn = Focus.occurrenceAt(night, localMs(2026, 9, 8, 1, 0))!!
        assertEquals(localMs(2026, 9, 7, 22, 0), dawn.startsAt)
        assertEquals(localMs(2026, 9, 8, 6, 0), dawn.endsAt)
    }

    @Test
    fun `a kovetkezo elofordulas - a mostani, kulonben a legkozelebbi kezdes`() {
        // Hétfő 9:30: benne vagyunk — a mostani.
        val live = Focus.nextOccurrence(weekdays, localMs(2026, 9, 7, 9, 30))!!
        assertEquals(localMs(2026, 9, 7, 9, 0), live.startsAt)
        // Hétfő 13:00: a keddi.
        val tue = Focus.nextOccurrence(weekdays, localMs(2026, 9, 7, 13, 0))!!
        assertEquals(localMs(2026, 9, 8, 9, 0), tue.startsAt)
        assertEquals(localMs(2026, 9, 8, 12, 0), tue.endsAt)
        // Péntek 13:00: a hétfői — a hétvégét átugorja.
        val mon = Focus.nextOccurrence(weekdays, localMs(2026, 9, 11, 13, 0))!!
        assertEquals(localMs(2026, 9, 14, 9, 0), mon.startsAt)
        // Hétfő 8:59: a mai, egy perc múlva.
        assertEquals(localMs(2026, 9, 7, 9, 0), Focus.nextOccurrence(weekdays, localMs(2026, 9, 7, 8, 59))!!.startsAt)
    }

    @Test
    fun `menetrend szerinti inditas - az ablak kezdesevel, es a naplo az or`() {
        val now = localMs(2026, 9, 7, 9, 30)
        val due = Focus.dueRecurrence(listOf(windowed()), null, emptyList(), now)!!
        assertEquals(localMs(2026, 9, 7, 9, 0), due.startsAt, "a kezdés az ablaké, nem a mostani perc")
        assertEquals(localMs(2026, 9, 7, 12, 0), due.endsAt)
        assertNull(
            Focus.dueRecurrence(listOf(windowed()), null, emptyList(), localMs(2026, 9, 7, 8, 0)),
            "ablakon kívül nem",
        )

        // A csomag SAJÁT futó menete mellett nincs esedékes; egy MÁSIK csomag
        // kézi menete nem tartja vissza az ablakot — azt a kör zárja le.
        val own = Focus.FocusRun("pack_1", now - 1000, now + 1000)
        assertNull(Focus.dueRecurrence(listOf(windowed()), own, emptyList(), now), "a saját menete fut")
        val other = Focus.FocusRun("other", now - 1000, now + 1000)
        assertTrue(Focus.dueRecurrence(listOf(windowed()), other, emptyList(), now) != null, "a másik csomag menete nem véd")

        // A leállított menet sora az ablak SAJÁT menete (a kezdése az ablaké): nem indul újra.
        val stopped = Focus.FocusLogEntry("pack_1", "x", due.startsAt, now, due.endsAt, true)
        assertNull(Focus.dueRecurrence(listOf(windowed()), null, listOf(stopped), now + 60_000))
        // A csomag kézi menete az ablakon belül (nem az ablak kezdésével) nem költi el.
        val manual = Focus.FocusLogEntry("pack_1", "x", due.startsAt + 5_000, due.startsAt + 65_000, due.startsAt + 65_000, false)
        assertTrue(Focus.dueRecurrence(listOf(windowed()), null, listOf(manual), now + 60_000) != null, "az egyperces kézi menet nem váltja ki")
        // Másnap viszont igen.
        assertTrue(
            Focus.dueRecurrence(listOf(windowed()), null, listOf(stopped), localMs(2026, 9, 8, 9, 30)) != null,
        )
        // Egy percnél kevesebb hátralévő idővel nem indul.
        assertNull(Focus.dueRecurrence(listOf(windowed()), null, emptyList(), due.endsAt - 30_000))

        assertTrue(Focus.isWindowRun(Focus.FocusRun("pack_1", due.startsAt, due.endsAt), listOf(windowed())))
        assertFalse(
            Focus.isWindowRun(Focus.FocusRun("pack_1", due.startsAt, due.endsAt + 60_000), listOf(windowed())),
            "a meghosszabbított menet már kézi",
        )
    }

    @Test
    fun `az ablak tisztitasa - ervenyes sav, legfeljebb nyolc ora`() {
        assertEquals(weekdays, Focus.cleanRecurrence(weekdays))
        assertNull(Focus.cleanRecurrence(ScheduleLogic.Band(emptySet(), 540, 720)), "nap nélkül nem")
        assertNull(Focus.cleanRecurrence(ScheduleLogic.Band(setOf(1), 0, 1440)), "huszonnégy óra nem munkamenet")
        assertNull(Focus.cleanRecurrence(null))
    }

    @Test
    fun `aldomain atmegy, a vegen hasonlito nev nem`() {
        val p = pack("google.com")
        assertTrue(Focus.isSiteAllowed(p, "translate.google.com"))
        assertTrue(Focus.isSiteAllowed(p, "google.com"))
        // Ez a megtévesztés klasszikus alakja: a végén stimmel, mégis más
        // tartomány. Ha ez átmenne, a fehérlista bármivel megkerülhető lenne.
        assertFalse(Focus.isSiteAllowed(p, "notgoogle.com"))
        assertFalse(Focus.isSiteAllowed(p, "google.com.evil.example"))
    }

    @Test
    fun `a blokklista eros a munkamenetnel`() {
        // A csomagba felvett tiltott oldal NEM oldódik fel. Enélkül a
        // munkamenet lenne a kiskapu a blokklistán: felveszem a youtube.com-ot
        // egy csomagba, elindítom, és próbatétel nélkül megnyílik.
        val p = pack("youtube.com")
        val run = Focus.FocusRun("pack_1", 0L, 10_000L)
        assertEquals(
            Focus.Verdict.BLOCKED_BY_LIST,
            Focus.verdict("youtube.com", run, p, 1_000L, listOf("youtube.com")),
        )
    }

    @Test
    fun `kulcsszo a hosztnevben - tilt, az infrastruktura es a fiokkiszolgalo nem, a lista elsobb`() {
        val kw = listOf("tiktok", "live")
        assertEquals(Focus.Verdict.BLOCKED_BY_KEYWORD, Focus.verdict("www.TikTok.com.", null, null, 0L, noBlocklist, null, kw))
        assertEquals(Focus.Verdict.ALLOW, Focus.verdict("example.com", null, null, 0L, noBlocklist, null, kw))
        assertEquals(Focus.Verdict.ALLOW, Focus.verdict("mtalk.google.com", null, null, 0L, noBlocklist, null, listOf("google")), "infrastruktúra: sosem")
        assertEquals(Focus.Verdict.ALLOW, Focus.verdict("live.example.org", null, null, 0L, noBlocklist, "live.example.org", kw), "a fiókkiszolgáló: sosem")
        assertEquals(Focus.Verdict.BLOCKED_BY_LIST, Focus.verdict("tiktok.com", null, null, 0L, listOf("tiktok.com"), null, kw), "a lista elsőbb")
        assertEquals(Focus.Verdict.ALLOW, Focus.verdict("tiktok.com", null, null, 0L, noBlocklist, null, emptyList()), "kulcsszó nélkül nincs")
        // Munkamenet alatt is a kulcsszó tilt — a csomag fehérlistája sem old fel.
        val run = Focus.FocusRun("pack_1", 0L, 10_000L)
        assertEquals(Focus.Verdict.BLOCKED_BY_KEYWORD, Focus.verdict("m.tiktok.com", run, pack("tiktok.com"), 1_000L, noBlocklist, null, kw))
    }

    @Test
    fun `mi lenne ezzel - a proba mondata ugyanaz az itelet, szoban`() {
        val kw = listOf("tiktok")
        assertEquals("Tiltva: a lista.", Focus.explain("youtube.com", null, null, 0L, listOf("youtube.com"), null, kw))
        assertEquals("Tiltva: kulcsszó a hosztnévben („tiktok”).", Focus.explain("www.tiktok.com", null, null, 0L, noBlocklist, null, kw))
        val run = Focus.FocusRun("pack_1", 0L, 10_000L)
        assertEquals("Tiltva, amíg a munkamenet tart: nincs a csomagon.", Focus.explain("reddit.com", run, pack("quizlet.com"), 1_000L, noBlocklist, null, kw))
        assertEquals("Átmegy: rendszer-infrastruktúra.", Focus.explain("mtalk.google.com", run, pack("quizlet.com"), 1_000L, noBlocklist, null, kw))
        assertEquals("Átmegy.", Focus.explain("example.com", null, null, 0L, noBlocklist, null, kw))
        assertEquals("", Focus.explain("  ", null, null, 0L, noBlocklist, null, kw), "üres név: nincs mondat")
    }

    @Test
    fun `munkamenet nelkul minden mehet, amit a blokklista enged`() {
        assertEquals(
            Focus.Verdict.ALLOW,
            Focus.verdict("example.com", null, null, 1_000L, noBlocklist),
        )
        // Lejárt munkamenet ugyanaz, mint a nincs: a fehérlista nem ragad be.
        val expired = Focus.FocusRun("pack_1", 0L, 500L)
        assertEquals(
            Focus.Verdict.ALLOW,
            Focus.verdict("example.com", expired, pack("a.com"), 1_000L, noBlocklist),
        )
    }

    @Test
    fun `munkamenet alatt a listan kivul minden tiltva`() {
        val p = pack("quizlet.com")
        val run = Focus.FocusRun("pack_1", 0L, 10_000L)
        assertEquals(
            Focus.Verdict.ALLOW,
            Focus.verdict("quizlet.com", run, p, 1_000L, noBlocklist),
        )
        assertEquals(
            Focus.Verdict.BLOCKED_BY_FOCUS,
            Focus.verdict("reddit.com", run, p, 1_000L, noBlocklist),
        )
    }

    @Test
    fun `a rendszer-infrastruktura atmegy`() {
        // Enélkül a munkamenet nem korlátozná a telefont, hanem elrontaná:
        // értesítés nem jön, a rendszer hálózati hibát jelez.
        val p = pack("quizlet.com")
        val run = Focus.FocusRun("pack_1", 0L, 10_000L)
        for (h in listOf("mtalk.google.com", "connectivitycheck.gstatic.com", "0.pool.ntp.org")) {
            assertEquals(
                Focus.Verdict.ALLOW, Focus.verdict(h, run, p, 1_000L, noBlocklist),
                "az infrastruktúrának át kell mennie: $h",
            )
        }
        // De a kivétellista SEM erősebb a blokklistánál.
        assertEquals(
            Focus.Verdict.BLOCKED_BY_LIST,
            Focus.verdict("mtalk.google.com", run, p, 1_000L, listOf("mtalk.google.com")),
        )
    }

    @Test
    fun `a sajat fiokkiszolgalo atmegy`() {
        // Enélkül a telefon a munkamenet alatt nem látná, ha egy MÁSIK eszközön
        // leállítod — egy zár, amit a saját kulcsod sem ér el, nem zár.
        val p = pack("quizlet.com")
        val run = Focus.FocusRun("pack_1", 0L, 10_000L)
        assertEquals(
            Focus.Verdict.ALLOW,
            Focus.verdict("sync.pelda.hu", run, p, 1_000L, noBlocklist, syncHost = "sync.pelda.hu"),
        )
        assertEquals(
            Focus.Verdict.BLOCKED_BY_FOCUS,
            Focus.verdict("mas.pelda.hu", run, p, 1_000L, noBlocklist, syncHost = "sync.pelda.hu"),
        )
    }

    @Test
    fun `a hossz normalizalasa ugyanaz, mint a gepen`() {
        assertEquals(43, Focus.normalizeMinutes(43.0))
        assertEquals(43, Focus.normalizeMinutes(42.6))
        assertNull(Focus.normalizeMinutes(0.0))
        assertNull(Focus.normalizeMinutes(null))
        assertNull(Focus.normalizeMinutes(Double.NaN))
        assertEquals(Focus.MAX_SESSION_MINUTES, Focus.normalizeMinutes(99_999.0))
    }

    @Test
    fun `a hosszabbitas ingyen, a rovidites nem`() {
        assertFalse(Focus.isSessionLoosening(1_000L, 2_000L))
        assertFalse(Focus.isSessionLoosening(1_000L, 1_000L))
        assertTrue(Focus.isSessionLoosening(1_000L, 500L))
    }

    @Test
    fun `a hatralevo ido szovege egyezik a gepevel`() {
        assertEquals("kevesebb mint egy perc", Focus.formatRemaining(30_000L))
        assertEquals("42 perc", Focus.formatRemaining(42 * 60_000L))
        assertEquals("1 óra", Focus.formatRemaining(60 * 60_000L))
        assertEquals("1 ó 12 p", Focus.formatRemaining(72 * 60_000L))
        assertEquals("kevesebb mint egy perc", Focus.formatRemaining(-5L))
    }

    @Test
    fun `az app-egyezes mindket iranyban reszleges`() {
        val p = pack("a.com")
        assertTrue(Focus.isAppAllowed(p, "Microsoft Word"))
        assertTrue(Focus.isAppAllowed(p, "word"))
        assertFalse(Focus.isAppAllowed(p, "Excel"))
        assertFalse(Focus.isAppAllowed(p, ""))
    }

    private fun entry(startedAt: Long, endedAt: Long) = Focus.FocusLogEntry(
        packId = "p1", packName = "Nyelvtanulás", startedAt = startedAt, endedAt = endedAt,
        plannedEndsAt = endedAt, stopped = false,
    )

    private fun localTime(hour: Int, minute: Int): Long = Calendar.getInstance().apply {
        set(2026, Calendar.SEPTEMBER, 5, hour, minute, 0); set(Calendar.MILLISECOND, 0)
    }.timeInMillis

    @Test
    fun `az elozo het - a 13 nap kezdetetol a 6 nap kezdeteig, a hatar a mostani hete`() {
        val now = localTime(12, 0)
        val start = Calendar.getInstance().apply {
            timeInMillis = now
            set(Calendar.HOUR_OF_DAY, 0); set(Calendar.MINUTE, 0); set(Calendar.SECOND, 0); set(Calendar.MILLISECOND, 0)
        }.timeInMillis
        val day = 86_400_000L
        val log = listOf(
            entry(start - 6 * day, start - 6 * day + 1),   // a mostani hét első pillanata
            entry(start - 7 * day, start - 6 * day - 1),   // az előző hét utolsó pillanata
            entry(start - 13 * day, start - 13 * day),     // az előző hét első pillanata
            entry(start - 14 * day, start - 13 * day - 1), // már nem
        )
        assertEquals(2, Focus.summarizeFocusPrevWeek(log, now).sessions, "a 13. nap kezdete és a 6. nap kezdete előtti pillanat benne")
        assertEquals(1, Focus.summarizeFocus(log, start - 6 * day, now).sessions, "a mostani hét a maradék")
        assertEquals(0, Focus.summarizeFocusPrevWeek(emptyList(), now).sessions)
    }

    @Test
    fun `naponta - a menet a vegenek napjara szamit, a het a legregebbitol a maiig`() {
        val day = 86_400_000L
        val hour = 3_600_000L
        val now = localTime(20, 0)
        val log = listOf(
            entry(now - 3 * hour, now - 2 * hour),                     // ma, 1 óra
            entry(now - day - hour, now - day),                         // tegnap, 1 óra
            entry(now - day - 30 * 60_000L, now - day + 10 * 60_000L),  // tegnap, 40 perc
            entry(now - 10 * day, now - 10 * day + hour),               // tíz napja: kiesik
            entry(now + hour, now + 2 * hour),                          // a jövő: kiesik
        )
        val s = Focus.daySeries(log, now, 7)
        assertEquals(7, s.size)
        assertEquals(hu.breaker.app.core.UsageLogic.dayKey(now), s[6].first, "az utolsó oszlop a mai nap")
        assertEquals(3600.0, s[6].second)
        assertEquals(6000.0, s[5].second, "tegnap: egy óra és negyven perc")
        assertEquals(listOf(0.0, 0.0, 0.0, 0.0, 0.0), s.take(5).map { it.second })
    }

    @Test
    fun `le van-e fedve az ora - a sav egy napon az ora egy reszet is atfogja, a fedo csomag az elso`() {
        val band = ScheduleLogic.Band(setOf(1, 2, 3, 4, 5), 21 * 60, 22 * 60)
        assertEquals(true, Focus.bandCoversHour(band, 21))
        assertEquals(false, Focus.bandCoversHour(band, 22), "az ablak vége nem fedi a következő órát")
        assertEquals(false, Focus.bandCoversHour(band, 20))
        assertEquals(true, Focus.bandCoversHour(ScheduleLogic.Band(setOf(0), 21 * 60 + 30, 23 * 60), 21), "a fél óra is fedés")
        assertEquals(false, Focus.bandCoversHour(ScheduleLogic.Band(emptySet(), 0, 1440), 5), "nap nélkül nem ablak")
        val a = pack("a.com")
        val b = pack("b.com").copy(id = "pack_b", recurrence = ScheduleLogic.Band(setOf(0, 1, 2, 3, 4, 5, 6), 21 * 60, 22 * 60))
        assertEquals("pack_b", Focus.packCoveringHour(listOf(a, b), 21)?.id)
        assertEquals(null, Focus.packCoveringHour(listOf(a, b), 9))
        assertEquals(null, Focus.packCoveringHour(emptyList(), 21))
    }

    @Test
    fun `a naplosor tudja, hogy az ablakbol indult - a lezaras irja, az osszegzes szamolja`() {
        val p = pack("w.com").copy(id = "w", name = "Ablakos", recurrence = Focus.peakWindowBand(21))
        val cal = java.util.Calendar.getInstance().apply {
            set(2026, java.util.Calendar.SEPTEMBER, 18, 21, 0, 0); set(java.util.Calendar.MILLISECOND, 0)
        }
        val start = cal.timeInMillis
        val run = Focus.FocusRun("w", start, start + 3_600_000L)
        val closed = Focus.closeIfEnded(run, listOf(p), emptyList(), start + 3_600_001L)
        assertEquals(true, closed?.log?.single()?.window, "az ablak előfordulása: ablakból indult")
        val manual = Focus.FocusRun("w", start + 300_000L, start + 3_600_000L)
        assertEquals(false, Focus.closeIfEnded(manual, listOf(p), emptyList(), start + 3_600_001L)?.log?.single()?.window, "a kézi menet nem ablak")
        assertEquals(true, Focus.closeRun(run, "Ablakos", start + 3_600_000L, false, true).window)
        assertEquals(false, Focus.closeRun(run, "Ablakos", start + 3_600_000L, false).window)
        val log = listOf(
            Focus.FocusLogEntry("a", "A", 1_000L, 2_000L, 2_000L, false, window = true),
            Focus.FocusLogEntry("b", "B", 2_000L, 3_000L, 3_000L, false),
            Focus.FocusLogEntry("c", "C", 3_000L, 4_000L, 4_000L, false, window = true),
        )
        assertEquals(2, Focus.summarizeFocus(log, 0, 10_000L).windowRuns)
        assertEquals(0, Focus.summarizeFocus(emptyList(), 0, 1L).windowRuns)
        // Csomagonként: a csomag sora ebből mondja, hányszor indult magától a héten.
        val perPack = log + Focus.FocusLogEntry("a", "A", 8_000L, 9_000L, 9_000L, false, window = true)
        assertEquals(mapOf("a" to 1, "c" to 1), Focus.windowRunsByPack(perPack, 0, 5_000L), "csak az ablakos sorok, csak az ablakban")
        assertEquals(emptyMap(), Focus.windowRunsByPack(null, 0, 5_000L))
    }

    @Test
    fun `az ejfelen atnyulo menet a vegenek napjara szamit egeszben`() {
        val now = localTime(20, 0)
        val midnight = localTime(0, 0)
        val s = Focus.daySeries(listOf(entry(midnight - 30 * 60_000L, midnight + 30 * 60_000L)), now, 7)
        assertEquals(3600.0, s[6].second, "a mai napon egy óra")
        assertEquals(0.0, s[5].second, "tegnap semmi")
        assertEquals(listOf(0.0, 0.0, 0.0), Focus.daySeries(emptyList(), now, 3).map { it.second })
    }

    @Test
    fun `a menet-nap - negy hetbol, a het napjaira osztva, a menet a vegenek napjara szamit`() {
        val day = 86_400_000L
        val hour = 3_600_000L
        val now = localTime(20, 0)
        val log = listOf(
            entry(now - 3 * hour, now - 2 * hour),            // ma
            entry(now - 5 * hour, now - 4 * hour),            // ma
            entry(now - 7 * day - hour, now - 7 * day),       // egy hete, ugyanaz a nap
            entry(now - day - hour, now - day),               // tegnap
            entry(now - 28 * day - hour, now - 28 * day),     // huszonnyolc napja: kiesik
            entry(now + hour, now + 2 * hour),                // a jövő: kiesik
        )
        val by = Focus.byWeekday(log, now)
        val today = hu.breaker.app.core.FilterHitLogic.weekdayOf(hu.breaker.app.core.UsageLogic.dayKey(now))
        assertEquals(7, by.size)
        assertEquals(3, by[today], "ma kettő és egy hete egy: három")
        assertEquals(1, by[(today + 6) % 7], "tegnap egy")
        assertEquals(4, by.sum(), "a huszonnyolc napos és a jövő nem számít")
        assertEquals(today to 3, hu.breaker.app.core.FilterHitLogic.peakWeekday(by), "a csúcs szabálya a csúcs-napéval közös")
        assertEquals("A négy hét menet-napja: kedd (6 menet).", Focus.weekdayText(2 to 6))
        assertEquals(listOf(0, 0, 0, 0, 0, 0, 0), Focus.byWeekday(emptyList(), now))
    }

    @Test
    fun `a menet-nap a dontes napjan - a kartya mondata`() {
        assertEquals("Ma a négy hét menet-napja van (kedd, 6 menet) — ilyenkor szoktál leülni.", Focus.dayNowText(2 to 6))
    }

    @Test
    fun `a menet-ora - negy hetbol, az indulas oraja szerint, holtversenynel a korabbi ora`() {
        val day = 86_400_000L
        val hour = 3_600_000L
        val now = localTime(20, 0)
        val log = listOf(
            entry(now - 3 * hour, now - 2 * hour),            // ma, 17-kor indult
            entry(now - 5 * hour, now - 4 * hour),            // ma, 15-kor
            entry(now - 7 * day - hour, now - 7 * day),       // egy hete, 19-kor
            entry(now - day - hour, now - day),               // tegnap, 19-kor
            entry(now - 28 * day - hour, now - 28 * day),     // huszonnyolc napja: kiesik
            entry(now + hour, now + 2 * hour),                // a jövő: kiesik
        )
        val by = Focus.byHour(log, now)
        assertEquals(24, by.size)
        assertEquals(2, by[19], "tizenkilenckor kettő")
        assertEquals(1, by[17])
        assertEquals(1, by[15])
        assertEquals(4, by.sum(), "a huszonnyolc napos és a jövő nem számít")
        assertEquals(19 to 2, Focus.peakHour(by))
        assertEquals(1 to 2, Focus.peakHour(listOf(0, 2, 0, 2)), "holtverseny: a korábbi óra")
        assertEquals(null, Focus.peakHour(List(24) { 0 }))
        assertEquals("A négy hét menet-órája: 9–10 óra (6 menet).", Focus.hourText(9 to 6))
        assertEquals(List(24) { 0 }, Focus.byHour(emptyList(), now))
    }

    @Test
    fun `a menet-ora a dontes orajaban - most van-e, es csak eleg mintabol`() {
        val at9 = localTime(9, 30)
        val at10 = localTime(10, 0)
        assertEquals(true, Focus.isHourNow(9 to 6, at9))
        assertEquals(false, Focus.isHourNow(9 to 6, at10), "más órában nem")
        assertEquals(false, Focus.isHourNow(9 to 2, at9), "kevés minta: nem mondat")
        assertEquals(false, Focus.isHourNow(null, at9))
        assertEquals("Most a menet-órád van (9–10 óra, 6 menet) — ilyenkor szoktál elkezdeni.", Focus.hourNowText(9 to 6))
    }
}
