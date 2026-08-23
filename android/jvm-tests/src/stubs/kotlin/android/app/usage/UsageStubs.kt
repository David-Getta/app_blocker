package android.app.usage

class UsageEvents {
    class Event {
        companion object {
            const val ACTIVITY_RESUMED = 1
            const val MOVE_TO_FOREGROUND = 1
        }
        var eventType: Int = 0
        var packageName: String = ""
    }
    fun hasNextEvent(): Boolean = false
    fun getNextEvent(e: Event): Boolean = false
}

class UsageStatsManager {
    fun queryEvents(begin: Long, end: Long): UsageEvents = UsageEvents()
}
