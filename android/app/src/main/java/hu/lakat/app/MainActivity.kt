package hu.lakat.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import hu.lakat.app.core.LakatStore
import hu.lakat.app.ui.LakatApp

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        LakatStore.init(this)
        setContent {
            LakatTheme {
                LakatApp()
            }
        }
    }
}

private val DarkColors = darkColorScheme(
    primary = Color(0xFF4F8EF7),
    secondary = Color(0xFF4FC48B),
    background = Color(0xFF101418),
    surface = Color(0xFF1A2027),
    error = Color(0xFFE5636C),
)

private val LightColors = lightColorScheme(
    primary = Color(0xFF2F6FE0),
    secondary = Color(0xFF2E9E6B),
)

@Composable
fun LakatTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = if (isSystemInDarkTheme()) DarkColors else LightColors,
        content = content,
    )
}
