// swift-tools-version:6.0
// HairKit — the device-independent core of Hair Try-On.
// Dependency rule (docs/ARCHITECTURE.md §5): ProtoStyle depends on nothing;
// nothing here imports ARKit, RealityKit or UIKit, so all of it tests on Linux CI.
import PackageDescription

let package = Package(
    name: "HairKit",
    platforms: [.iOS(.v18), .macOS(.v14)],
    products: [
        .library(name: "HairKit", targets: ["ProtoStyle", "HeadFit", "HairDynamics", "TryOnCore"]),
    ],
    targets: [
        .target(name: "ProtoStyle"),
        .target(name: "HeadFit", dependencies: ["ProtoStyle"]),
        .target(name: "HairDynamics", dependencies: ["ProtoStyle"]),
        .target(name: "TryOnCore", dependencies: ["ProtoStyle", "HeadFit", "HairDynamics"],
                resources: [.copy("Resources/catalog.json")]),
        .testTarget(name: "ProtoStyleTests", dependencies: ["ProtoStyle"]),
        .testTarget(name: "HeadFitTests", dependencies: ["HeadFit", "ProtoStyle"]),
        .testTarget(name: "HairDynamicsTests", dependencies: ["HairDynamics", "ProtoStyle"]),
        .testTarget(name: "TryOnCoreTests", dependencies: ["TryOnCore", "HairDynamics", "HeadFit", "ProtoStyle"]),
    ]
)
