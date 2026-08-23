package android.content

import android.app.AppOpsManager
import android.app.KeyguardManager
import android.app.usage.UsageStatsManager
import android.os.PowerManager

interface SharedPreferences {
    fun getString(key: String, defValue: String?): String?
    fun edit(): Editor
    interface Editor {
        fun putString(key: String, value: String?): Editor
        fun apply()
    }
}

class FakePrefs : SharedPreferences {
    val map = mutableMapOf<String, String?>()
    override fun getString(key: String, defValue: String?): String? = map[key] ?: defValue
    override fun edit(): SharedPreferences.Editor = object : SharedPreferences.Editor {
        private val pending = mutableMapOf<String, String?>()
        override fun putString(key: String, value: String?): SharedPreferences.Editor {
            pending[key] = value; return this
        }
        override fun apply() { map.putAll(pending) }
    }
}

class Intent(action: String) {
    companion object { const val FLAG_ACTIVITY_NEW_TASK = 0x10000000 }
    fun addFlags(f: Int): Intent = this
}

class ApplicationInfo
class PackageManager {
    fun getApplicationInfo(pkg: String, flags: Int): ApplicationInfo = ApplicationInfo()
    fun getApplicationLabel(info: ApplicationInfo): CharSequence = "Stub App"
}

open class Context {
    companion object {
        const val MODE_PRIVATE = 0
        const val APP_OPS_SERVICE = "appops"
        const val POWER_SERVICE = "power"
        const val KEYGUARD_SERVICE = "keyguard"
        const val USAGE_STATS_SERVICE = "usagestats"
    }
    private val prefs = FakePrefs()
    open val applicationContext: Context get() = this
    open val packageName: String get() = "hu.lakat.app"
    open val packageManager: PackageManager get() = PackageManager()
    open fun getSharedPreferences(name: String, mode: Int): SharedPreferences = prefs
    open fun getSystemService(name: String): Any? = when (name) {
        APP_OPS_SERVICE -> AppOpsManager()
        POWER_SERVICE -> PowerManager()
        KEYGUARD_SERVICE -> KeyguardManager()
        USAGE_STATS_SERVICE -> UsageStatsManager()
        else -> null
    }
}
