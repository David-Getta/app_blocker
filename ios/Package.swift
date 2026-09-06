// swift-tools-version:5.9
//
// A Swift mag (Shared/) TESZTELÉSÉRE, nem az app építésére. Az appot és az
// alagutat továbbra is az XcodeGen-projekt (project.yml) építi; ez a csomag
// ugyanazokat a forrásokat fordítja egy könyvtárrá, hogy `swift test`-tel
// macOS-en — a CI macOS-futóján is — lefussanak a tükör-tesztek.
//
// Miért kell: a Swift mag eddig CSAK fordult a CI-ban, egyetlen tesztje sem
// futott le soha. A TypeScript-nek 500+, a Kotlinnak 100+ tesztje van; a
// harmadik nyelv szabályait senki nem ellenőrizte futás közben. Egy tükör,
// ami csak fordul, nem tükör.
//
//   cd ios && swift test
import PackageDescription

let package = Package(
    name: "BreakerShared",
    platforms: [.macOS(.v13), .iOS(.v16)],
    targets: [
        .target(name: "BreakerShared", path: "Shared"),
        .testTarget(name: "BreakerSharedTests", dependencies: ["BreakerShared"], path: "SharedTests"),
    ]
)
