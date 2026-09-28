"""Inspect packaged extension ZIPs, not a source or test-build manifest."""
import argparse
import json
import re
import zipfile
from pathlib import Path

BASE = {"storage", "activeTab", "contextMenus", "scripting", "webNavigation", "webRequest"}
OPTIONAL = {"https://*/*", "http://*/*", "file:///*"}
# The oneclick flavor's engine (scripts/webengine.mjs): its runtime, its worker and the
# language identifier it reads from the package. Its model download needs no host permission.
ENGINE_FILES = ("vendor/engine/ort.jspi.min.mjs", "vendor/engine/ort-wasm-simd-threaded.jspi.wasm",
                "vendor/engine/worker.min.mjs", "vendor/engine/lid.176.ftz")


def required(flavor, manifest_version):
    """The native flavor talks to the local engine; the oneclick one runs it in the browser."""
    if flavor == "native":
        return BASE | {"nativeMessaging"}
    return BASE | {"unlimitedStorage"} | ({"offscreen"} if manifest_version == 3 else set())


def verify(path, flavor):
    with zipfile.ZipFile(path) as archive:
        names = set(archive.namelist())
        manifest = json.loads(archive.read("manifest.json"))
        assert not manifest.get("host_permissions"), "Required website grants must be absent"
        assert not manifest.get("content_scripts"), "Shipping package must use permission-based registration"
        permissions = set(manifest["permissions"])
        assert permissions == required(flavor, manifest["manifest_version"]), f"Unexpected required permissions: {permissions}"
        optional_key = "optional_host_permissions" if manifest["manifest_version"] == 3 else "optional_permissions"
        expected_optional = OPTIONAL if manifest["manifest_version"] == 3 else OPTIONAL | {"clipboardWrite"}
        assert set(manifest.get(optional_key, [])) == expected_optional, "Unexpected optional permissions"
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
        # Each flavor carries its own engine and not the other's.
        if flavor == "oneclick":
            assert all(name in names for name in ENGINE_FILES), "In-browser engine runtime missing"
        else:
            carried = [name for name in (*ENGINE_FILES, "engine.html") if name in names]
            assert not carried, f"Native package carries the in-browser engine: {carried}"
        for notice in ("LICENSE", "THIRD_PARTY_NOTICES.md"):
            assert notice in names, f"Missing {notice}"
    print(f"PASS {path.name}: {flavor} permissions, pages, CSP and executable assets")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--flavor", choices=("native", "oneclick"), default="native")
    parser.add_argument("archives", nargs="+", type=Path)
    arguments = parser.parse_args()
    for path in arguments.archives:
        verify(path, arguments.flavor)
