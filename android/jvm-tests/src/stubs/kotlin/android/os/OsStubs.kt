package android.os

object Build { object VERSION { const val SDK_INT = 34 } }
class PowerManager { val isInteractive: Boolean = true }
object Process { fun myUid(): Int = 1000 }
