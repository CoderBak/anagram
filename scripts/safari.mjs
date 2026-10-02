// Generate a macOS app wrapper. Never opens Xcode/Safari, signs, installs or publishes.
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import JSON5 from "json5";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Packager versions disagree on identifier capitalization. Set both targets explicitly. */
export function setBundleIdentifiers(project, identifier) {
  const modern = join(project, "project.xcproj");
  if (existsSync(modern)) {
    const value = JSON5.parse(readFileSync(modern, "utf8"));
    const app = value.targets.find((target) => target["product-type"] === "application");
    const extension = value.targets.find((target) => target["product-type"] === "app-extension");
    if (!app || !extension) throw new Error("Safari project is missing an app or extension target");
    app["build-settings"].PRODUCT_BUNDLE_IDENTIFIER = identifier;
    extension["build-settings"].PRODUCT_BUNDLE_IDENTIFIER = `${identifier}.Extension`;
    writeFileSync(modern, JSON.stringify(value, null, 2) + "\n");
  } else {
    const path = join(project, "project.pbxproj");
    const value = JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", path], { encoding: "utf8" }));
    const targets = Object.values(value.objects).filter((object) => object.isa === "PBXNativeTarget");
    for (const [type, suffix] of [["com.apple.product-type.application", ""], ["com.apple.product-type.app-extension", ".Extension"]]) {
      const target = targets.find((target) => target.productType === type);
      if (!target) throw new Error(`Safari project is missing ${type}`);
      for (const config of value.objects[target.buildConfigurationList].buildConfigurations) {
        value.objects[config].buildSettings.PRODUCT_BUNDLE_IDENTIFIER = identifier + suffix;
      }
    }
    writeFileSync(path, JSON.stringify(value));
    execFileSync("plutil", ["-convert", "xml1", path]);
  }
  const controller = join(dirname(project), "Anagram/ViewController.swift");
  const source = readFileSync(controller, "utf8");
  if (!/let extensionBundleIdentifier = "[^"]*"/.test(source)) throw new Error("Safari app template has no extension identifier");
  writeFileSync(controller, source.replace(/let extensionBundleIdentifier = "[^"]*"/,
    `let extensionBundleIdentifier = "${identifier}.Extension"`));
}

export function createSafariProject(destination, identifier = "dev.coderbak.Anagram") {
  if (process.platform !== "darwin") throw new Error("Safari's macOS app wrapper requires Xcode on a Mac. The web build and ZIP can be produced on other systems.");
  if (existsSync(destination)) throw new Error(`Preserving existing Xcode files at ${destination}. Choose a new --output directory; existing signing settings are never overwritten.`);
  const resources = join(root, "output", "safari-mv3");
  if (!existsSync(join(resources, "manifest.json"))) throw new Error("Run npm run build:safari first.");
  const manifest = JSON.parse(readFileSync(join(resources, "manifest.json"), "utf8"));
  if (manifest.manifest_version !== 3 || manifest.name !== "Anagram for Safari" || manifest.host_permissions?.length ||
      manifest.permissions?.includes("offscreen") || !manifest.permissions?.includes("nativeMessaging")) {
    throw new Error("Refusing to package a non-shipping Safari manifest.");
  }

  // Xcode renamed the converter to the packager. Support both names without changing
  // the selected Xcode installation or accepting licence prompts on the person's behalf.
  let tool;
  const lookupErrors = [];
  for (const name of ["safari-web-extension-packager", "safari-web-extension-converter"]) {
    const lookup = spawnSync("xcrun", ["--find", name], { encoding: "utf8" });
    if (lookup.status === 0) { tool = name; break; }
    const detail = lookup.error?.message || lookup.stderr?.trim() || lookup.stdout?.trim() || `exit ${lookup.status ?? lookup.signal}`;
    lookupErrors.push(`${name}: ${detail}`);
  }
  if (!tool) throw new Error(`Safari's web extension packager could not be located. Resolve the Xcode error below, then run this command again.\n${lookupErrors.join("\n")}`);
  const result = spawnSync("xcrun", [tool, resources,
    "--project-location", destination, "--app-name", "Anagram", "--bundle-identifier", identifier,
    "--macos-only", "--swift", "--copy-resources", "--no-open", "--no-prompt",
  ], { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Safari packaging failed (${result.status ?? result.signal}). Review the packager's output above.`);
  const project = join(destination, "Anagram", "Anagram.xcodeproj");
  if (!existsSync(project)) throw new Error(`The packager did not create ${project}`);
  setBundleIdentifiers(project, identifier);
  copyFileSync(join(root, "native/safari/SafariWebExtensionHandler.swift"),
    join(destination, "Anagram/Anagram Extension/SafariWebExtensionHandler.swift"));
  return project;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let destination = join(root, "dist", "safari");
  let identifier = "dev.coderbak.Anagram";
  for (let i = 0; i < args.length; i++) {
    const value = args[i + 1];
    if (args[i] === "--output" && value && !value.startsWith("--")) { destination = resolve(value); i++; }
    else if (args[i] === "--bundle-identifier" && value && /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(value)) { identifier = value; i++; }
    else throw new Error("Usage: node scripts/safari.mjs [--output <new directory>] [--bundle-identifier <reverse.dns.id>]");
  }
  createSafariProject(destination, identifier);
  console.log(`macOS Xcode project created under ${destination}. It has not been signed, installed or launched.`);
  console.log("This project runs the browser engine. Use npm run build:safari:app to also embed the optional native engine bridge.");
}
