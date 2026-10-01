import Foundation

/// A mag naptára: GREGORIÁN, a készülék időzónájában — kimondva.
///
/// A `Calendar.current` a felhasználó beállított naptárát követi: buddhista
/// naptárnál az év 2569, japánnál 8 (Reiwa). A napkulcs (`YYYY-MM-DD`) viszont
/// a szinkron közös nyelve: a gép (JS `Date`) és az Android (gregorián
/// `Calendar`) gregorián évet ír. Egy buddhista naptárú iPhone napkulcsa így
/// sosem egyezett volna a többi eszközével — a közös napi keret például a
/// többi eszköz sorát csak a mai napkulcs egyezésekor számolja, tehát ott a
/// keret sosem érvényesült volna (az iPhone maga nem mér).
///
/// A hét napja és az óra a naptártól független; a napkulcs és a dátumból
/// visszabontott nap nem. A mag ezért mindenhol ezt használja; a
/// `scripts/check-core-sync.js` tiltja a `Calendar.current`-et a magban.
enum LocalCalendar {
    static var gregorian: Calendar {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone.current
        return cal
    }
}
