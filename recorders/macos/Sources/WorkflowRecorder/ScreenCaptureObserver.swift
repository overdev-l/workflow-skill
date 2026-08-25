@preconcurrency import ScreenCaptureKit
import CoreMedia
import CoreVideo
import Foundation

final class ScreenCaptureObserver: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    private let writer: JSONLineWriter
    private let eventHandler: @Sendable (FrameSample) -> Void
    private let sampleQueue = DispatchQueue(label: "com.trace.recorder.screen-samples", qos: .utility)
    private let lock = NSLock()
    private var stream: SCStream?
    private var frameCount = 0
    private var lastEmittedAt = Date.distantPast
    private var displayId: UInt32 = 0

    init(writer: JSONLineWriter, eventHandler: @escaping @Sendable (FrameSample) -> Void) {
        self.writer = writer
        self.eventHandler = eventHandler
    }

    func start() async throws {
        if stream != nil { return }

        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let display = content.displays.first else {
            throw NSError(domain: "TraceRecorder", code: 1001, userInfo: [NSLocalizedDescriptionKey: "No capturable display found"])
        }

        let ownPid = pid_t(ProcessInfo.processInfo.processIdentifier)
        let excludedApplications = content.applications.filter { $0.processID == ownPid }
        let filter = SCContentFilter(
            display: display,
            excludingApplications: excludedApplications,
            exceptingWindows: []
        )

        let configuration = SCStreamConfiguration()
        let maximumWidth = 1920
        let scale = min(1.0, Double(maximumWidth) / Double(max(display.width, 1)))
        configuration.width = max(1, Int(Double(display.width) * scale))
        configuration.height = max(1, Int(Double(display.height) * scale))
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: 2)
        configuration.queueDepth = 2
        configuration.pixelFormat = kCVPixelFormatType_32BGRA
        configuration.showsCursor = true
        configuration.capturesAudio = false

        let newStream = SCStream(filter: filter, configuration: configuration, delegate: self)
        try newStream.addStreamOutput(self, type: .screen, sampleHandlerQueue: sampleQueue)
        try await newStream.startCapture()

        lock.withLock {
            displayId = display.displayID
            stream = newStream
        }
    }

    func stop() async {
        let currentStream = lock.withLock {
            let value = stream
            stream = nil
            return value
        }

        guard let currentStream else { return }
        try? await currentStream.stopCapture()
        try? currentStream.removeStreamOutput(self, type: .screen)
    }

    func stream(_ stream: SCStream, didStopWithError error: any Error) {
        writer.send("error", payload: RecorderError(
            code: "screen_capture_interrupted",
            message: error.localizedDescription,
            recoverable: true
        ))
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of outputType: SCStreamOutputType) {
        guard outputType == .screen, sampleBuffer.isValid, let imageBuffer = sampleBuffer.imageBuffer else { return }

        lock.lock()
        frameCount += 1
        let currentFrame = frameCount
        let currentDisplayId = displayId
        let shouldEmit = Date().timeIntervalSince(lastEmittedAt) >= 1
        if shouldEmit { lastEmittedAt = Date() }
        lock.unlock()

        guard shouldEmit else { return }
        let sample = FrameSample(
            frameNumber: currentFrame,
            width: CVPixelBufferGetWidth(imageBuffer),
            height: CVPixelBufferGetHeight(imageBuffer),
            displayId: currentDisplayId,
            contentRect: contentRect(from: sampleBuffer)
        )
        eventHandler(sample)
    }

    private func contentRect(from sampleBuffer: CMSampleBuffer) -> Bounds? {
        guard
            let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
            let first = attachments.first,
            let rect = first[.contentRect] as? CGRect
        else { return nil }
        return Bounds(x: rect.origin.x, y: rect.origin.y, width: rect.width, height: rect.height)
    }
}
