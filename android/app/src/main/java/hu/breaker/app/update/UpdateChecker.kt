package hu.breaker.app.update

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import hu.breaker.app.BuildConfig
import hu.breaker.app.core.UpdateLogic
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * Play-Store-like updates without the Play Store: checks GitHub Releases for a
 * newer version, downloads the APK, and launches the system installer.
 *
 * On the Play Store track this is unused (the store updates the app); for the
 * direct-download track it keeps the app current with one tap.
 *
 * Minden kimenet NEVESÍTETT: a „letöltöm és hátha” változat csendben elbukott,
 * ha nem volt telepítési engedély, és a felhasználó annyit látott, hogy a gomb
 * visszaugrik. Egy frissítő, ami néma marad, nem frissítő.
 */
object UpdateChecker {

    private const val OWNER = "David-Getta"
    private const val REPO = "app_blocker"
    private const val LATEST_API = "https://api.github.com/repos/$OWNER/$REPO/releases/latest"

    data class Update(val version: String, val apkUrl: String, val notes: String)

    /** Mi lett a frissítésből — a felület ebből tud értelmes dolgot mondani. */
    sealed class InstallResult {
        /** A rendszertelepítő elindult; innentől a felhasználóé a szó. */
        object Started : InstallResult()

        /**
         * Hiányzik az „ismeretlen forrásból telepítés” engedély EHHEZ az apphoz.
         * Android 8 óta a manifest-beli jogosultság önmagában kevés: a
         * felhasználónak kapcsolóval kell megadnia. Enélkül a telepítő-indítás
         * nem csinál semmit — ezért ezt külön esetként kezeljük, és el is
         * navigálunk a megfelelő beállításhoz.
         */
        object NeedsPermission : InstallResult()

        data class Failed(val message: String) : InstallResult()
    }

    /** Returns an Update when the latest release is newer than the running build. */
    suspend fun check(): Update? = withContext(Dispatchers.IO) {
        runCatching {
            val json = httpGet(LATEST_API) ?: return@runCatching null
            val obj = JSONObject(json)
            val tag = obj.getString("tag_name")
            if (!UpdateLogic.isNewer(tag, BuildConfig.VERSION_NAME)) return@runCatching null
            val assets = obj.getJSONArray("assets")
            val names = ArrayList<String>(assets.length())
            val urls = HashMap<String, String>()
            for (i in 0 until assets.length()) {
                val a = assets.getJSONObject(i)
                val name = a.getString("name")
                names.add(name)
                urls[name] = a.getString("browser_download_url")
            }
            val apk = UpdateLogic.pickApk(names) ?: return@runCatching null
            val url = urls[apk] ?: return@runCatching null
            Update(
                version = tag.trim().removePrefix("v"),
                apkUrl = url,
                notes = obj.optString("body", ""),
            )
        }.getOrNull()
    }

    /** Van-e engedélye az appnak csomagot telepíteni? Android 8 alatt mindig. */
    fun canInstall(context: Context): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.O ||
            context.packageManager.canRequestPackageInstalls()

    /** A rendszerbeállítás, ahol az engedély megadható — pont ehhez az apphoz. */
    fun installPermissionIntent(context: Context): Intent =
        Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES)
            .setData(Uri.parse("package:${context.packageName}"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

    /** Downloads the APK to cache and launches the installer. */
    suspend fun downloadAndInstall(context: Context, update: Update): InstallResult =
        withContext(Dispatchers.IO) {
            // Előbb az engedély: felesleges letölteni 7 MB-ot ahhoz, hogy a végén
            // kiderüljön, a telepítő el sem indulhat.
            if (!canInstall(context)) return@withContext InstallResult.NeedsPermission

            val dir = File(context.cacheDir, "updates").apply { mkdirs() }
            val name = "breaker-${update.version}.apk"
            val apk = File(dir, name)
            val part = File(dir, UpdateLogic.partName(name))
            // A korábbi verziók csomagjai már semmire nem jók.
            dir.listFiles()?.forEach { if (it.name != name) it.delete() }

            try {
                var total = 0L
                URL(update.apkUrl).openStream().use { input ->
                    part.outputStream().use { output ->
                        val buf = ByteArray(64 * 1024)
                        while (true) {
                            val n = input.read(buf)
                            if (n < 0) break
                            total += n
                            if (total > UpdateLogic.MAX_APK_BYTES) {
                                throw IllegalStateException("a letöltés túllépte a méretkorlátot")
                            }
                            output.write(buf, 0, n)
                        }
                    }
                }
                // Csak a HIÁNYTALAN fájl kapja meg a végleges nevet: így egy
                // megszakadt letöltésből sosem lesz „telepíthetőnek látszó” APK.
                if (apk.exists()) apk.delete()
                if (!part.renameTo(apk)) throw IllegalStateException("a letöltött fájl nem véglegesíthető")
            } catch (e: Exception) {
                part.delete()
                return@withContext InstallResult.Failed(e.message ?: "ismeretlen hiba")
            }

            try {
                val uri: Uri = FileProvider.getUriForFile(context, "${context.packageName}.updates", apk)
                val intent = Intent(Intent.ACTION_VIEW).apply {
                    setDataAndType(uri, "application/vnd.android.package-archive")
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                withContext(Dispatchers.Main) { context.startActivity(intent) }
                InstallResult.Started
            } catch (e: Exception) {
                InstallResult.Failed(e.message ?: "a telepítő nem indult el")
            }
        }

    private fun httpGet(urlStr: String): String? {
        val conn = URL(urlStr).openConnection() as HttpURLConnection
        return try {
            conn.connectTimeout = 8000
            conn.readTimeout = 8000
            conn.setRequestProperty("Accept", "application/vnd.github+json")
            conn.setRequestProperty("User-Agent", "Breaker-Android")
            if (conn.responseCode != 200) return null
            conn.inputStream.bufferedReader().readText()
        } catch (_: Exception) {
            null
        } finally {
            conn.disconnect()
        }
    }
}
