package hu.breaker.app.vpn

import android.content.Context
import android.content.Intent
import android.provider.Settings

/**
 * A rendszer Privát DNS beállítása — a DNS-szűrő legcsendesebb kiskapuja.
 *
 * A Breaker VPN-je csak a névfeloldást viszi: a virtuális DNS-címet routolja,
 * és a rendszer neki küldi a kérdéseket. Ha viszont a Privát DNS „szigorú”
 * módban áll (egy megadott kiszolgáló nevével), a rendszer a névfeloldást
 * TLS-en, közvetlenül annak a kiszolgálónak küldi — a VPN mellett, a szűrő
 * nélkül. A tiltás ilyenkor nem érvényesül, és az app közben zöldet mutatna.
 *
 * Kényszeríteni nem tudjuk (rendszerbeállítás), kimondani igen: a főképernyő
 * és a tartós értesítés innen tudja. Az „Automatikus” mód nem gond: ott a
 * rendszer a hálózat DNS-ét — vagyis a VPN-ét — próbálja TLS-en, nem kap
 * választ, és sima kérdéssel folytatja, amit a szűrő lát.
 */
object PrivateDns {
    /**
     * A szigorú módban beállított kiszolgáló neve, vagy null, ha a mód nem
     * szigorú (ki / automatikus / nincs beállítva). A beállítás olvasásához
     * nem kell engedély; ha mégsem olvasható, inkább nem riasztunk.
     */
    fun strictHostname(context: Context): String? {
        val resolver = context.contentResolver
        val mode = runCatching { Settings.Global.getString(resolver, "private_dns_mode") }.getOrNull()
        if (mode != "hostname") return null
        val host = runCatching { Settings.Global.getString(resolver, "private_dns_specifier") }.getOrNull()
        return host?.trim()?.takeIf { it.isNotEmpty() } ?: "névtelen kiszolgáló"
    }

    /** A rendszer hálózati beállításai — a Privát DNS ott van. */
    fun settingsIntent(): Intent =
        Intent(Settings.ACTION_WIRELESS_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
}
