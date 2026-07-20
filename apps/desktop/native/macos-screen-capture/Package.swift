// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "StoryCaptureScreenCaptureHelper",
    platforms: [.macOS(.v13)],
    products: [
        .executable(
            name: "storycapture-screen-capture-helper",
            targets: ["StoryCaptureScreenCaptureHelper"]
        )
    ],
    targets: [
        .target(name: "ScreenCaptureCore"),
        .executableTarget(
            name: "StoryCaptureScreenCaptureHelper",
            dependencies: ["ScreenCaptureCore"]
        ),
        .testTarget(
            name: "StoryCaptureScreenCaptureHelperTests",
            dependencies: ["ScreenCaptureCore"]
        ),
    ]
)
