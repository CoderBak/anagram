"""User-level native host registration and fixed component maintenance operations.

No downloaded code is executed by this helper. Updates run the installer already
shipped inside the owned component. stdout is reserved for native messaging by
callers; all diagnostics here go to stderr.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import stat
import subprocess
import sys
import tempfile
import time

HOST = "dev.coderbak.anagram"
FIREFOX_ID = "anagram@coderbak.dev"
INVENTORY = "native-registration.json"
OWNER = ".native-component.json"
UNINSTALLING = ".native-uninstall.json"
RELEASES = "https://github.com/CoderBak/anagram/releases"
RELEASE_VERSION = re.compile(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)")


def safe_path(path: Path, boundary: Path) -> Path:
    """Reject symlinks/reparse points from the explicit boundary downwards."""
    path = Path(os.path.abspath(path))
    boundary = Path(os.path.abspath(boundary))
    try:
        relative = path.relative_to(boundary)
    except ValueError:
        raise ValueError(f"Path is outside its allowed directory: {path}") from None
    current = boundary
    for part in (None, *relative.parts):
        if part is not None:
            current = current / part
        try:
            info = current.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            raise ValueError(f"Symbolic link/reparse point refused: {current}")
    return path


def owned_home(home: Path, require_owner=False) -> Path:
    raw = Path(home)
    if not raw.is_absolute() or ".." in raw.parts or raw == Path(raw.anchor):
        raise ValueError("Component home must be an absolute dedicated directory")
    safe_path(raw, raw)
    home = raw.resolve()
    if home == Path.home().resolve() or not (home / ".anagram-home").is_file():
        raise ValueError("Not an owned Anagram component directory")
    for name in (".anagram-home", OWNER, UNINSTALLING, INVENTORY, "app", "bin", "venv", "models", "run"):
        safe_path(home / name, home)
    if require_owner:
        marker = json.loads((home / OWNER).read_text(encoding="utf-8"))
        if marker != {"schema_version": 1, "host": HOST, "home": str(home)}:
            raise ValueError("Component ownership marker does not match this directory")
    return home


def validate_selection(browser, extension_id, language):
    if browser not in ("chrome", "firefox") or language not in ("en", "zh_CN"):
        raise ValueError("Browser must be chrome/firefox and language en/zh_CN")
    if (browser == "chrome" and not re.fullmatch("[a-p]{32}", extension_id)) or (
            browser == "firefox" and extension_id != FIREFOX_ID):
        raise ValueError("Invalid extension ID; use the exact ID shown by Anagram setup")


def manifest_path(home, user_home, browser, platform):
    if platform == "win32":
        return home / "native" / browser / (HOST + ".json")
    if platform == "darwin":
        parent = user_home / "Library/Application Support" / ("Google/Chrome" if browser == "chrome" else "Mozilla") / "NativeMessagingHosts"
    elif platform.startswith("linux"):
        parent = user_home / (".config/google-chrome/NativeMessagingHosts" if browser == "chrome" else ".mozilla/native-messaging-hosts")
    else:
        raise ValueError("Native installation supports macOS, Linux and Windows")
    return parent / (HOST + ".json")


def launcher_path(home, platform):
    return home / "bin" / ("anagram-native.exe" if platform == "win32" else "anagram-native")


def registry_key(browser):
    return "Software\\" + ("Google\\Chrome" if browser == "chrome" else "Mozilla") + "\\NativeMessagingHosts\\" + HOST


class Registry:
    """Only HKCU, in both documented lookup views. No caller-supplied key names."""
    def __init__(self):
        import winreg
        self.api = winreg

    def read(self, browser, view):
        w = self.api
        flag = w.KEY_WOW64_32KEY if view == 32 else w.KEY_WOW64_64KEY
        try:
            with w.OpenKey(w.HKEY_CURRENT_USER, registry_key(browser), 0, w.KEY_READ | flag) as key:
                value, kind = w.QueryValueEx(key, "")
                # Refuse surprising subkeys/values rather than deleting unrelated data.
                children, values, _ = w.QueryInfoKey(key)
                if children or values != 1 or kind != w.REG_SZ:
                    raise ValueError("Native host registry key contains unexpected data")
                return value
        except FileNotFoundError:
            return None

    def write(self, browser, view, value):
        w = self.api
        flag = w.KEY_WOW64_32KEY if view == 32 else w.KEY_WOW64_64KEY
        if value is None:
            try:
                w.DeleteKeyEx(w.HKEY_CURRENT_USER, registry_key(browser), flag, 0)
            except FileNotFoundError:
                pass
        else:
            with w.CreateKeyEx(w.HKEY_CURRENT_USER, registry_key(browser), 0, w.KEY_WRITE | flag) as key:
                w.SetValueEx(key, "", 0, w.REG_SZ, value)


def encoded(value):
    return (json.dumps(value, indent=2, ensure_ascii=False) + "\n").encode()


def atomic_write(path, value, mode=0o600):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(prefix="." + path.name + "-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(value)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def inventory(home, user_home, platform, *, required=False):
    path = home / INVENTORY
    if not path.exists():
        if required:
            raise ValueError("Native registration inventory is missing; cleanup cannot verify owned registrations")
        return {"schema_version": 1, "host": HOST, "home": str(home),
                "user_home": str(user_home), "platform": platform, "registrations": []}
    value = json.loads(path.read_text(encoding="utf-8"))
    if (value.get("schema_version") != 1 or value.get("host") != HOST or value.get("home") != str(home)
            or value.get("user_home") != str(user_home) or value.get("platform") != platform
            or not isinstance(value.get("registrations"), list)):
        raise ValueError("Native registration inventory is invalid or belongs to another user/home")
    browsers = set()
    for entry in value["registrations"]:
        validate_selection(entry["browser"], entry["extension_id"], entry["language"])
        if entry["browser"] in browsers:
            raise ValueError("Duplicate registration entry")
        browsers.add(entry["browser"])
        expected = manifest_path(home, user_home, entry["browser"], platform)
        if entry.get("manifest") != str(expected) or not re.fullmatch("[0-9a-f]{64}", entry.get("sha256", "")):
            raise ValueError("Registration inventory contains an unexpected path or hash")
    return value


def lock_registrations(manifest, created):
    """Lock the NativeMessagingHosts directory that every component home registering
    this browser shares (POSIX, advisory). Closing the descriptor releases it."""
    import fcntl
    directory = manifest.parent
    missing = directory
    while not missing.exists():
        created.add(missing)
        missing = missing.parent
    deadline = time.monotonic() + 10
    while True:
        fd = None
        try:
            directory.mkdir(parents=True, exist_ok=True, mode=0o700)
            fd = os.open(directory, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0))
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            # A holder that failed may have removed the directory it created.
            held, current = os.fstat(fd), directory.lstat()
            if (held.st_dev, held.st_ino) == (current.st_dev, current.st_ino):
                return fd
        except (BlockingIOError, FileNotFoundError):
            pass
        except BaseException:
            if fd is not None:
                os.close(fd)
            raise
        if fd is not None:
            os.close(fd)
        if time.monotonic() > deadline:
            raise ValueError("Another Anagram component is registering with this browser; retry")
        time.sleep(0.05)


def register(home, browser, extension_id, language="en", *, user_home=None, platform=None, registry=None):
    validate_selection(browser, extension_id, language)
    home = owned_home(Path(home))
    user_home = Path(user_home or Path.home()).resolve()
    platform = platform or sys.platform
    value = inventory(home, user_home, platform)
    target = manifest_path(home, user_home, browser, platform)
    safe_path(target, home if platform == "win32" else user_home)
    launcher = launcher_path(home, platform)
    safe_path(launcher, home)
    if not (home / "app/native_host.py").is_file():
        raise ValueError("Native host program is missing from this release")
    old = next((x for x in value["registrations"] if x["browser"] == browser), None)
    manifest = {"name": HOST, "description": "Anagram local model component", "path": str(launcher), "type": "stdio"}
    manifest["allowed_origins" if browser == "chrome" else "allowed_extensions"] = [
        "chrome-extension://" + extension_id + "/" if browser == "chrome" else extension_id]
    data = encoded(manifest)
    changed_files = []
    changed_keys = []
    created_dirs = set()
    def write(path, content, mode=0o600):
        safe_path(path, home if path.is_relative_to(home) else user_home)
        parent = path.parent
        while not parent.exists():
            created_dirs.add(parent)
            parent = parent.parent
        changed_files.append((path, path.read_bytes() if path.exists() else None, path.stat().st_mode & 0o777 if path.exists() else mode))
        atomic_write(path, content, mode)
    lock = None
    try:
        if platform != "win32":
            lock = lock_registrations(target, created_dirs)
        before = target.read_bytes() if target.exists() else None
        if before is not None and (old is None or hashlib.sha256(before).hexdigest() != old["sha256"]):
            raise ValueError("A different or modified native registration already exists; refusing to replace it")
        if platform != "win32":
            # A browser invokes this absolute path. No system Python, shell profile,
            # inherited PYTHONPATH, or stdout logging participates in host startup.
            python = shlex.quote(str(home / "venv/bin/python"))
            script = "#!/bin/sh\nexec " + python + " -I -u " + shlex.quote(str(home / "app/native_host.py")) + " --home " + shlex.quote(str(home)) + ' "$@"\n'
            write(launcher, script.encode(), 0o700)
        elif not launcher.is_file():
            raise ValueError("Compiled Windows native launcher is missing")
        write(target, data)
        if platform == "win32":
            registry = registry or Registry()
            for view in (32, 64):
                prior = registry.read(browser, view)
                if prior is not None and (old is None or prior != str(target)):
                    raise ValueError("A different native host owns the HKCU registration")
                changed_keys.append((browser, view, prior))
                registry.write(browser, view, str(target))
        entry = {"browser": browser, "extension_id": extension_id, "language": language,
                 "manifest": str(target), "sha256": hashlib.sha256(data).hexdigest()}
        value["registrations"] = [x for x in value["registrations"] if x["browser"] != browser] + [entry]
        write(home / OWNER, encoded({"schema_version": 1, "host": HOST, "home": str(home)}))
        write(home / INVENTORY, encoded(value))
    except BaseException:
        for b, view, prior in reversed(changed_keys):
            registry.write(b, view, prior)
        for path, previous, mode in reversed(changed_files):
            if previous is None:
                path.unlink(missing_ok=True)
            else:
                atomic_write(path, previous, mode)
        for directory in sorted(created_dirs, key=lambda p: len(p.parts), reverse=True):
            try:
                directory.rmdir()
            except OSError:
                pass
        raise
    finally:
        if lock is not None:
            os.close(lock)
    return entry


def unregister(home, *, user_home=None, platform=None, registry=None):
    home = owned_home(Path(home), require_owner=True)
    user_home = Path(user_home or Path.home()).resolve()
    platform = platform or sys.platform
    value = inventory(home, user_home, platform, required=True)
    # Preflight every path/key before deleting any registration.
    for entry in value["registrations"]:
        target = Path(entry["manifest"])
        safe_path(target, home if platform == "win32" else user_home)
        if target.exists() and hashlib.sha256(target.read_bytes()).hexdigest() != entry["sha256"]:
            raise ValueError("Registration was modified after installation; refusing to delete it")
        if platform == "win32":
            registry = registry or Registry()
            for view in (32, 64):
                current = registry.read(entry["browser"], view)
                if current is not None and current != str(target):
                    raise ValueError("HKCU registration no longer belongs to this component")
    changed_keys, removed_files = [], []
    try:
        for entry in value["registrations"]:
            if platform == "win32":
                for view in (32, 64):
                    previous = registry.read(entry["browser"], view)
                    changed_keys.append((entry["browser"], view, previous))
                    registry.write(entry["browser"], view, None)
            target = Path(entry["manifest"])
            if target.exists():
                removed_files.append((target, target.read_bytes()))
                target.unlink()
        value["registrations"] = []
        atomic_write(home / INVENTORY, encoded(value))
    except BaseException:
        for target, data in reversed(removed_files):
            atomic_write(target, data)
        for browser, view, previous in reversed(changed_keys):
            registry.write(browser, view, previous)
        raise


def schedule_windows(home, operation, release=None):
    data = inventory(home, Path.home().resolve(), sys.platform, required=True)
    language = data["registrations"][0]["language"] if data["registrations"] else "en"
    worker = safe_path(home / "app/maintenance.ps1", home)
    # The verified payload is copied outside the tree it will remove. No message
    # can provide a script, command line, URL or alternative component directory.
    temporary = Path(tempfile.mkdtemp(prefix="anagram-maintenance-"))
    copied = temporary / "maintenance.ps1"
    shutil.copyfile(worker, copied)
    receipt = temporary / "receipt.json"
    powershell = Path(os.environ["SystemRoot"]) / "System32/WindowsPowerShell/v1.0/powershell.exe"
    subprocess.Popen([str(powershell), "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(copied),
                      "-Operation", operation, "-ComponentHome", str(home), "-HostPid", str(os.getppid()),
                      "-Receipt", str(receipt), "-Language", language, *(["-Release", release] if release else [])],
                     creationflags=subprocess.CREATE_NEW_CONSOLE, close_fds=True,
                     stdin=None, stdout=None, stderr=None)
    return {"status": "scheduled", "receipt": str(receipt),
            "message": "Finish this operation in the separate Windows progress window. It has not completed yet."}


@contextmanager
def maintenance_lock(home, inherited_fd=None):
    """Hold the existing native-home flock across the complete POSIX helper chain.

    A borrowed descriptor shares the parent's open-file description: never LOCK_UN
    it. Closing one descriptor leaves every surviving child copy locked. Windows
    maintenance is guarded by the fixed PowerShell worker's byte-range lock.
    """
    if os.name == "nt":
        if inherited_fd is not None:
            raise ValueError("Inherited maintenance descriptors are POSIX-only")
        yield None
        return
    import fcntl
    path = safe_path(home / ".native-host.lock", home)
    owned = inherited_fd is None
    fd = os.open(path, os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600) if owned else inherited_fd
    try:
        if type(fd) is not int or fd < 3:
            raise ValueError("Invalid maintenance lock descriptor")
        actual, expected = os.fstat(fd), path.lstat()
        if (not stat.S_ISREG(actual.st_mode) or not stat.S_ISREG(expected.st_mode)
                or (actual.st_dev, actual.st_ino) != (expected.st_dev, expected.st_ino)):
            raise ValueError("Maintenance descriptor is not the owned native lock")
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        owned_home(home, require_owner=True)  # ownership may have changed before locking
        yield fd
    finally:
        if owned:
            os.close(fd)  # never explicitly unlock an open description inherited by children


def update(home, worker=False, lock_fd=None, release=None):
    """Install `release` (the requesting extension's version), or the latest release."""
    if release is not None and not (isinstance(release, str) and RELEASE_VERSION.fullmatch(release)):
        raise ValueError("Release version must be MAJOR.MINOR.PATCH")
    home = owned_home(home, require_owner=True)
    if sys.platform == "win32" and not worker:
        return schedule_windows(home, "update", release)
    with maintenance_lock(home, lock_fd) as fd:
        data = inventory(home, Path.home().resolve(), sys.platform, required=True)
        if not data["registrations"]:
            raise ValueError("No owned browser registration to update")
        entry = data["registrations"][0]
        if sys.platform == "win32":
            installer = safe_path(home / "app/install.ps1", home)
            if not installer.is_file():
                raise ValueError("Installed component update script is missing")
            # The fixed PowerShell worker invokes this script in its own process,
            # lending the real locked FileStream instead of an environment bypass.
            return {"status": "prepared", "installer": str(installer), "browser": entry["browser"],
                    "extension_id": entry["extension_id"], "language": entry["language"]}
        env = {k: v for k, v in os.environ.items() if k in (
            "HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "SystemRoot", "WINDIR", "TEMP", "TMP", "LANG",
            "http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "no_proxy", "NO_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE")}
        env.update(ANAGRAM_HOME=str(home), ANAGRAM_BROWSER=entry["browser"], ANAGRAM_EXTENSION_ID=entry["extension_id"], ANAGRAM_LANG=entry["language"])
        if release:
            env["ANAGRAM_RELEASE_URL"] = RELEASES + "/download/v" + release
        if fd is not None:
            env["ANAGRAM_MAINTENANCE_FD"] = str(fd)
        env["PATH"] = "/usr/bin:/bin:/usr/sbin:/sbin"
        installer = safe_path(home / "app/install.sh", home)
        command = ["/bin/sh", str(installer)]
        kwargs = {"pass_fds": (fd,)} if fd is not None else {}
        subprocess.run(command, env=env, stdout=sys.stderr, stderr=sys.stderr, check=True, **kwargs)
    return {"status": "completed"}


def remove_home(home):
    """Delete a retired component. What `anagram uninstall` needs to finish an
    interrupted removal (both markers and the command itself) goes last."""
    last = {home / ".anagram-home", home / UNINSTALLING, home / "bin", home / "bin/anagram"}
    bin_dir = home / "bin"
    entries = [*home.iterdir(), *(bin_dir.iterdir() if bin_dir.is_dir() and not bin_dir.is_symlink() else ())]
    for entry in entries:
        if entry in last:
            continue
        if entry.is_dir() and not entry.is_symlink():
            shutil.rmtree(entry)
        else:
            entry.unlink()
    shutil.rmtree(home)


def uninstall(home, lock_fd=None):
    home = owned_home(home, require_owner=True)
    if sys.platform == "win32":
        return schedule_windows(home, "uninstall")
    with maintenance_lock(home, lock_fd):
        unregister(home)
        # Retire the startup authority before rmtree can unlink/recreate the lock
        # path; no new host may authorize itself against a half-removed component.
        # The renamed marker records that only file removal remains.
        os.replace(home / OWNER, home / UNINSTALLING)
        remove_home(home)
    return {"status": "completed"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=["register", "unregister", "update", "uninstall"])
    parser.add_argument("--home", required=True, type=Path)
    parser.add_argument("--browser", choices=["chrome", "firefox"])
    parser.add_argument("--extension-id")
    parser.add_argument("--language", default="en", choices=["en", "zh_CN"])
    parser.add_argument("--worker", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--lock-fd", type=int, help=argparse.SUPPRESS)
    parser.add_argument("--release", help=argparse.SUPPRESS)
    args = parser.parse_args()
    try:
        if args.operation == "register":
            register(args.home, args.browser, args.extension_id or "", args.language)
        elif args.operation == "unregister":
            unregister(args.home)
        elif args.operation == "update":
            print(json.dumps(update(args.home, args.worker, args.lock_fd, args.release)))
        elif args.operation == "uninstall":
            print(json.dumps(uninstall(args.home, args.lock_fd)))
        if args.operation not in ("update", "uninstall"):
            print("Native component " + args.operation + " completed", file=sys.stderr)
        return 0
    except Exception as exc:
        print("Native component " + args.operation + " failed: " + str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
