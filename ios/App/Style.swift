import SwiftUI

/// A Breaker vizuális nyelve iPhone-on és macOS-en — az asztali felület tükre.
///
/// Ugyanaz a három szabály, mint a másik két platformon:
///
/// 1. A hierarchiát a TIPOGRÁFIA és a TÉRKÖZ adja, nem a keretek. Ezért nincs
///    doboz a dobozban: egy kártyán belül a sorokat hajszálvonal választja el.
/// 2. EGY hangsúlyos elem képernyőnként. Minden más visszahúzódik.
/// 3. Ahol szín hordoz jelentést, ott a SZÖVEG is kimondja ugyanazt.
///
/// A színek szándékosan a rendszer szemantikus színeiből származnak
/// (`Color.primary` átlátszósággal), nem rögzített értékekből. Így a világos és
/// a sötét téma, a fokozott kontraszt és a macOS/iOS eltérései maguktól
/// helyesek maradnak — egy bedrótozott `#131519` világos témában fekete folt
/// lenne.
enum BreakerStyle {
    static let radius: CGFloat = 16
    static let cardPadding: CGFloat = 18

    /// A kártya felülete: egy hajszálnyival elemelve az alaptól.
    static let surface = Color.primary.opacity(0.045)
    /// Beágyazott mező vagy sor a kártyán belül.
    static let surfaceNested = Color.primary.opacity(0.07)
    /// Hajszálvonal — keret és elválasztó.
    static let hairline = Color.primary.opacity(0.10)
}

/// Kártya: nyugodt felület, hajszálkeret, nagy lekerekítés.
struct BreakerCard: ViewModifier {
    func body(content: Content) -> some View {
        content
            .padding(BreakerStyle.cardPadding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                BreakerStyle.surface,
                in: RoundedRectangle(cornerRadius: BreakerStyle.radius, style: .continuous)
            )
            .overlay(
                RoundedRectangle(cornerRadius: BreakerStyle.radius, style: .continuous)
                    .strokeBorder(BreakerStyle.hairline, lineWidth: 1)
            )
    }
}

extension View {
    func breakerCard() -> some View { modifier(BreakerCard()) }
}

/// Szakaszcím: apró, ritkított, NAGYBETŰS, halk.
///
/// Eddig `\.headline` volt — ugyanakkora és ugyanolyan sötét, mint a tartalom,
/// tehát versenyzett vele. Egy cím dolga megnevezni a szakaszt, nem elvinni a
/// tekintetet a tartalomról.
struct SectionLabel: View {
    let text: String
    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text.uppercased())
            .font(.caption2)
            .fontWeight(.semibold)
            .kerning(0.9)
            .foregroundStyle(.secondary)
    }
}

/// Állapot: halk felirat + színes pötty.
///
/// A teljesen színes felirat ugyanakkora hangsúlyt kapott, mint az elsődleges
/// gomb — pedig csak közöl, nem hív cselekvésre. A kettős kódolás megmarad: a
/// jelentést a FELIRAT mondja ki, a szín csak megerősíti.
struct StatusDot: View {
    let text: String
    let color: Color

    var body: some View {
        HStack(spacing: 7) {
            Circle().fill(color).frame(width: 7, height: 7)
            Text(text).font(.footnote).foregroundStyle(.secondary)
        }
    }
}

/// A védjegy: MEGSZAKÍTOTT gyűrű — a kör, ami nem zárul be.
///
/// Rajzolva, nem emojival. Az emoji minden rendszeren és minden verzión máshogy
/// néz ki, és egy márkajel nem függhet a rendszer betűkészletétől. A rés FELÜL
/// van, 72 fokos: keskenyebbnél apró méretben összezáródna, szélesebbnél már
/// „C” betű lenne.
struct BrandMark: View {
    var size: CGFloat = 22

    var body: some View {
        Canvas { context, canvasSize in
            let lineWidth = canvasSize.width * 0.135
            let rect = CGRect(origin: .zero, size: canvasSize).insetBy(dx: lineWidth / 2, dy: lineWidth / 2)
            var path = Path()
            path.addArc(
                center: CGPoint(x: rect.midX, y: rect.midY),
                radius: rect.width / 2,
                startAngle: .degrees(-90 + 36),
                endAngle: .degrees(-90 - 36),
                clockwise: false
            )
            context.stroke(
                path,
                with: .color(.primary),
                style: StrokeStyle(lineWidth: lineWidth, lineCap: .round)
            )
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}
