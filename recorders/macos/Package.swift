// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "WorkflowRecorder",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "workflow-recorder-macos", targets: ["WorkflowRecorder"])],
    targets: [.executableTarget(name: "WorkflowRecorder")]
)
