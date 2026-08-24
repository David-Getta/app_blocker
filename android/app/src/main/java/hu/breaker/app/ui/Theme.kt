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
 *
 * Az ELSŐDLEGES szín nem kék, hanem majdnem fehér (világos témában majdnem
 * fekete). Sötét felületen a legerősebb hangsúly a legnagyobb világosság-
 * különbség — és így nem kell hozzá új szín. Ugyanez a döntés az asztali
 * felületen: ott a „Blokkolás” gomb szintén világos. A kék akcentus megmarad,
 * de csak a kapcsolatoké és a kiemeléseké, nem a gomboké.
 */

private val Primary = Color(0xFFF2F4F7)
private val PrimaryLight = Color(0xFF14181E)
private val Accent = Color(0xFF6F9BFF)
private val AccentLight = Color(0xFF2F6FE0)
private val Ink = Color(0xFF0B0D10)

private val DarkColors = darkColorScheme(
    primary = Primary,
    onPrimary = Ink,
    primaryContainer = Color(0xFF22262D),
    onPrimaryContainer = Color(0xFFE7EBF1),

    secondary = Color(0xFF58D1A0),
    onSecondary = Ink,
    secondaryContainer = Color(0xFF16302A),
    onSecondaryContainer = Color(0xFFC8F0DD),

    tertiary = Accent,
    onTertiary = Ink,

    background = Color(0xFF08090B),
    onBackground = Color(0xFFF2F4F7),
    surface = Color(0xFF131519),
    onSurface = Color(0xFFF2F4F7),
    surfaceVariant = Color(0xFF191C21),
    onSurfaceVariant = Color(0xFF9AA4B0),

    // Hajszálvonalak. Az asztali oldalon ezek átlátszó fehérek; itt a Compose
    // tömör színt vár, ezért a felületre KISZÁMOLT megfelelőjük áll — nem
    // szemre választott szürkék.
    outline = Color(0xFF2C3037),
    outlineVariant = Color(0xFF1F2228),

    error = Color(0xFFFF6B73),
    onError = Ink,
    errorContainer = Color(0xFF3D1A1D),
    onErrorContainer = Color(0xFFFFD9DC),
)

private val LightColors = lightColorScheme(
    primary = PrimaryLight,
    onPrimary = Color.White,
    primaryContainer = Color(0xFFECEEF2),
    onPrimaryContainer = Color(0xFF14181E),

    secondary = Color(0xFF1F7D57),
    onSecondary = Color.White,
    secondaryContainer = Color(0xFFCDEEDF),
    onSecondaryContainer = Color(0xFF0A3D2A),

    tertiary = AccentLight,
    onTertiary = Color.White,

    background = Color(0xFFF4F5F7),
    onBackground = Color(0xFF10141A),
    surface = Color(0xFFFFFFFF),
    onSurface = Color(0xFF10141A),
    surfaceVariant = Color(0xFFF6F7F9),
    onSurfaceVariant = Color(0xFF545D69),

    outline = Color(0xFFD5D8DE),
    outlineVariant = Color(0xFFE6E8EC),

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
    // A NAGY számok és a képernyőcímek feszes betűközzel: minél nagyobb a
    // betű, annál szorosabbra kell húzni, különben szétesik.
    headlineSmall = TextStyle(fontSize = 26.sp, lineHeight = 32.sp, fontWeight = FontWeight.SemiBold, letterSpacing = (-0.8).sp),
    titleLarge = TextStyle(fontSize = 20.sp, lineHeight = 26.sp, fontWeight = FontWeight.SemiBold, letterSpacing = (-0.4).sp),
    titleMedium = TextStyle(fontSize = 17.sp, lineHeight = 23.sp, fontWeight = FontWeight.SemiBold, letterSpacing = (-0.3).sp),
    bodyLarge = TextStyle(fontSize = 15.sp, lineHeight = 23.sp),
    bodyMedium = TextStyle(fontSize = 14.sp, lineHeight = 21.sp),
    bodySmall = TextStyle(fontSize = 12.5.sp, lineHeight = 18.sp),
    labelLarge = TextStyle(fontSize = 14.sp, lineHeight = 18.sp, fontWeight = FontWeight.Medium),
    // Szakaszcímek: aprók, ritkított betűközzel, NAGYBETŰVEL írva a hívás
    // helyén. Így a cím nem versenyez a tartalommal — az asztali felületen
    // ugyanez a döntés.
    labelSmall = TextStyle(fontSize = 11.sp, lineHeight = 15.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 1.0.sp),
)

private val BreakerShapes = Shapes(
    extraSmall = RoundedCornerShape(8.dp),
    small = RoundedCornerShape(11.dp),
    medium = RoundedCornerShape(16.dp),
    large = RoundedCornerShape(20.dp),
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
