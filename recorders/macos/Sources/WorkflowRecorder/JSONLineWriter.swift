import Foundation

final class JSONLineWriter: @unchecked Sendable {
    private let lock = NSLock()
    private let encoder: JSONEncoder

    init() {
        encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    }

    func send<T: Encodable>(_ type: String, payload: T) {
        let envelope = RecorderEnvelope(type: type, timestamp: isoTimestamp(), payload: payload)
        do {
            let data = try encoder.encode(envelope)
            lock.lock()
            defer { lock.unlock() }
            FileHandle.standardOutput.write(data)
            FileHandle.standardOutput.write(Data("\n".utf8))
        } catch {
            FileHandle.standardError.write(Data("json encoding failed: \(error)\n".utf8))
        }
    }
}
