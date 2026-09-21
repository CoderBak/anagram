# Install and manage Anagram

[简体中文](user-guide.zh-CN.md) · [File and permission inventory](footprint.md)

Anagram's interface follows the browser language (English or Simplified Chinese).
The local component runs EditLens on your computer. Install it once from the first-run
page; routine use and management then happen in the extension.

Download the browser package from the [0.5.0 release](https://github.com/CoderBak/anagram/releases/tag/v0.5.0).
Release packages use the matching published installer and native component. An ordinary
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
permissions are storage, activeTab, contextMenus, scripting, nativeMessaging,
webNavigation and webRequest; the latter two recognize authorized PDF documents.
Website and local-file access are optional and requested separately.

Firefox uses the Firefox build. During development, `about:debugging` → **This Firefox**
→ **Load Temporary Add-on** can load its `manifest.json`; Firefox removes this temporary
installation on restart. Persistent distribution requires a signed Firefox package.

A one-off Analyze action applies to the current document. Reloading or navigating to a new document ends that run, even on the same site; changing history within the same document does not. Site permission withdrawal also stops affected embedded frames immediately.

## 2. Install the local component once

The first-run page detects your OS and browser, explains the download size, and shows
**View installation script** and **Copy installation command**. The command names this
extension version and exact ID. Paste it into Terminal on macOS/Linux, or PowerShell on
Windows. No administrator account or system Python is required.

The installer puts a private runtime and application in the component folder and registers
the browser host. Keep the first-run page open: it retries the connection. Once installation
finishes, the terminal can be closed. The component detects usable devices before choosing
files. A working Torch GPU uses shared safetensors for CPU FP32 and GPU FP32/FP16; CPU-only
systems use ONNX Runtime FP32 when available, otherwise Torch FP32. The recommended set
usually totals **1.43 GB**, including language detection; runtime dependencies and temporary
space are additional. Settings lists detected devices, files and the exact plan size.
Preparation progress includes verified existing files, so it is not network traffic.
Detection starts without a known total; verification and downloading are separate phases.
Pause/Resume remains available and takes effect after the current operation finishes.
No Hugging Face login is needed. The original model's **CC BY-NC-SA 4.0** license,
attribution and noncommercial terms still apply.

## 3. Compare and choose

**Download expanded comparison models** is an explicit optional action in Settings. It
adds compatible runtimes and experimental CPU INT8; the displayed expanded size is the
whole set, with verified files reused. CPU ONNX FP16, CoreML and MLX are not included.
**Rescan devices and prepare recommended models** detects hardware again and changes the
preparation plan without deleting existing extras. Use it after attaching a GPU or changing
local runtimes. **Delete model files** removes all model files when you want to reclaim space.
Pausing and resuming keeps the chosen preparation profile across restarts.

After download, setup runs a benchmark. Its default **30 seconds is the total inference
measurement budget**, not the total wall-clock time: model loading and warmup are separate
visible stages and can take longer. Tests use built-in sample text, not your open pages.

Compare available device/runtime/precision combinations by single-text latency, batch
throughput and sampled process/accelerator memory. Missing memory measurements display as
unavailable. Each configuration runs in its own process; sample counts and low-sample
warnings help interpret short tests. Process RAM and Apple GPU driver memory overlap
and must not be added. The fastest measured option has its own label. Recommendations use FP32; FP16 is optional and INT8 carries an experimental
accuracy warning. Click **Use selected configuration** to begin inference. Selection is
explicit and saved locally. Grant a website or use a one-off Analyze action to try it.

## 4. Daily use and restart

Opening the browser and using Anagram starts the registered component automatically.
No terminal, manual server start or login service is needed. A valid saved runtime choice
is reused without repeating the benchmark. An intentional Stop or Pause remains in effect;
use **Start engine** or **Resume download** in Settings to continue.

After five minutes without scoring, the model unloads by default and reloads on the
next request. Settings can change or disable this idle timeout. Merely opening Settings
does not keep a model in memory. This differs from an explicit Stop.

Settings also lets you switch configuration, rerun/cancel the benchmark, stop inference,
delete model files and download them again. Deleting models does not automatically
redownload them on the next browser launch. One component directory currently has one
active native host owner: another browser/profile must wait until the owning browser
disconnects, instead of loading a duplicate model into memory.

## Read PDFs and check network privacy

The reader uses the packaged Mozilla PDF.js viewer, with Anagram analysis on the original
document. You can choose or drop a local PDF without granting access to all local files.
To open a PDF already in a `file:///` tab, grant local-file access in Anagram and enable
the browser's file-access control when required (Chrome: **Allow access to file URLs**).
Revoking either access keeps the file-picker route available.

With **Open PDFs in Anagram** enabled, automatic opening requires persistent access to
that source. Chrome can relay an online PDF from its current tab; Firefox and local-file
routes use an isolated loader for the authorized original document. An ungranted source
is not automatically read. Protected documents, redirecting URLs, POST-only responses,
oversized files and browser-specific restrictions can still prevent a handoff; choose
the local file when necessary. The browser/version cases are listed in the
[manual checks](manual-checks.md), rather than assumed universally supported.

Scoring runs locally, but original PDF/Google Docs reads, installation, model downloads
and requested updates may use the network. Settings includes a privacy explanation and
a short offline check. After setup, disconnect the computer and score a new passage or
local PDF; a cached result alone is not evidence of fresh offline inference.
[Network verification](network-privacy.md) explains the exceptions, source checks and
separate browser/native traffic monitoring.

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
