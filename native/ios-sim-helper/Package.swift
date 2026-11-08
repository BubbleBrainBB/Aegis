// swift-tools-version:5.10
// aegis-sim-helper: the long-running process behind Aegis's iOS Simulator
// pane. Built on idb's FBSimulatorControl (MIT, the fork AXe pins), which
// scripts/build-ios-sim-helper.mjs builds into .idb/ before this package.
import Foundation
import PackageDescription

let packageRoot = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
let privateHeaders = packageRoot.appendingPathComponent(".idb/PrivateHeaders", isDirectory: true)
// Compile-only: idb's module maps reference Apple's private headers.
let privateHeaderFlags = [
    "",
    "AccessibilityPlatformTranslation",
    "AXRuntime",
    "CoreSimDeviceIO",
    "CoreSimulator",
    "CoreSimulatorUtilities",
    "SimulatorKit",
].map { name in "-I" + (name.isEmpty ? privateHeaders : privateHeaders.appendingPathComponent(name)).path }

let package = Package(
    name: "AegisSimHelper",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "aegis-sim-helper",
            dependencies: ["FBControlCore", "FBSimulatorControl", "XCTestBootstrap"],
            path: "Sources/AegisSimHelper",
            swiftSettings: [.unsafeFlags(["-parse-as-library"] + privateHeaderFlags)],
            linkerSettings: [
                .unsafeFlags([
                    "-Xlinker", "-headerpad_max_install_names",
                    "-Xlinker", "-rpath", "-Xlinker", "@executable_path/Frameworks",
                    "-Xlinker", "-rpath", "-Xlinker", "@executable_path",
                ]),
            ]
        ),
        .binaryTarget(name: "FBControlCore", path: ".idb/XCFrameworks/FBControlCore.xcframework"),
        .binaryTarget(name: "FBSimulatorControl", path: ".idb/XCFrameworks/FBSimulatorControl.xcframework"),
        .binaryTarget(name: "XCTestBootstrap", path: ".idb/XCFrameworks/XCTestBootstrap.xcframework"),
    ]
)
