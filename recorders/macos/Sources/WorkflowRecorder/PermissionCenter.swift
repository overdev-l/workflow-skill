import ApplicationServices
import CoreGraphics
import Foundation

enum PermissionCenter {
    static func snapshot() -> PermissionSnapshot {
        PermissionSnapshot(
            screenRecording: CGPreflightScreenCaptureAccess(),
            accessibility: AXIsProcessTrusted()
        )
    }

    static func request(_ target: String? = nil) -> PermissionSnapshot {
        if (target == nil || target == "screenRecording"), !CGPreflightScreenCaptureAccess() {
            _ = CGRequestScreenCaptureAccess()
        }

        if (target == nil || target == "accessibility"), !AXIsProcessTrusted() {
            let options = ["AXTrustedCheckOptionPrompt": true] as CFDictionary
            _ = AXIsProcessTrustedWithOptions(options)
        }

        return snapshot()
    }
}
