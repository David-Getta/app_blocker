package hu.breaker.app.vpn

import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import android.widget.Toast
import hu.breaker.app.core.BreakerStore
import hu.breaker.app.core.FilterHitLogic
import hu.breaker.app.core.Focus
import hu.breaker.app.core.Referee

/**
 * EGY KOPPINTÁS az értesítésről az ablakig: az előjelzés értesítésének
 * második gombja ide jön, és a bíró heti ablakot tesz a csomagra az óra egy
 * órájában, minden napra — ugyanaz az út, mint a statisztika és a kártya
 * gombjáé. Csak felvétel (szigorítás, ingyen): ablakos csomagra a bíró nemet
 * mond, és a nem is látszik. Az óra a gombé, a sáv a magé (`peakWindowBand`).
 */
class FocusWindowReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_WINDOW) return
        val packId = intent.getStringExtra(EXTRA_PACK_ID) ?: return
        val hour = intent.getIntExtra(EXTRA_HOUR, -1)
        if (hour !in 0..23) return
        BreakerStore.init(context)
        val now = System.currentTimeMillis()
        val notifId = intent.getIntExtra(EXTRA_NOTIF_ID, 0)
        if (notifId != 0) context.getSystemService(NotificationManager::class.java)?.cancel(notifId)
        runCatching { Referee.addFocusWindow(packId, Focus.peakWindowBand(hour), now) }
            .onSuccess {
                val name = BreakerStore.state.value.focusPacks.find { it.id == packId }?.name ?: "a csomag"
                Toast.makeText(context, "Megvan: $name minden nap ${FilterHitLogic.hourLabel(hour)} magától indul — levenni próbatétellel.", Toast.LENGTH_LONG).show()
            }
            .onFailure {
                Log.w(TAG, "az ablak nem került fel az értesítésről: $it")
                Toast.makeText(context, "Nem került fel: ${it.message ?: "a bíró nemet mondott."}", Toast.LENGTH_LONG).show()
            }
    }

    companion object {
        private const val TAG = "FocusWindowReceiver"
        const val ACTION_WINDOW = "hu.breaker.app.FOCUS_WINDOW"
        const val EXTRA_PACK_ID = "packId"
        const val EXTRA_HOUR = "hour"
        const val EXTRA_NOTIF_ID = "notifId"
    }
}
