import AppKit
import CoreGraphics
import Darwin
import Foundation

private struct WatchedWindowFrame: Codable, Equatable {
    let x: CGFloat
    let y: CGFloat
    let width: CGFloat
    let height: CGFloat
}

private struct SystemSettingsSnapshot: Codable, Equatable {
    let visible: Bool
    let frame: WatchedWindowFrame?
}

enum SystemSettingsWindowWatcher {
    private static let bundleIdentifier = "com.apple.systempreferences"

    @MainActor
    static func run() async {
        let encoder = JSONEncoder()
        var previous: SystemSettingsSnapshot?

        while parentIsAlive() {
            autoreleasepool {
                let snapshot = currentSnapshot()
                guard snapshot != previous else { return }
                previous = snapshot
                guard let data = try? encoder.encode(snapshot) else { return }
                FileHandle.standardOutput.write(data)
                FileHandle.standardOutput.write(Data([0x0A]))
            }
            try? await Task.sleep(for: .milliseconds(150))
        }
    }

    private static func currentSnapshot() -> SystemSettingsSnapshot {
        guard NSWorkspace.shared.frontmostApplication?.bundleIdentifier == bundleIdentifier else {
            return SystemSettingsSnapshot(visible: false, frame: nil)
        }
        guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleIdentifier)
            .max(by: { ($0.activationPolicy == .prohibited ? 0 : 1) < ($1.activationPolicy == .prohibited ? 0 : 1) }) else {
            return SystemSettingsSnapshot(visible: false, frame: nil)
        }
        guard let windowInfo = CGWindowListCopyWindowInfo(
            [.optionOnScreenOnly, .excludeDesktopElements],
            .zero
        ) as? [[String: Any]] else {
            return SystemSettingsSnapshot(visible: false, frame: nil)
        }

        let frames = windowInfo.compactMap { info -> CGRect? in
            guard let ownerPID = info[kCGWindowOwnerPID as String] as? pid_t,
                  ownerPID == app.processIdentifier,
                  let layer = info[kCGWindowLayer as String] as? Int,
                  layer == 0,
                  let bounds = info[kCGWindowBounds as String] as? [String: CGFloat]
            else { return nil }

            let frame = CGRect(
                x: bounds["X"] ?? 0,
                y: bounds["Y"] ?? 0,
                width: bounds["Width"] ?? 0,
                height: bounds["Height"] ?? 0
            )
            return frame.width > 320 && frame.height > 240 ? frame : nil
        }

        guard let frame = frames.max(by: { $0.width * $0.height < $1.width * $1.height }) else {
            return SystemSettingsSnapshot(visible: false, frame: nil)
        }
        return SystemSettingsSnapshot(
            visible: true,
            frame: WatchedWindowFrame(x: frame.minX, y: frame.minY, width: frame.width, height: frame.height)
        )
    }

    private static func parentIsAlive() -> Bool {
        guard let rawPID = ProcessInfo.processInfo.environment["TRACE_PARENT_PID"],
              let pid = Int32(rawPID),
              pid > 1
        else { return true }
        return kill(pid, 0) == 0 || errno == EPERM
    }
}
