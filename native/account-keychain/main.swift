import Foundation
import Security

let SERVICE = "gemini"
let ACCOUNT = "antigravity"
let MAX_PAYLOAD_SIZE = 8 * 1024 * 1024 // 8 MiB

func readStdinBounded(limit: Int) -> Data? {
    let handle = FileHandle.standardInput
    var data = Data()
    let chunkSize = 64 * 1024
    while true {
        let chunk = handle.readData(ofLength: chunkSize)
        if chunk.isEmpty {
            break
        }
        data.append(chunk)
        if data.count > limit {
            return nil
        }
    }
    return data
}

func outputJSON(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: []) else {
        let fallback = "{\"ok\":false,\"error\":\"malformed\"}\n"
        FileHandle.standardOutput.write(fallback.data(using: .utf8)!)
        return
    }
    if data.count > MAX_PAYLOAD_SIZE {
        let fallback = "{\"ok\":false,\"error\":\"malformed\"}\n"
        FileHandle.standardOutput.write(fallback.data(using: .utf8)!)
        return
    }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

func fail(_ error: String) -> Never {
    outputJSON(["ok": false, "error": error])
    exit(0)
}

func mapStatusToError(_ status: OSStatus) -> String {
    switch status {
    case errSecAuthFailed:
        return "denied"
    case errSecUserCanceled:
        return "denied"
    case errSecInteractionNotAllowed, errSecInteractionRequired:
        return "locked"
    case errSecNotAvailable, errSecNoSuchKeychain, errSecInvalidKeychain:
        return "unavailable"
    case errSecParam, errSecAllocate:
        return "malformed"
    default:
        return "unavailable"
    }
}

func doRead(interactive: Bool) {
    _ = SecKeychainSetUserInteractionAllowed(interactive)

    let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: SERVICE,
        kSecAttrAccount as String: ACCOUNT,
        kSecReturnData as String: true,
        kSecMatchLimit as String: kSecMatchLimitOne
    ]

    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)

    if status == errSecSuccess {
        guard let data = item as? Data,
              let string = String(data: data, encoding: .utf8) else {
            fail("malformed")
        }
        outputJSON(["ok": true, "data": string])
        exit(0)
    }

    if status == errSecItemNotFound {
        outputJSON(["ok": true, "data": NSNull()])
        exit(0)
    }

    fail(mapStatusToError(status))
}

func doWrite(secret: String, interactive: Bool) {
    _ = SecKeychainSetUserInteractionAllowed(interactive)

    guard let secretData = secret.data(using: .utf8), secretData.count <= MAX_PAYLOAD_SIZE else {
        fail("malformed")
    }

    // 1. First attempt: SecItemUpdate on existing item to preserve original ACL.
    let updateQuery: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: SERVICE,
        kSecAttrAccount as String: ACCOUNT
    ]
    let attributesToUpdate: [String: Any] = [
        kSecValueData as String: secretData
    ]

    let updateStatus = SecItemUpdate(updateQuery as CFDictionary, attributesToUpdate as CFDictionary)
    if updateStatus == errSecSuccess {
        outputJSON(["ok": true])
        exit(0)
    }

    // 2. ONLY when genuinely missing: SecItemAdd new item with default ACL.
    // NEVER perform delete-add replacement; never grant all-app access; never reset ACL.
    if updateStatus == errSecItemNotFound {
        let addQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: SERVICE,
            kSecAttrAccount as String: ACCOUNT,
            kSecValueData as String: secretData
        ]
        let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
        if addStatus == errSecSuccess {
            outputJSON(["ok": true])
            exit(0)
        }
        fail(mapStatusToError(addStatus))
    }

    // On denial, lock, or other error: fail explicitly without fallback or destruction.
    fail(mapStatusToError(updateStatus))
}

func doDelete(interactive: Bool) {
    _ = SecKeychainSetUserInteractionAllowed(interactive)

    let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: SERVICE,
        kSecAttrAccount as String: ACCOUNT
    ]
    let status = SecItemDelete(query as CFDictionary)
    if status == errSecSuccess || status == errSecItemNotFound {
        outputJSON(["ok": true])
        exit(0)
    }
    fail(mapStatusToError(status))
}

func main() {
    guard let inputData = readStdinBounded(limit: MAX_PAYLOAD_SIZE) else {
        fail("malformed")
    }

    guard let json = try? JSONSerialization.jsonObject(with: inputData, options: []) as? [String: Any] else {
        fail("malformed")
    }

    // Security check: reject any caller-supplied service, account, path or unknown target identifiers
    if json["service"] != nil || json["account"] != nil || json["path"] != nil {
        fail("malformed")
    }

    let target = json["target"] as? String ?? "cli"
    if target != "cli" && target != "desktop" {
        fail("malformed")
    }

    guard let action = json["action"] as? String else {
        fail("malformed")
    }

    let interactive = json["interactive"] as? Bool ?? false

    switch action {
    case "read":
        doRead(interactive: interactive)
    case "write":
        guard let secret = json["secret"] as? String ?? json["value"] as? String else {
            fail("malformed")
        }
        doWrite(secret: secret, interactive: interactive)
    case "delete":
        doDelete(interactive: interactive)
    default:
        fail("malformed")
    }
}

main()
