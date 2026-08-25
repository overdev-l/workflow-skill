import Foundation

enum RecorderState: String, Codable {
    case idle
    case observing
    case paused
    case interrupted
}

struct PermissionSnapshot: Codable, Sendable {
    let screenRecording: Bool
    let accessibility: Bool
}

struct Point: Codable, Sendable {
    let x: Double
    let y: Double
}

struct Bounds: Codable, Sendable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

struct SemanticTarget: Codable, Sendable {
    let role: String?
    let subrole: String?
    let identifier: String?
    let labelHash: String?
    let windowTitleHash: String?
    let bounds: Bounds?
}

struct CaptureEvent: Codable, Sendable {
    let id: String
    let occurredAt: String
    let sessionId: String
    let applicationId: String?
    let applicationName: String?
    let eventType: String
    let pointer: Point?
    let keyCode: Int?
    let modifiers: UInt64?
    let target: SemanticTarget?
    let attributes: [String: String]
}

struct FrameSample: Codable, Sendable {
    let frameNumber: Int
    let width: Int
    let height: Int
    let displayId: UInt32
    let contentRect: Bounds?
}

struct RecorderStatus: Codable, Sendable {
    let protocolVersion: Int
    let recorderVersion: String
    let platform: String
    let state: RecorderState
    let sessionId: String?
    let activeApplication: String?
    let eventCount: Int
    let frameCount: Int
    let recordedBytes: Int
    let permissions: PermissionSnapshot
    let timestamp: String
}

struct RecorderCommand: Decodable {
    let type: String
    let sessionId: String?
    let prompt: Bool?
    let permissionTarget: String?
    let excludedBundleIds: [String]?
    let excludedWindowTitlePatterns: [String]?
}

struct RecorderError: Codable {
    let code: String
    let message: String
    let recoverable: Bool
}

struct RecorderEnvelope<Payload: Encodable>: Encodable {
    let protocolVersion = 1
    let type: String
    let timestamp: String
    let payload: Payload
}

func isoTimestamp() -> String {
    ISO8601DateFormatter().string(from: Date())
}
