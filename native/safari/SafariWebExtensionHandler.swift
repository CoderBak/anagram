import SafariServices

@objc protocol AnagramScoring {
    func request(_ data: Data, withReply reply: @escaping (Data?, String?) -> Void)
}

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    private static let lock = NSLock()
    private struct Lease {
        let client: String
        let connection: NSXPCConnection
    }
    private static var connections: [String: Lease] = [:]

    private static func connect(profile: String, client: String) {
        lock.lock()
        defer { lock.unlock() }
        if connections[profile]?.client == client { return }
        connections.removeValue(forKey: profile)?.connection.invalidate()
        let connection = NSXPCConnection(serviceName: "dev.coderbak.Anagram.Scoring")
        connection.remoteObjectInterface = NSXPCInterface(with: AnagramScoring.self)
        connection.invalidationHandler = { [weak connection] in
            lock.lock()
            defer { lock.unlock() }
            if connections[profile]?.connection === connection { connections.removeValue(forKey: profile) }
        }
        connection.resume()
        connections[profile] = Lease(client: client, connection: connection)
    }

    private static func connection(profile: String, client: String, disconnect: Bool = false) -> NSXPCConnection? {
        lock.lock()
        defer { lock.unlock() }
        guard let lease = connections[profile], lease.client == client else { return nil }
        if disconnect {
            connections.removeValue(forKey: profile)
            lease.connection.invalidate()
        }
        return lease.connection
    }

    func beginRequest(with context: NSExtensionContext) {
        guard let item = context.inputItems.first as? NSExtensionItem,
              let message = item.userInfo?[SFExtensionMessageKey] as? [String: Any] else {
            context.cancelRequest(withError: CocoaError(.coderInvalidValue))
            return
        }
        if message["anagram"] as? String == "capabilities" {
            let service = Bundle.main.bundleURL.appendingPathComponent("Contents/XPCServices/Scoring.xpc")
            let result = NSExtensionItem()
            result.userInfo = [SFExtensionMessageKey: [
                "anagramNative": FileManager.default.fileExists(atPath: service.path) ? 1 : 0,
                "home": Bundle.main.object(forInfoDictionaryKey: "AnagramHome") ?? NSNull(),
            ]]
            context.completeRequest(returningItems: [result])
            return
        }
        guard let client = message["client"] as? String, UUID(uuidString: client) != nil else {
            context.cancelRequest(withError: CocoaError(.coderInvalidValue))
            return
        }
        let profile: String
        if #available(macOS 14.0, *) {
            profile = (item.userInfo?[SFExtensionProfileKey] as? UUID)?.uuidString ?? "default"
        } else { profile = "default" }
        switch message["anagram"] as? String {
        case "connect":
            Self.connect(profile: profile, client: client)
            let result = NSExtensionItem()
            result.userInfo = [SFExtensionMessageKey: ["connected": true]]
            context.completeRequest(returningItems: [result])
            return
        case "disconnect":
            _ = Self.connection(profile: profile, client: client, disconnect: true)
            let result = NSExtensionItem()
            result.userInfo = [SFExtensionMessageKey: ["disconnected": true]]
            context.completeRequest(returningItems: [result])
            return
        case "request": break
        default:
            context.cancelRequest(withError: CocoaError(.coderInvalidValue))
            return
        }
        guard let payload = message["message"] as? [String: Any],
              let data = try? JSONSerialization.data(withJSONObject: payload), data.count <= 1_000_000,
              let connection = Self.connection(profile: profile, client: client) else {
            context.cancelRequest(withError: CocoaError(.coderInvalidValue))
            return
        }
        let proxy = connection.remoteObjectProxyWithErrorHandler { error in
            context.cancelRequest(withError: error)
        } as! AnagramScoring
        proxy.request(data) { response, error in
            guard let response, let value = try? JSONSerialization.jsonObject(with: response) else {
                context.cancelRequest(withError: NSError(domain: "AnagramScoring", code: 1,
                    userInfo: [NSLocalizedDescriptionKey: error ?? "Local engine unavailable"]))
                return
            }
            let result = NSExtensionItem()
            result.userInfo = [SFExtensionMessageKey: value]
            context.completeRequest(returningItems: [result])
        }
    }
}
