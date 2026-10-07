import Foundation

/// Egész a lebegőpontosból, LEÁLLÁS NÉLKÜL.
///
/// A Swift `Int(_:)` a tartományon kívüli vagy NaN értéken nem kerekít, hanem
/// leállítja az appot. A felület idői viszont gyakran a dróton jönnek: egy
/// zárlat vége (magasvízjel — ha egyszer abszurd, az is marad), egy törlés
/// ideje, egy másik eszköz mérése. Egy hibás eszköz egyetlen értéke így
/// minden indításkor elvinné az iPhone-appot. A Kotlin `toLong()` és a JS szám
/// ilyenkor telítődik; ez ugyanazt teszi: a NaN nulla, a túl nagy a plafon.
/// A plafon (10^15) bőven több minden valódi időnél és számnál, amit a felület
/// kiír, és belefér az `Int`-be.
func clampedInt(_ x: Double, limit: Double = 1e15) -> Int {
    guard !x.isNaN else { return 0 }
    return Int(Swift.min(Swift.max(x, -limit), limit))
}
