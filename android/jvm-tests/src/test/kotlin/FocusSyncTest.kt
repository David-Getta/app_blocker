import hu.breaker.app.core.AppState
import hu.breaker.app.core.Focus
import hu.breaker.app.core.FocusSync
import hu.breaker.app.core.SyncRevisions
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * A munkamenet szinkronja Androidon.
 *
 * A tesztek SZÁNDÉKOSAN úgy állítják be a döntetlen-eltörést, hogy az utolsó
 * írót előnyben részesítő szabály a ROSSZ oldalt választaná. Enélkül egy elrontott
 * összefésülés mellett is átmennének, és pont azt nem vennék észre, ami ellen
 * készültek.
 */
class FocusSyncTest {

    private fun pack(id: String = "p1") = Focus.FocusPack(
        id = id, name = "Nyelvtanulás",
        allowSites = listOf("quizlet.com"), allowApps = listOf("Word"), defaultMinutes = 50,
    )

    @Test
    fun `a futo menetet egy nem futo allapot nem kapcsolja ki`() {
        val running = FocusSync.SyncFocus(
            packs = listOf(pack()),
            run = Focus.FocusRun("p1", 0, 10_000),
            rev = 4, updatedAt = 100, updatedBy = "eszkoz-a",
        )
        // Az újabb ÉS a később rendezett azonosító az üres oldalé.
        val stale = FocusSync.SyncFocus(
            packs = listOf(pack()), run = null, rev = 4, updatedAt = 500, updatedBy = "eszkoz-z",
        )
        assertEquals(running.run, FocusSync.merge(running, stale).run)
        assertEquals(running.run, FocusSync.merge(stale, running).run)
    }

    @Test
    fun `a leallitas nagyobb rev-vel atmegy`() {
        val running = FocusSync.SyncFocus(
            packs = listOf(pack()), run = Focus.FocusRun("p1", 0, 10_000),
            rev = 4, updatedAt = 100, updatedBy = "eszkoz-a",
        )
        val stopped = FocusSync.SyncFocus(
            packs = listOf(pack()), run = null, rev = 5, updatedAt = 110, updatedBy = "eszkoz-b",
        )
        assertNull(FocusSync.merge(running, stopped).run)
        assertNull(FocusSync.merge(stopped, running).run)
    }

    @Test
    fun `a hosszabbitas azonos rev mellett is nyer`() {
        val shorter = FocusSync.SyncFocus(
            packs = listOf(pack()), run = Focus.FocusRun("p1", 0, 5_000),
            rev = 2, updatedAt = 500, updatedBy = "eszkoz-z",
        )
        val longer = FocusSync.SyncFocus(
            packs = listOf(pack()), run = Focus.FocusRun("p1", 0, 9_000),
            rev = 2, updatedAt = 100, updatedBy = "eszkoz-a",
        )
        assertEquals(9_000, FocusSync.merge(shorter, longer).run?.endsAt)
        assertEquals(9_000, FocusSync.merge(longer, shorter).run?.endsAt)
    }

    @Test
    fun `az osszefesules sorrendfuggetlen es idempotens`() {
        val a = FocusSync.SyncFocus(packs = listOf(pack("p1")), rev = 3, updatedAt = 100, updatedBy = "a")
        val b = FocusSync.SyncFocus(packs = listOf(pack("p2")), rev = 3, updatedAt = 100, updatedBy = "b")
        assertTrue(FocusSync.same(FocusSync.merge(a, b), FocusSync.merge(b, a)))
        val once = FocusSync.merge(a, b)
        assertTrue(FocusSync.same(FocusSync.merge(once, b), once))
    }

    @Test
    fun `a futas kiesik, ha a csomagja nincs meg`() {
        // Nem tippelünk: egy futás ismeretlen csomaggal azt jelentené, hogy
        // tiltunk mindent, és nem tudjuk megmondani, mi az, ami mehet.
        assertNull(FocusSync.cleanRun(Focus.FocusRun("nincs", 0, 9_000), listOf(pack("p1"))))
        assertEquals("p1", FocusSync.cleanRun(Focus.FocusRun("p1", 0, 9_000), listOf(pack("p1")))?.packId)
    }

    @Test
    fun `az ures allapot nem lepteti a szamlalot`() {
        // EZ A LÉNYEG. Ha léptetne, a telefon az első szinkronnál a semmiből
        // 1-es számlálót kapna, az ideje frissebb lenne a gépénél, és az ÜRES
        // listája nyerne — csendben letörölve a gépen felvett összes csomagot.
        val fresh = AppState()
        val after = SyncRevisions.bumpFocus(fresh, "telefon", 1_000)
        assertEquals(0, after.focusRev, "egy üres eszköz 0-n marad")
        assertNotEquals(null, after.focusRevFp, "de a lenyomatot már ismeri")

        // Egy VALÓDI változás viszont léptet.
        val withPack = after.copy(focusPacks = listOf(pack()))
        val bumped = SyncRevisions.bumpFocus(withPack, "telefon", 2_000)
        assertEquals(1, bumped.focusRev)
        assertEquals(2_000, bumped.focusUpdatedAt)

        // Változatlan állapot nem léptet újra — enélkül a két eszköz örökké
        // írogatná egymást.
        assertEquals(bumped, SyncRevisions.bumpFocus(bumped, "telefon", 3_000))
    }

    @Test
    fun `az ora-ugras elnyelese nem lepteti a szamlalot`() {
        // Alvásból ébredve az app elnyeli az óra ugrását: a futó menet
        // kezdését és végét ugyanannyival tolja el, hogy ne legyen lejárt. Ez
        // NEM döntés, csak helyi újraértelmezés — a felhasználó nem csinált
        // semmit.
        //
        // A lenyomat viszont korábban az abszolút időpontokat nézte, tehát az
        // eltolás változásnak látszott és léptetett. Következmény: az alvó
        // telefon „még fut” állapota legyőzte az ébren lévő gép szabályos,
        // próbatétellel megszerzett lezárását — a menet VISSZATÉRT.
        val base = SyncRevisions.bumpFocus(
            AppState(focusPacks = listOf(pack("p1"))).copy(
                focusRun = Focus.FocusRun("p1", 1_000_000, 1_000_000 + 50 * 60_000),
            ),
            "telefon", 1_000,
        )
        val shift = 8L * 3_600_000
        val shifted = base.copy(
            focusRun = base.focusRun!!.copy(
                startedAt = base.focusRun!!.startedAt + shift,
                endsAt = base.focusRun!!.endsAt + shift,
            ),
        )
        val after = SyncRevisions.bumpFocus(shifted, "telefon", 2_000)
        assertEquals(base.focusRev, after.focusRev, "egy eltolás nem szerkesztés")

        // A HOSSZ változása viszont valódi döntés, és léptet.
        val longer = shifted.copy(
            focusRun = shifted.focusRun!!.copy(endsAt = shifted.focusRun!!.endsAt + 600_000),
        )
        assertEquals(base.focusRev + 1, SyncRevisions.bumpFocus(longer, "telefon", 3_000).focusRev)
    }

    @Test
    fun `a formatumvaltas onmagaban nem leptet, a szerkesztest megsem nyeli el`() {
        // Frissítés után a mentésben a RÉGI alakú lenyomat van. Ha ilyenkor a
        // kör vakon léptetne, egy üres telefon 1-esre ugrana, és az üres
        // listája legyőzhetné a gépen felvett csomagokat.
        val st = AppState(focusPacks = listOf(pack("p1")))
        val old = st.copy(focusRevFp = SyncRevisions.focusFingerprintV1(st), focusRev = 4)
        val migrated = SyncRevisions.bumpFocus(old, "telefon", 5_000)
        assertEquals(4, migrated.focusRev, "a formátumváltás nem szerkesztés")
        assertTrue(migrated.focusRevFp!!.startsWith(SyncRevisions.FOCUS_FP_V2))

        // De ha közben VOLT szerkesztés, azt nem nyelheti el: az a változás
        // különben soha nem érne át a többi eszközre — csendben.
        val edited = old.copy(focusPacks = listOf(pack("p1"), pack("p2")))
        assertEquals(5, SyncRevisions.bumpFocus(edited, "telefon", 6_000).focusRev)
    }

    @Test
    fun `az indulo menet is lepteti a szamlalot`() {
        // Ha a futás kimaradna a lenyomatból, az indítás sosem léptetne, és a
        // másik eszköz soha nem tudná meg, hogy fut valami.
        val withPack = SyncRevisions.bumpFocus(
            AppState().copy(focusPacks = listOf(pack())), "gep", 1_000,
        )
        val started = withPack.copy(focusRun = Focus.FocusRun("p1", 1_000, 9_000))
        val bumped = SyncRevisions.bumpFocus(started, "gep", 2_000)
        assertEquals(withPack.focusRev + 1, bumped.focusRev)
    }

    // -----------------------------------------------------------------------
    // A NAPLÓ. Más a szabálya, mint a fenti kettőnek, és a különbség szándékos:
    // a csomagok és a futás ENGEDÉLYEK, a napló a MÚLT feljegyzése.

    private fun entry(
        packId: String = "p1", startedAt: Long = 1_000, endedAt: Long = 4_000,
        plannedEndsAt: Long = 4_000, stopped: Boolean = false,
    ) = Focus.FocusLogEntry(packId, "Nyelvtanulás", startedAt, endedAt, plannedEndsAt, stopped)

    @Test
    fun `a naplo EGYESUL, egyik eszkoz sorai sem vesznek el`() {
        // A döntetlen-eltörést SZÁNDÉKOSAN a másik oldal javára állítjuk. Ha a
        // napló az „utolsó író nyer” szabályt követné — mint a csomagok —, a gép
        // sorai eltűnnének, és a felhasználó azt látná, hogy fél hete nem
        // dolgozott.
        val gep = FocusSync.SyncFocus(
            log = listOf(entry(startedAt = 1_000, endedAt = 4_000)),
            rev = 3, updatedAt = 100, updatedBy = "eszkoz-a",
        )
        val telefon = FocusSync.SyncFocus(
            log = listOf(entry(startedAt = 9_000, endedAt = 12_000)),
            rev = 3, updatedAt = 500, updatedBy = "eszkoz-z",
        )
        for (m in listOf(FocusSync.merge(gep, telefon), FocusSync.merge(telefon, gep))) {
            assertEquals(listOf(1_000L, 9_000L), m.log.map { it.startedAt })
        }
    }

    @Test
    fun `ugyanazt a menetet ketszer lezarva EGY sor lesz, a korabbi veggel`() {
        // Ez a gyakori eset, nem a kivétel: a telefonon próbatétellel leállítod,
        // a gép meg később, a szinkronból veszi észre. Ha nem fésülődne össze,
        // minden ilyen menet KETTŐNEK számítana.
        val telefon = FocusSync.SyncFocus(log = listOf(entry(endedAt = 3_000, stopped = true)))
        val gep = FocusSync.SyncFocus(log = listOf(entry(endedAt = 3_500, stopped = true)))
        for (m in listOf(FocusSync.merge(telefon, gep), FocusSync.merge(gep, telefon))) {
            assertEquals(1, m.log.size, "egy menet — egy sor")
            assertEquals(3_000, m.log[0].endedAt, "a menet akkor ért véget, amikor véget ért")
        }
    }

    @Test
    fun `a naplo NEM tud leallitani egy futo menetet`() {
        // EZ A LÉNYEG. Ha a napló a `rev`-hez lenne kötve, egy statisztika-sor
        // léptetné a számlálót, a nagyobb `rev` pedig azt jelentené, hogy annak
        // az eszköznek a „nem fut” állapota nyer — vagyis egy naplósorral ki
        // lehetne kapcsolni a másik gépen futó menetet, próbatétel nélkül.
        val fut = FocusSync.SyncFocus(
            packs = listOf(pack()), run = Focus.FocusRun("p1", 0, 10_000),
            rev = 4, updatedAt = 100, updatedBy = "eszkoz-a",
        )
        val sokNaplo = FocusSync.SyncFocus(
            packs = listOf(pack()), run = null,
            log = (0 until 20).map { entry(startedAt = it * 100L, endedAt = it * 100L + 50) },
            rev = 4, updatedAt = 900, updatedBy = "eszkoz-z",
        )
        assertNotEquals(null, FocusSync.merge(fut, sokNaplo).run, "a menet fut tovább")
        assertNotEquals(null, FocusSync.merge(sokNaplo, fut).run, "sorrendtől függetlenül")
    }

    @Test
    fun `egy naplosor VAN mit feltolteni`() {
        // A kör a `same`-re hallgat: ha az „ugyanaz”-t mond, nem tölt fel. Ha a
        // napló kimaradna belőle, az itt lezárult menet örökre a telefonon
        // maradna, és a gépen a statisztika hiányos lenne — némán.
        val ures = FocusSync.SyncFocus(rev = 2, updatedAt = 100)
        val naplos = FocusSync.SyncFocus(log = listOf(entry()), rev = 2, updatedAt = 100)
        assertTrue(!FocusSync.same(ures, naplos))
        assertTrue(FocusSync.same(naplos, naplos))
    }

    @Test
    fun `a naplo felso hatara a LEGREGEBBI sorokat dobja el`() {
        // Fordítva a mai menetek esnének ki, és pont az a képernyő lenne üres,
        // amit a felhasználó néz.
        val sok = (0 until Focus.MAX_FOCUS_LOG + 30).map {
            entry(startedAt = it * 10L, endedAt = it * 10L + 5)
        }
        val m = FocusSync.merge(FocusSync.SyncFocus(log = sok), FocusSync.SyncFocus())
        assertEquals(Focus.MAX_FOCUS_LOG, m.log.size)
        assertEquals(
            (Focus.MAX_FOCUS_LOG + 29) * 10L + 5, m.log.last().endedAt,
            "a legfrissebb sor bent maradt",
        )
    }

    @Test
    fun `a magatol lejart menet lezarul a naploba`() {
        // Enélkül csak a próbatétellel leállított menetek kerülnének a
        // statisztikába — vagyis pont azok hiányoznának, amiket a felhasználó
        // VÉGIGVITT. Az a statisztika rosszabb a semminél: azt mondaná, hogy
        // sosem sikerül.
        val run = Focus.FocusRun("p1", 0, 5_000)
        assertEquals(null, Focus.closeIfEnded(run, listOf(pack()), emptyList(), 4_999),
            "amíg fut, nincs teendő")
        val closed = Focus.closeIfEnded(run, listOf(pack()), emptyList(), 5_000)!!
        assertEquals(null, closed.run)
        assertEquals(1, closed.log.size)
        // A TERVEZETT vég kerül be, nem a mostani idő: a takarítás késhet pár
        // másodpercet, és egy „51 perces” ötvenperces menet apró, de fölösleges
        // hazugság lenne.
        assertEquals(5_000, closed.log[0].endedAt)
        assertTrue(!closed.log[0].stopped, "magától járt le, nem állították le")
        assertEquals("Nyelvtanulás", closed.log[0].packName, "a NÉV is bekerül")
    }

    @Test
    fun `az osszegzes a korai vegeket a TENY alapjan szamolja`() {
        // Nem a `stopped` jelző dönt: a próbatétel utáni RÖVIDÍTÉS is korai vég,
        // akkor is, ha utána még futott egy darabig.
        val log = listOf(
            entry(startedAt = 0, endedAt = 3_000, plannedEndsAt = 9_000, stopped = false),
            entry(packId = "p2", startedAt = 10_000, endedAt = 20_000, plannedEndsAt = 20_000),
        )
        val s = Focus.summarizeFocus(log, 0, 100_000)
        assertEquals(2, s.sessions)
        assertEquals(13_000, s.totalMs)
        assertEquals(1, s.stoppedEarly, "a rövidítés is korai vég")
    }

    @Test
    fun `a naplo EGYETLEN sorrendre jut akkor is, ha a sorok dontetlenek`() {
        // EZ EGY VALÓDI HIBA VOLT, és a legcsúnyább fajtából: nem hibás adat,
        // hanem NEM KONVERGÁLÓ szinkron.
        //
        // A rendezés `endedAt`, majd `packId` szerint ment — ha mindkettő
        // egyezett, a hasonlító nem döntött, és a sorrend a BEMENET sorrendjétől
        // függött. Az pedig a két eszközön szükségszerűen más. Következmény: a
        // két eszköz ugyanazt a HALMAZT más sorrendben sorosítja, a `same`
        // örökre „különbözőt” mond, és minden körben feltöltenek.
        fun tie(packId: String, startedAt: Long, planned: Long = 5_000) =
            entry(packId = packId, startedAt = startedAt, endedAt = 5_000, plannedEndsAt = planned)

        val a = FocusSync.SyncFocus(
            log = listOf(tie("p1", 100, 9_000), tie("p1", 200), tie("p2", 300)),
        )
        val b = FocusSync.SyncFocus(
            log = listOf(tie("p2", 300), tie("p1", 100, 4_000), tie("p1", 200)),
        )
        val ab = FocusSync.merge(a, b)
        val ba = FocusSync.merge(b, a)
        assertEquals(ab.log, ba.log, "a két oldal ugyanarra a sorrendre és sorokra jut")
        assertTrue(FocusSync.same(ab, ba), "tehát nincs mit feltölteni egymásnak")
        // És a következő kör sem mozdít semmit — enélkül a hurok csak lassabb lenne.
        assertTrue(FocusSync.same(FocusSync.merge(ab, b), ab))
        assertTrue(FocusSync.same(FocusSync.merge(ba, a), ba))
    }

    // ------------------------------------------------------- csomag-jelek
    //
    // A blob rev-jét a telefon egy menet indításával is lépteti. Jel nélkül egy
    // azonos rev-ű, frissebb telefon-blob egyben hozta a RÉGI listáját, és a
    // gépen frissen felvett ablak csendben eltűnt. A focus-pack-marks.test.ts
    // tükre; a telefon jelet nem ír, de fésül és hordoz.

    @Test
    fun `a gepen felvett ablak nem tunik el a telefon egyideju menet-inditasatol`() {
        val band = hu.breaker.app.core.ScheduleLogic.Band(setOf(1, 2, 3, 4, 5), 9 * 60, 12 * 60)
        val desktop = FocusSync.SyncFocus(
            packs = listOf(pack().copy(recurrence = band)), rev = 6, updatedAt = 100, updatedBy = "gep",
            packMarks = mapOf("p1" to 6),
        )
        // A telefon blobja SZÁNDÉKOSAN az újabb: azonos rev, frissebb idő, később
        // rendezett azonosító — az „utolsó író nyer” őt választaná.
        val phone = FocusSync.SyncFocus(
            packs = listOf(pack()), run = Focus.FocusRun("p1", 150, 150 + 3_000_000),
            rev = 6, updatedAt = 200, updatedBy = "telefon",
        )
        for ((x, y) in listOf(desktop to phone, phone to desktop)) {
            val m = FocusSync.merge(x, y)
            assertEquals(listOf("p1"), m.packs.map { it.id })
            assertEquals(band, m.packs[0].recurrence, "az ablak marad")
            assertTrue(m.run != null, "a telefon menete is marad")
            assertEquals(mapOf("p1" to 6), m.packMarks)
        }
    }

    @Test
    fun `a torles jele legyozi a regebbi listat, jel nelkul az ujabb blob dont`() {
        val deleted = FocusSync.SyncFocus(packs = listOf(pack("p2")), rev = 7, updatedAt = 100, updatedBy = "gep", packMarks = mapOf("p1" to 7))
        val stale = FocusSync.SyncFocus(packs = listOf(pack("p1"), pack("p2")), rev = 6, updatedAt = 50, updatedBy = "telefon")
        assertEquals(listOf("p2"), FocusSync.merge(stale, deleted).packs.map { it.id })
        assertEquals(mapOf("p1" to 7), FocusSync.merge(deleted, stale).packMarks, "a sírkő utazik tovább")

        val newer = FocusSync.SyncFocus(packs = listOf(pack("p2")), rev = 7, updatedAt = 100, updatedBy = "gep")
        val older = FocusSync.SyncFocus(packs = listOf(pack("p1"), pack("p2")), rev = 6, updatedAt = 50, updatedBy = "telefon")
        val m = FocusSync.merge(older, newer)
        assertEquals(listOf("p2"), m.packs.map { it.id }, "jel nélkül az újabb blob listája")
        assertNull(m.packMarks, "jel nélkül nem keletkezik jel")

        // Újra felvéve nagyobb jellel a törlés fölött; a csak a régebbin élő a végére.
        val readded = FocusSync.SyncFocus(packs = listOf(pack("p1").copy(name = "új")), rev = 9, updatedAt = 300, updatedBy = "gep", packMarks = mapOf("p1" to 9))
        val tomb = FocusSync.SyncFocus(packs = listOf(pack("p3")), rev = 8, updatedAt = 200, updatedBy = "telefon", packMarks = mapOf("p1" to 7, "p3" to 8))
        val r = FocusSync.merge(tomb, readded)
        assertEquals(listOf("p1", "p3"), r.packs.map { it.id })
        assertEquals("új", r.packs[0].name)
        assertEquals(mapOf("p1" to 9, "p3" to 8), r.packMarks)
    }
}
