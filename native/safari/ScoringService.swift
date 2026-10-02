import Foundation

@objc protocol AnagramScoring {
    func request(_ data: Data, withReply reply: @escaping (Data?, String?) -> Void)
}

// One stdio host per XPC connection; page text never travels over a network socket.
final class ScoringService: NSObject, AnagramScoring {
    private let queue = DispatchQueue(label: "anagram.stdio")
    private var process: Process?
    private var input: FileHandle?
    private var output: FileHandle?
    private var pending: [String: (Data?, String?) -> Void] = [:]
    private let home: URL

    init(home: URL) { self.home = home }

    func request(_ data: Data, withReply reply: @escaping (Data?, String?) -> Void) {
        queue.async {
            guard data.count <= 1_000_000,
                  let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let id = value["id"] as? String, !id.isEmpty, id.count <= 96,
                  self.pending[id] == nil else {
                reply(nil, "Invalid or duplicate native request")
                return
            }
            guard self.pending.count < 64 else { reply(nil, "Too many pending requests"); return }
            do {
                try self.start()
                self.pending[id] = reply
                var size = UInt32(data.count).littleEndian
                var frame = withUnsafeBytes(of: &size) { Data($0) }
                frame.append(data)
                try self.input!.write(contentsOf: frame)
                self.queue.asyncAfter(deadline: .now() + 120) {
                    if self.pending[id] != nil { self.stop("Local engine timed out") }
                }
            } catch {
                if self.pending[id] == nil { reply(nil, "Local engine unavailable: \(error.localizedDescription)") }
                self.stop("Local engine disconnected")
            }
        }
    }

    private func start() throws {
        if process != nil { return }
        let child = Process()
        child.executableURL = home.appendingPathComponent("venv/bin/python")
        child.arguments = ["-I", "-u", home.appendingPathComponent("app/native_host.py").path, "--home", home.path]
        child.environment = ["HOME": NSHomeDirectory(), "PATH": "/usr/bin:/bin", "LANG": "en_US.UTF-8"]
        let stdin = Pipe(), stdout = Pipe()
        child.standardInput = stdin
        child.standardOutput = stdout
        child.standardError = FileHandle.nullDevice
        try child.run()
        process = child
        input = stdin.fileHandleForWriting
        output = stdout.fileHandleForReading
        let reader = stdout.fileHandleForReading
        DispatchQueue.global().async {
            do {
                while true {
                    let header = try self.readExactly(reader, 4)
                    let size = header.enumerated().reduce(UInt32(0)) { $0 | (UInt32($1.element) << ($1.offset * 8)) }
                    guard size > 0, size <= 1_000_000 else { throw CocoaError(.fileReadCorruptFile) }
                    let response = try self.readExactly(reader, Int(size))
                    guard let value = try JSONSerialization.jsonObject(with: response) as? [String: Any],
                          let id = value["id"] as? String else { throw CocoaError(.fileReadCorruptFile) }
                    self.queue.async {
                        guard self.process === child else { return }
                        self.pending.removeValue(forKey: id)?(response, nil)
                    }
                }
            } catch {
                self.queue.async { if self.process === child { self.stop("Local engine disconnected") } }
            }
        }
    }

    private func readExactly(_ handle: FileHandle, _ count: Int) throws -> Data {
        var data = Data()
        while data.count < count {
            guard let part = try handle.read(upToCount: count - data.count), !part.isEmpty else { throw CocoaError(.fileReadCorruptFile) }
            data.append(part)
        }
        return data
    }

    func invalidate() { queue.async { self.stop("Safari connection closed") } }

    private func stop(_ reason: String) {
        try? input?.close()
        input = nil
        if let child = process, child.isRunning { child.terminate() }
        process = nil
        output = nil
        let replies = pending.values
        pending.removeAll()
        for reply in replies { reply(nil, reason) }
    }
}
