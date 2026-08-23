package hu.breaker.app.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * A Breaker arculata Androidon — az asztali felület tükre.
 *
 * Miért TELJES a színséma, és miért nem elég pár szín: a Material3 minden meg
 * nem adott helyet kitölt a saját alapértelmezésével, ami lila alapú. Öt szín
 * megadásával a felület fele (nyomógombok háttere, kártyák kontúrja, kijelölés,
 * hibamezők) a Material lilájából jött, a másik fele a mi kékünkből — ettől
 * nézett ki összeszedetlennek. Minden fontos helyet kitöltünk.
 *
 * A sötét téma számai szándékosan azonosak az asztali stíluslapéval, hogy a két
 * platform ugyanannak az appnak látsszon.
 */

private val Accent = Color(0xFF5B8CFF)
private val AccentLight = Color(0xFF2F6FE0)
private val Ink = Color(0xFF0B1220)

private val DarkColors = darkColorScheme(
    primary = Accent,
    onPrimary = Ink,
    primaryContainer = Color(0xFF23334F),
    onPrimaryContainer = Color(0xFFD5E2FF),

    secondary = Color(0xFF45C78D),
    onSecondary = Ink,
    secondaryContainer = Color(0xFF1E3B31),
    onSecondaryContainer = Color(0xFFC8F0DD),

    tertiary = Color(0xFFE8B34B),
    onTertiary = Ink,

    background = Color(0xFF0D1116),
    onBackground = Color(0xFFE9EEF4),
    surface = Color(0xFF1A2027),
    onSurface = Color(0xFFE9EEF4),
    surfaceVariant = Color(0xFF212A33),
    onSurfaceVariant = Color(0xFFA4B1BE),

    outline = Color(0xFF3A4551),
    outlineVariant = Color(0xFF2A333D),

    error = Color(0xFFF0616B),
    onError = Ink,
    errorContainer = Color(0xFF4A1F23),
    onErrorContainer = Color(0xFFFFD9DC),
)

private val LightColors = lightColorScheme(
    primary = AccentLight,
    onPrimary = Color.White,
    primaryContainer = Color(0xFFDCE7FF),
    onPrimaryContainer = Color(0xFF0F2A5C),

    secondary = Color(0xFF1F7D57),
    onSecondary = Color.White,
    secondaryContainer = Color(0xFFCDEEDF),
    onSecondaryContainer = Color(0xFF0A3D2A),

    tertiary = Color(0xFF8A6100),
    onTertiary = Color.White,

    background = Color(0xFFF7F9FC),
    onBackground = Color(0xFF121820),
    surface = Color(0xFFFFFFFF),
    onSurface = Color(0xFF121820),
    surfaceVariant = Color(0xFFEEF2F7),
    onSurfaceVariant = Color(0xFF4A5764),

    outline = Color(0xFFC3CCD8),
    outlineVariant = Color(0xFFDDE4EC),

    error = Color(0xFFC02A35),
    onError = Color.White,
    errorContainer = Color(0xFFFFDAD9),
    onErrorContainer = Color(0xFF410006),
)

/**
 * Betűtípus-skála. A Material alapértelmezése minden címsort ugyanolyan
 * vastagnak hagy; itt a címek kapnak súlyt és szorosabb betűközt, a segédszöveg
 * pedig marad kicsi és halk — ettől lesz a képernyőn sorrend.
 */
private val BreakerTypography = Typography(
    titleLarge = TextStyle(fontSize = 20.sp, lineHeight = 26.sp, fontWeight = FontWeight.SemiBold, letterSpacing = (-0.2).sp),
    titleMedium = TextStyle(fontSize = 16.sp, lineHeight = 22.sp, fontWeight = FontWeight.SemiBold, letterSpacing = (-0.1).sp),
    bodyLarge = TextStyle(fontSize = 15.sp, lineHeight = 22.sp),
    bodyMedium = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
    bodySmall = TextStyle(fontSize = 12.5.sp, lineHeight = 17.sp),
    labelLarge = TextStyle(fontSize = 14.sp, lineHeight = 18.sp, fontWeight = FontWeight.SemiBold),
)

private val BreakerShapes = Shapes(
    extraSmall = RoundedCornerShape(8.dp),
    small = RoundedCornerShape(10.dp),
    medium = RoundedCornerShape(14.dp),
    large = RoundedCornerShape(18.dp),
)

@Composable
fun BreakerTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = if (isSystemInDarkTheme()) DarkColors else LightColors,
        typography = BreakerTypography,
        shapes = BreakerShapes,
        content = content,
    )
}
