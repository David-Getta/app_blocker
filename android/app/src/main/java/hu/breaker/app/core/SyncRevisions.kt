package hu.breaker.app.core

import java.security.MessageDigest

/**
 * Verziószám-vezetés a szinkronhoz — a `desktop/src/helper/revisions.ts` tükre.
 *
 * Az összefésülés azon áll, hogy minden oldal-rekordnak van egy [Site.rev]
 * számlálója, ami MINDEN érdemi változásnál nő. Ez dönti el, mikor mehet át egy
 * lazítás a másik eszközre: a nagyobb `rev` mögött ott a munka.
 *
 * A lenyomat a MENTETT állapotban van, nem a memóriában, tehát az app
 * újraindítása nem hajtja fel a számlálót a semmiért.
 */
object SyncRevisions {

    /**
     * Amit a szinkron lát egy rekordból.
     *
     * A SZÜNET kimarad: eszközfüggő és rövid életű, fel se megy a kiszolgálóra.
     * Ha itt benne lenne, minden feloldás fölöslegesen léptetné a számlálót és
     * indítana egy feltöltést.
     */
    private fun syncFields(s: Site): String {
        val bands = s.schedule?.let { sch ->
            sch.mode.name + sch.bands.joinToString(";") { b ->
                b.days.sorted().joinToString("+") + ":" + b.startMin + "-" + b.endMin
            }
        } ?: "-"
        return listOf(
            s.domain,
            s.hostnames.sorted().joinToString(","),
            s.pendingDeleteAt?.toString() ?: "-",
            bands,
            s.dailyLimitSeconds?.toString() ?: "-",
            // Az adag-szabály beállítása utazik; a számláló nem (eszköz-helyi).
            s.burstSeconds?.toString() ?: "-",
            s.cooldownSeconds?.toString() ?: "-",
            s.alias ?: "-",
            // RENDEZVE: a sorrend nem jelent semmit, viszont ha beleszámítana,
            // egy átrendeződés fölöslegesen léptetné a számlálót, és minden
            // körben feltöltést indítana.
            s.rules?.map { it.host + it.path }?.sorted()?.joinToString(",") ?: "-",
        ).joinToString(" ")
    }

    fun fingerprint(s: Site): String {
        val md = MessageDigest.getInstance("SHA-256")
        val d = md.digest(syncFields(s).toByteArray(Charsets.UTF_8))
        return d.take(8).joinToString("") { b -> Integer.toHexString(b.toInt() and 0xff).padStart(2, '0') }
    }

    /** A megváltozott rekordok számlálójának léptetése. */
    fun bump(state: AppState, now: Long): AppState {
        val deviceId = state.sync?.deviceId ?: "local"
        var changed = false
        val sites = state.sites.map { site ->
            val fp = fingerprint(site)
            if (site.revFp == fp) {
                site
            } else {
                changed = true
                site.copy(rev = site.rev + 1, updatedAt = now, updatedBy = deviceId, revFp = fp)
            }
        }
        var next = if (changed) state.copy(sites = sites) else state
        next = bumpFocus(next, deviceId, now)
        return next
    }

    /**
     * A munkamenet lenyomata.
     *
     * A FUTÓ menet benne van, ellentétben az oldalak szünetével — és ez a
     * különbség szándékos. A szünet eszközfüggő és fel sem megy a kiszolgálóra;
     * a munkamenet viszont a fiók egészére szól. Ha a futás kimaradna, az
     * indítás sosem léptetné a számlálót, és a másik eszköz sosem tudná meg,
     * hogy fut valami.
     */
    /**
     * A lenyomat formátumának jele.
     *
     * Azért van benne, hogy a formátumváltás FELISMERHETŐ legyen. Enélkül egy
     * régi alakú lenyomat egyszerűen másnak látszana, és a frissítés utáni
     * első kör mindenkinél léptetne egyet — egy ÜRES telefonon pedig ez azt
     * jelentené, hogy az üres lista legyőzi a gépen felvett csomagokat.
     */
    const val FOCUS_FP_V2 = "2|"

    private fun packsPart(state: AppState): String =
        state.focusPacks.sortedBy { it.id }.joinToString("|") { p ->
            listOf(
                p.id, p.name,
                p.allowSites.sorted().joinToString(","),
                p.allowApps.sorted().joinToString(","),
                p.defaultMinutes.toString(),
            ).joinToString(";")
        }

    private fun digest(text: String): String {
        val md = MessageDigest.getInstance("SHA-256")
        val d = md.digest(text.toByteArray(Charsets.UTF_8))
        return d.take(8).joinToString("") { b -> Integer.toHexString(b.toInt() and 0xff).padStart(2, '0') }
    }

    /**
     * A RÉGI lenyomat — kizárólag a formátumváltás felismeréséhez.
     *
     * Ne épüljön rá semmi új. Az egyetlen dolga, hogy a mentésben talált, régi
     * alakú lenyomatról el tudjuk dönteni: az azóta VÁLTOZATLAN állapothoz
     * tartozik-e, vagy közben valódi szerkesztés is történt.
     */
    fun focusFingerprintV1(state: AppState): String {
        val run = state.focusRun?.let { "${it.packId};${it.startedAt};${it.endsAt}" } ?: "-"
        return digest("${packsPart(state)}//$run")
    }

    fun focusFingerprint(state: AppState): String {
        // A futás HOSSZA számít, nem az abszolút időpontjai.
        //
        // Ez zárja be az óra-átállítás rését. Alvásból ébredve az app elnyeli
        // az ugrást: a kezdést és a véget UGYANANNYIVAL tolja el, hogy a menet
        // ne legyen lejárt. Abszolút időpontokkal ez változásnak látszott,
        // tehát léptette a számlálót — és így az alvó eszköz „még fut”
        // állapota legyőzte az ébren lévő eszköz szabályos lezárását. Az
        // elnyelés viszont nem döntés, csak helyi újraértelmezés; a HOSSZ
        // pedig egy egyenletes eltolástól nem változik.
        val run = state.focusRun?.let { "${it.packId};${it.endsAt - it.startedAt}" } ?: "-"
        return FOCUS_FP_V2 + digest("${packsPart(state)}//$run")
    }

    /**
     * A munkamenet számlálójának léptetése.
     *
     * AZ ÜRESSÉG NEM SZERKESZTÉS. Egy telefon, ami még sosem látott
     * munkamenetet, ne lépjen 1-re pusztán attól, hogy először számolunk neki
     * lenyomatot — különben az első szinkronnál az ÜRES listája nyerne az
     * „utolsó író nyer” szabály szerint, és CSENDBEN letörölné a gépen felvett
     * összes csomagot. Az oldalaknál ez nem fordulhat elő, mert ott rekordonként
     * megy a számláló; itt EGY blob utazik, tehát külön ki kell mondani.
     */
    fun bumpFocus(state: AppState, deviceId: String, now: Long): AppState {
        val fp = focusFingerprint(state)
        if (state.focusRevFp == fp) return state
        if (state.focusRevFp == null && state.focusPacks.isEmpty() && state.focusRun == null) {
            return state.copy(focusRevFp = fp)
        }
        // FORMÁTUMVÁLTÁS. A mentésben még a régi alakú lenyomat van; ettől
        // önmagában nem történt semmi. A régi algoritmussal döntjük el, volt-e
        // valódi változás: ha egyezik, csak a formátum változott — átvesszük
        // az újat léptetés nélkül. Ha eltér, akkor VOLT szerkesztés, és az
        // ugyanúgy léptet. Így a váltásnak nincs ablaka: sem szerkesztést nem
        // nyel el, sem fölöslegesen nem léptet egy üres telefonon.
        val old = state.focusRevFp
        if (old != null && !old.startsWith(FOCUS_FP_V2) && old == focusFingerprintV1(state)) {
            return state.copy(focusRevFp = fp)
        }
        return state.copy(
            focusRev = state.focusRev + 1,
            focusUpdatedAt = now,
            focusUpdatedBy = deviceId,
            focusRevFp = fp,
        )
    }

    /** Egy távolról átvett munkamenet lenyomatának újraszámolása. */
    fun adoptFocus(state: AppState): AppState = state.copy(focusRevFp = focusFingerprint(state))

    /**
     * Egy távolról érkezett rekord átvétele.
     *
     * A lenyomatot ÚJRASZÁMOLJUK, nem a másik eszközét vesszük át: így ha a két
     * oldal ugyanarra a tartalomra jutott, a következő mentés nem lépteti
     * fölöslegesen a számlálót, és nem indul be egy végtelen oda-vissza írás.
     */
    fun adopt(site: Site): Site = site.copy(revFp = fingerprint(site))
}
