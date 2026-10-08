package hu.breaker.app

import android.os.Bundle
import androidx.activity.enableEdgeToEdge
import androidx.fragment.app.FragmentActivity
import androidx.activity.compose.setContent
import hu.breaker.app.core.BreakerStore
import hu.breaker.app.ui.BreakerApp
import hu.breaker.app.ui.BreakerTheme

// FragmentActivity, nem ComponentActivity: a LISTA ZÁRJÁNAK rendszer-párbeszéde
// (BiometricPrompt) fragment-gazdát kíván. Minden Compose-kód változatlan —
// a FragmentActivity a ComponentActivity leszármazottja.
class MainActivity : FragmentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        // A rendszersávok mögé rajzolunk — a 35-ös API-tól a rendszer amúgy is
        // ezt kényszeríti, így minden Androidon ugyanaz a kép. A sávok ikonjai a
        // rendszer sötét/világos módját követik, akárcsak a felület (BreakerTheme);
        // a tartalom a biztonságos területen marad (WindowInsets.safeDrawing).
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        BreakerStore.init(this)
        setContent {
            BreakerTheme {
                BreakerApp()
            }
        }
    }
}
