package hu.lakat.app.core

import java.security.SecureRandom
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
    const val SESSION_MAX_AGE_MS: Long = 6 * 3600_000L

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

    private val TRANSCRIBE_CHARS = intArrayOf(300, 420, 560, 720)
    private val MATH_LEN = intArrayOf(3, 5, 7, 9)
    private val MATH_FACTOR_MAX = intArrayOf(29, 39, 59, 79)
    private val MEMORY_LEN = intArrayOf(8, 10, 12, 14)
    private val MEMORY_SHOW_MS = longArrayOf(20_000, 18_000, 15_000, 12_000)
    private val MEMORY_WAIT_MS = longArrayOf(20_000, 30_000, 40_000, 60_000)
    private val REVERSE_WORDS = intArrayOf(4, 6, 8, 10)
    private val PAUSE_DELAY_MIN = arrayOf(10 to 20, 20 to 40, 30 to 60, 45 to 90)
    private val DELETE_DELAY_MIN = arrayOf(15 to 30, 30 to 50, 45 to 80, 60 to 120)

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
        if (parts.size != 2 || parts[0] == parts[1]) return null
        if (!parts.all { it in ACTIVE_POOL }) return null
        return parts
    }

    fun generatePlan(kind: Kind, tier: Int, lastCombo: String?, forceCombo: String? = null): Plan {
        var types: List<String>? = parseCombo(forceCombo)
        while (types == null) {
            val draw = ACTIVE_POOL.shuffled(rnd.asKotlinRandom()).take(2)
            if (lastCombo == null || comboKeyOf(draw) != lastCombo) types = draw
        }
        val steps = types.map { makeStep(it, tier, kind) }.toMutableList()
        if (tier >= 2 || kind == Kind.DELETE) steps.add(makeStep("DELAY", tier, kind))
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
