import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync, realpathSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

if (process.platform !== "darwin") throw new Error("Safari builds require macOS and Xcode.");
const root = resolve(import.meta.dirname, "..");
const engineHome = process.env.ANAGRAM_SAFARI_HOME ? realpathSync(process.env.ANAGRAM_SAFARI_HOME) : null;
const appName = "Anagram";
const displayName = "Anagram";
const team = process.env.ANAGRAM_APPLE_TEAM;
const signingIdentity = process.env.ANAGRAM_SIGNING_IDENTITY ?? (team ? "Apple Development" : "-");
if (team && !/^[A-Z0-9]{10}$/.test(team)) throw new Error("Invalid Apple team ID");
const bundleId = `dev.coderbak.${appName}`;
const run = (command, args) => execFileSync(command, args, { cwd: root, stdio: "inherit" });
run("node", ["scripts/vendor.mjs"]);
run("npx", ["wxt", "build", "-b", "safari", "--mv3"]);
const extension = resolve(root, "output/safari-mv3");
if (!existsSync(resolve(extension, "manifest.json"))) throw new Error("Safari manifest missing");
mkdirSync(resolve(root, "output"), { recursive: true });
// Preserve existing projects, signing settings and installed copies.
const projectRoot = mkdtempSync(resolve(root, "output/safari-project-"));
run("xcrun", ["safari-web-extension-converter", extension,
  "--project-location", projectRoot, "--app-name", appName,
  "--bundle-identifier", bundleId, "--macos-only", "--swift",
  "--copy-resources", "--no-open", "--no-prompt"]);
const project = resolve(projectRoot, `${appName}/${appName}.xcodeproj`);
if (!existsSync(project)) throw new Error(`Converter did not create ${project}`);
const pbx = resolve(project, "project.pbxproj");
writeFileSync(pbx, readFileSync(pbx, "utf8").replaceAll(
  /INFOPLIST_KEY_CFBundleDisplayName = [^;]+;/g,
  `INFOPLIST_KEY_CFBundleDisplayName = "${displayName}";`));
copyFileSync(resolve(root, "native/safari/SafariWebExtensionHandler.swift"),
  resolve(projectRoot, `${appName}/${appName} Extension/SafariWebExtensionHandler.swift`));
const derived = resolve(projectRoot, "build");
const archive = resolve(projectRoot, "Anagram.xcarchive");
run("xcodebuild", ["-project", project, "-scheme", appName, "-configuration", "Debug",
  "-derivedDataPath", derived, "-destination", "platform=macOS",
  "-archivePath", archive, "archive", `CODE_SIGN_IDENTITY=${team ? "Apple Development" : signingIdentity}`,
  ...(team ? ["CODE_SIGN_STYLE=Automatic", `DEVELOPMENT_TEAM=${team}`, "-allowProvisioningUpdates"] : ["CODE_SIGN_STYLE=Manual"]),
  "MACOSX_DEPLOYMENT_TARGET=13.0"]);
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
if (engineHome) run("/usr/libexec/PlistBuddy", ["-c", `Add :AnagramHome string ${engineHome}`, resolve(service, "Contents/Info.plist")]);
run("xcrun", ["swiftc", "native/safari/ScoringService.swift", "native/safari/main.swift",
  "-o", resolve(service, "Contents/MacOS/Scoring")]);
run("codesign", ["--force", "--sign", signingIdentity, "--options", "runtime", service]);
run("codesign", ["--force", "--sign", signingIdentity, "--preserve-metadata=entitlements,flags,runtime", appex]);
run("codesign", ["--force", "--sign", signingIdentity, "--preserve-metadata=entitlements,flags,runtime", app]);
run("codesign", ["--verify", "--deep", "--strict", app]);
console.log(`Local Safari app (not installed): ${app}`);
console.log(`Xcode project: ${project}`);
