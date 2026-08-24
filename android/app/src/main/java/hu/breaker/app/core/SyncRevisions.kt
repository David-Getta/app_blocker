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
        return if (changed) state.copy(sites = sites) else state
    }

    /**
     * Egy távolról érkezett rekord átvétele.
     *
     * A lenyomatot ÚJRASZÁMOLJUK, nem a másik eszközét vesszük át: így ha a két
     * oldal ugyanarra a tartalomra jutott, a következő mentés nem lépteti
     * fölöslegesen a számlálót, és nem indul be egy végtelen oda-vissza írás.
     */
    fun adopt(site: Site): Site = site.copy(revFp = fingerprint(site))
}
