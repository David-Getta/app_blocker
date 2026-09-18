package hu.breaker.app.vpn

import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import android.widget.Toast
import hu.breaker.app.core.BreakerStore
import hu.breaker.app.core.Referee

/**
 * EGY KOPPINTÁS az értesítésről a menetig: a sokadik megakadás és az
 * előjelzés értesítésének gombja ide jön, és a bíró indítja a csomagot —
 * ugyanaz az út, mint a kezdőlap kártyájáé. Nem old fel semmit: a menet
 * szigorítás, ingyen van. Futó menet mellett nem indít (egyszerre egy fut),
 * és a koppintásnak látszania kell: egy rövid üzenet mondja, mi indult.
 */
class FocusStartReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_START) return
        val packId = intent.getStringExtra(EXTRA_PACK_ID) ?: return
        val minutes = intent.getIntExtra(EXTRA_MINUTES, 0)
        if (minutes <= 0) return
        BreakerStore.init(context)
        val now = System.currentTimeMillis()
        val notifId = intent.getIntExtra(EXTRA_NOTIF_ID, 0)
        if (notifId != 0) context.getSystemService(NotificationManager::class.java)?.cancel(notifId)
        if (BreakerStore.runningFocus(now) != null) return
        runCatching { Referee.startFocus(packId, minutes, now) }
            .onSuccess {
                val name = BreakerStore.state.value.focusPacks.find { it.id == packId }?.name ?: "menet"
                Toast.makeText(context, "A menet elindult: $name, $minutes perc.", Toast.LENGTH_LONG).show()
            }
            .onFailure { Log.w(TAG, "a menet nem indult az értesítésről: $it") }
    }

    companion object {
        private const val TAG = "FocusStartReceiver"
        const val ACTION_START = "hu.breaker.app.FOCUS_START"
        const val EXTRA_PACK_ID = "packId"
        const val EXTRA_MINUTES = "minutes"
        const val EXTRA_NOTIF_ID = "notifId"
    }
}
