import AppKit
import Foundation

public enum PermisoPanel: String, CaseIterable, Sendable {
    case accessibility = "Privacy_Accessibility"
    case screenRecording = "Privacy_ScreenCapture"
    case appManagement = "Privacy_AppBundles"

    public var title: String {
        let isZh = Locale.preferredLanguages.first?.hasPrefix("zh") == true
        switch self {
        case .accessibility:
            return isZh ? "辅助功能" : "Accessibility"
        case .screenRecording:
            return isZh ? "屏幕录制" : "Screen Recording"
        case .appManagement:
            return isZh ? "App 管理" : "App Management"
        }
    }

    public var settingsURL: URL {
        guard let url = URL(string: "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?\(rawValue)") else {
            preconditionFailure("Invalid System Settings URL for \(rawValue)")
        }
        return url
    }
}
