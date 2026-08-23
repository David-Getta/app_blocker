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

    /** Called by the VPN service for every DNS name it resolves (not blocked ones). */
    fun noteDomain(domain: String, now: Long) {
        // Ignore infrastructure lookups that no user ever "visits".
        if (domain.endsWith("in-addr.arpa") || domain.endsWith(".local")) return
        lastDomain.set(Sighting(domain, now))
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
        LakatStore.mutate { s ->
            UsageLogic.recordSample(s.usage, decision.key, decision.seconds, now, decision.label)
            // New snapshot: StateFlow would not emit for an unchanged reference.
            s.copy(usage = UsageLogic.snapshot(s.usage))
        }
    }

    /** Screen-off / service restart: the gap must not be counted. */
    fun resetClock(now: Long = System.currentTimeMillis()) {
        lastAt = now
    }
}
