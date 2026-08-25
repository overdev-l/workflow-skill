import AppKit
import ApplicationServices
import CryptoKit
import Foundation

final class AccessibilityObserver: @unchecked Sendable {
    private let eventHandler: @Sendable (CaptureEvent) -> Void
    private let lock = NSLock()
    private var eventTap: CFMachPort?
    private var runLoop: CFRunLoop?
    private var thread: Thread?
    private var sessionId = ""
    private var excludedBundleIds = Set<String>()
    private var excludedWindowTitleHashes = Set<String>()
    private var lastApplicationId: String?

    init(eventHandler: @escaping @Sendable (CaptureEvent) -> Void) {
        self.eventHandler = eventHandler
    }

    func updatePolicy(excludedBundleIds: [String], excludedWindowTitlePatterns: [String]) {
        lock.lock()
        self.excludedBundleIds = Set(excludedBundleIds)
        excludedWindowTitleHashes = Set(excludedWindowTitlePatterns)
        lock.unlock()
    }

    func start(sessionId: String) {
        stop()
        lock.lock()
        self.sessionId = sessionId
        lock.unlock()

        let observerThread = Thread { [weak self] in
            guard let self else { return }
            let mask = (1 << CGEventType.leftMouseDown.rawValue)
                | (1 << CGEventType.rightMouseDown.rawValue)
                | (1 << CGEventType.otherMouseDown.rawValue)
                | (1 << CGEventType.keyDown.rawValue)
                | (1 << CGEventType.scrollWheel.rawValue)

            guard let tap = CGEvent.tapCreate(
                tap: .cgSessionEventTap,
                place: .headInsertEventTap,
                options: .listenOnly,
                eventsOfInterest: CGEventMask(mask),
                callback: AccessibilityObserver.eventTapCallback,
                userInfo: Unmanaged.passUnretained(self).toOpaque()
            ) else { return }

            let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
            let currentRunLoop = CFRunLoopGetCurrent()
            lock.lock()
            eventTap = tap
            runLoop = currentRunLoop
            lock.unlock()
            CFRunLoopAddSource(currentRunLoop, source, .commonModes)
            CGEvent.tapEnable(tap: tap, enable: true)
            CFRunLoopRun()
        }
        observerThread.name = "com.trace.recorder.accessibility"
        thread = observerThread
        observerThread.start()
    }

    func stop() {
        lock.lock()
        let currentTap = eventTap
        let currentRunLoop = runLoop
        eventTap = nil
        runLoop = nil
        lock.unlock()

        if let currentTap { CGEvent.tapEnable(tap: currentTap, enable: false) }
        if let currentRunLoop { CFRunLoopStop(currentRunLoop) }
        thread = nil
    }

    private static let eventTapCallback: CGEventTapCallBack = { _, type, event, userInfo in
        guard let userInfo else { return Unmanaged.passUnretained(event) }
        let observer = Unmanaged<AccessibilityObserver>.fromOpaque(userInfo).takeUnretainedValue()
        observer.handle(type: type, event: event)
        return Unmanaged.passUnretained(event)
    }

    private func handle(type: CGEventType, event: CGEvent) {
        guard type != .tapDisabledByTimeout, type != .tapDisabledByUserInput else {
            lock.lock()
            let currentTap = eventTap
            lock.unlock()
            if let currentTap { CGEvent.tapEnable(tap: currentTap, enable: true) }
            return
        }

        let frontmost = NSWorkspace.shared.frontmostApplication
        let bundleId = frontmost?.bundleIdentifier
        let applicationName = frontmost?.localizedName

        lock.lock()
        let isExcluded = bundleId.map { excludedBundleIds.contains($0) } ?? false
        let currentSessionId = sessionId
        let previousApplicationId = lastApplicationId
        if !isExcluded { lastApplicationId = bundleId }
        lock.unlock()
        guard !isExcluded, !currentSessionId.isEmpty else { return }

        if bundleId != previousApplicationId {
            emit(
                eventType: "application-activated",
                sessionId: currentSessionId,
                bundleId: bundleId,
                applicationName: applicationName,
                pointer: nil,
                keyCode: nil,
                event: event,
                target: nil
            )
        }

        let point = event.location
        switch type {
        case .leftMouseDown, .rightMouseDown, .otherMouseDown:
            let target = semanticTarget(at: point)
            guard !isExcludedWindow(target?.windowTitleHash) else { return }
            emit(
                eventType: type == .leftMouseDown ? "mouse-left-down" : type == .rightMouseDown ? "mouse-right-down" : "mouse-other-down",
                sessionId: currentSessionId,
                bundleId: bundleId,
                applicationName: applicationName,
                pointer: Point(x: point.x, y: point.y),
                keyCode: nil,
                event: event,
                target: target
            )
        case .keyDown:
            emit(
                eventType: "key-down",
                sessionId: currentSessionId,
                bundleId: bundleId,
                applicationName: applicationName,
                pointer: nil,
                keyCode: Int(event.getIntegerValueField(.keyboardEventKeycode)),
                event: event,
                target: focusedSemanticTarget(for: frontmost?.processIdentifier)
            )
        case .scrollWheel:
            emit(
                eventType: "scroll",
                sessionId: currentSessionId,
                bundleId: bundleId,
                applicationName: applicationName,
                pointer: Point(x: point.x, y: point.y),
                keyCode: nil,
                event: event,
                target: semanticTarget(at: point)
            )
        default:
            break
        }
    }

    private func emit(
        eventType: String,
        sessionId: String,
        bundleId: String?,
        applicationName: String?,
        pointer: Point?,
        keyCode: Int?,
        event: CGEvent,
        target: SemanticTarget?
    ) {
        eventHandler(CaptureEvent(
            id: UUID().uuidString,
            occurredAt: isoTimestamp(),
            sessionId: sessionId,
            applicationId: bundleId,
            applicationName: applicationName,
            eventType: eventType,
            pointer: pointer,
            keyCode: keyCode,
            modifiers: event.flags.rawValue,
            target: target,
            attributes: [:]
        ))
    }

    private func semanticTarget(at point: CGPoint) -> SemanticTarget? {
        let systemWide = AXUIElementCreateSystemWide()
        var element: AXUIElement?
        guard AXUIElementCopyElementAtPosition(systemWide, Float(point.x), Float(point.y), &element) == .success, let element else {
            return nil
        }
        return semanticTarget(from: element)
    }

    private func focusedSemanticTarget(for pid: pid_t?) -> SemanticTarget? {
        guard let pid else { return nil }
        let application = AXUIElementCreateApplication(pid)
        guard let element = attributeElement(application, key: kAXFocusedUIElementAttribute) else { return nil }
        return semanticTarget(from: element)
    }

    private func semanticTarget(from element: AXUIElement) -> SemanticTarget {
        let window = attributeElement(element, key: kAXWindowAttribute)
        return SemanticTarget(
            role: attributeString(element, key: kAXRoleAttribute),
            subrole: attributeString(element, key: kAXSubroleAttribute),
            identifier: attributeString(element, key: kAXIdentifierAttribute),
            labelHash: attributeString(element, key: kAXTitleAttribute).map(hash),
            windowTitleHash: window.flatMap { attributeString($0, key: kAXTitleAttribute) }.map(hash),
            bounds: bounds(of: element)
        )
    }

    private func attributeString(_ element: AXUIElement, key: String) -> String? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, key as CFString, &value) == .success else { return nil }
        return value as? String
    }

    private func attributeElement(_ element: AXUIElement, key: String) -> AXUIElement? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, key as CFString, &value) == .success, let value else { return nil }
        guard CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
        return unsafeDowncast(value, to: AXUIElement.self)
    }

    private func bounds(of element: AXUIElement) -> Bounds? {
        var positionValue: CFTypeRef?
        var sizeValue: CFTypeRef?
        guard
            AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &positionValue) == .success,
            AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeValue) == .success,
            let positionValue,
            let sizeValue,
            CFGetTypeID(positionValue) == AXValueGetTypeID(),
            CFGetTypeID(sizeValue) == AXValueGetTypeID()
        else { return nil }

        var point = CGPoint.zero
        var size = CGSize.zero
        guard
            AXValueGetValue(positionValue as! AXValue, .cgPoint, &point),
            AXValueGetValue(sizeValue as! AXValue, .cgSize, &size)
        else { return nil }
        return Bounds(x: point.x, y: point.y, width: size.width, height: size.height)
    }

    private func hash(_ value: String) -> String {
        SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    private func isExcludedWindow(_ windowTitleHash: String?) -> Bool {
        guard let windowTitleHash else { return false }
        lock.lock()
        let isExcluded = excludedWindowTitleHashes.contains(windowTitleHash)
        lock.unlock()
        return isExcluded
    }
}
