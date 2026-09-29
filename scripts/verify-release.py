"""Inspect packaged extension ZIPs, not a source or test-build manifest."""
import argparse
import json
import re
import zipfile
from pathlib import Path

BASE = {"storage", "activeTab", "contextMenus", "scripting", "unlimitedStorage", "webNavigation", "webRequest"}
OPTIONAL = {"https://*/*", "http://*/*", "file:///*"}
# The in-browser engine (scripts/webengine.mjs), all of vendor/engine/: ONNX Runtime
# Web's JSPI build, which runs both the GPU and the CPU path, with its licence and notices,
# the engine's worker and the language identifier it reads from the package. Its model
# download needs no host permission.
ENGINE_FILES = {"vendor/engine/ort.jspi.min.mjs", "vendor/engine/ort-wasm-simd-threaded.jspi.mjs",
                "vendor/engine/ort-wasm-simd-threaded.jspi.wasm", "vendor/engine/LICENSE.onnxruntime-web",
                "vendor/engine/ThirdPartyNotices.onnxruntime-web.txt", "vendor/engine/worker.min.mjs",
                "vendor/engine/lid.176.ftz"}


def required(manifest_version):
    """Both engines: the in-browser one's offscreen document (Chrome) and storage. Native
    Messaging, for the local engine, is optional: asked for when the person picks it."""
    return BASE | ({"offscreen"} if manifest_version == 3 else set())


def verify(path):
    with zipfile.ZipFile(path) as archive:
        names = set(archive.namelist())
        manifest = json.loads(archive.read("manifest.json"))
        assert not manifest.get("host_permissions"), "Required website grants must be absent"
        assert not manifest.get("content_scripts"), "Shipping package must use permission-based registration"
        permissions = set(manifest["permissions"])
        assert permissions == required(manifest["manifest_version"]), f"Unexpected required permissions: {permissions}"
        if manifest["manifest_version"] == 3:
            assert set(manifest.get("optional_host_permissions", [])) == OPTIONAL, "Unexpected optional hosts"
            assert manifest.get("optional_permissions") == ["nativeMessaging"], "Unexpected optional permissions"
            assert manifest.get("minimum_chrome_version") == "137", "The in-browser engine needs Chrome 137 (JSPI)"
            assert manifest.get("cross_origin_embedder_policy") == {"value": "require-corp"}, "Extension pages must be cross-origin isolated"
            assert manifest.get("cross_origin_opener_policy") == {"value": "same-origin"}, "Extension pages must be cross-origin isolated"
        else:
            assert set(manifest.get("optional_permissions", [])) == OPTIONAL | {"clipboardWrite", "nativeMessaging"}, "Unexpected optional permissions"
            gecko = manifest["browser_specific_settings"]["gecko"]
            # The ID the local engine's installer registers (installer/native_registration.py).
            assert gecko["id"] == "anagram@coderbak.dev" and gecko["strict_min_version"] == "153.0", f"Unexpected Firefox ID or minimum: {gecko}"
        csp = manifest["content_security_policy"]
        if isinstance(csp, dict): csp = csp["extension_pages"]
        assert "connect-src 'self'" in csp
        assert "'unsafe-eval'" not in csp
        for page in ("popup.html", "options.html", "onboarding.html", "reader.html", "paste.html"):
            assert page in names, f"Missing page: {page}"
            html = archive.read(page).decode()
            assert re.search(r'<meta[^>]+http-equiv=["\']Content-Security-Policy["\'][^>]+content="connect-src \'self\'"', html, re.I), f"UI network restriction missing: {page}"
        assert "pdf-loader.html" in names, "Isolated PDF source loader missing"
        for entry in manifest.get("web_accessible_resources", []):
            resources = entry.get("resources", []) if isinstance(entry, dict) else [entry]
            assert "pdf-loader.html" not in resources and "reader.html" not in resources, "Private PDF pages must not be web accessible"
        for name in names:
            assert not name.startswith("/") and ".." not in Path(name).parts, f"Unsafe ZIP path: {name}"
            if name.endswith(".html"):
                html = archive.read(name).decode()
                for source in re.findall(r'<script\b[^>]*\bsrc=["\']([^"\']+)', html, re.I):
                    assert not re.match(r"(?:[a-z]+:)?//", source, re.I), f"Remote executable asset: {source}"
                    relative = (Path(name).parent / source).as_posix() if not source.startswith("/") else source[1:]
                    assert relative in names, f"Unpackaged script: {relative}"
        assert any(name.endswith(".wasm") for name in names), "Packaged PDF WASM decoders missing"
        engine = {name for name in names if name.startswith("vendor/engine/")}
        assert engine == ENGINE_FILES, f"In-browser engine files: missing {sorted(ENGINE_FILES - engine)}, unexpected {sorted(engine - ENGINE_FILES)}"
        assert ("engine.html" in names) == (manifest["manifest_version"] == 3), "The offscreen document is Chrome's only"
        # The test build's stand-in device is never in a package.
        assert "test-device.json" not in names, "A test device in the package"
        for notice in ("LICENSE", "THIRD_PARTY_NOTICES.md"):
            assert notice in names, f"Missing {notice}"
    print(f"PASS {path.name}: permissions, both engines, pages, CSP and executable assets")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archives", nargs="+", type=Path)
    arguments = parser.parse_args()
    for path in arguments.archives:
        verify(path)
