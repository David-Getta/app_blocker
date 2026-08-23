package hu.lakat.app.update

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.content.FileProvider
import hu.lakat.app.BuildConfig
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
 */
object UpdateChecker {

    private const val OWNER = "David-Getta"
    private const val REPO = "app_blocker"
    private const val LATEST_API = "https://api.github.com/repos/$OWNER/$REPO/releases/latest"

    data class Update(val version: String, val apkUrl: String, val notes: String)

    /** Returns an Update when the latest release is newer than the running build. */
    suspend fun check(): Update? = withContext(Dispatchers.IO) {
        runCatching {
            val json = httpGet(LATEST_API) ?: return@runCatching null
            val obj = JSONObject(json)
            val tag = obj.getString("tag_name").removePrefix("v").trim()
            if (compareVersions(tag, BuildConfig.VERSION_NAME) <= 0) return@runCatching null
            val assets = obj.getJSONArray("assets")
            var apkUrl: String? = null
            for (i in 0 until assets.length()) {
                val a = assets.getJSONObject(i)
                if (a.getString("name").endsWith(".apk", ignoreCase = true)) {
                    apkUrl = a.getString("browser_download_url"); break
                }
            }
            val url = apkUrl ?: return@runCatching null
            Update(version = tag, apkUrl = url, notes = obj.optString("body", ""))
        }.getOrNull()
    }

    /** Downloads the APK to cache and launches the installer. */
    suspend fun downloadAndInstall(context: Context, update: Update) = withContext(Dispatchers.IO) {
        val dir = File(context.cacheDir, "updates").apply { mkdirs() }
        val apk = File(dir, "lakat-${update.version}.apk")
        URL(update.apkUrl).openStream().use { input ->
            apk.outputStream().use { output -> input.copyTo(output) }
        }
        val uri: Uri = FileProvider.getUriForFile(context, "${context.packageName}.updates", apk)
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        withContext(Dispatchers.Main) { context.startActivity(intent) }
    }

    private fun httpGet(urlStr: String): String? {
        val conn = URL(urlStr).openConnection() as HttpURLConnection
        return try {
            conn.connectTimeout = 8000
            conn.readTimeout = 8000
            conn.setRequestProperty("Accept", "application/vnd.github+json")
            conn.setRequestProperty("User-Agent", "Lakat-Android")
            if (conn.responseCode != 200) return null
            conn.inputStream.bufferedReader().readText()
        } catch (_: Exception) {
            null
        } finally {
            conn.disconnect()
        }
    }

    /** Semver-ish compare: returns >0 if a>b, 0 if equal, <0 if a<b. */
    fun compareVersions(a: String, b: String): Int {
        val pa = a.split(".").map { it.toIntOrNull() ?: 0 }
        val pb = b.split(".").map { it.toIntOrNull() ?: 0 }
        for (i in 0 until maxOf(pa.size, pb.size)) {
            val x = pa.getOrElse(i) { 0 }
            val y = pb.getOrElse(i) { 0 }
            if (x != y) return x - y
        }
        return 0
    }
}
