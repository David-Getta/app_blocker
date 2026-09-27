package hu.breaker.app.auth

import android.content.Context
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_WEAK
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import hu.breaker.app.R

/**
 * A LISTA ZÁRJA: a rejtett blokklista felfedése a készülék azonosítását kéri —
 * ujjlenyomat, arc, vagy a képernyőzár kódja. A rejtés eddig csak nem
 * emlékeztetett; ettől VÉD is: aki a kezébe veszi a telefont, nem koppint rá
 * egy gombra, hogy lássa, mi ellen küzdesz.
 *
 * Az azonosítás a rendszeré (BiometricPrompt): mi nem látunk se ujjlenyomatot,
 * se kódot, csak egy igen/nem választ. Ahol nincs beállítva képernyőzár, ott
 * nincs mit kérni — ezt kimondjuk, nem tettetjük.
 *
 * A rejtés egy koppintás (szigorítás), a felfedés nem az: a híd befelé csak
 * szigorít, a lazítás munkába kerül — itt a munka a saját ujjad vagy kódod.
 */
object ListLock {
    /** Biometria VAGY képernyőzár-kód — a kompatibilitási könyvtár minden API-szinten tudja. */
    private const val ALLOWED = BIOMETRIC_WEAK or DEVICE_CREDENTIAL

    /** Van-e MIVEL azonosítani: biometria vagy képernyőzár-kód beállítva. */
    fun canAuthenticate(context: Context): Boolean =
        BiometricManager.from(context).canAuthenticate(ALLOWED) == BiometricManager.BIOMETRIC_SUCCESS

    /**
     * A rendszer azonosító párbeszéde. `onSuccess` csak sikeres azonosításra;
     * elutasításra, hibára vagy megszakításra `onFail` — az ok szövegével, vagy
     * üresen, ha a felhasználó csak bezárta.
     */
    fun prompt(activity: FragmentActivity, onSuccess: () -> Unit, onFail: (String) -> Unit) {
        val executor = ContextCompat.getMainExecutor(activity)
        val callback = object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) = onSuccess()
            override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                val cancelled = errorCode == BiometricPrompt.ERROR_USER_CANCELED ||
                    errorCode == BiometricPrompt.ERROR_NEGATIVE_BUTTON ||
                    errorCode == BiometricPrompt.ERROR_CANCELED
                onFail(if (cancelled) "" else errString.toString())
            }
            // Egy rossz próba még nem vég: a párbeszéd nyitva marad, újra lehet próbálni.
            override fun onAuthenticationFailed() {}
        }
        // Képernyőzár-kóddal együtt NEM lehet saját elutasító gombot adni — a rendszer adja.
        val info = BiometricPrompt.PromptInfo.Builder()
            .setTitle(activity.getString(R.string.list_lock_title))
            .setSubtitle(activity.getString(R.string.list_lock_subtitle))
            .setAllowedAuthenticators(ALLOWED)
            .build()
        BiometricPrompt(activity, executor, callback).authenticate(info)
    }
}
