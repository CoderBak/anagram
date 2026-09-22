// A real browser -> real native stdio pipe, with deterministic test-only component
// replies. Production Native Messaging registrations and the user's HOME are untouched.
import assert from "node:assert/strict";
import { blockNativeHostInProfile } from "./native-test-host.mjs";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { uiLanguage } from "./harness.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = join(ROOT, "output/chrome-mv3");
const manifest = JSON.parse(readFileSync(join(EXT, "manifest.json"), "utf8"));
assert.ok(manifest.permissions.includes("nativeMessaging"));
assert.equal(manifest.host_permissions, undefined);
assert.equal(manifest.options_ui.open_in_tab, true, "Lifecycle controls must open in a trusted top-level page");
if (process.platform === "win32") throw new Error("This isolated stdio launcher fixture requires POSIX; use Windows launcher CI for Windows");
const artifacts = process.env.ANAGRAM_ARTIFACTS ?? join(ROOT, "test-results/native");
mkdirSync(artifacts, { recursive: true });
const quote = (text) => "'" + text.replaceAll("'", "'\\''") + "'";

for (const language of ["en", "zh-CN"]) {
  const temp = mkdtempSync(join(tmpdir(), "anagram-native-browser-"));
  const profile = join(temp, "profile");
  const stateFile = join(temp, "state.json");
  const logFile = join(temp, "requests.jsonl");
  const script = join(temp, "host.py");
  const launcher = join(temp, "host");
  let state = { schema_version: 1, version: manifest.version, home: join(temp, "component"),
    state: "downloading", runtime: null, storage: { models_bytes: 100 }, error: null, operation: null,
    download: { status: "running", bytes_received: 100, total_bytes: 1000, file: "onnx/model.onnx", error: null } };
  const save = () => writeFileSync(stateFile, JSON.stringify(state));
  save();
  writeFileSync(script, `import json, os, struct, sys
from pathlib import Path
state_path, log_path = Path(sys.argv[1]), Path(sys.argv[2])
while True:
    header = sys.stdin.buffer.read(4)
    if not header: break
    size = struct.unpack('=I', header)[0]
    request = json.loads(sys.stdin.buffer.read(size))
    with log_path.open('a') as log: log.write(json.dumps({'pid':os.getpid(), **request}) + '\\n')
    state = json.loads(state_path.read_text())
    op = request['op']
    if op == 'health':
        reply = {'ok':False,'status':503,'error':{'code':'not_ready','message':'Fixture setup'}}
    else:
        if op == 'models.pause': state['state']='paused'; state['download']['status']='paused'
        elif op == 'models.download': state['state']='downloading'; state['download']['status']='running'
        elif op == 'engine.stop': state['state']='stopped'
        elif op == 'engine.resume': state['state']='needs_models'
        elif op == 'models.delete':
            assert request['payload'] == {'confirm':True}
            state.update(state='needs_models',storage={'models_bytes':0},operation={'name':'delete_models','status':'completed','receipt':'test-delete'})
            state['download'].update(status='idle',bytes_received=0)
        elif op == 'component.uninstall':
            assert request['payload'] == {'confirm':True}
            state.update(state='uninstalling',operation={'name':'uninstall','status':'scheduled','receipt':'test-scheduled'})
        state_path.write_text(json.dumps(state))
        reply = {'ok':True,'status':200,'data':state}
    payload=json.dumps({'v':1,'id':request['id'],**reply}).encode()
    sys.stdout.buffer.write(struct.pack('=I',len(payload))+payload); sys.stdout.buffer.flush()
`);
  writeFileSync(launcher, `#!/bin/sh\nexec /usr/bin/env python3 -u ${quote(script)} ${quote(stateFile)} ${quote(logFile)}\n`);
  chmodSync(launcher, 0o700);
  let context;
  try {
    const localized = uiLanguage(language);
    blockNativeHostInProfile(profile);
    context = await chromium.launchPersistentContext(profile, {
      headless: true, channel: "chromium", viewport: { width: 1200, height: 1000 },
      ...localized, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
        "--no-first-run", "--no-default-browser-check", ...(localized.args ?? [])],
    });
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
    const id = new URL(worker.url()).host;
    const actualLanguage = await worker.evaluate(() => chrome.i18n.getUILanguage());
    assert.ok(actualLanguage.toLowerCase().startsWith(language.toLowerCase().split("-")[0]), `Expected ${language}, got ${actualLanguage}`);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`chrome-extension://${id}/onboarding.html`);
    await page.locator("#install-cmd").waitFor();
    const installCommand = await page.locator("#install-cmd").innerText();
    assert.ok(installCommand.includes(`/releases/download/v${manifest.version}/install.sh`));
    assert.ok(installCommand.includes(`ANAGRAM_EXTENSION_ID='${id}'`));
    assert.ok(installCommand.includes(`ANAGRAM_LANG='${language === "en" ? "en" : "zh_CN"}'`));
    await page.locator("#componentSettings").screenshot({ path: join(artifacts, `install-${language}.png`) });
    mkdirSync(join(profile, "NativeMessagingHosts"), { recursive: true });
    writeFileSync(join(profile, "NativeMessagingHosts/dev.coderbak.anagram.json"), JSON.stringify({
      name: "dev.coderbak.anagram", description: "Anagram test fixture only", path: launcher,
      type: "stdio", allowed_origins: [`chrome-extension://${id}/`],
    }));
    const panel = page.locator("#componentSettings");
    await panel.locator("progress").waitFor({ timeout: 20000 });
    assert.equal(await panel.locator("progress").getAttribute("value"), "100");
    // The page only observes: model download intent belongs to the native component.
    const requests = () => readFileSync(logFile, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(requests().filter((r) => r.op === "models.download").length, 0);
    const buttons = async () => panel.getByRole("button").allTextContents();
    console.log(`${language} initial native controls: ${JSON.stringify(await buttons())}`);
    const pause = panel.getByRole("button", { name: language === "en" ? "Pause download" : "暂停下载", exact: true });
    await pause.click();
    const resume = panel.getByRole("button", { name: language === "en" ? "Resume download" : "继续下载", exact: true });
    await resume.waitFor(); await resume.click(); await pause.waitFor();
    // Use the actual browser Settings entry point, not a manually navigated tab.
    const openedSettings = context.waitForEvent("page");
    await worker.evaluate(() => chrome.runtime.openOptionsPage());
    const settings = await openedSettings;
    await settings.waitForURL(`chrome-extension://${id}/options.html`);
    await settings.locator("#componentSettings progress").waitFor();
    assert.equal(new Set(requests().map((r) => r.pid)).size, 1, "Setup and Settings must share a single native process");
    assert.deepEqual(await worker.evaluate(async () => (await chrome.permissions.getAll()).origins ?? []), []);
    console.log(`PASS ${language}: real native framing, shared process, responsive pause/resume, no host grants`);
    await settings.close();
    await page.evaluate(readFileSync(join(ROOT, "node_modules/axe-core/axe.min.js"), "utf8"));
    for (const colorScheme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme });
      await page.waitForFunction((scheme) => document.documentElement.classList.contains("dark") === (scheme === "dark"), colorScheme);
      const violations = await page.evaluate(async () => (await axe.run("#componentSettings", {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
      })).violations.map((v) => ({ id: v.id, targets: v.nodes.map((n) => n.target) })));
      assert.deepEqual(violations, [], `${language} ${colorScheme} component accessibility`);
      await panel.screenshot({ path: join(artifacts, `setup-${language}-${colorScheme}.png`) });
    }
    await page.setViewportSize({ width: 400, height: 1000 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "No whole-page overflow at 400 px");
    await panel.screenshot({ path: join(artifacts, `setup-${language}-narrow.png`) });
    // Move to an idle state to exercise the exact delete confirmation boundary.
    state = JSON.parse(readFileSync(stateFile, "utf8"));
    state.state = "needs_models"; state.download.status = "idle"; save();
    // Destructive actions live behind the Manage fold.
    await panel.locator("#manage > summary").waitFor();
    await panel.locator("#manage > summary").click();
    const remove = panel.getByRole("button", { name: language === "en" ? "Delete model files" : "删除模型文件", exact: true });
    await remove.waitFor(); await remove.click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    assert.equal(requests().filter((r) => r.op === "models.delete").length, 0);
    const cancel = dialog.getByRole("button", { name: language === "en" ? "Cancel" : "取消", exact: true });
    assert.equal(await cancel.evaluate((e) => e === document.activeElement), true, "Cancel gets initial focus");
    await cancel.click();
    assert.equal(requests().filter((r) => r.op === "models.delete").length, 0);
    await remove.click();
    await dialog.getByRole("button", { name: language === "en" ? "Delete model files" : "删除模型文件", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector("dialog[open]"));
    assert.equal(requests().filter((r) => r.op === "models.delete").length, 1);
    await panel.getByRole("button", { name: language === "en" ? "Uninstall Anagram" : "卸载 Anagram", exact: true }).click();
    await dialog.getByRole("button", { name: language === "en" ? "Uninstall Anagram" : "卸载 Anagram", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector("dialog[open]"));
    await page.waitForFunction(() => document.querySelector("#componentSettings")?.textContent?.match(/system window|系统窗口|清理窗口/i));
    assert.equal(await worker.evaluate(() => chrome.runtime.getManifest().version), manifest.version, "Scheduled cleanup must not uninstall the extension");
    assert.deepEqual(errors, []);
    console.log(`PASS ${language}: light/dark/narrow UI, confirmations, scheduled cleanup is not completion`);
    state = JSON.parse(readFileSync(stateFile, "utf8"));
    state.state = "stopped";
    state.operation = { name: "uninstall", status: "completed", receipt: "verified-fixture-receipt" };
    save();
    // A completed host receipt is required before the actual browser removes its
    // temporary extension. No management permission is present in the manifest.
    await page.waitForEvent("close", { timeout: 15000 });
    console.log(`PASS ${language}: confirmed local cleanup triggers real browser self-uninstall`);
  } finally {
    await context?.close();
    rmSync(temp, { recursive: true, force: true });
  }
}
