package hu.breaker.app.vpn

import android.content.Context
import android.content.Intent
import android.provider.Settings
import androidx.core.app.NotificationManagerCompat

/**
 * Ha a Breaker értesítései ki vannak kapcsolva — a gépi
 * `desktop/src/shared/notify-delivery.ts` testvére.
 *
 * A telefon sok mindent értesítésben mond el: a szünet végét, a betelő
 * keretet, a közelgő heti ablakot, a hétfői visszatekintést, és a védelem
 * tartós értesítése is ott beszél. Ha az app értesítései a rendszerben ki
 * vannak kapcsolva (Android 13-tól az engedély elutasítása is ez), mindez
 * nyomtalanul elmarad. A gép csak utólag tudja meg, ha a rendszer egy
 * értesítést visszautasít; a telefon előre tudja: a rendszer megmondja.
 *
 * A főképernyő kimondja, csendben — kártya a többi beállítás között, nem
 * felugró ablak: ha valaki szándékosan kapcsolta ki, annak ez csak egy tény.
 * Csak a teljes kikapcsolás számít: egy-egy csatorna (például a heti
 * visszatekintés) némítása szándékos, finomabb döntés.
 */
object NotificationAccess {
    /** Engedélyezve vannak-e az app értesítései. Ha nem olvasható, inkább nem riasztunk. */
    fun enabled(context: Context): Boolean =
        runCatching { NotificationManagerCompat.from(context).areNotificationsEnabled() }.getOrDefault(true)

    /** Az app saját értesítési beállításai — egy koppintás a kapcsolóig. */
    fun settingsIntent(context: Context): Intent =
        Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
            .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
}
