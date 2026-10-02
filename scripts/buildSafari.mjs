import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, realpathSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createSafariProject } from "./safari.mjs";

if (process.platform !== "darwin") throw new Error("Safari builds require macOS and Xcode.");
const root = resolve(import.meta.dirname, "..");
const engineHome = process.env.ANAGRAM_SAFARI_HOME ? realpathSync(process.env.ANAGRAM_SAFARI_HOME) : null;
const appName = "Anagram";
const version = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version;
const team = process.env.ANAGRAM_APPLE_TEAM;
const signingIdentity = process.env.ANAGRAM_SIGNING_IDENTITY ?? (team ? "Apple Development" : "-");
if (team && !/^[A-Z0-9]{10}$/.test(team)) throw new Error("Invalid Apple team ID");
const bundleId = `dev.coderbak.${appName}`;
const run = (command, args) => execFileSync(command, args, { cwd: root, stdio: "inherit" });
mkdirSync(resolve(root, "output"), { recursive: true });
// Preserve existing projects, signing settings and installed copies.
const workspace = mkdtempSync(resolve(root, "output/safari-app-"));
const projectRoot = resolve(workspace, "project");
// Leave Xcode's project format alone: both project.pbxproj and project.xcproj work.
const project = createSafariProject(projectRoot, bundleId);
const derived = resolve(projectRoot, "build");
const archive = resolve(projectRoot, "Anagram.xcarchive");
run("xcodebuild", ["-project", project, "-scheme", appName, "-configuration", "Debug",
  "-derivedDataPath", derived, "-destination", "platform=macOS",
  "-archivePath", archive, "archive", `CODE_SIGN_IDENTITY=${signingIdentity}`,
  ...(team ? ["CODE_SIGN_STYLE=Automatic", `DEVELOPMENT_TEAM=${team}`] : ["CODE_SIGN_STYLE=Manual"]),
  `MARKETING_VERSION=${version}`, "MACOSX_DEPLOYMENT_TARGET=14.0"]);
const app = resolve(archive, `Products/Applications/${appName}.app`);
const appex = resolve(app, `Contents/PlugIns/${appName} Extension.appex`);
const service = resolve(appex, "Contents/XPCServices/Scoring.xpc");
mkdirSync(resolve(service, "Contents/MacOS"), { recursive: true });
writeFileSync(resolve(service, "Contents/Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>dev.coderbak.Anagram.Scoring</string>
<key>CFBundleExecutable</key><string>Scoring</string>
<key>CFBundlePackageType</key><string>XPC!</string>
<key>CFBundleVersion</key><string>1</string>
<key>XPCService</key><dict><key>ServiceType</key><string>Application</string></dict>
</dict></plist>
`);
if (engineHome) {
  for (const bundle of [service, appex]) {
    run("plutil", ["-insert", "AnagramHome", "-string", engineHome, resolve(bundle, "Contents/Info.plist")]);
  }
}
// The bridge is universal even when archiving on an Apple Silicon development Mac.
const slices = ["arm64", "x86_64"].map((arch) => {
  const binary = resolve(workspace, `Scoring-${arch}`);
  run("xcrun", ["swiftc", "native/safari/ScoringService.swift", "native/safari/main.swift",
    "-target", `${arch}-apple-macos14.0`, "-module-cache-path", resolve(workspace, "module-cache"), "-o", binary]);
  return binary;
});
run("xcrun", ["lipo", "-create", ...slices, "-output", resolve(service, "Contents/MacOS/Scoring")]);
run("codesign", ["--force", "--sign", signingIdentity, "--options", "runtime", service]);
run("codesign", ["--force", "--sign", signingIdentity, "--preserve-metadata=entitlements,flags,runtime", appex]);
run("codesign", ["--force", "--sign", signingIdentity, "--preserve-metadata=entitlements,flags,runtime", app]);
run("codesign", ["--verify", "--deep", "--strict", app]);
console.log(`Local Safari app (not installed): ${app}`);
console.log(`Xcode project: ${project}`);
console.log("Open the app above to enable it in Safari. Re-run this command after changes; an Xcode Run alone does not embed the native XPC bridge.");
