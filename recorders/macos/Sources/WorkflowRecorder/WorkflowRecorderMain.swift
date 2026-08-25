import AppKit
import Foundation

@main
struct WorkflowRecorderMain {
    @MainActor
    static func main() async {
        let args = Array(CommandLine.arguments.dropFirst())
        let mode = args.first ?? "status"

        if mode == "permiso" {
            runPermiso(args: Array(args.dropFirst()))
            return
        }

        if mode == "watch-system-settings" {
            await SystemSettingsWindowWatcher.run()
            return
        }

        let writer = JSONLineWriter()
        let service = RecorderService(writer: writer)

        if mode == "serve" {
            service.sendStatus()
            let decoder = JSONDecoder()
            while let line = readLine(strippingNewline: true) {
                guard !line.isEmpty else { continue }
                do {
                    let command = try decoder.decode(RecorderCommand.self, from: Data(line.utf8))
                    if !(await service.handle(command)) { break }
                } catch {
                    writer.send("error", payload: RecorderError(
                        code: "invalid_command",
                        message: error.localizedDescription,
                        recoverable: true
                    ))
                }
            }
            return
        }

        let command = RecorderCommand(
            type: mode,
            sessionId: CommandLine.arguments.dropFirst(2).first,
            prompt: mode == "permissions",
            permissionTarget: nil,
            excludedBundleIds: nil,
            excludedWindowTitlePatterns: nil
        )
        _ = await service.handle(command)
    }

    @MainActor
    private static func runPermiso(args: [String]) {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)

        let panel: PermisoPanel = args.contains(where: { $0.contains("ScreenCapture") || $0.contains("screenRecording") })
            ? .screenRecording
            : .accessibility

        var appPath: String?
        var sourceX: CGFloat?
        var sourceY: CGFloat?
        var sourceW: CGFloat?
        var sourceH: CGFloat?

        var i = 0
        while i < args.count {
            let arg = args[i]
            if arg == "--app-path" && i + 1 < args.count {
                appPath = args[i + 1]
                i += 2
                continue
            }
            if arg == "--source-x" && i + 1 < args.count {
                if let v = Double(args[i + 1]) { sourceX = CGFloat(v) }
                i += 2
                continue
            }
            if arg == "--source-y" && i + 1 < args.count {
                if let v = Double(args[i + 1]) { sourceY = CGFloat(v) }
                i += 2
                continue
            }
            if arg == "--source-w" && i + 1 < args.count {
                if let v = Double(args[i + 1]) { sourceW = CGFloat(v) }
                i += 2
                continue
            }
            if arg == "--source-h" && i + 1 < args.count {
                if let v = Double(args[i + 1]) { sourceH = CGFloat(v) }
                i += 2
                continue
            }
            i += 1
        }

        let hostApp = PermisoHostApp.from(path: appPath)
        var sourceFrame: CGRect?
        if let x = sourceX, let y = sourceY, let w = sourceW, let h = sourceH {
            let primaryHeight = NSScreen.screens.first?.frame.height ?? 1000
            let appKitY = primaryHeight - y - h
            sourceFrame = CGRect(x: x, y: appKitY, width: w, height: h)
        }

        PermisoAssistant.shared.present(
            panel: panel,
            hostApp: hostApp,
            sourceFrameInScreen: sourceFrame,
            onDismiss: {
                exit(0)
            }
        )

        app.run()
    }
}
