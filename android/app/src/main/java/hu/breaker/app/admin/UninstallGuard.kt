package hu.breaker.app.admin

import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.provider.Settings
import hu.breaker.app.R

/**
 * A TÖRLÉS-VÉDELEM kapcsolója egy helyen: az eszközadmin be- és kikapcsolásának
 * útjai, meg a jelenlegi állapot. Az állapotot a rendszertől kérdezzük, nem
 * tároljuk — nincs mit szinkronizálni, ez a készülék dolga.
 *
 * A bekapcsolás egy koppintás (a híd befelé csak szigorít). A kikapcsoláshoz
 * SZÁNDÉKOSAN nem adunk csendes, egykoppintásos gombot: az visszahozná a
 * reflexből törlést, ami ellen az egész véd. A kikapcsolás a rendszer
 * biztonsági beállításain át, tudatosan történik.
 */
object UninstallGuard {
    fun component(context: Context): ComponentName =
        ComponentName(context, BreakerDeviceAdminReceiver::class.java)

    private fun dpm(context: Context): DevicePolicyManager =
        context.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager

    /** Aktív-e most a törlés-védelem. A rendszertől kérdezzük, minden alkalommal. */
    fun isActive(context: Context): Boolean =
        dpm(context).isAdminActive(component(context))

    /**
     * A bekapcsolás rendszer-párbeszéde: a felhasználó maga hagyja jóvá. Mellé
     * tesszük, mit ad és mit nem — átlátszó, nem meglepetés.
     */
    fun enableIntent(context: Context): Intent =
        Intent(DevicePolicyManager.ACTION_ADD_DEVICE_ADMIN)
            .putExtra(DevicePolicyManager.EXTRA_DEVICE_ADMIN, component(context))
            .putExtra(
                DevicePolicyManager.EXTRA_ADD_EXPLANATION,
                context.getString(R.string.device_admin_add_explanation),
            )

    /**
     * A kikapcsolás útja: a rendszer biztonsági beállításai. Nem mi kapcsoljuk
     * ki — a rendszer eszközadmin-listáján, tudatosan. Ez maga a súrlódás.
     */
    fun securitySettingsIntent(): Intent =
        Intent(Settings.ACTION_SECURITY_SETTINGS)
}
