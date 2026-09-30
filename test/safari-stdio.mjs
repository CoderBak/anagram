import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const realHome = process.env.ANAGRAM_SAFARI_REAL_HOME ? realpathSync(process.env.ANAGRAM_SAFARI_REAL_HOME) : null;
if (realHome && !realHome.startsWith("/private/tmp/anagram-safari-real-")) throw new Error("Real-engine tests require a temporary owned home");
const temp = mkdtempSync(join(tmpdir(), "anagram-safari-stdio-"));
try {
  mkdirSync(join(temp, "venv/bin"), { recursive: true });
  mkdirSync(join(temp, "app"));
  const python = execFileSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim();
  symlinkSync(python, join(temp, "venv/bin/python"));
  writeFileSync(join(temp, "app/native_host.py"), `import sys, struct, json
while True:
    header = sys.stdin.buffer.read(4)
    if not header: break
    request = json.loads(sys.stdin.buffer.read(struct.unpack('<I', header)[0]))
    body = json.dumps({'v': 1, 'id': request['id'], 'ok': True, 'status': 200, 'data': request['payload']}).encode()
    sys.stdout.buffer.write(struct.pack('<I', len(body)) + body)
    sys.stdout.buffer.flush()
`);
  writeFileSync(join(temp, "main.swift"), `import Foundation
let service = ScoringService(home: URL(fileURLWithPath: CommandLine.arguments[1]))
let group = DispatchGroup()
for id in ["a", "b", "c"] {
    group.enter()
    let request = try! JSONSerialization.data(withJSONObject: ["v": 1, "id": id, "op": "status", "payload": ["text": "Unicode 中文"]])
    service.request(request) { data, error in
        precondition(error == nil, error ?? "unexpected failure")
        let value = try! JSONSerialization.jsonObject(with: data!) as! [String: Any]
        precondition(value["id"] as? String == id)
        precondition((value["data"] as! [String: String])["text"] == "Unicode 中文")
        group.leave()
    }
}
precondition(group.wait(timeout: .now() + 10) == .success)
let invalid = DispatchSemaphore(value: 0)
service.request(Data("null".utf8)) { data, error in
    precondition(data == nil && error != nil)
    invalid.signal()
}
precondition(invalid.wait(timeout: .now() + 5) == .success)
service.invalidate()
print("stdio: concurrent replies, Unicode and invalid requests passed")
`);
  const binary = join(temp, "test");
  execFileSync("xcrun", ["swiftc", resolve("native/safari/ScoringService.swift"), join(temp, "main.swift"), "-o", binary], { stdio: "inherit" });
  execFileSync(binary, [temp], { stdio: "inherit", timeout: 20000 });
  const app = join(temp, "BridgeTest.app/Contents/PlugIns/BridgeTest.appex");
  const service = join(app, "Contents/XPCServices/Scoring.xpc");
  mkdirSync(join(app, "Contents/MacOS"), { recursive: true });
  mkdirSync(join(service, "Contents/MacOS"), { recursive: true });
  const plist = (id, executable, type, extra = "") => `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${id}</string><key>CFBundleExecutable</key><string>${executable}</string><key>CFBundlePackageType</key><string>${type}</string>${extra}</dict></plist>`;
  writeFileSync(join(app, "Contents/Info.plist"), plist("dev.coderbak.Anagram.BridgeTest.Extension", "BridgeTest", "XPC!"));
  writeFileSync(join(service, "Contents/Info.plist"), plist("dev.coderbak.Anagram.Scoring", "Scoring", "XPC!", `<key>AnagramHome</key><string>${realHome ?? temp}</string><key>XPCService</key><dict><key>ServiceType</key><string>Application</string></dict>`));
  const serviceSource = join(temp, "service");
  mkdirSync(serviceSource);
  writeFileSync(join(serviceSource, "main.swift"), readFileSync("native/safari/main.swift", "utf8"));
  execFileSync("xcrun", ["swiftc", resolve("native/safari/ScoringService.swift"), join(serviceSource, "main.swift"), "-o", join(service, "Contents/MacOS/Scoring")], { stdio: "inherit" });
  writeFileSync(join(temp, "main.swift"), `import Foundation
@objc protocol AnagramScoring { func request(_ data: Data, withReply reply: @escaping (Data?, String?) -> Void) }
let connection = NSXPCConnection(serviceName: "dev.coderbak.Anagram.Scoring")
connection.remoteObjectInterface = NSXPCInterface(with: AnagramScoring.self)
connection.resume()
let proxy = connection.remoteObjectProxyWithErrorHandler { error in print(error); exit(1) } as! AnagramScoring
let request = try! JSONSerialization.data(withJSONObject: ["v": 1, "id": "xpc", "op": "status", "payload": [:]])
proxy.request(request) { data, error in
    guard let data, error == nil else { print(error ?? "No reply"); exit(1) }
    let reply = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
    precondition(reply["id"] as? String == "xpc")
    print("XPC → stdio round trip passed")
    connection.invalidate()
    exit(0)
}
RunLoop.main.run(until: Date(timeIntervalSinceNow: 15))
exit(2)
`);
  if (realHome) {
    const code = readFileSync(join(temp, "main.swift"), "utf8");
    const start = code.indexOf("let request =");
    writeFileSync(join(temp, "main.swift"), code.slice(0, start) + `
func request(_ op: String, _ payload: [String: Any] = [:], done: @escaping ([String: Any]) -> Void) {
    let body = try! JSONSerialization.data(withJSONObject: ["v": 1, "id": UUID().uuidString, "op": op, "payload": payload])
    proxy.request(body) { data, error in
        guard let data, error == nil else { print(error ?? "No native response"); exit(1) }
        let value = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
        guard value["ok"] as? Bool == true else { print(value); exit(1) }
        done(value["data"] as! [String: Any])
    }
}
func ready() {
    request("status") { status in
        guard status["state"] as? String != "error" else { print(status); exit(1) }
        if status["state"] as? String != "ready" {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { ready() }
            return
        }
        let text = "I got the call around six, right when the rice was starting to catch on the bottom of the pan. My brother never rings on weeknights, so I turned the burner off and sat on the floor to listen. He talked for twenty minutes about a dog he was thinking of adopting and never mentioned the thing we both knew he had rung to say. Afterwards the rice was ruined and I ate it anyway."
        request("score", ["v": "3.0", "blocks": [["id": "real", "text": text]]]) { result in
            guard let rows = result["results"] as? [[String: Any]], rows.count == 1, rows[0]["bucket"] is NSNumber else { print(result); exit(1) }
            print("Real model through sandboxed XPC → stdio:", result)
            connection.invalidate()
            exit(0)
        }
    }
}
ready()
RunLoop.main.run(until: Date(timeIntervalSinceNow: 120))
exit(2)
`);
  }
  execFileSync("xcrun", ["swiftc", join(temp, "main.swift"), "-o", join(app, "Contents/MacOS/BridgeTest")], { stdio: "inherit" });
  execFileSync("codesign", ["--force", "--sign", "-", service]);
  writeFileSync(join(temp, "sandbox.plist"), '<plist version="1.0"><dict><key>com.apple.security.app-sandbox</key><true/></dict></plist>');
  execFileSync("codesign", ["--force", "--sign", "-", "--entitlements", join(temp, "sandbox.plist"), app]);
  execFileSync(join(app, "Contents/MacOS/BridgeTest"), [], { stdio: "inherit", timeout: realHome ? 150000 : 20000 });

} finally { rmSync(temp, { recursive: true, force: true }); }
