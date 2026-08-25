import AppKit
import Foundation

@MainActor
public final class PermisoAssistant {
    public static let shared = PermisoAssistant()

    private var overlayController: OverlayWindowController?
    private var trackingTimer: Timer?
    private var permissionPollTimer: Timer?
    private var activationObserver: NSObjectProtocol?
    private var activePanel: PermisoPanel?
    private var pendingSourceFrameInScreen: CGRect?
    private var didPresentCurrentOverlay = false
    private var initialPermissionGranted = false
    private var missedFramesCount = 0
    private var onDismissCallback: (() -> Void)?

    public init() {}

    public func present(
        panel: PermisoPanel,
        hostApp: PermisoHostApp,
        sourceFrameInScreen: CGRect? = nil,
        onDismiss: (() -> Void)? = nil
    ) {
        self.activePanel = panel
        self.pendingSourceFrameInScreen = sourceFrameInScreen
        self.didPresentCurrentOverlay = false
        self.onDismissCallback = onDismiss
        self.missedFramesCount = 0

        let snapshot = PermissionCenter.snapshot()
        self.initialPermissionGranted = (panel == .accessibility && snapshot.accessibility)
            || (panel == .screenRecording && snapshot.screenRecording)

        self.overlayController = OverlayWindowController(hostApp: hostApp, panel: panel) { [weak self] in
            self?.dismiss()
        }

        NSWorkspace.shared.open(panel.settingsURL)
        startTracking()
        startPermissionPolling()
    }

    public func dismiss() {
        trackingTimer?.invalidate()
        trackingTimer = nil
        permissionPollTimer?.invalidate()
        permissionPollTimer = nil

        if let activationObserver {
            NSWorkspace.shared.notificationCenter.removeObserver(activationObserver)
            self.activationObserver = nil
        }

        overlayController?.close()
        overlayController = nil
        activePanel = nil
        pendingSourceFrameInScreen = nil
        didPresentCurrentOverlay = false

        onDismissCallback?()
    }

    private func startTracking() {
        trackingTimer?.invalidate()
        trackingTimer = Timer.scheduledTimer(withTimeInterval: 0.15, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard self?.checkParentAlive() == true else {
                    self?.dismiss()
                    return
                }
                self?.refreshPosition()
            }
        }

        if let activationObserver {
            NSWorkspace.shared.notificationCenter.removeObserver(activationObserver)
        }
        activationObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                self?.missedFramesCount = 0
                self?.refreshPosition()
            }
        }

        refreshPosition()
    }

    private func startPermissionPolling() {
        permissionPollTimer?.invalidate()
        // Only auto-dismiss if permission was NOT granted initially and becomes granted now
        guard !initialPermissionGranted else { return }

        permissionPollTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self, let panel = self.activePanel else { return }
                let snapshot = PermissionCenter.snapshot()
                let isGranted = (panel == .accessibility && snapshot.accessibility)
                    || (panel == .screenRecording && snapshot.screenRecording)
                if isGranted {
                    try? await Task.sleep(for: .milliseconds(700))
                    self.dismiss()
                }
            }
        }
    }

    private func refreshPosition() {
        guard let snapshot = SettingsWindowLocator.frontmostWindow() ?? SettingsWindowLocator.frontmostFallbackWindow() else {
            missedFramesCount += 1
            // Debounce: only hide after 3 consecutive misses (450ms) to avoid flickers during click/drag
            if missedFramesCount >= 3 {
                overlayController?.hide()
            }
            return
        }

        missedFramesCount = 0
        if didPresentCurrentOverlay {
            overlayController?.updatePosition(with: snapshot.frame, visibleFrame: snapshot.visibleFrame)
            return
        }

        overlayController?.present(
            from: pendingSourceFrameInScreen,
            settingsFrame: snapshot.frame,
            visibleFrame: snapshot.visibleFrame
        )
        didPresentCurrentOverlay = true
    }

    private func checkParentAlive() -> Bool {
        guard let rawPID = ProcessInfo.processInfo.environment["TRACE_PARENT_PID"],
              let pid = Int32(rawPID),
              pid > 1
        else { return true }
        return kill(pid, 0) == 0 || errno == EPERM
    }
}
