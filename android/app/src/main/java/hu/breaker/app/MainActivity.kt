package hu.breaker.app

import android.os.Bundle
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
        super.onCreate(savedInstanceState)
        BreakerStore.init(this)
        setContent {
            BreakerTheme {
                BreakerApp()
            }
        }
    }
}
