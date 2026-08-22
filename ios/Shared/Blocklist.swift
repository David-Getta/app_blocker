import Foundation

/// Domain normalization + preset expansion.
/// Mirrors desktop/src/shared/blocklist.ts and android .../core/Blocklist.kt.
enum Blocklist {

    private static let domainRegex = try! NSRegularExpression(
        pattern: "^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$"
    )

    static let presets: [String: [String]] = [
        "youtube.com": ["m.youtube.com", "music.youtube.com", "youtubei.googleapis.com",
                        "youtube-nocookie.com", "www.youtube-nocookie.com", "youtu.be"],
        "facebook.com": ["m.facebook.com", "mbasic.facebook.com", "fb.com", "www.fb.com", "fb.watch"],
        "instagram.com": ["m.instagram.com", "ig.me"],
        "tiktok.com": ["m.tiktok.com", "vm.tiktok.com", "vt.tiktok.com"],
        "x.com": ["twitter.com", "www.twitter.com", "mobile.twitter.com", "mobile.x.com", "t.co"],
        "twitter.com": ["x.com", "www.x.com", "mobile.twitter.com", "mobile.x.com", "t.co"],
        "reddit.com": ["old.reddit.com", "new.reddit.com", "np.reddit.com", "m.reddit.com", "redd.it"],
        "twitch.tv": ["m.twitch.tv"],
        "netflix.com": ["m.netflix.com"],
        "9gag.com": ["m.9gag.com"],
    ]

    static func normalizeDomain(_ input: String) -> String? {
        var s = input.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if s.isEmpty { return nil }
        s = s.replacingOccurrences(of: "^[a-z][a-z0-9+.-]*://", with: "", options: .regularExpression)
        s = s.replacingOccurrences(of: "^[^/@]*@", with: "", options: .regularExpression)
        if let idx = s.firstIndex(where: { $0 == "/" || $0 == "?" || $0 == "#" }) {
            s = String(s[..<idx])
        }
        if let colon = s.firstIndex(of: ":") {
            s = String(s[..<colon])
        }
        while s.hasSuffix(".") { s.removeLast() }
        if s.hasPrefix("www.") { s = String(s.dropFirst(4)) }
        let range = NSRange(s.startIndex..<s.endIndex, in: s)
        return domainRegex.firstMatch(in: s, range: range) != nil ? s : nil
    }

    static func expandHostnames(_ domain: String, usePreset: Bool) -> [String] {
        var set: Set<String> = [domain, "www.\(domain)", "m.\(domain)"]
        if usePreset, let extra = presets[domain] { set.formUnion(extra) }
        return set.sorted()
    }

    /// true when `qname` equals a blocked hostname or is a subdomain of one
    static func matches(_ qname: String, blocked: Set<String>) -> Bool {
        for b in blocked {
            if qname == b || qname.hasSuffix(".\(b)") { return true }
        }
        return false
    }
}
