import SafariServices

@objc protocol AnagramScoring {
    func request(_ data: Data, withReply reply: @escaping (Data?, String?) -> Void)
}

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    private static let lock = NSLock()
    private static var activeConnection: NSXPCConnection?

    private static func connection() -> NSXPCConnection {
        lock.lock()
        defer { lock.unlock() }
        if let activeConnection { return activeConnection }
        let connection = NSXPCConnection(serviceName: "dev.coderbak.Anagram.Scoring")
        connection.remoteObjectInterface = NSXPCInterface(with: AnagramScoring.self)
        connection.invalidationHandler = { [weak connection] in
            lock.lock()
            defer { lock.unlock() }
            if activeConnection === connection { activeConnection = nil }
        }
        connection.resume()
        activeConnection = connection
        return connection
    }

    func beginRequest(with context: NSExtensionContext) {
        guard let item = context.inputItems.first as? NSExtensionItem,
              let message = item.userInfo?[SFExtensionMessageKey],
              let data = try? JSONSerialization.data(withJSONObject: message), data.count <= 1_000_000 else {
            context.cancelRequest(withError: CocoaError(.coderInvalidValue))
            return
        }
        let proxy = Self.connection().remoteObjectProxyWithErrorHandler { error in
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
