package hu.breaker.app.core

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
}
