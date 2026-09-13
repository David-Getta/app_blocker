package hu.breaker.app.core

import java.security.SecureRandom
import java.util.Calendar
import kotlin.math.max
import kotlin.math.min
import kotlin.random.asKotlinRandom

/**
 * Unlock challenge engine — 1:1 mirror of desktop/src/shared/challenges.ts.
 * See docs/challenge-spec.md for the behavioural contract.
 */
object ChallengeEngine {

    enum class Kind { PAUSE, DELETE }

    sealed class Step {
        abstract val id: String

        data class Transcribe(override val id: String, val text: String) : Step()
        data class MathChain(
            override val id: String,
            val problems: List<Problem>,
            val pos: Int,
        ) : Step()

        data class Memory(
            override val id: String,
            val code: String,
            val showMs: Long,
            val waitMs: Long,
            /** a bíró állítja be, amikor a lépés aktuálissá válik; az időzítés
             *  ebből a szerveroldali bélyegből érvényesül */
            val armedAt: Long?,
        ) : Step()

        data class Reverse(override val id: String, val text: String) : Step()
        data class Delay(
            override val id: String,
            val minutes: Int,
            val claimableAt: Long?,
            val claimWindowMs: Long,
        ) : Step()
    }

    data class Problem(val q: String, val a: Long)

    data class Outcome(val ok: Boolean, val done: Boolean, val step: Step, val message: String? = null)

    const val CLAIM_WINDOW_MS: Long = 10 * 60_000L
    const val DELETE_PENDING_MS: Long = 24 * 3600_000L

    /**
     * Ennyi idő után évül el egy kísérlet.
     *
     * A leghosszabb várakozás hat óra (törlés, maximális fok), és a munka is
     * idő: ha az elévülés ennél szorosabb lenne, a legnehezebb szinten a
     * kísérletet BEFEJEZNI sem lehetne — az nem szigor, hanem elrontott
     * szabály.
     */
    const val SESSION_MAX_AGE_MS: Long = 14 * 3600_000L

    /**
     * A hátralévő lépések számát SOHA nem mondjuk meg.
     *
     * A „még kettő” tudása ugyanaz a lendület, mint a majdnem-kész érzés — és
     * pont az viszi át az embert a feloldáson. Amit a felület mondhat: van még
     * legalább ennyi. Ez mindig IGAZ, és nem árulja el, hol a vége.
     */
    const val REMAINING_FLOOR: Int = 3

    enum class RemainingHint { MANY, FEW }

    /** „Legalább három van még” vagy „van még” — pontos szám sehol. */
    fun remainingHint(stepIndex: Int, stepCount: Int): RemainingHint =
        if (stepCount - stepIndex >= REMAINING_FLOOR) RemainingHint.MANY else RemainingHint.FEW

    /**
     * How long an abandoned attempt keeps its challenge types.
     *
     * Without this, cancelling was a free re-roll: every new attempt drew a
     * fresh pair, so one could keep restarting until the easiest pair came up.
     * Friction that can be re-rolled is not friction. Within this window the
     * same PAIR comes back — with fresh content, so nothing is banked either.
     */
    const val REROLL_COOLDOWN_MS: Long = 60 * 60_000L
    val PAUSE_CHOICES_MIN = listOf(15, 30, 60)

    private val rnd = SecureRandom()
    private var seq = 0

    /**
     * Hány AKTÍV próba egy kísérletben (a várakozás ezen felül jön).
     *
     * Kettő volt, és az kevésnek bizonyult: két feladat után az ember már
     * „majdnem kész”, és a majdnem-kész pont az az érzés, ami átlendít a
     * feloldáson. A típusok a négyes készletből jönnek; ha több lépés kell,
     * mint ahány típus van, a típus ISMÉTLŐDIK — friss tartalommal.
     */
    private val ACTIVE_STEPS = intArrayOf(3, 4, 5, 6)
    private val TRANSCRIBE_CHARS = intArrayOf(900, 1300, 1800, 2400)
    private val MATH_LEN = intArrayOf(8, 12, 16, 20)
    private val MATH_FACTOR_MAX = intArrayOf(59, 79, 99, 129)
    private val MEMORY_LEN = intArrayOf(12, 14, 16, 20)
    private val MEMORY_SHOW_MS = longArrayOf(12_000, 10_000, 8_000, 6_000)
    private val MEMORY_WAIT_MS = longArrayOf(90_000, 150_000, 240_000, 360_000)
    private val REVERSE_WORDS = intArrayOf(10, 14, 18, 24)
    private val PAUSE_DELAY_MIN = arrayOf(30 to 45, 60 to 90, 90 to 150, 150 to 240)
    private val DELETE_DELAY_MIN = arrayOf(45 to 70, 90 to 130, 150 to 210, 240 to 360)

    private val WORDS = (
        "alma bogrács cinege délután erdő füzet gomba határ időjárás jégvirág kanál lámpa " +
            "macska nyár ösvény patak róka sündisznó tenger utazás vándor zászló asztal bicikli " +
            "csillag dallam egér felhő gyertya hajnal iskola játék kavics levél mező napraforgó " +
            "óra pillangó rigó sétány tavasz udvar vonat zongora ablak barlang cipő dombtető " +
            "este fenyő galamb hegység irány kapu liget malom nádas orgona páfrány rönk sátor " +
            "tücsök uszoda vihar zápor bálna cseresznye dinnye eper fahéj gesztenye hínár ibolya " +
            "kagyló lekvár mandula naspolya olajbogyó paprika ribizli szilva tökmag uborka " +
            "vadkörte zeller bagoly csuka delfin egérke fóka gepárd hiúz jaguár kenguru lajhár " +
            "medve nyest orrszarvú pele rozmár sakál teve ürge vidra zebra híd torony kastély " +
            "kikötő könyvtár műhely óváros piactér raktár színház tetőtér várfal zsilip csónak " +
            "ekevas fűrész gereblye horgony iránytű kalapács létra metsző olló reszelő szögmérő " +
            "talicska vödör aranyos borongós csendes derűs egyszerű fényes gyors hűvös illatos " +
            "kerek lassú meleg nyugodt okos pontos ritka sima tiszta vidám zöldes hosszú keskeny " +
            "magas mély széles apró hatalmas kicsi óriási törékeny erős fürge"
        ).split(Regex("\\s+"))

    private const val CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"

    private fun rndInt(minIncl: Int, maxIncl: Int): Int = minIncl + rnd.nextInt(maxIncl - minIncl + 1)

    private fun stepId(): String {
        seq = (seq + 1) % 1_000_000
        return "st_${System.currentTimeMillis().toString(36)}_${seq}_${rnd.nextInt(0xFFFFFF)}"
    }

    /**
     * Hány napja volt az utolsó feloldás — vagy null, ha még egy sem volt.
     *
     * NAPTÁRI napokban, nem huszonnégy órás egységekben: a tegnap esti
     * feloldás „tegnap”, akkor is, ha tíz órája volt. A `digest.ts` tükre.
     */
    fun daysSinceUnlock(unlockLog: List<Long>, now: Long): Int? {
        val last = unlockLog.maxOrNull() ?: return null
        fun dayStart(t: Long): Long = Calendar.getInstance().apply {
            timeInMillis = t
            set(Calendar.HOUR_OF_DAY, 0); set(Calendar.MINUTE, 0)
            set(Calendar.SECOND, 0); set(Calendar.MILLISECOND, 0)
        }.timeInMillis
        return max(0L, Math.round((dayStart(now) - dayStart(last)) / 86_400_000.0)).toInt()
    }

    fun computeTier(unlockLog: List<Long>, now: Long): Int {
        val weekAgo = now - 7 * 24 * 3600_000L
        val n = unlockLog.count { it in weekAgo..now }
        return when {
            n <= 1 -> 0
            n <= 3 -> 1
            n <= 6 -> 2
            else -> 3
        }
    }

    fun makeSentence(wordCount: Int): String {
        val parts = mutableListOf<String>()
        for (i in 0 until wordCount) {
            var w = WORDS[rnd.nextInt(WORDS.size)]
            if (i == 0) w = w.replaceFirstChar { it.uppercaseChar() }
            else if (rndInt(1, 100) <= 12) w = w.uppercase()
            if (i in 1 until wordCount - 1 && rndInt(1, 100) <= 18) w += ","
            parts.add(w)
        }
        if (rndInt(1, 100) <= 25) parts.add(rndInt(10, 9999).toString())
        val punct = listOf(".", ".", ".", "!", "?")
        return parts.joinToString(" ") + punct[rnd.nextInt(punct.size)]
    }

    private fun makeTranscription(targetChars: Int): String {
        val sb = StringBuilder()
        while (sb.length < targetChars) {
            if (sb.isNotEmpty()) sb.append(' ')
            sb.append(makeSentence(rndInt(5, 9)))
        }
        return sb.toString()
    }

    private fun makeCode(len: Int): String =
        (1..len).map { CODE_ALPHABET[rnd.nextInt(CODE_ALPHABET.length)] }.joinToString("")

    private fun makeMathProblem(factorMax: Int): Problem = when (rnd.nextInt(3)) {
        0 -> {
            val a = rndInt(12, factorMax); val b = rndInt(12, factorMax); val c = rndInt(100, 999)
            Problem("$a × $b + $c", a.toLong() * b + c)
        }
        1 -> {
            val a = rndInt(12, factorMax); val b = rndInt(12, factorMax); val c = rndInt(100, 999)
            Problem("$a × $b − $c", a.toLong() * b - c)
        }
        else -> {
            val a = rndInt(23, factorMax + 40); val b = rndInt(23, factorMax + 40); val c = rndInt(3, 9)
            Problem("($a + $b) × $c", (a.toLong() + b) * c)
        }
    }

    fun makeStep(type: String, tier: Int, kind: Kind): Step {
        val t = max(0, min(3, tier))
        return when (type) {
            "TRANSCRIBE" -> Step.Transcribe(stepId(), makeTranscription(TRANSCRIBE_CHARS[t]))
            "MATH_CHAIN" -> Step.MathChain(stepId(), (1..MATH_LEN[t]).map { makeMathProblem(MATH_FACTOR_MAX[t]) }, 0)
            "MEMORY" -> Step.Memory(stepId(), makeCode(MEMORY_LEN[t]), MEMORY_SHOW_MS[t], MEMORY_WAIT_MS[t], null)
            "REVERSE" -> Step.Reverse(stepId(), makeSentence(REVERSE_WORDS[t]))
            "DELAY" -> {
                val (lo, hi) = (if (kind == Kind.DELETE) DELETE_DELAY_MIN else PAUSE_DELAY_MIN)[t]
                Step.Delay(stepId(), rndInt(lo, hi), null, CLAIM_WINDOW_MS)
            }
            else -> throw IllegalArgumentException("unknown step type $type")
        }
    }

    data class Plan(val steps: List<Step>, val comboKey: String)

    private val ACTIVE_POOL = listOf("TRANSCRIBE", "MATH_CHAIN", "MEMORY", "REVERSE")

    fun comboKeyOf(types: List<String>): String = types.sorted().joinToString("+")

    /** A lépés típusneve — ugyanaz a szótár, amit a kombináció-kulcsok használnak. */
    fun typeNameOf(step: Step): String = when (step) {
        is Step.Transcribe -> "TRANSCRIBE"
        is Step.MathChain -> "MATH_CHAIN"
        is Step.Memory -> "MEMORY"
        is Step.Reverse -> "REVERSE"
        is Step.Delay -> "DELAY"
    }

    /**
     * A combo key back into its two challenge types, or null if this build
     * cannot serve it (unknown name, wrong arity — e.g. state from a newer
     * version). Null means „draw a fresh plan”, never „serve something broken”.
     */
    fun parseCombo(key: String?): List<String>? {
        if (key.isNullOrEmpty()) return null
        val parts = key.split("+")
        // ISMÉTLŐDÉS MEGENGEDETT: több lépés jár, mint ahány típus van.
        if (parts.size < 2 || parts.size > ACTIVE_STEPS[3]) return null
        if (!parts.all { it in ACTIVE_POOL }) return null
        return parts
    }

    /** Hány aktív próba jár ehhez a fokhoz (a várakozás ezen felül van). */
    fun activeStepCount(tier: Int): Int = ACTIVE_STEPS[max(0, min(3, tier))]

    /** Ennyiszer próbálunk más kombinációt húzni, mint az előző kísérleté. */
    private const val COMBO_REDRAW_TRIES = 8

    /** `n` típus sorsolása: előbb mind a négy, utána ismétlés — friss tartalommal. */
    private fun drawTypes(n: Int): List<String> {
        val out = mutableListOf<String>()
        while (out.size < n) {
            for (t in ACTIVE_POOL.shuffled(rnd.asKotlinRandom())) {
                if (out.size < n) out.add(t)
            }
        }
        return out
    }

    /**
     * A kísérlet lépéslistája: `ACTIVE_STEPS[tier]` aktív próba, és MINDIG egy
     * várakozás — nem csak magas fokon vagy törlésnél.
     *
     * A feladott kísérlet típusait a hűtés alatt visszakapjuk (`forceCombo`).
     * Ha az a lista RÖVIDEBB, mint amennyi most jár, FELTÖLTJÜK: egy régi
     * állapot nem lehet a kevesebb munka útja.
     */
    fun generatePlan(kind: Kind, tier: Int, lastCombo: String?, forceCombo: String? = null): Plan {
        val want = activeStepCount(tier)
        var types: List<String>? = parseCombo(forceCombo)
        if (types != null && types.size < want) types = types + drawTypes(want - types.size)
        if (types == null) {
            // Az ismétlődés elkerülése PRÓBÁLKOZÁS, nem követelmény: ha annyi
            // lépés jár, ahány típus van, minden terv ugyanaz a halmaz, tehát
            // nincs mit másikra cserélni — a korlát nélküli újrasorsolás
            // örökre pörögne. A tartalom úgyis friss.
            var draw = drawTypes(want)
            var tries = 0
            while (lastCombo != null && comboKeyOf(draw) == lastCombo && tries < COMBO_REDRAW_TRIES) {
                draw = drawTypes(want)
                tries++
            }
            types = draw
        }
        val steps = types.map { makeStep(it, tier, kind) }.toMutableList()
        steps.add(makeStep("DELAY", tier, kind))
        return Plan(steps, comboKeyOf(types))
    }

    fun reverse(s: String): String = s.reversed()

    fun applyAnswer(step: Step, answer: String, tier: Int, kind: Kind, now: Long): Outcome = when (step) {
        is Step.Transcribe ->
            if (answer == step.text) Outcome(ok = true, done = true, step = step)
            else Outcome(false, false, step,
                "Nem egyezik karakterre pontosan. Ellenőrizd az írásjeleket és a kis-/nagybetűket.")

        is Step.MathChain -> {
            val expected = step.problems[step.pos].a
            val given = answer.trim().replace(" ", "").toLongOrNull()
            when {
                given != null && given == expected -> {
                    val next = step.copy(pos = step.pos + 1)
                    if (next.pos >= next.problems.size) Outcome(true, true, next)
                    else Outcome(true, false, next)
                }
                else -> Outcome(false, false, makeStep("MATH_CHAIN", tier, kind),
                    "Hibás eredmény — a lánc elölről indul, új feladatokkal.")
            }
        }

        is Step.Memory ->
            // Az időzítés szerveroldali: a memorizálás + várakozás letelte előtt
            // semmilyen válasz nem fogadható el (és nem is számít hibának).
            if (step.armedAt == null || now < step.armedAt + step.showMs + step.waitMs) {
                Outcome(false, false, step,
                    "Még tart a memorizálás vagy a várakozás — a kivárást nem lehet megúszni.")
            } else if (answer.trim().uppercase() == step.code) {
                Outcome(true, true, step)
            } else {
                Outcome(false, false, makeStep("MEMORY", tier, kind), "Nem ez volt a kód. Új kódot kapsz.")
            }

        is Step.Reverse ->
            if (answer == reverse(step.text)) Outcome(true, true, step)
            else Outcome(false, false, makeStep("REVERSE", tier, kind),
                "Nem pontos a visszafelé gépelés. Új mondatot kapsz.")

        is Step.Delay -> Outcome(false, false, step, "Ez egy várakozási lépés — itt nincs beírható válasz.")
    }
}
