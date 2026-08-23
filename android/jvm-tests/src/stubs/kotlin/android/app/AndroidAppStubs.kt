package android.app

/** Test-harness stand-ins for the Android APIs UsageTracker touches. */
class AppOpsManager {
    companion object {
        const val OPSTR_GET_USAGE_STATS = "android:get_usage_stats"
        const val MODE_ALLOWED = 0
    }
    fun unsafeCheckOpNoThrow(op: String, uid: Int, pkg: String): Int = MODE_ALLOWED
    fun checkOpNoThrow(op: String, uid: Int, pkg: String): Int = MODE_ALLOWED
}

class KeyguardManager { val isKeyguardLocked: Boolean = false }
