# Install and manage Anagram

[简体中文](user-guide.zh-CN.md) · [File and permission inventory](footprint.md)

Anagram's interface follows the browser language (English or Simplified Chinese).
The local component runs EditLens on your computer. Install it once from the first-run
page; routine use and management then happen in the extension.

Version 0.4.0 is currently prepared locally. A release package's installation command
works only after its matching GitHub release assets have been published. An ordinary
source build displays an unpublished-build notice instead of a usable copy button.

## 1. Install the extension

**ZIP distribution, before the store listing:** extract the Chrome extension ZIP into
a permanent folder. Open `chrome://extensions`, enable Developer mode, select **Load
unpacked**, and select the folder containing `manifest.json`. Do not load the ZIP itself.
Keep that folder in place: moving it can change an unpacked extension's ID and require
registration again. No model or terminal setup is hidden inside the ZIP instructions.

**Chrome Web Store:** when the listing is published, use **Add to Chrome** and approve
the browser's required permissions. Chrome manages the extension's installed files.

Both routes open the same first-run page. No website is granted automatically. Required
permissions are storage, activeTab, contextMenus, scripting and nativeMessaging; site
access is requested separately when you enable a site or all sites.

Firefox uses the Firefox build. During development, `about:debugging` → **This Firefox**
→ **Load Temporary Add-on** can load its `manifest.json`; Firefox removes this temporary
installation on restart. Persistent distribution requires a signed Firefox package.

## 2. Install the local component once

The first-run page detects your OS and browser, explains the download size, and shows
**View installation script** and **Copy installation command**. The command names this
extension version and exact ID. Paste it into Terminal on macOS/Linux, or PowerShell on
Windows. No administrator account or system Python is required.

The installer puts a private runtime and application in the component folder and registers
the browser host. Keep the first-run page open: it retries the connection. Once installation
finishes, the terminal can be closed. The extension then shows model download progress,
bytes received and Pause/Resume controls. Existing verified files are reused. All model
variants total about **4.07 GB**; runtime dependencies and temporary downloads need extra
space. No Hugging Face login is needed. The original model's **CC BY-NC-SA 4.0** license,
attribution and noncommercial terms still apply.

## 3. Compare and choose

After download, setup runs a benchmark. Its default **30 seconds is the total inference
measurement budget**, not the total wall-clock time: model loading and warmup are separate
visible stages and can take longer. Tests use built-in sample text, not your open pages.

Compare available device/runtime/precision combinations by single-text latency, batch
throughput and sampled process/accelerator memory. Missing memory measurements display as
unavailable. Recommendations use FP32; FP16 is optional and INT8 carries an experimental
accuracy warning. Click **Use selected configuration** to begin inference. Selection is
explicit and saved locally. Grant a website or use a one-off Analyze action to try it.

## 4. Daily use and restart

Opening the browser and using Anagram starts the registered component automatically.
No terminal, manual server start or login service is needed. A valid saved runtime choice
is reused without repeating the benchmark. An intentional Stop or Pause remains in effect;
use **Start engine** or **Resume download** in Settings to continue.

Settings also lets you switch configuration, rerun/cancel the benchmark, stop inference,
delete model files and download them again. Deleting models does not automatically
redownload them on the next browser launch. One component directory currently has one
active native host owner: another browser/profile must wait until the owning browser
disconnects, instead of loading a duplicate model into memory.

## 5. Upgrade

For a ZIP installation, replace files in the **same extracted folder** with the new
extension package, then press Reload on `chrome://extensions`. Store installations use
Chrome's update system; an update waiting for the persistent native connection can be
applied with the extension's reload action or by restarting Chrome.

Use **Update local component** in Settings for the native application. Model files and
the saved choice are reused when compatible; changed model/hardware information can require
a fresh comparison. A failed update shows an error. Windows may show a separate maintenance
window; wait for its actual result rather than treating its launch as success.

## 6. Remove models or uninstall

**Delete model files** frees weights and partial downloads while retaining the application.
**Uninstall Anagram completely** asks for confirmation, cleans the owned component and
native registration, then removes the extension after verified completion on macOS/Linux.
On Windows, watch the cleanup window and remove the extension after it confirms success.
Cancelling the confirmation changes nothing.

The browser's ordinary Remove button deletes extension settings/cache but cannot invoke
native cleanup. If used first, the component and models remain. Reinstall the same extension
to reach its cleanup controls, or use the installed component's manual uninstall command.
Delete your downloaded ZIP and unpacked extension folder yourself if no longer needed.

## Where files live

| Location | Contents |
| --- | --- |
| Your chosen ZIP extraction folder | Unpacked extension code; needed for developer-mode use |
| Browser profile | Extension package for store installs, settings and hashed verdict cache |
| macOS/Linux: `~/.anagram` | Private Python/packages, application/launcher, model weights, partial downloads, runtime selection/benchmark data, component state and registration records |
| Windows: `%LOCALAPPDATA%\Anagram` | The same local component files, plus Windows launch/maintenance helpers |
| Browser NativeMessagingHosts directory or Windows HKCU registration | Small pointer authorizing this extension to launch the component |

Exact registration paths are in [footprint](footprint.md). Installation and maintenance can
also create OS temporary files; browser/OS logs, backups, ZIPs and user-chosen source folders
are outside the complete-uninstall cleanup promise. Browsing text is not persisted.

Initial native installer targets are Apple Silicon macOS, supported Linux x64/ARM64 and
Windows x64. Windows ARM64, custom Chrome profile paths and other Chromium-based browsers
need additional support. The Windows implementation needs execution on Windows in CI and
manual release testing; testing on macOS alone does not establish Windows support.
