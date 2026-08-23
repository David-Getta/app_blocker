package hu.breaker.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import hu.breaker.app.core.BreakerStore
import hu.breaker.app.ui.BreakerApp
import hu.breaker.app.ui.BreakerTheme

class MainActivity : ComponentActivity() {
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
