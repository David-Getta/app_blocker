package hu.lakat.app.core

/**
 * Domain normalization and preset expansion.
 * Mirrors desktop/src/shared/blocklist.ts — keep the two in sync.
 */
object Blocklist {

    private val DOMAIN_RE =
        Regex("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$")

    val PRESETS: Map<String, List<String>> = mapOf(
        "youtube.com" to listOf(
            "m.youtube.com", "music.youtube.com", "youtubei.googleapis.com",
            "youtube-nocookie.com", "www.youtube-nocookie.com", "youtu.be",
        ),
        "facebook.com" to listOf("m.facebook.com", "mbasic.facebook.com", "fb.com", "www.fb.com", "fb.watch"),
        "instagram.com" to listOf("m.instagram.com", "ig.me"),
        "tiktok.com" to listOf("m.tiktok.com", "vm.tiktok.com", "vt.tiktok.com"),
        "x.com" to listOf("twitter.com", "www.twitter.com", "mobile.twitter.com", "mobile.x.com", "t.co"),
        "twitter.com" to listOf("x.com", "www.x.com", "mobile.twitter.com", "mobile.x.com", "t.co"),
        "reddit.com" to listOf("old.reddit.com", "new.reddit.com", "np.reddit.com", "m.reddit.com", "redd.it"),
        "twitch.tv" to listOf("m.twitch.tv"),
        "netflix.com" to listOf("m.netflix.com"),
        "9gag.com" to listOf("m.9gag.com"),
    )

    fun normalizeDomain(input: String): String? {
        var s = input.trim().lowercase()
        if (s.isEmpty()) return null
        s = s.replace(Regex("^[a-z][a-z0-9+.-]*://"), "")
        s = s.replace(Regex("^[^/@]*@"), "")
        val slash = s.indexOfFirst { it == '/' || it == '?' || it == '#' }
        if (slash >= 0) s = s.substring(0, slash)
        val colon = s.indexOf(':')
        if (colon >= 0) s = s.substring(0, colon)
        s = s.trimEnd('.')
        if (s.startsWith("www.")) s = s.removePrefix("www.")
        return if (DOMAIN_RE.matches(s)) s else null
    }

    fun expandHostnames(domain: String, usePreset: Boolean): List<String> {
        val set = sortedSetOf(domain, "www.$domain", "m.$domain")
        if (usePreset) PRESETS[domain]?.let { set.addAll(it) }
        return set.toList()
    }

    /** true when [qname] equals a blocked hostname or is a subdomain of one */
    fun matches(qname: String, blocked: Collection<String>): Boolean {
        for (b in blocked) {
            if (qname == b || qname.endsWith(".$b")) return true
        }
        return false
    }
}
