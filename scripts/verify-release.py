"""Inspect packaged extension ZIPs, not a source or test-build manifest."""
import argparse
import json
import re
import zipfile
from pathlib import Path

REQUIRED = {"storage", "activeTab", "contextMenus", "scripting", "nativeMessaging", "webNavigation", "webRequest"}
OPTIONAL = {"https://*/*", "http://*/*", "file:///*"}


def verify(path):
    with zipfile.ZipFile(path) as archive:
        names = set(archive.namelist())
        manifest = json.loads(archive.read("manifest.json"))
        assert not manifest.get("host_permissions"), "Required website grants must be absent"
        assert not manifest.get("content_scripts"), "Shipping package must use permission-based registration"
        permissions = set(manifest["permissions"])
        assert permissions == REQUIRED, f"Unexpected required permissions: {permissions}"
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
    print(f"PASS {path.name}: shipping permissions, pages, CSP and executable assets")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archives", nargs="+", type=Path)
    for path in parser.parse_args().archives:
        verify(path)
