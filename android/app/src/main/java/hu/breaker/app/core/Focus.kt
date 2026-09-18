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
    enum class Verdict { ALLOW, BLOCKED_BY_LIST, BLOCKED_BY_KEYWORD, BLOCKED_BY_FOCUS }

    /**
     * Átmehet-e ez a név most.
     *
     * A sorrend nem esztétika, hanem a szabályrendszer:
     *
     *   1. A BLOKKLISTA MINDIG NYER. A munkamenet sosem old fel semmit — csak
     *      hozzátesz. Ha ez fordítva lenne, egy csomagba felvett `youtube.com`
     *      feloldaná a tiltott YouTube-ot, próbatétel nélkül: a munkamenet
     *      lenne a kiskapu a blokklistán.
     *   1b. A KULCSSZÓ a hosztnévben -> tiltva. A telefon szűrője csak a
     *      hosztnevet látja, abban tilt (`tiktok` -> `www.tiktok.com`); a
     *      rendszer-infrastruktúra és a saját fiókkiszolgáló sosem — egy
     *      `live` kulcsszó ne vigye el a push-csatornát vagy a saját fiókot.
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
        keywords: List<String> = emptyList(),
    ): Verdict {
        val h = qname.trim().lowercase().trimEnd('.')
        if (Blocklist.matches(h, blocked)) return Verdict.BLOCKED_BY_LIST
        val sh = syncHost?.trim()?.lowercase()?.trimEnd('.')
        val ownSync = !sh.isNullOrEmpty() && (h == sh || h.endsWith(".$sh"))
        if (keywords.isNotEmpty() && !isInfrastructure(h) && !ownSync && KeywordLogic.keywordInHost(keywords, h) != null) {
            return Verdict.BLOCKED_BY_KEYWORD
        }
        if (!isRunning(run, now) || pack == null) return Verdict.ALLOW
        if (isSiteAllowed(pack, h)) return Verdict.ALLOW
        if (isInfrastructure(h)) return Verdict.ALLOW
        if (ownSync) return Verdict.ALLOW
        return Verdict.BLOCKED_BY_FOCUS
    }

    /**
     * MI LENNE EZZEL a névvel, és miért — a felület próbamezője ezt írja ki.
     * Ugyanaz az ítélet, mint a szűrőé, szóban: a kulcsszó a hosztnévben
     * meglephet, itt derül ki előre, nem a hálózati hibánál. Üres névre üres.
     */
    fun explain(
        qname: String,
        run: FocusRun?,
        pack: FocusPack?,
        now: Long,
        blocked: Collection<String>,
        syncHost: String? = null,
        keywords: List<String> = emptyList(),
    ): String {
        val h = qname.trim().lowercase().trimEnd('.')
        if (h.isEmpty()) return ""
        return when (verdict(h, run, pack, now, blocked, syncHost, keywords)) {
            Verdict.BLOCKED_BY_LIST -> "Tiltva: a lista."
            Verdict.BLOCKED_BY_KEYWORD -> "Tiltva: kulcsszó a hosztnévben („${KeywordLogic.keywordInHost(keywords, h) ?: ""}”)."
            Verdict.BLOCKED_BY_FOCUS -> "Tiltva, amíg a munkamenet tart: nincs a csomagon."
            Verdict.ALLOW ->
                if (isRunning(run, now) && pack != null && isInfrastructure(h)) "Átmegy: rendszer-infrastruktúra." else "Átmegy."
        }
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
        /**
         * A HETI ABLAKBÓL indult, magától (a csomag ablakának egy előfordulása)
         * — a régi sorban nincs, és az nem ablak. A statisztika és a heti
         * mondat ebből mondja, dolgozik-e az ablak.
         */
        val window: Boolean = false,
    )

    /** Egy naplósor a futó menetből. */
    fun closeRun(run: FocusRun, packName: String, endedAt: Long, stopped: Boolean, window: Boolean = false) =
        FocusLogEntry(
            packId = run.packId,
            packName = packName,
            startedAt = run.startedAt,
            endedAt = endedAt,
            plannedEndsAt = run.endsAt,
            stopped = stopped,
            window = window,
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
        val entry = closeRun(run, pack?.name ?: "Ismeretlen csomag", run.endsAt, false, isWindowRun(run, packs))
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
        /** ennyi indult a heti ablakból, magától — dolgozik-e az ablak */
        val windowRuns: Int = 0,
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
        var windowRuns = 0
        val byPack = LinkedHashMap<String, Int>()
        for (e in rows) {
            totalMs += maxOf(0L, e.endedAt - e.startedAt)
            // Nem a `stopped` jelző dönt, hanem a TÉNY: a próbatétel utáni
            // rövidítés is korai vég, akkor is, ha utána még futott egy darabig.
            if (e.endedAt < e.plannedEndsAt) stoppedEarly++
            if (e.window) windowRuns++
            byPack[e.packName] = (byPack[e.packName] ?: 0) + 1
        }
        var topPack: String? = null
        var best = 0
        for ((name, count) in byPack) if (count > best) { best = count; topPack = name }
        return FocusSummary(rows.size, totalMs, stoppedEarly, topPack, windowRuns)
    }

    /**
     * A HETI ABLAKBÓL indult menetek csomagonként az ablakban (azonosító →
     * darab): a csomag sora ebből mondja, hányszor indult magától a héten —
     * dolgozik-e az ablak. Csak az ablakos sorok; a régi sor nem ablak. A TS
     * `windowRunsByPack` tükre.
     */
    fun windowRunsByPack(log: List<FocusLogEntry>?, since: Long, now: Long): Map<String, Int> {
        val out = LinkedHashMap<String, Int>()
        for (e in log ?: emptyList()) {
            if (!e.window || e.endedAt < since || e.endedAt > now) continue
            out[e.packId] = (out[e.packId] ?: 0) + 1
        }
        return out
    }

    /**
     * Az ELŐZŐ hét menetei: a mai nap kezdete előtti tizenhárom naptól a hat
     * nappal ezelőtti nap kezdetéig — azt már nem, az a mostani hét ablaka. A
     * statisztika és a heti mondat a két hetet egymás mellé teszi: irány, nem ítélet.
     */
    fun summarizeFocusPrevWeek(log: List<FocusLogEntry>?, now: Long): FocusSummary {
        val start = UsageLogic.startOfDay(now)
        return summarizeFocus(log, start - 13 * 86_400_000L, start - 6 * 86_400_000L - 1)
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

    /**
     * A sáv KÖVETKEZŐ előfordulása: a mostani, ha épp benne vagyunk, különben
     * a legközelebbi kezdés a következő héten. A `focus.ts` `nextOccurrence`
     * tükre — a felület ebből mondja meg, mikor indul legközelebb, és hogy
     * egy kézi menetet félbeszakít-e egy másik csomag ablaka.
     */
    fun nextOccurrence(band: ScheduleLogic.Band, now: Long): Occurrence? {
        occurrenceAt(band, now)?.let { return it }
        for (d in 0..7) {
            val start = localAt(now, d, band.startMin)
            if (start < now) continue
            val day = Calendar.getInstance().apply { timeInMillis = start }.get(Calendar.DAY_OF_WEEK) - 1
            if (day !in band.days) continue
            occurrenceAt(band, start)?.let { return it }
        }
        return null
    }

    data class DueRecurrence(val pack: FocusPack, val startsAt: Long, val endsAt: Long)

    /**
     * Melyik csomag ablaka esedékes MOST — vagy null. Nem indul, ha a csomag
     * saját menete fut; ha a naplóban ott az ablak saját menete; vagy ha egy
     * percnél kevesebb van hátra. Egy másik csomag menete nem tartja vissza —
     * azt a kör zárja le. Több közül a korábban kezdődő, azonos kezdésnél a
     * kisebb azonosítójú.
     */
    fun dueRecurrence(
        packs: List<FocusPack>,
        run: FocusRun?,
        log: List<FocusLogEntry>,
        now: Long,
    ): DueRecurrence? {
        var best: DueRecurrence? = null
        for (pack in packs) {
            val band = pack.recurrence ?: continue
            if (!ScheduleLogic.isValidBand(band)) continue
            // A csomag SAJÁT futó menete mellett nincs mit indítani. Egy MÁSIK
            // csomag kézi menete nem tartja vissza az ablakot: a hívó (a kör)
            // zárja le az ablak kezdetén — különben egy 8:59-kor indított,
            // nyolcórás eldobható menet az egész ablakot kiváltaná.
            if (isRunning(run, now) && run!!.packId == pack.id) continue
            val occ = occurrenceAt(band, now) ?: continue
            if (occ.endsAt - now < RECURRENCE_MIN_REMAINING_MS) continue
            // Csak az ablak SAJÁT menete (a kezdése az ablak kezdése) számít
            // elköltöttnek: a csomag egyperces kézi menete az ablakon belül nem
            // váltja ki a háromórás ablakot.
            val spent = log.any { it.packId == pack.id && it.startedAt == occ.startsAt }
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
    /**
     * A legutóbb használt csomag — a napló legfrissebb olyan sora szerint,
     * amelynek a csomagja még megvan —, vagy az első, ha még nem volt menet;
     * null, ha nincs csomag. A javaslat gombja ezt indítja a szokásos
     * hosszával: egy koppintás a mondattól a menetig. A Swift `lastUsedPack`
     * tükre.
     */
    /**
     * LE VAN-E FEDVE az óra: a sáv legalább egy napon az óra egy részét is átfogja.
     * A csúcs-óra a hét órája, napra nem bontva — ezért elég, ha valamelyik napon
     * fedi. Nap nélkül nem ablak.
     */
    fun bandCoversHour(band: ScheduleLogic.Band, hour: Int): Boolean {
        val h = hour.coerceIn(0, 23)
        return band.days.isNotEmpty() && band.startMin < (h + 1) * 60 && band.endMin > h * 60
    }

    /** A csomag, amelynek heti ablaka fedi az órát (a csúcs-órát) — az első a listában; null, ha egyik sem. */
    fun packCoveringHour(packs: List<FocusPack>, hour: Int): FocusPack? =
        packs.firstOrNull { p -> p.recurrence?.let { bandCoversHour(it, hour) } == true }

    /**
     * ABLAK A CSÚCS-ÓRÁRA: a csúcs egy órája, minden napra — a gépi
     * `peakWindowBand` tükre. A 23 óra vége a nap vége (1440), nem nulla:
     * különben a sáv éjfélen átfordulna.
     */
    fun peakWindowBand(hour: Int): ScheduleLogic.Band {
        val h = hour.coerceIn(0, 23)
        return ScheduleLogic.Band(setOf(0, 1, 2, 3, 4, 5, 6), h * 60, (h + 1) * 60)
    }

    /**
     * A csúcs-óra ablakának jelöltje a telefon gombjához: (csomag, sáv) — vagy
     * null, ha nincs gomb. Ugyanazok a feltételek, mint a gépi gombé: van csúcs,
     * semelyik csomag ablaka nem fedi, nem fut menet, és a legutóbb használt
     * csomagnak nincs még ablaka (a telefon csak FELVESZ, nem cserél).
     */
    fun peakWindowPick(
        packs: List<FocusPack>, log: List<FocusLogEntry>, run: FocusRun?, peakHour: Int?, now: Long,
    ): Pair<FocusPack, ScheduleLogic.Band>? {
        if (peakHour == null) return null
        if (packCoveringHour(packs, peakHour) != null) return null
        if (isRunning(run, now)) return null
        val pick = lastUsedPack(packs, log) ?: return null
        if (pick.recurrence != null) return null
        return pick to peakWindowBand(peakHour)
    }

    fun lastUsedPack(packs: List<FocusPack>, log: List<FocusLogEntry>): FocusPack? {
        val byId = packs.associateBy { it.id }
        return log.sortedByDescending { it.startedAt }.firstNotNullOfOrNull { byId[it.packId] } ?: packs.firstOrNull()
    }

    /**
     * Fókuszban töltött idő NAPONTA az utolsó [count] napra, a legrégebbitől —
     * a hét alakja a menetekre. Egy menet a VÉGÉNEK napjára számít egészben
     * (nyolc óránál hosszabb menet nincs; a lezárás napja az, amire az ember
     * emlékszik). Ugyanaz a nap-fogalom, mint a mérésnél. A focus.ts
     * `focusDaySeries` tükre.
     */
    fun daySeries(log: List<FocusLogEntry>, now: Long, count: Int): List<Pair<String, Double>> {
        val days = UsageLogic.dayKeysBack(now, count)
        val totals = LinkedHashMap<String, Double>()
        for (d in days) totals[d] = 0.0
        for (e in log) {
            if (e.endedAt > now) continue
            val key = UsageLogic.dayKey(e.endedAt)
            if (key !in totals) continue
            totals[key] = totals.getValue(key) + maxOf(0L, e.endedAt - e.startedAt) / 1000.0
        }
        return days.map { it to Math.round(totals.getValue(it)).toDouble() }
    }

    /**
     * A HÉT NAPJAI szerint: az utolsó 28 nap menetei a hét hét napjára osztva
     * (0 = vasárnap) — a menet a végének napjára számít, mint a napi rajzon. A
     * megakadások csúcs-napjának tükre: nem az, mikor csúszik a kéz, hanem az,
     * mikor ülsz le. A minta hossza és a holtverseny szabálya a csúcs-napéval
     * közös. A gépi `focusByWeekday` tükre.
     */
    fun byWeekday(log: List<FocusLogEntry>, now: Long, count: Int = FilterHitLogic.PEAK_WEEKDAY_DAYS): List<Int> {
        val by = IntArray(7)
        val days = UsageLogic.dayKeysBack(now, count).toSet()
        for (e in log) {
            if (e.endedAt > now) continue
            val key = UsageLogic.dayKey(e.endedAt)
            if (key !in days) continue
            by[FilterHitLogic.weekdayOf(key)] += 1
        }
        return by.toList()
    }

    /** „A négy hét menet-napja: kedd (6 menet).” — melyik napon ülsz le a legtöbbször. */
    fun weekdayText(peak: Pair<Int, Int>): String =
        "A négy hét menet-napja: ${FilterHitLogic.WEEKDAY_NAMES.getOrElse(peak.first) { "?" }} (${peak.second} menet)."

    /**
     * A MENET-ÓRA: az utolsó 28 nap menetei a nap huszonnégy órájára osztva, az
     * INDULÁS órája szerint — a megakadások csúcs-órájának tükre: nem az, mikor
     * jár a kéz magától, hanem az, mikor ülsz le. Négy hétből; a menet a
     * végének napja szerint tartozik a mintába. A gépi `focusByHour` tükre.
     */
    fun byHour(log: List<FocusLogEntry>, now: Long, count: Int = FilterHitLogic.PEAK_WEEKDAY_DAYS): List<Int> {
        val by = IntArray(24)
        val days = UsageLogic.dayKeysBack(now, count).toSet()
        for (e in log) {
            if (e.endedAt > now) continue
            if (UsageLogic.dayKey(e.endedAt) !in days) continue
            by[FilterHitLogic.hourOf(e.startedAt)] += 1
        }
        return by.toList()
    }

    /** A menet-óra: (óra, szám) — vagy null. Holtversenynél a korábbi óra. */
    fun peakHour(byHour: List<Int>): Pair<Int, Int>? {
        var best: Pair<Int, Int>? = null
        for ((hour, count) in byHour.withIndex()) {
            val b = best
            if (count > 0 && (b == null || count > b.second)) best = hour to count
        }
        return best
    }

    /**
     * „A négy hét menet-órája: 9–10 óra (6 menet).” — mikor ülsz le a legtöbbször.
     * A fedés a szám mellett: „magától indul: …”, ha egy csomag heti ablaka fedi
     * a menet-órát; „nincs rá ablak”, ha lehetne rá tenni. A fedés erősebb. Ha a
     * menet-óra a csúcs-óra, a csúcs mondata mondja — a hívó nem ad fedést.
     */
    fun hourText(peak: Pair<Int, Int>, pack: String? = null, offer: Boolean = false): String {
        val tail = pack?.let { ", magától indul: $it" } ?: (if (offer) ", nincs rá ablak" else "")
        return "A négy hét menet-órája: ${FilterHitLogic.hourLabel(peak.first)} (${peak.second} menet$tail)."
    }

    /**
     * MENET-SOROZAT: hány napja ülsz le minden nap — a ma (vagy ha ma még nem, a
     * tegnap) végződő, megszakítás nélküli napok száma menettel (a menet a végének
     * napjára számít). Egy nap nem sorozat. Tény, nem ítélet. A gépi tükör.
     */
    fun dayStreak(log: List<FocusLogEntry>, now: Long): Int {
        val days = log.filter { it.endedAt <= now }.map { UsageLogic.dayKey(it.endedAt) }.toSet()
        val back = UsageLogic.dayKeysBack(now, 400).sortedDescending()
        var i = if (back.isNotEmpty() && back[0] in days) 0 else 1
        var n = 0
        while (i < back.size && back[i] in days) { n += 1; i += 1 }
        return n
    }

    /** A LEGHOSSZABB SOROZAT: a napló leghosszabb, megszakítás nélküli napsora menettel — a mostani mércéje. */
    fun longestStreak(log: List<FocusLogEntry>, now: Long): Int {
        val days = log.filter { it.endedAt <= now }.map { UsageLogic.dayKey(it.endedAt) }.toSortedSet()
        var best = 0
        var run = 0
        var prev: String? = null
        for (k in days) {
            val (y, m, d) = k.split("-").map { it.toInt() }
            val cal = java.util.Calendar.getInstance().apply { clear(); set(y, m - 1, d, 12, 0, 0); add(java.util.Calendar.DAY_OF_MONTH, -1) }
            val yesterday = UsageLogic.dayKey(cal.timeInMillis)
            run = if (prev == yesterday) run + 1 else 1
            if (run > best) best = run
            prev = k
        }
        return best
    }

    /**
     * „5 napja minden nap leültél.” — kettőtől; alatta üres. A leghosszabb sorozattal (ha
     * nagyobb a mostaninál): „(a leghosszabb sorozatod: 12 nap)”; mostani nélkül csak a rekord.
     */
    fun streakText(n: Int, longest: Int = 0): String = when {
        n >= 2 && longest > n -> "$n napja minden nap leültél (a leghosszabb sorozatod: $longest nap)."
        n >= 2 -> "$n napja minden nap leültél."
        longest >= 2 -> "A leghosszabb sorozatod: $longest nap."
        else -> ""
    }

    /**
     * AMIKOR A CSÚCS-ÓRA A MENET-ÓRA: a kéz ugyanabban az órában jár magától,
     * amelyikben le szoktál ülni — a tükör két fele egy pontra mutat. Null, ha
     * nem esik egybe. Tény, nem ítélet.
     */
    fun sameHourText(peak: Pair<Int, Int>?, focusHour: Pair<Int, Int>?): String? =
        if (peak == null || focusHour == null || peak.first != focusHour.first) null
        else "A csúcs-óra és a menet-óra ugyanaz: ${FilterHitLogic.hourLabel(peak.first)} — a kéz akkor jár, amikor le szoktál ülni."

    /** A tükör a döntés napján: a kezdőlap kártyája a menet-napon (a „ma van” szabálya a csúcs-napé: FilterHitLogic.isPeakDayNow). */
    fun dayNowText(peak: Pair<Int, Int>): String =
        "Ma a négy hét menet-napja van (${FilterHitLogic.WEEKDAY_NAMES.getOrElse(peak.first) { "?" }}, ${peak.second} menet) — ilyenkor szoktál leülni."

    /** MOST a menet-óra van-e: a négy hét menet-órája és a helyi óra egybeesik — és a minta elég (a csúcs-nap küszöbe). */
    fun isHourNow(peak: Pair<Int, Int>?, now: Long): Boolean =
        peak != null && peak.second >= FilterHitLogic.PEAK_DAY_MIN_COUNT && FilterHitLogic.hourOf(now) == peak.first

    /** A tükör a döntés órájában: a kezdőlap kártyája a menet-órában. */
    fun hourNowText(peak: Pair<Int, Int>): String =
        "Most a menet-órád van (${FilterHitLogic.hourLabel(peak.first)}, ${peak.second} menet) — ilyenkor szoktál elkezdeni."

    /** Az előjelzés mondata a menet-óra előtt — a csúcs-óra előjelzésének tükre; a kulcs és a küszöb a csúcs-óráé (FilterHitLogic.peakWarnKey). */
    fun hourWarnText(peak: Pair<Int, Int>): String =
        "Mindjárt ${peak.first} óra — ilyenkor szoktál elkezdeni (${peak.second} menet négy hét alatt). Egy munkamenet most segítene — te döntesz."

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
