# Verifying Anagram's network behavior

**Anagram scores text on your computer. It does not send passages or scores to a
remote inference service.** That is different from saying that it never connects
to the internet. Reading a document can require fetching its original source;
installing, downloading models and explicitly updating the component also use
the network. The original website and the browser have their own network activity.

**中文说明：** Anagram 在本机评分，不把待分析的段落或结果上传到远程推理服务。
“本地评分”不等于“绝不联网”：首次安装、模型下载、主动更新，以及重新读取用户打开的
PDF / Google Docs 原文可能联网。网页本身和浏览器的联网也不由 Anagram 控制。
下面按用途列出例外和验证办法，不要求只凭隐私声明相信这些承诺。

## Network inventory

| Action | Connection and data | When it happens |
| --- | --- | --- |
| Paragraph, selection, pasted-text and PDF scoring | Browser Native Messaging to the fixed local host `dev.coderbak.anagram`; paragraph IDs and text, not the source URL or cookies. This is a local process pipe, with no HTTP listening port. | During analysis, using installed model files. There is no remote scoring fallback. |
| Ordinary webpage reading | Reads the authorized document's existing DOM. The website may independently load images, scripts, ads or other resources. | On pages the user permits or invokes a one-off action on. Anagram does not make the whole browser offline. |
| Google Docs reading mode | Fetches the open document's `docs.google.com/document/d/…/mobilebasic` view with same-origin credentials. Rendering its sanitized content can also load images and resources referenced by the document's own styles. | Opening or refreshing that document's reading mode. These are original-document resources, not Anagram analytics. DOMPurify is not a network filter. |
| Online PDF reading | May GET the exact PDF source again, with normal browser credentials and cache behavior. A cache miss or revalidation can reach the original server. | Opening an authorized PDF in the reader. A source request can disclose its URL, request headers and ordinary cookies to that source; it is not a scoring upload. |
| Local PDF reading | Reads a user-chosen file, or the authorized local `file:///` document. No native arbitrary-file-read command is involved. | On a file selection or authorized local-PDF action. File-access permission does not upload the file. |
| Model preparation | Anonymous HTTPS GETs to pinned files in `huggingface.co/CoderBak/editlens_roberta_modelkit`, potentially redirected to Hugging Face's file CDN; the small language model comes from `dl.fbaipublicfiles.com`. | Initial setup, an explicitly resumed download, or a user-selected additional model profile. Valid installed files are reused. |
| Component installation and requested update | GitHub release assets for Anagram and pinned uv; managed Python distribution and locked Python package downloads. The checked-in Python lock currently uses `pypi.org` and `files.pythonhosted.org`. Distribution redirects/CDNs may use other hosts. | The installation command or the component's Update action. Python packages are installed using `uv sync --frozen`; inference does not run a package installer. |
| Browser extension update | Browser/store-managed update traffic, governed by browser settings and the distribution channel. | Outside the extension's model-inference transport. The native version notice compares local component and extension versions without querying GitHub. |
| External links | Normal browser navigation to a source document, repository, help page or PDF hyperlink. | When the user follows the link. Such navigation is not a promise that the destination website has no tracking. |

Download hosts see ordinary request metadata such as the public IP address, requested
artifact, time, user agent and resumed byte range. Model requests use no Hugging Face
account token, browser cookies or request body. Download paths come from shipped pins;
the extension cannot pass an arbitrary model URL through the component control API.
The model downloader rejects non-HTTPS redirects and checks file size and SHA-256.
It does **not** implement a complete CDN hostname allowlist or an OS firewall.

Anagram has no analytics, remote error-reporting or telemetry endpoint. Inference forces
Hugging Face offline/telemetry-disabled settings, uses `local_files_only=True` and
`trust_remote_code=False`, and disables ONNX Runtime telemetry before its sessions/probes.
The PDF viewer, workers, language resources, fonts, CMaps and image decoders ship locally;
PDF document scripting is disabled. Installing or updating the native component deliberately
installs executable packages; this should not be confused with a model loading remote code.
The viewer's local document-fingerprint/view-history and preference storage is described in
[PRIVACY.md](../PRIVACY.md); local-only operation does not mean that all state is ephemeral.

## Browser controls and their limits

The manifest keeps executable scripts and workers local. Its connection policy permits
HTTP, HTTPS and file sources because the private PDF loader must be able to read a
user-authorized original document. Ordinary extension pages and the reader add a stricter
`connect-src 'self'` meta policy. The loader uses a separate authorization and a policy
limited to its source origin; a manifest connection permission alone is not authorization
to read a particular document.

The reader receives bytes, rather than letting the generic PDF.js viewer open an arbitrary
URL. Online Chrome PDFs use the current-tab relay; the isolated loader handles the routes
that need an extension-origin read. A one-use source ticket is tied to the reader/tab and
checked against current access. Local source URLs must identify a local file, not a remote
file-server hostname. See [footprint](footprint.md) for the concrete modules and permissions.
An OS-mounted network drive can still be reached through a local-looking file path;
that filesystem traffic is outside the browser URL check. Use a file stored on the
computer's own disk for the offline verification below.

Content scripts and DOM inserted into websites are subject to the web document's context,
not an extension-wide promise to block every webpage request. **Browser CSP does not
sandbox the native Python process.** The component has the user's ordinary OS privileges.
Offline library options and fixed operations reduce its network surface, but OS-level
outbound restrictions are a separate, stronger control.

## A repeatable offline check

1. Finish installing the component and the selected model profile while online. Wait for
   a successful local configuration choice. Record the extension/component versions and
   the selected runtime; no model download or update should still be pending.
2. Open a webpage you are allowed to analyze, or use Analyze text. For the PDF check,
   prepare a local PDF. Keep the content available before disconnecting; an online PDF
   or Google Doc that must be fetched again cannot be assumed available offline.
3. Disconnect the computer from all networks, not just the tab's DevTools network switch.
   That switch does not block a native process. If testing only native egress with a
   firewall, target the installed private Python executable and any child processes,
   not just the browser or the small native launcher.
4. Analyze a new supported-English passage long enough to score (at least 50 words).
   Use text not previously scored, or clear cached verdicts first. Confirm a new verdict
   and its model identity; merely displaying an old cached score does not test inference.
5. Open the local PDF and analyze its text. Repeating after an idle unload also exercises
   reloading the installed weights. Do not request an additional model profile or update
   during this test: those operations are intentionally online.

This demonstrates that these tested workflows do not *require* internet access. It does
not by itself prove that a program never attempts a connection, or that a different
release behaves identically. Record the exact release and exercise each workflow you
care about. Failed connection attempts still matter when auditing behavior.

## Observe requests separately from proving offline operation

- Inspect the extension background worker and reader/loader with browser developer tools,
  preserving the network log. Packaged `chrome-extension:` / `moz-extension:` resources
  and local `file:` reads are not internet requests. Also inspect the source webpage:
  Google Docs and Chrome's PDF relay requests occur there, not in the background worker.
- Use a trusted OS-level network monitor or outbound firewall to observe the component's
  private Python, installer, uv and their child processes. Browser DevTools cannot see
  their requests. A machine-wide capture includes unrelated browser/OS traffic; attribute
  requests to a process and test action before concluding they came from Anagram.
- Compare phases: setup/download, idle, fresh inference, original-document loading, and
  explicit update. For inference/idle there should be no Anagram-initiated external request.
  Document loading and setup have the exceptions in the table above.
- HTTPS inspection without decrypting TLS normally shows destinations/timing, not request
  bodies. Inspect the source/payload boundaries too. HARs and diagnostic captures may
  contain original document URLs or cookies; review them locally before sharing.

No single screenshot of an empty Network panel proves a negative. For an enforceable
post-setup guarantee, the user can deny outbound access to the native runtime at the OS
boundary and retain only the browser access needed for their original documents. Anagram
does not install or change firewall rules for the user.

## Reproduce the source checks

From the extension source tree, with development dependencies already installed:

```sh
python3 test/network-privacy.py
npm run test:node -- test/node/networkPrivacy.test.ts test/node/nativeOnly.test.ts test/node/footprint.test.ts
```

The Python checks inspect our inference source without importing model libraries: online
environment values are overridden, each Transformers loader is explicitly local and
refuses remote code, and inference modules do not directly import network clients.
The Node checks cover the minimal scoring payload, no HTTP fallback, and the documented
source inventory. Existing modelkit tests use fake download responses to check anonymous
requests, pins, resumable downloads and integrity; no real weights are needed.

These are regression checks, not a proof covering arbitrary dynamic code or every
transitive dependency. The footprint scanner covers named APIs and URL literals in
`lib/` and `entrypoints/`, not all native or vendored code and not every declarative
resource a document could load. Review the release's packaged viewer and native code,
`package-lock.json`, `anagramd/uv.lock`, and `anagramd/modelkit.json` as well. Published
SHA-256 sums detect differing bytes against a trusted expected sum; a checksum fetched
beside an artifact is not an independent signature of its publisher.

Review builds and test fixtures separately from a shipped extension: developer tools may
download browser binaries or dependencies, and test harnesses can use local web servers.
Those are not production inference transports. A reproducible report should name the
source revision, package checksum, operating system, browser, workflow, capture method
and observed destinations, including unexpected attempts rather than only successes.
