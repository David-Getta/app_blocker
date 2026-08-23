package hu.lakat.app.core

/**
 * A frissítés-ellenőrzés tiszta része — a desktop `shared/update-manifest.ts`
 * megfelelője, csak annyiban, amennyi Androidon értelmes.
 *
 * Azért van külön a hálózatot és az Android API-kat használó UpdateCheckertől,
 * mert így a JVM-teszt harness le tudja fordítani és tesztelni tudja. A
 * verzió-összevetés az a fajta kód, ami ránézésre mindig helyes, és amiben
 * mindig van egy 0.10 < 0.9 típusú hiba.
 */
object UpdateLogic {

    /** Az APK, amit letöltünk — akkora, hogy ne lehessen belőle DoS a tárhelyen. */
    const val MAX_APK_BYTES: Long = 300L * 1024 * 1024

    /** Semver-szerű összevetés: >0 ha a>b, 0 ha egyenlő, <0 ha a<b. */
    fun compareVersions(a: String, b: String): Int {
        val pa = parts(a)
        val pb = parts(b)
        for (i in 0 until maxOf(pa.size, pb.size)) {
            val x = pa.getOrElse(i) { 0 }
            val y = pb.getOrElse(i) { 0 }
            if (x != y) return if (x > y) 1 else -1
        }
        return 0
    }

    private fun parts(v: String): List<Int> =
        v.trim().removePrefix("v").removePrefix("V")
            .split('.', '-', '+')
            .map { chunk -> chunk.takeWhile { it.isDigit() }.toIntOrNull() ?: 0 }

    /** Újabb-e a kiadás annál, ami fut? Üres vagy értelmezhetetlen címke sosem. */
    fun isNewer(releaseTag: String, running: String): Boolean {
        val tag = releaseTag.trim().removePrefix("v").removePrefix("V")
        if (tag.isEmpty()) return false
        return compareVersions(tag, running) > 0
    }

    /**
     * A telepíthető APK a kiadás fájljai közül.
     *
     * A `.aab` KIMARAD: az a Play Store feltöltési formátuma, telepíteni nem
     * lehet. Ha véletlenül azt választanánk, a felhasználó egy letöltés után
     * kapna egy értelmezhetetlen hibát a rendszertelepítőtől.
     */
    fun pickApk(assetNames: List<String>): String? =
        assetNames.firstOrNull { it.endsWith(".apk", ignoreCase = true) }

    /** A letöltés ideiglenes neve; készre csak átnevezéssel válik. */
    fun partName(finalName: String): String = "$finalName.part"
}
