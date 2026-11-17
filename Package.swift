// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "MacADICore",
    platforms: [.iOS(.v16)],
    products: [
        .library(name: "MacADICore", targets: ["MacADICore"]),
    ],
    targets: [
        // Static arm64-iOS framework built from this repo by build-ios.sh.
        // Its C API needs libz and libbz2 at link time.
        .binaryTarget(name: "MacADICore", path: "MacADICore.xcframework"),
    ]
)
