package hu.lakat.app.vpn

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.VpnService
import hu.lakat.app.core.LakatStore

/** Restarts the DNS filter after reboot — no user interaction needed as long
 *  as the VPN consent is still granted. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        LakatStore.init(context)
        val wasOn = LakatStore.state.value.protectionOn
        val hasSites = LakatStore.state.value.sites.isNotEmpty()
        val consentOk = VpnService.prepare(context) == null
        if ((wasOn || hasSites) && consentOk) {
            LakatVpnService.start(context)
        }
    }
}
