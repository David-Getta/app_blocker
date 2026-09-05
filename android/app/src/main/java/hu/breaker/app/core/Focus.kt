package hu.breaker.app.core

import java.util.Calendar

/**
 * Munkamenetek: „most csak EZ mehet” — a `desktop/src/shared/focus.ts` tükre.
 *
 * A blokklista arról szól, mi NE menjen. A munkamenet ellenkező irányból
 * közelít: leülök nyelvet tanulni, és a következő ötven percben CSAK a szótár
 * és a jegyzetfüzet kell. Mindent felsorolni, ami zavarhat, reménytelen — a
 * világon minden zavarhat. Felsorolni, ami kell: öt tétel.
 *
 * EZ MEGFORDÍTJA A LOGIKÁT, és ezért külön fájl: a blokklista feketelista, a
 * munkamenet FEHÉRLISTA. A kettő együtt él: a munkamenet sosem old fel semmit,
 * amit a blokklista tilt — csak hozzátesz.
 *
 * MIÉRT VAN EZ A TELEFONON IS. Eddig a munkamenet csak az asztali appban
 * létezett, és ez a funkció felét elvette: elindítod a gépen a „Nyelvtanulás”
 * csomagot, aztán felveszed a telefont, és ott minden mehet. A telefon volt a
 * kiskapu — pont az az eszköz, ami kéznél van.
 *
 * Tiszta és függőségmentes (a `Blocklist.normalizeDomain`-en kívül), hogy a TS
 * és a Swift oldal pontosan ugyanezt csinálja.
 */
object Focus {

    /** Egy csomagban ennyi engedélyezett tétel lehet. */
    const val MAX_ALLOW_ENTRIES = 40

    /** A csomag nevének felső hossza — a felületen is ki kell férnie. */
    const val MAX_PACK_NAME = 40

    /** Egy munkamenet leghosszabb hossza. Ennél tovább nem tervez az ember. */
    const val MAX_SESSION_MINUTES = 8 * 60

    /** A felületen felkínált hosszak. */
    val SESSION_CHOICES_MIN = listOf(15, 25, 50, 90, 120)

    data class FocusPack(
        val id: String,
        /** amit a felhasználó ír: „Nyelvtanulás” */
        val name: String,
        /**
         * Engedélyezett hosztok. MINDEN MÁS tiltva a munkamenet alatt.
         *
         * Aldomainek is átmennek: a `google.com` engedése a
         * `translate.google.com`-ot is engedi. Enélkül minden oldalnál külön ki
         * kellene találni, melyik aldomain kell — és a felhasználó azt látná,
         * hogy a beállítása nem működik.
         */
        val allowSites: List<String>,
        /** Engedélyezett appok, a mérésből ismert néven („Microsoft Word”). */
        val allowApps: List<String>,
        /** amit induláskor felkínálunk, percben */
        val defaultMinutes: Int,
        /**
         * Ismétlődés: ezeken a napokon, ebben az ablakban a menet MAGÁTÓL
         * indul, és az ablak végéig tart. Null = csak kézzel indul. Ugyanaz a
         * sáv-alak, mint az oldalak menetrendjében.
         */
        val recurrence: ScheduleLogic.Band? = null,
    )

    data class FocusRun(
        val packId: String,
        val startedAt: Long,
        /** mikor jár le magától */
        val endsAt: Long,
    )

    /** Fut-e most munkamenet. */
    fun isRunning(run: FocusRun?, now: Long): Boolean = run != null && run.endsAt > now

    /** Mennyi van hátra (0, ha nem fut). */
    fun remainingMs(run: FocusRun?, now: Long): Long =
        if (isRunning(run, now)) run!!.endsAt - now else 0L

    /** Percek -> használható hossz, vagy null. */
    fun normalizeMinutes(value: Double?): Int? {
        if (value == null || !value.isFinite()) return null
        val rounded = Math.round(value).toInt()
        if (rounded < 1) return null
        return minOf(rounded, MAX_SESSION_MINUTES)
    }

    /**
     * Egy engedélyezett oldal megtisztítása.
     *
     * Ugyanazon a magon megy át, mint a blokklista: így ami itt engedve van, az
     * ugyanazt a hosztot jelenti, mint amit ott tiltunk.
     */
    fun normalizeAllowSite(input: String): String? = Blocklist.normalizeDomain(input)

    fun normalizeAllowApp(input: String): String? {
        val s = input.trim().replace(Regex("\\s+"), " ")
        if (s.isEmpty()) return null
        return s.take(64)
    }

    /**
     * Átmehet-e ez a hoszt a munkamenet alatt.
     *
     * Egyezés vagy ALDOMAIN. A `translate.google.com` átmegy, ha a `google.com`
     * engedve van; a `notgoogle.com` NEM — a végén hasonlító tartománynév a
     * leggyakoribb megtévesztés.
     */
    fun isSiteAllowed(pack: FocusPack, host: String): Boolean {
        val h = host.trim().lowercase().trimEnd('.')
        if (h.isEmpty()) return false
        return pack.allowSites.any { h == it || h.endsWith(".$it") }
    }

    /**
     * Átmehet-e ez az app.
     *
     * Részleges, kis-nagybetűtől független egyezés MINDKÉT irányban: a beírt
     * „word” engedi a „Microsoft Word”-öt, és a beírt „Microsoft Word” is
     * engedi a „Word” néven jelentkezőt. Az appnevek gépenként és nyelvenként
     * eltérnek — egy pontos egyezésre épülő lista mindenkinél máshogy
     * viselkedne, és senki nem értené, miért.
     */
    fun isAppAllowed(pack: FocusPack, app: String): Boolean {
        val a = app.trim().lowercase()
        if (a.isEmpty()) return false
        return pack.allowApps.any {
            val y = it.lowercase()
            a == y || a.contains(y) || y.contains(a)
        }
    }

    /**
     * A munkamenet meghosszabbítása INGYEN van, a rövidítése nem.
     *
     * Ugyanaz a szabály, mint mindenhol az appban: a szigorítás irányába szabad
     * az út. Aki ötven perc helyett hatvanat akar, azt nem akadályozzuk; aki
     * negyvenre rövidítené, az ugyanazt a próbatételt kapja, mint egy
     * feloldásnál.
     */
    fun isSessionLoosening(currentEndsAt: Long, nextEndsAt: Long): Boolean =
        nextEndsAt < currentEndsAt

    // -----------------------------------------------------------------------
    // A DNS-döntés a munkamenet alatt
    // -----------------------------------------------------------------------
    //
    // A telefonon a fehérlistát a DNS-szűrő érvényesíti — nem egy bővítmény.
    // Ez ERŐSEBB, mint amit az asztali app tud: ott a hosts fájlba nem írható
    // le, hogy „mindent tilts, kivéve ötöt”, a VPN-szűrő viszont minden
    // lekérdezést lát, és bármire tud nemet mondani.
    //
    // Épp ezért veszélyes is. Egy telefon, aminek MINDEN névfeloldása elhasal,
    // nem korlátozott telefon, hanem használhatatlan: nem jön értesítés, a
    // rendszer azt hiszi, nincs internet, és a felhasználó nem érti, mi történt
    // — a munkamenetet fogja hibásnak tartani, nem a saját beállítását.
    //
    // Ezért van egy SZŰK, tételesen indokolt kivétellista. Nem kényelmi lista:
    // minden sora olyasmi, aminek a hiánya kárt okoz, és amin böngészni nem
    // lehet. A felület ki is mondja, hogy létezik — egy titkos kivétel rosszabb
    // lenne, mint egy nyílt.

    /**
     * Amit a munkamenet alatt sem tiltunk el, és miért.
     *
     * Aldomainre is érvényes (`endsWith`), mert ezek a szolgáltatások
     * régiónként külön nevet használnak.
     */
    val INFRA_ALLOW = listOf(
        // Értesítések. Enélkül nyolc órán át nem jön üzenet — a munkamenet
        // nem arról szól, hogy elérhetetlen legyél.
        "mtalk.google.com",
        "fcm.googleapis.com",
        "firebaseinstallations.googleapis.com",
        // Kapcsolat-ellenőrzés. Ha ez elhasal, a rendszer „nincs internet”-et
        // jelez, és mobiladatra vált — a felhasználó egy hálózati hibát lát,
        // nem egy munkamenetet.
        "connectivitycheck.gstatic.com",
        "clients3.google.com",
        // Óra. Egy elcsúszott óra a munkamenet VÉGÉT is elcsúsztatná.
        "time.android.com",
        "pool.ntp.org",
    )

    /** Rendszer-infrastruktúra-e ez a név (egyezés vagy aldomain). */
    fun isInfrastructure(host: String): Boolean {
        val h = host.trim().lowercase().trimEnd('.')
        if (h.isEmpty()) return false
        return INFRA_ALLOW.any { h == it || h.endsWith(".$it") }
    }

    /** Mi lett a névvel, és MIÉRT — a felület ezt írja ki. */
    enum class Verdict { ALLOW, BLOCKED_BY_LIST, BLOCKED_BY_FOCUS }

    /**
     * Átmehet-e ez a név most.
     *
     * A sorrend nem esztétika, hanem a szabályrendszer:
     *
     *   1. A BLOKKLISTA MINDIG NYER. A munkamenet sosem old fel semmit — csak
     *      hozzátesz. Ha ez fordítva lenne, egy csomagba felvett `youtube.com`
     *      feloldaná a tiltott YouTube-ot, próbatétel nélkül: a munkamenet
     *      lenne a kiskapu a blokklistán.
     *   2. Nem fut munkamenet -> a blokklista döntött, mehet.
     *   3. A csomagon rajta van -> mehet.
     *   4. Rendszer-infrastruktúra -> mehet (lásd fent).
     *   5. Minden más -> tiltva, mert a munkamenet fehérlista.
     *
     * A `syncHost` a saját fiókkiszolgálód neve, ha van: enélkül a munkamenet
     * alatt a telefon nem tudná feltölteni a mért időt, és nem is látná, ha egy
     * MÁSIK eszközön leállítod a munkamenetet. Egy zár, amit a saját kulcsod
     * sem ér el, nem zár, hanem hiba.
     */
    fun verdict(
        qname: String,
        run: FocusRun?,
        pack: FocusPack?,
        now: Long,
        blocked: Collection<String>,
        syncHost: String? = null,
    ): Verdict {
        val h = qname.trim().lowercase().trimEnd('.')
        if (Blocklist.matches(h, blocked)) return Verdict.BLOCKED_BY_LIST
        if (!isRunning(run, now) || pack == null) return Verdict.ALLOW
        if (isSiteAllowed(pack, h)) return Verdict.ALLOW
        if (isInfrastructure(h)) return Verdict.ALLOW
        val sh = syncHost?.trim()?.lowercase()?.trimEnd('.')
        if (!sh.isNullOrEmpty() && (h == sh || h.endsWith(".$sh"))) return Verdict.ALLOW
        return Verdict.BLOCKED_BY_FOCUS
    }


    // -----------------------------------------------------------------------
    // A LEZÁRULT menetek naplója — ebből lesz a statisztika.
    //
    // A telefonon ugyanúgy kell, mint a gépen, és ez nem másolásból következik:
    // a menetet MÁR itt is lehet indítani és leállítani, tehát ha csak a gép
    // naplózna, a telefonon lefutott menetek egyszerűen nem léteznének. Aki a
    // telefonján dolgozik, azt látná, hogy a héten nem ült le egyszer sem.

    /** Ennyi sort tartunk — a statisztika a mai napot és a hetet nézi. */
    const val MAX_FOCUS_LOG = 200

    data class FocusLogEntry(
        val packId: String,
        /** a csomag neve AKKOR — a csomag azóta átnevezhető vagy törölhető */
        val packName: String,
        val startedAt: Long,
        /** mikor ért véget ténylegesen */
        val endedAt: Long,
        /** mikorra volt tervezve — ebből látszik, hogy korábban ért-e véget */
        val plannedEndsAt: Long,
        /** próbatétellel leállítva (igaz), vagy magától lejárt (hamis) */
        val stopped: Boolean,
    )

    /** Egy naplósor a futó menetből. */
    fun closeRun(run: FocusRun, packName: String, endedAt: Long, stopped: Boolean) =
        FocusLogEntry(
            packId = run.packId,
            packName = packName,
            startedAt = run.startedAt,
            endedAt = endedAt,
            plannedEndsAt = run.endsAt,
            stopped = stopped,
        )

    /** Amit a lezárás ad vissza: az új napló, és a futás (mindig null). */
    data class FocusClose(val run: FocusRun?, val log: List<FocusLogEntry>)

    /**
     * Egy LEJÁRT menet lezárása a naplóba.
     *
     * A magban van, nem a felületen, mert mind a három platformnak ugyanez
     * kell. A `null` azt jelenti: nincs teendő — így a hívó nyugodtan
     * meghívhatja minden körben, fölösleges mentés nélkül.
     *
     * @return az új állapot, vagy null, ha nincs mit lezárni
     */
    fun closeIfEnded(
        run: FocusRun?,
        packs: List<FocusPack>,
        log: List<FocusLogEntry>,
        now: Long,
    ): FocusClose? {
        if (run == null || run.endsAt > now) return null
        val pack = packs.firstOrNull { it.id == run.packId }
        // A csomag NEVÉT is elmentjük, nem csak az azonosítóját: a csomag azóta
        // átnevezhető vagy törölhető: egy statisztika, ami a múlt hétre csak
        // ismeretlen csomagot ír ki, semmit nem ér.
        val entry = closeRun(run, pack?.name ?: "Ismeretlen csomag", run.endsAt, false)
        return FocusClose(null, (log + entry).takeLast(MAX_FOCUS_LOG))
    }

    data class FocusSummary(
        /** hány menet zárult le az ablakban */
        val sessions: Int = 0,
        /** összesen ennyi ideig tartottak, ezredmásodpercben */
        val totalMs: Long = 0,
        /** ennyit állítottál le a tervezettnél korábban */
        val stoppedEarly: Int = 0,
        /** a leggyakoribb csomag neve, ha van */
        val topPack: String? = null,
    )

    /**
     * Összegzés egy időablakra.
     *
     * A „korán leállítva” szándékosan nem szégyenpad: ha ötből négyszer
     * leálltál, nem a csomaggal van baj, hanem a hosszal — rövidebb menetet
     * érdemes indítani, és az működni fog.
     */
    fun summarizeFocus(log: List<FocusLogEntry>?, since: Long, now: Long): FocusSummary {
        val rows = (log ?: emptyList()).filter { it.endedAt in since..now }
        var totalMs = 0L
        var stoppedEarly = 0
        val byPack = LinkedHashMap<String, Int>()
        for (e in rows) {
            totalMs += maxOf(0L, e.endedAt - e.startedAt)
            // Nem a `stopped` jelző dönt, hanem a TÉNY: a próbatétel utáni
            // rövidítés is korai vég, akkor is, ha utána még futott egy darabig.
            if (e.endedAt < e.plannedEndsAt) stoppedEarly++
            byPack[e.packName] = (byPack[e.packName] ?: 0) + 1
        }
        var topPack: String? = null
        var best = 0
        for ((name, count) in byPack) if (count > best) { best = count; topPack = name }
        return FocusSummary(rows.size, totalMs, stoppedEarly, topPack)
    }

    /** Ahogy a felületen áll: „Nyelvtanulás — 42 perc van hátra”. */
    fun formatRemaining(ms: Long): String {
        val total = maxOf(0L, (ms + 59_999L) / 60_000L).toInt()
        if (total >= 60) {
            val h = total / 60
            val m = total % 60
            return if (m == 0) "$h óra" else "$h ó $m p"
        }
        return if (total <= 1) "kevesebb mint egy perc" else "$total perc"
    }

    // -----------------------------------------------------------------------
    // Ismétlődő munkamenet: a csomag magától indul egy heti ablakban.
    //
    // A `focus.ts` azonos nevű szakaszának tükre — az indoklás ott van. A
    // lényeg két mondat: AZ ABLAK AZ ÍGÉRET (a menet kezdése mindig az ablak
    // kezdete, így minden eszköz ugyanazt a menetet állítja elő), és A NAPLÓ
    // AZ ŐR (ami ebben az ablakban egyszer már indult, az nem indul újra —
    // a leállítás próbatétele különben egy percig érne).
    // -----------------------------------------------------------------------

    /** Ennél kevesebb hátralévő idővel már nem indul menetrend szerinti menet. */
    const val RECURRENCE_MIN_REMAINING_MS = 60_000L

    /** Egy ablak-előfordulás: mikor kezdődik és mikor ér véget (epoch ms). */
    data class Occurrence(val startsAt: Long, val endsAt: Long)

    /** A sáv hossza percben (éjfélen átnyúlva is). */
    fun bandMinutes(b: ScheduleLogic.Band): Int =
        if (b.endMin > b.startMin) b.endMin - b.startMin else 1440 - b.startMin + b.endMin

    /**
     * Kívülről jött ismétlődés használható alakja, vagy null: érvényes sáv,
     * és nem hosszabb egy menet plafonjánál — egy huszonnégy órás „ablak” nem
     * munkamenet lenne, hanem egy kikapcsolhatatlan fehérlista.
     */
    fun cleanRecurrence(b: ScheduleLogic.Band?): ScheduleLogic.Band? {
        if (b == null || !ScheduleLogic.isValidBand(b)) return null
        if (bandMinutes(b) > MAX_SESSION_MINUTES) return null
        return b
    }

    /** Egy helyi időpont: a `now` napjától `dayOffset` nappal, `min` perccel éjfél után. */
    private fun localAt(now: Long, dayOffset: Int, min: Int): Long {
        val c = Calendar.getInstance().apply { timeInMillis = now }
        c.set(Calendar.HOUR_OF_DAY, 0); c.set(Calendar.MINUTE, 0)
        c.set(Calendar.SECOND, 0); c.set(Calendar.MILLISECOND, 0)
        c.add(Calendar.DAY_OF_MONTH, dayOffset + min / 1440)
        // Mezőkkel, nem percek hozzáadásával: az óraátállás napján a 9:00 az
        // a 9:00, nem éjfél plusz ötszáznegyven perc.
        c.set(Calendar.HOUR_OF_DAY, (min % 1440) / 60); c.set(Calendar.MINUTE, min % 60)
        return c.timeInMillis
    }

    /** A sáv MOSTANI előfordulása — vagy null, ha `now` nincs benne. */
    fun occurrenceAt(band: ScheduleLogic.Band, now: Long): Occurrence? {
        val c = Calendar.getInstance().apply { timeInMillis = now }
        val day = c.get(Calendar.DAY_OF_WEEK) - 1
        val minute = c.get(Calendar.HOUR_OF_DAY) * 60 + c.get(Calendar.MINUTE)
        val prevDay = (day + 6) % 7
        if (band.endMin > band.startMin) {
            if (day in band.days && minute >= band.startMin && minute < band.endMin) {
                return Occurrence(localAt(now, 0, band.startMin), localAt(now, 0, band.endMin))
            }
            return null
        }
        if (day in band.days && minute >= band.startMin) {
            return Occurrence(localAt(now, 0, band.startMin), localAt(now, 1, band.endMin))
        }
        if (prevDay in band.days && minute < band.endMin) {
            return Occurrence(localAt(now, -1, band.startMin), localAt(now, 0, band.endMin))
        }
        return null
    }

    data class DueRecurrence(val pack: FocusPack, val startsAt: Long, val endsAt: Long)

    /**
     * Melyik csomag ablaka esedékes MOST — vagy null. Nem indul, ha fut
     * valami; ha a naplóban van ebben az ablakban kezdődött menet ebből a
     * csomagból; vagy ha egy percnél kevesebb van hátra. Több közül a
     * korábban kezdődő, azonos kezdésnél a kisebb azonosítójú.
     */
    fun dueRecurrence(
        packs: List<FocusPack>,
        run: FocusRun?,
        log: List<FocusLogEntry>,
        now: Long,
    ): DueRecurrence? {
        if (isRunning(run, now)) return null
        var best: DueRecurrence? = null
        for (pack in packs) {
            val band = pack.recurrence ?: continue
            if (!ScheduleLogic.isValidBand(band)) continue
            val occ = occurrenceAt(band, now) ?: continue
            if (occ.endsAt - now < RECURRENCE_MIN_REMAINING_MS) continue
            val spent = log.any {
                it.packId == pack.id && it.startedAt >= occ.startsAt && it.startedAt < occ.endsAt
            }
            if (spent) continue
            val b = best
            if (b == null || occ.startsAt < b.startsAt ||
                (occ.startsAt == b.startsAt && pack.id < b.pack.id)
            ) {
                best = DueRecurrence(pack, occ.startsAt, occ.endsAt)
            }
        }
        return best
    }

    /** Az ismétlődés kulcsa a lenyomatokhoz: napok rendezve, kezdés, vég — vagy „-”. */
    fun recurrenceKey(b: ScheduleLogic.Band?): String =
        b?.let { "${it.days.sorted().joinToString(",")}/${it.startMin}-${it.endMin}" } ?: "-"

    /**
     * Ablak-menet-e ez a futás: a csomag ismétlődésének egy előfordulása,
     * pontosan annak kezdésével és végével. Az óra-ugrás elnyelése az ilyet
     * nem tolja el — az ablak vége az ablak vége.
     */
    fun isWindowRun(run: FocusRun, packs: List<FocusPack>): Boolean {
        val band = packs.firstOrNull { it.id == run.packId }?.recurrence ?: return false
        val occ = occurrenceAt(band, run.startedAt) ?: return false
        return occ.startsAt == run.startedAt && occ.endsAt == run.endsAt
    }
}
