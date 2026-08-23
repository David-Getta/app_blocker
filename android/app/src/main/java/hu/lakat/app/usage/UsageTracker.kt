package hu.lakat.app.usage

import android.app.AppOpsManager
import android.app.KeyguardManager
import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.PowerManager
import android.os.Process
import android.provider.Settings
import hu.lakat.app.core.LakatStore
import hu.lakat.app.core.UsageLogic
import java.util.concurrent.atomic.AtomicReference

/**
 * Active-time tracker for Android.
 *
 * Foreground app comes from UsageStatsManager (needs the user-granted "usage
 * access" permission). Screen-off and a locked keyguard count as idle, so time
 * only accrues while the user is genuinely present.
 *
 * Websites: Android exposes no per-URL API for other apps' browsers. When a
 * browser is in the foreground we attribute time to the domain most recently
 * seen by our own VPN DNS filter — an approximation, and the UI says so.
 */
object UsageTracker {

    /** Packages we treat as browsers for domain attribution. */
    private val BROWSERS = setOf(
        "com.android.chrome", "com.chrome.beta", "com.chrome.dev",
        "org.mozilla.firefox", "org.mozilla.fenix",
        "com.microsoft.emmx", "com.brave.browser", "com.opera.browser",
        "com.sec.android.app.sbrowser", "com.duckduckgo.mobile.android",
        "com.vivaldi.browser", "com.kiwibrowser.browser",
    )

    /** How recent a DNS sighting must be to be treated as "the current page". */
    private const val DOMAIN_FRESH_MS = 30_000L

    private data class Sighting(val domain: String, val at: Long)

    private val lastDomain = AtomicReference<Sighting?>(null)
    private var lastAt = 0L
    private var cachedFgPackage: String? = null

    /**
     * Hosts that are never "the page you are on": CDNs, media, telemetry and
     * analytics. Loading one page fires dozens of these, and without filtering
     * the browser's time would be attributed to whichever asset host happened
     * to resolve last instead of the site the user is actually reading.
     */
    private val INFRA_SUFFIXES = listOf(
        "in-addr.arpa", ".local", ".arpa",
        "gstatic.com", "googleapis.com", "googleusercontent.com", "googlevideo.com",
        "google-analytics.com", "googletagmanager.com", "googlesyndication.com",
        "doubleclick.net", "gvt1.com", "gvt2.com",
        "cloudfront.net", "akamai.net", "akamaized.net", "akamaiedge.net",
        "fbcdn.net", "cdninstagram.com", "licdn.com", "twimg.com", "redditstatic.com",
        "cloudflare.com", "cloudflareinsights.com", "jsdelivr.net", "unpkg.com",
        "sentry.io", "segment.io", "amplitude.com", "mixpanel.com", "hotjar.com",
        "azureedge.net", "cdn77.org", "fastly.net", "edgekey.net", "llnwd.net",
        "apple.com.akadns.net", "aaplimg.com", "mzstatic.com",
        "ntp.org", "msftncsi.com", "msftconnecttest.com",
    )

    private fun isInfrastructure(domain: String): Boolean =
        INFRA_SUFFIXES.any { domain == it.trimStart('.') || domain.endsWith(it) }

    /**
     * Called by the VPN service for every DNS name it resolves. The name is
     * canonicalised to the domain the user would recognise: if it belongs to a
     * site on the block list we use that site's own domain (so statistics and
     * the block list line up), otherwise we strip the usual www./m. prefixes.
     */
    fun noteDomain(rawDomain: String, now: Long) {
        val domain = rawDomain.lowercase()
        if (isInfrastructure(domain)) return

        val sites = LakatStore.state.value.sites
        val canonical = sites.firstOrNull { site ->
            domain == site.domain || domain.endsWith(".${site.domain}") ||
                site.hostnames.any { it == domain }
        }?.domain ?: domain.removePrefix("www.").removePrefix("m.")

        lastDomain.set(Sighting(canonical, now))
    }

    fun hasUsageAccess(context: Context): Boolean {
        val ops = context.getSystemService(Context.APP_OPS_SERVICE) as AppOpsManager
        val mode = if (Build.VERSION.SDK_INT >= 29) {
            ops.unsafeCheckOpNoThrow(
                AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), context.packageName)
        } else {
            @Suppress("DEPRECATION")
            ops.checkOpNoThrow(
                AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), context.packageName)
        }
        return mode == AppOpsManager.MODE_ALLOWED
    }

    fun usageAccessIntent(): Intent =
        Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

    /** True when the user is present: screen on and not behind the lock screen. */
    private fun userPresent(context: Context): Boolean {
        val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
        if (!pm.isInteractive) return false
        val km = context.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
        return !km.isKeyguardLocked
    }

    /** Most recent foreground package, or the cached one when the window was quiet. */
    private fun foregroundPackage(context: Context, now: Long): String? {
        val usm = context.getSystemService(Context.USAGE_STATS_SERVICE) as? UsageStatsManager
            ?: return null
        val events = runCatching { usm.queryEvents(now - 15_000, now) }.getOrNull() ?: return cachedFgPackage
        val e = UsageEvents.Event()
        var latest: String? = null
        while (events.hasNextEvent()) {
            events.getNextEvent(e)
            val resumed = if (Build.VERSION.SDK_INT >= 29) {
                e.eventType == UsageEvents.Event.ACTIVITY_RESUMED
            } else {
                @Suppress("DEPRECATION")
                e.eventType == UsageEvents.Event.MOVE_TO_FOREGROUND
            }
            if (resumed) latest = e.packageName
        }
        if (latest != null) cachedFgPackage = latest
        return cachedFgPackage
    }

    private fun appLabel(context: Context, pkg: String): String = runCatching {
        val pm = context.packageManager
        pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString()
    }.getOrDefault(pkg)

    private fun buildForeground(context: Context, now: Long): UsageLogic.Foreground? {
        val pkg = foregroundPackage(context, now) ?: return null
        // Our own app's screen time is not what the user wants measured.
        if (pkg == context.packageName) return null
        val label = appLabel(context, pkg)
        if (pkg in BROWSERS) {
            val seen = lastDomain.get()
            if (seen != null && now - seen.at <= DOMAIN_FRESH_MS) {
                return UsageLogic.Foreground(pkg, label, seen.domain)
            }
        }
        return UsageLogic.Foreground(pkg, label)
    }

    /**
     * One sampling tick. Safe to call on any schedule; the elapsed span is
     * clamped so a missed or delayed tick cannot inflate the measurement.
     */
    fun tick(context: Context, now: Long = System.currentTimeMillis()) {
        if (!LakatStore.state.value.usage.enabled) { lastAt = now; return }
        if (!hasUsageAccess(context)) { lastAt = now; return }
        if (!userPresent(context)) { lastAt = now; return }
        if (lastAt == 0L) { lastAt = now; return }

        val fg = buildForeground(context, now)
        // The OS already tells us the screen is on and unlocked, so idle is 0 here.
        val decision = UsageLogic.decideSample(lastAt, now, 0, fg)
        lastAt = now
        if (decision == null) return
        buffer(decision, now)
    }

    /** Screen-off / service restart: the gap must not be counted. */
    fun resetClock(now: Long = System.currentTimeMillis()) {
        lastAt = now
        flush(now)
    }

    // ------------------------------------------------------------ buffering

    /**
     * Measured slices are buffered in memory and written to the store once a
     * minute. Writing on every 5s tick would re-serialize the whole app state
     * (up to 90 days of history) to SharedPreferences twelve times a minute
     * from this background thread.
     */
    private const val FLUSH_INTERVAL_MS = 60_000L

    private val pending = LinkedHashMap<String, UsageLogic.SampleDecision>()
    private var lastFlush = 0L

    @Synchronized
    private fun buffer(decision: UsageLogic.SampleDecision, now: Long) {
        // Key by (target, local day) so a buffer spanning midnight does not dump
        // the earlier day's seconds into the later day's bucket.
        val bucket = "${decision.key}@${UsageLogic.dayKey(now)}"
        val existing = pending[bucket]
        pending[bucket] = if (existing == null) decision
            else existing.copy(seconds = existing.seconds + decision.seconds)
        if (lastFlush == 0L) lastFlush = now
        if (now - lastFlush >= FLUSH_INTERVAL_MS) flush(now)
    }

    /** Writes the buffer into the store as ONE state update. */
    @Synchronized
    fun flush(now: Long = System.currentTimeMillis()) {
        lastFlush = now
        if (pending.isEmpty()) return
        val batch = pending.toMap()
        pending.clear()
        LakatStore.mutate { s ->
            // Snapshot FIRST, then record into the copy: recording into the live
            // object would mutate the value StateFlow already holds, the "new"
            // value would compare equal to it, and nothing would ever be emitted.
            val next = UsageLogic.snapshot(s.usage)
            for ((bucket, d) in batch) {
                val at = bucketTime(bucket, now)
                UsageLogic.recordSample(next, d.key, d.seconds, at, d.label)
            }
            s.copy(usage = next)
        }
    }

    /** Recovers an instant inside the buffered slice's own local day. */
    private fun bucketTime(bucket: String, now: Long): Long {
        val day = bucket.substringAfterLast('@')
        if (day == UsageLogic.dayKey(now)) return now
        // A buffered slice from an earlier day: land it at noon of that day.
        val parts = day.split("-")
        if (parts.size != 3) return now
        val c = java.util.Calendar.getInstance()
        val y = parts[0].toIntOrNull() ?: return now
        val mo = parts[1].toIntOrNull() ?: return now
        val d = parts[2].toIntOrNull() ?: return now
        c.set(y, mo - 1, d, 12, 0, 0)
        c.set(java.util.Calendar.MILLISECOND, 0)
        return c.timeInMillis
    }
}
