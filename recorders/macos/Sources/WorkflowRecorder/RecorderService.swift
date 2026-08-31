import AppKit
import Foundation

final class RecorderService: @unchecked Sendable {
    private let writer: JSONLineWriter
    private let lock = NSLock()
    private lazy var screenObserver = ScreenCaptureObserver(writer: writer) { [weak self] frame in
        self?.handle(frame: frame)
    }
    private lazy var accessibilityObserver = AccessibilityObserver { [weak self] event in
        self?.handle(event: event)
    }
    private var state: RecorderState = .idle
    private var sessionId: String?
    private var eventCount = 0
    private var frameCount = 0

    init(writer: JSONLineWriter) {
        self.writer = writer
    }

    func handle(_ command: RecorderCommand) async -> Bool {
        switch command.type {
        case "status":
            sendStatus()
        case "permissions":
            let snapshot = command.prompt == true
                ? PermissionCenter.request(command.permissionTarget)
                : PermissionCenter.snapshot()
            writer.send("permissions", payload: snapshot)
            sendStatus()
        case "policy":
            accessibilityObserver.updatePolicy(
                excludedBundleIds: command.excludedBundleIds ?? [],
                excludedWindowTitlePatterns: command.excludedWindowTitlePatterns ?? []
            )
            sendStatus()
        case "start", "resume":
            await start(sessionId: command.sessionId)
        case "pause":
            await pause()
        case "stop":
            await stop()
        case "shutdown":
            await stop()
            return false
        default:
            writer.send("error", payload: RecorderError(
                code: "unknown_command",
                message: "Unknown recorder command: \(command.type)",
                recoverable: true
            ))
        }
        return true
    }

    func sendStatus() {
        lock.lock()
        let currentState = state
        let currentSessionId = sessionId
        let currentEventCount = eventCount
        let currentFrameCount = frameCount
        lock.unlock()

        writer.send("status", payload: RecorderStatus(
            protocolVersion: 1,
            recorderVersion: "0.2.0",
            platform: "macos",
            state: currentState,
            sessionId: currentSessionId,
            activeApplication: NSWorkspace.shared.frontmostApplication?.bundleIdentifier,
            eventCount: currentEventCount,
            frameCount: currentFrameCount,
            recordedBytes: 0,
            permissions: PermissionCenter.snapshot(),
            timestamp: isoTimestamp()
        ))
    }

    private func start(sessionId requestedSessionId: String?) async {
        if lock.withLock({ state == .observing }) {
            sendStatus()
            return
        }

        let permissions = PermissionCenter.snapshot()
        guard permissions.screenRecording, permissions.accessibility else {
            writer.send("error", payload: RecorderError(
                code: "permissions_required",
                message: "Screen Recording and Accessibility permissions are required",
                recoverable: true
            ))
            sendStatus()
            return
        }

        let nextSessionId = requestedSessionId ?? sessionId ?? UUID().uuidString
        do {
            try await screenObserver.start()
            try accessibilityObserver.start(sessionId: nextSessionId)
            lock.withLock {
                sessionId = nextSessionId
                state = .observing
            }
            sendStatus()
        } catch {
            accessibilityObserver.stop()
            await screenObserver.stop()
            lock.withLock { state = .interrupted }
            writer.send("error", payload: RecorderError(
                code: "capture_start_failed",
                message: error.localizedDescription,
                recoverable: true
            ))
            sendStatus()
        }
    }

    private func pause() async {
        accessibilityObserver.stop()
        await screenObserver.stop()
        lock.withLock { state = .paused }
        sendStatus()
    }

    private func stop() async {
        accessibilityObserver.stop()
        await screenObserver.stop()
        lock.withLock {
            state = .idle
            sessionId = nil
        }
        sendStatus()
    }

    private func handle(event: CaptureEvent) {
        lock.lock()
        eventCount += 1
        lock.unlock()
        writer.send("capture-event", payload: event)
    }

    private func handle(frame: FrameSample) {
        lock.lock()
        frameCount = frame.frameNumber
        lock.unlock()
        writer.send("frame-sample", payload: frame)
    }
}
