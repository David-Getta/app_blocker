import hu.breaker.app.core.ChallengeEngine
import hu.breaker.app.core.DigestLogic
import hu.breaker.app.core.Focus
import hu.breaker.app.core.ScheduleLogic
import hu.breaker.app.core.UsageLogic
import java.util.Locale
import java.util.TimeZone
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * A mag NEM függ a telefon nyelvétől és naptárától.
 *
 * A napkulcs (`YYYY-MM-DD`) és a hét kulcsa a szinkron közös nyelve: a gép
 * gregorián évet és latin számjegyet ír. Ha a telefon a saját nyelvével
 * formázna, arab vagy perzsa nyelven nem latin számjegy lenne a kulcsban (a
 * napló-tisztító az ilyen hetet eldobta volna); ha a saját naptárával
 * számolna, thai nyelven buddhista év (2569), japán császári naptárral 8
 * (Reiwa) — és a közös napi keret a többi eszköz sorát sosem számolná, mert a
 * napkulcs sosem egyezne.
 *
 * Androidon a `Calendar.getInstance()` amúgy is gregorián (a platform így
 * szűkíti), de a mag a JVM-en is fut, ahol nem — ezért a mag kimondva
 * `GregorianCalendar()`-t és `Locale.ROOT`-ot használ, és ez a teszt minden
 * nyelven ugyanazt várja.
 */
class LocaleIndependenceTest {

    private val now = 1_790_856_000_000L // 2026-10-01 12:00 UTC, csütörtök

    private fun underLocale(locale: Locale, body: () -> Unit) {
        val saved = Locale.getDefault()
        val savedTz = TimeZone.getDefault()
        try {
            Locale.setDefault(locale)
            TimeZone.setDefault(TimeZone.getTimeZone("UTC"))
            body()
        } finally {
            Locale.setDefault(saved)
            TimeZone.setDefault(savedTz)
        }
    }

    private val locales = listOf(
        Locale("ar", "EG"), Locale("fa", "IR"), Locale("th", "TH"), Locale("ja", "JP", "JP"),
        Locale.forLanguageTag("th-TH-u-ca-buddhist-nu-thai"), Locale("hu", "HU"),
    )

    @Test fun `a napkulcs es a het kulcsa minden nyelven gregorian es latin szamjegyu`() {
        for (locale in locales) {
            underLocale(locale) {
                assertEquals("2026-10-01", UsageLogic.dayKey(now), "napkulcs, $locale")
                assertEquals("2026-09-28", DigestLogic.weekKey(now), "a hét kulcsa, $locale")
                assertEquals("2026. 09. 28.", DigestLogic.weekLabel(DigestLogic.weekKey(now)), "a hét címkéje, $locale")
                assertEquals(
                    listOf("2026-09-29", "2026-09-30", "2026-10-01"), UsageLogic.dayKeysBack(now, 3), "visszafelé, $locale",
                )
            }
        }
    }

    @Test fun `a nap hatara, a menetrend es az ablak minden nyelven ugyanaz`() {
        val band = ScheduleLogic.Band(setOf(4), 11 * 60, 13 * 60) // csütörtök 11–13
        val expected = mutableListOf<String>()
        underLocale(Locale.ROOT) {
            expected += "${ChallengeEngine.daysSinceUnlock(listOf(now - 86_400_000L), now)}"
            expected += "${ScheduleLogic.isBlockedNow(null, null, ScheduleLogic.Schedule(ScheduleLogic.Mode.SCHEDULED_BLOCK, listOf(band)), now)}"
            expected += "${Focus.occurrenceAt(band, now)}"
        }
        for (locale in locales) {
            underLocale(locale) {
                val got = listOf(
                    "${ChallengeEngine.daysSinceUnlock(listOf(now - 86_400_000L), now)}",
                    "${ScheduleLogic.isBlockedNow(null, null, ScheduleLogic.Schedule(ScheduleLogic.Mode.SCHEDULED_BLOCK, listOf(band)), now)}",
                    "${Focus.occurrenceAt(band, now)}",
                )
                assertEquals(expected, got, "nap határa / menetrend / ablak, $locale")
            }
        }
    }
}
