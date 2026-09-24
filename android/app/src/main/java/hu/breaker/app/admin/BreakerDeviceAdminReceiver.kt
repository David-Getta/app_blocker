package hu.breaker.app.admin

import android.app.admin.DeviceAdminReceiver
import android.content.Context
import android.content.Intent
import hu.breaker.app.R

/**
 * TÖRLÉS-VÉDELEM — eszközadmin.
 *
 * Amíg ez a vevő aktív eszközadmin, az Android nem engedi az egykoppintásos
 * eltávolítást: előbb ki kell kapcsolni az eszközadmint. Ez az EGYETLEN dolog,
 * amit belőle használunk — a házirend (res/xml/device_admin.xml) üres: nem
 * kérünk semmilyen jogot, és semmit nem látunk a telefonból.
 *
 * Nem gépzár, és ezt nem is titkoljuk: a rendszer Beállításaiban bármikor
 * kikapcsolható. A cél a súrlódás — hogy a törlés ne egy reflex legyen, hanem
 * egy tudatos, több lépéses döntés. „A híd befelé csak szigorít”: bekapcsolni
 * egy koppintás, kikapcsolni szándékos lépés a rendszeren át.
 */
class BreakerDeviceAdminReceiver : DeviceAdminReceiver() {
    // A rendszer a kikapcsolás megerősítő képernyőjén mutatja meg ezt a
    // mondatot — az utolsó tudatos pillanat, mielőtt visszatér az
    // egykoppintásos törlés lehetősége.
    override fun onDisableRequested(context: Context, intent: Intent): CharSequence =
        context.getString(R.string.device_admin_disable_warning)
}
