import AppKit
import Foundation

public struct PermisoHostApp: Sendable {
    public let displayName: String
    public let bundleURL: URL
    public let icon: NSImage

    public init(displayName: String, bundleURL: URL, icon: NSImage) {
        self.displayName = displayName
        self.bundleURL = bundleURL
        self.icon = icon
    }

    public static func from(path: String?) -> PermisoHostApp {
        if let path, !path.isEmpty {
            let url = URL(fileURLWithPath: path)
            let name = (try? url.resourceValues(forKeys: [.localizedNameKey]))?.localizedName
                ?? url.deletingPathExtension().lastPathComponent
            let icon = NSWorkspace.shared.icon(forFile: url.path)
            icon.size = NSSize(width: 48, height: 48)
            return PermisoHostApp(displayName: name, bundleURL: url, icon: icon)
        }

        // Try to locate parent .app bundle
        let mainBundle = Bundle.main
        if mainBundle.bundleURL.pathExtension == "app" {
            return fromBundle(mainBundle)
        }

        // Check if running inside Electron or sub-helper
        let execPath = ProcessInfo.processInfo.arguments.first ?? ""
        if let appIndex = execPath.range(of: ".app") {
            let appPath = String(execPath[..<appIndex.upperBound])
            let url = URL(fileURLWithPath: appPath)
            let name = (try? url.resourceValues(forKeys: [.localizedNameKey]))?.localizedName
                ?? url.deletingPathExtension().lastPathComponent
            let icon = NSWorkspace.shared.icon(forFile: url.path)
            icon.size = NSSize(width: 48, height: 48)
            return PermisoHostApp(displayName: name, bundleURL: url, icon: icon)
        }

        return fromBundle(.main)
    }

    private static func fromBundle(_ bundle: Bundle) -> PermisoHostApp {
        let displayName = bundle.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String
            ?? bundle.object(forInfoDictionaryKey: kCFBundleNameKey as String) as? String
            ?? bundle.bundleURL.deletingPathExtension().lastPathComponent
        let icon = NSWorkspace.shared.icon(forFile: bundle.bundleURL.path)
        icon.size = NSSize(width: 48, height: 48)
        return PermisoHostApp(displayName: displayName.isEmpty ? "Trace" : displayName, bundleURL: bundle.bundleURL, icon: icon)
    }
}
