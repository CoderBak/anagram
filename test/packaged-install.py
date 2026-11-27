"""Exercise the POSIX installer and native updater against built archives, without fetching weights.

Usage: python3 test/packaged-install.py dist [--previous /path/to/previous/release]
The only substitute is uv provisioning, which points the staged runtime at this Python.
"""
import argparse
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import tarfile
import tempfile


def version(release):
    with tarfile.open(release / "anagram.tar.gz") as archive:
        return archive.extractfile("anagram/VERSION").read().decode().strip()


def provision(home, release):
    (home / "bin").mkdir(parents=True)
    (home / ".anagram-home").write_text(f"Anagram installation: {home.resolve()}\n")
    pin = re.search(r'^UV_VERSION="([\d.]+)"', (release / "install.sh").read_text(), re.M)[1]
    uv = home / "bin/uv"
    uv.write_text(f"""#!/bin/sh
set -eu
case "$1" in
  --version) echo 'uv {pin}' ;;
  sync) mkdir -p "$UV_PROJECT_ENVIRONMENT/bin"
        ln -s {shlex.quote(sys.executable)} "$UV_PROJECT_ENVIRONMENT/bin/python" ;;
  python|cache) exit 0 ;;
  *) echo "Unexpected provisioning operation: $1" >&2; exit 2 ;;
esac
""")
    uv.chmod(0o755)
    state = dict(schema_version=1, initialized=False, download_pending=False, download_paused=True,
                 download_failed=False, engine_stopped=False, models_deleted=False,
                 idle_unload_s=300, model_profile="recommended")
    (home / "component-state.json").write_text(json.dumps(state))


def exercise(root, candidate, previous):
    user = root / "user"
    user.mkdir()
    home = user / ".anagram"
    registry = user / ("Library/Application Support/Google/Chrome/NativeMessagingHosts"
                       if sys.platform == "darwin" else ".config/google-chrome/NativeMessagingHosts")
    manifest = registry / "dev.coderbak.anagram.json"
    env = dict(HOME=str(user), PATH="/usr/bin:/bin:/usr/sbin:/sbin", LANG="C",
               ANAGRAM_BROWSER="chrome", ANAGRAM_EXTENSION_ID="a"*32, ANAGRAM_LANG="en",
               http_proxy="http://127.0.0.1:9", https_proxy="http://127.0.0.1:9")

    def installed(release):
        command = home / "bin/anagram"
        assert subprocess.check_output([command, "version"], env=env, text=True).strip() == version(release)
        assert json.loads((home / "extension/manifest.json").read_text())["version"] == version(release)
        record = json.loads(manifest.read_text())
        assert Path(record["path"]).is_file() and home in Path(record["path"]).parents
        assert record["allowed_origins"] == ["chrome-extension://" + "a"*32 + "/"]
        assert json.loads((home / "component-state.json").read_text())["download_paused"]

    def install(release):
        provision(home, release)
        subprocess.run(["sh", release / "install.sh"], env={**env, "ANAGRAM_RELEASE_URL": release.as_uri()}, check=True)
        installed(release)

    install(previous)
    retained = home / "models/retained-test-bytes"
    retained.write_bytes(b"preserve on update")
    release_url = root / "releases"
    dest = release_url / "download" / ("v" + version(candidate))
    dest.parent.mkdir(parents=True)
    dest.symlink_to(candidate, target_is_directory=True)
    # Substitute the release origin only. The installed updater selects the browser, borrows
    # the native lock and runs the installed script as it would for a browser-requested update.
    subprocess.run([home / "venv/bin/python", "-I", "-c", """
import sys
from pathlib import Path
home = Path(sys.argv[1])
sys.path.insert(0, str(home / 'app'))
import native_registration as registration
registration.RELEASES = sys.argv[2]
registration.update(home, release=sys.argv[3])
""", str(home), release_url.as_uri(), version(candidate)], env=env, check=True)
    installed(candidate)
    assert retained.read_bytes() == b"preserve on update"
    expected = json.loads((home / "app/detector-release.json").read_text())
    assert expected["repository"] == "CoderBak/anagram-detectors"
    for release in (None, candidate):
        if release:
            install(release)
        subprocess.run([home / "bin/anagram", "uninstall", "-y"], env=env, check=True)
        assert not manifest.exists()
        assert not (home / "app/native_host.py").exists()
        assert not (home / "bin/anagram").exists()
        if not release:
            assert retained.read_bytes() == b"preserve on update"
            # This is a test-owned fixture. Keep the residual tree, then install in a fresh location.
            home.rename(root / "preserved-first-install")
    print(f"PASS packaged install {version(previous)} → update {version(candidate)} → uninstall → reinstall → uninstall")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("candidate", type=Path)
    parser.add_argument("--previous", type=Path)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="anagram-package-") as tmp:
        exercise(Path(tmp).resolve(), args.candidate.resolve(), (args.previous or args.candidate).resolve())
