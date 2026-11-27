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


def private_tree(home: Path) -> None:
    """POSIX: the component's code is the user's alone (anagramd/safe_files.py private_tree,
    which this standalone helper cannot import): the home and the trees code runs from belong
    to this user, writable by no one else, and no directory above it could let another user
    swap it — the rule of OpenSSH's StrictModes."""
    if os.name == "nt":
        return
    uid = os.getuid()
    for path in (home, home / "app", home / "venv", home / "python"):
        try:
            info = path.lstat()
        except FileNotFoundError:
            continue
        if info.st_uid != uid or info.st_mode & 0o022:
            raise ValueError(f"{path} must belong to you and be writable by you alone")
    for parent in home.parents:
        info = parent.stat()
        if info.st_uid not in (uid, 0) or (info.st_mode & 0o022 and not info.st_mode & stat.S_ISVTX):
            raise ValueError(f"{parent} could let another user replace {home}")


def owned_home(home: Path, require_owner=False) -> Path:
    raw = Path(home)
    if not raw.is_absolute() or ".." in raw.parts or raw == Path(raw.anchor):
        raise ValueError("Component home must be an absolute dedicated directory")
    safe_path(raw, raw)
    home = raw.resolve()
    if home == Path.home().resolve() or not (home / ".anagram-home").is_file():
        raise ValueError("Not an owned Anagram component directory")
    private_tree(home)
    for name in (".anagram-home", OWNER, UNINSTALLING, INVENTORY, "app", "bin", "venv", "models", "run"):
        safe_path(home / name, home)
    if require_owner:
        marker = json.loads((home / OWNER).read_text(encoding="utf-8"))
        if marker != {"schema_version": 1, "host": HOST, "home": str(home)}:
            raise ValueError("Component ownership marker does not match this directory")
    return home


def validate_selection(browser, extension_id, language):
    if browser not in ("chrome", "firefox", "safari") or language not in ("en", "zh_CN"):
        raise ValueError("Browser must be chrome/firefox/safari and language en/zh_CN")
    if (browser == "chrome" and not re.fullmatch("[a-p]{32}", extension_id)) or (
            browser == "firefox" and extension_id != FIREFOX_ID) or (
            browser == "safari" and not re.fullmatch(r"[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+(?: \([A-Za-z0-9-]+\))?", extension_id)):
        raise ValueError("Invalid extension ID; use the exact ID shown by Anagram setup")


def manifest_path(home, user_home, browser, platform):
    if browser == "safari":
        if platform != "darwin":
            raise ValueError("Safari's local engine requires macOS")
        # The containing app provides Safari's bridge. This owned receipt is used
        # for update/uninstall; Safari does not read Chrome/Firefox host manifests.
        return home / "native" / "safari.json"
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


EMPTY_REGISTRY_KEY = object()


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
                # Refuse surprising subkeys/values rather than deleting unrelated data.
                children, values, _ = w.QueryInfoKey(key)
                if not children and not values:
                    return EMPTY_REGISTRY_KEY
                if children or values != 1:
                    raise ValueError("Native host registry key contains unexpected data")
                try:
                    value, kind = w.QueryValueEx(key, "")
                except FileNotFoundError:
                    raise ValueError("Native host registry key contains an unrelated value") from None
                if kind != w.REG_SZ:
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
                with w.OpenKey(w.HKEY_CURRENT_USER, registry_key(browser).rsplit("\\", 1)[0], 0, w.KEY_READ | flag) as parent:
                    w.FlushKey(parent)
            except FileNotFoundError:
                pass
        else:
            with w.CreateKeyEx(w.HKEY_CURRENT_USER, registry_key(browser), 0, w.KEY_WRITE | w.KEY_QUERY_VALUE | flag) as key:
                if value is not EMPTY_REGISTRY_KEY:
                    w.SetValueEx(key, "", 0, w.REG_SZ, value)
                else:
                    try:
                        w.DeleteValue(key, "")
                    except FileNotFoundError:
                        pass
                w.FlushKey(key)


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
        durable_replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def durable_replace(source, target):
    # The external browser registration must never reach disk before its receipt.
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes
        move = ctypes.WinDLL("kernel32", use_last_error=True).MoveFileExW
        move.argtypes = (wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD)
        move.restype = wintypes.BOOL
        if not move(str(source), str(target), 0x1 | 0x8):  # REPLACE_EXISTING | WRITE_THROUGH
            raise ctypes.WinError(ctypes.get_last_error())
    else:
        os.replace(source, target)
        sync_directory(target.parent)


def sync_directory(directory):
    if os.name != "nt":
        fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def transaction_id(value):
    if not isinstance(value, str) or not re.fullmatch(r"[a-zA-Z0-9._-]{1,128}", value):
        raise ValueError("Invalid installation transaction ID")
    return value


def registration_matches(entry, data):
    if entry is None:
        return False
    digest = hashlib.sha256(data).hexdigest()
    return digest in (entry["sha256"], entry.get("previous_sha256"))


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
        if "previous_sha256" in entry and not re.fullmatch("[0-9a-f]{64}", entry["previous_sha256"]):
            raise ValueError("Invalid previous registration digest")
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


def lock_hkcu(user_home):
    """Lock the HKCU keys that every component home registering a browser shares (Windows).
    A key cannot be locked, so a per-user file is, the way the filelock package does it:
    msvcrt's byte-range lock on Windows (flock where the Windows layout is tested). The
    function returned releases it."""
    path = safe_path(user_home / "AppData/Local" / (HOST + ".registration.lock"), user_home)
    path.parent.mkdir(parents=True, exist_ok=True)
    deadline = time.monotonic() + 10
    while True:
        flags = os.O_RDWR | getattr(os, "O_NOFOLLOW", 0)
        try:
            fd = os.open(path, flags | os.O_CREAT | os.O_EXCL, 0o600)
            created = True
        except FileExistsError:
            try:
                fd = os.open(path, flags)
            except FileNotFoundError:
                continue
            created = False
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size or not os.path.samestat(info, path.lstat()):
                raise ValueError("Unexpected file at the browser registration lock")

            if os.name == "nt":
                import msvcrt
                msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            os.close(fd)
            if time.monotonic() > deadline:
                raise ValueError("Another Anagram component is registering with this browser; retry") from None
            time.sleep(0.05)
            continue
        except BaseException:
            os.close(fd)
            raise

        def release():
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
            os.close(fd)
            # Windows refuses to delete a file another process has open, as one taking the
            # lock does, so the last one out removes it and nothing is left behind.
            if os.name == "nt" and created:
                try:
                    if os.path.samestat(info, path.lstat()):
                        path.unlink()
                except OSError:
                    pass
        return release


# The release's immutable trees are installed by rename. A list of their individual
# files lets cleanup distinguish the release from files added or edited afterwards.
FILES = ".anagram-installed-files.json"
REMOVAL = ".anagram-removal.json"
TREES = ("app", "extension", "venv")
TOOLS = ("bin/anagram", "bin/anagram-native", "bin/anagram-native.exe", "bin/uv", "bin/uv.exe", "VERSION")


def file_signature(path):
    info = path.lstat()
    if stat.S_ISLNK(info.st_mode):
        return "link:" + os.readlink(path)
    if not stat.S_ISREG(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
        return None
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    with os.fdopen(fd, "rb") as stream:
        opened = os.fstat(stream.fileno())
        if not os.path.samestat(opened, info):
            raise ValueError(f"File changed during inspection: {path}")
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    after = path.lstat()
    if not os.path.samestat(after, info) or after.st_size != info.st_size or after.st_mtime_ns != info.st_mtime_ns:
        raise ValueError(f"File changed during inspection: {path}")
    return digest


def receipt_path(name):
    parts = name.split("/")
    if (not name or any(p in ("", ".", "..") for p in parts)
            or any(c in name for c in ("\\", ":", "\x00"))):
        raise ValueError("Invalid relative filename in the installation receipt")
    if parts[0] not in (*TREES, "python", "models", "bin", "hf", "run", "cache", "native") and name not in (
            "VERSION", "component-state.json", "active-detector.json", "pending-detector.json", "download-error.json",
            "runtime.json", "runtime-crashes.json"):
        raise ValueError("Unexpected filename in the installation receipt")
    return Path(*parts)


def read_files(home, path, *, boundary=None):
    safe_path(path, home if boundary is None else boundary)
    if not path.exists():
        return {}
    value = json.loads(path.read_bytes())
    if value.get("home") != str(home) or value.get("schema_version") != 1 or not isinstance(value.get("files"), dict):
        raise ValueError("Installation file receipt belongs to another folder or is invalid")
    for name, signature in value["files"].items():
        receipt_path(name)
        if not isinstance(signature, str) or not (signature == "dir" or signature.startswith("link:") or re.fullmatch("[a-f0-9]{64}", signature)):
            raise ValueError("Invalid file signature in the installation receipt")
    return value["files"]


def file_receipt(home, files):
    return {"schema_version": 1, "home": str(home), "files": files}


def staged_payload(home, trees, single_files, include=None):
    files = {} if include is None else read_stage(home, include)

    def record(path, name):
        receipt_path(name)
        if name in files or name == "app/" + FILES:
            raise ValueError(f"Duplicate or reserved installation filename: {name}")
        if path.is_symlink():
            files[name] = "link:" + os.readlink(path)
        elif getattr(path.lstat(), "st_file_attributes", 0) & 0x400 or path.is_mount():
            raise ValueError(f"Unexpected mounted directory or reparse point: {path}")
        elif path.is_dir():
            files[name] = "dir"
            for child in path.iterdir():
                record(child, name + "/" + child.name)
        else:
            signature = file_signature(path)
            if signature is None:
                raise ValueError(f"Unexpected install file type: {path}")
            files[name] = signature

    for name, source in trees:
        path = Path(source)
        if name not in (*TREES, "python") or path.is_symlink() or not path.is_dir():
            raise ValueError(f"Invalid staged installation directory: {name}")
        record(path, name)
    for name, source in single_files:
        path = Path(source)
        if name not in TOOLS or path.is_symlink() or not path.is_file():
            raise ValueError(f"Invalid staged installation file: {name}")
        record(path, name)
    return files


def read_stage(home, path):
    path = Path(path)
    if not path.is_file() or path.is_symlink():
        raise ValueError("Missing or unsafe staged file receipt")
    files = read_files(home, path, boundary=path.parent)
    for name in files:
        if (name.split("/")[0] not in (*TREES, "python") and name not in TOOLS) or name == "app/" + FILES:
            raise ValueError(f"Unexpected filename in staged payload: {name}")
    return files


def installed_files(home, new_python, new_uv, staged_files=None):
    old = read_files(home, home / "app.old" / FILES)
    uv = "bin/uv.exe" if os.name == "nt" else "bin/uv"
    files = {name: value for name, value in old.items() if name.split("/")[0] == "python" or name == uv}
    if staged_files is None:
        # Releases before staging receipts and standalone registration fixtures.
        tree_names = (*TREES, *(("python",) if new_python else ()))
        tool_names = ("VERSION", "bin/anagram-native.exe") if os.name == "nt" else ("VERSION", "bin/anagram", "bin/anagram-native")
        staged = staged_payload(home, [(n, home / n) for n in tree_names if (home / n).exists()],
                                [(n, home / n) for n in (*tool_names, *((uv,) if new_uv else ())) if (home / n).is_file()])
    else:
        staged = read_stage(home, staged_files)
        if any(staged.get(n) != "dir" for n in TREES) or not all(name in staged for name in ("VERSION", "app/native_host.py")):
            raise ValueError("Incomplete staged installation receipt")
    if "python" in staged:
        files = {name: sig for name, sig in files.items() if name.split("/")[0] != "python"}
    files.update(staged)
    for name in ("bin", "models", "hf", "cache", "run"):
        files[name] = "dir"
    return files


def same_file(path, signature):
    if not isinstance(signature, str) or signature == "dir":
        return False
    try:
        return file_signature(path) == signature
    except FileNotFoundError:
        return False


def prune_files(home, files, *, backups=False, python_backup=False):
    # Never enumerate an existing directory for deletion. Directory removal is
    # nonrecursive even when an entry was added after we checked its children.
    for name, sig in sorted(files.items(), key=lambda item: (
            item[0] in ("bin/anagram", "app/native_registration.py") or item[0].split("/")[0] in ("python", "venv"),
            -item[0].count("/"), item[0])):
        rel = receipt_path(name)
        if backups:
            if rel.parts[0] not in TREES and not (python_backup and rel.parts[0] == "python"):
                continue
            rel = Path(rel.parts[0] + ".old", *rel.parts[1:])
        path = home / rel
        try:
            safe_path(path.parent, home)
        except ValueError:
            continue  # An ancestor now belongs to another tree.
        if any(p.is_mount() for p in path.parents if p != home and p.is_relative_to(home)):
            continue
        if sig == "dir":
            empty_directory(path)
        elif same_file(path, sig):
            path.unlink()


def empty_directory(path):
    import errno
    if path.is_symlink() or path.is_mount() or getattr(path, "is_junction", lambda: False)():
        return
    try:
        path.rmdir()
    except FileNotFoundError:
        pass
    except OSError as exc:
        if exc.errno not in (errno.ENOTEMPTY, errno.EEXIST, errno.ENOTDIR):
            raise


def check_update(home):
    files = read_files(home, home / "app" / FILES)
    def check(path):
        name = path.relative_to(home).as_posix()
        if name == "app/" + FILES:
            return
        if path.is_dir() and not path.is_symlink():
            if path.is_mount() or getattr(path, "is_junction", lambda: False)():
                raise ValueError(f"Mounted directory in the install: {path}")
            if path.name == "__pycache__":
                return  # Unrecorded bytecode is preserved with any other leftover.
            if files.get(name) == "dir":
                for child in path.iterdir():
                    check(child)
                return
        elif same_file(path, files.get(name)):
            return
        raise ValueError(f"Update stopped to preserve a new or edited file: {path}")
    for name in (*TREES, *TOOLS):
        path = home / name
        if name in TOOLS and name not in files:
            continue
        if path.exists() or path.is_symlink():
            check(path)


def finish_update(home, backups=None, *, python_backup=False):
    previous = home / "app.old" / FILES
    files = read_files(home, previous)
    prune_files(home, files, backups=True, python_backup=python_backup)
    previous.unlink(missing_ok=True)
    kept = None
    for name in (*TREES, *(("python",) if python_backup else ())):
        path = safe_path(home / (name + ".old"), home)
        empty_directory(path)
        if path.exists():
            if kept is None:
                kept = Path(tempfile.mkdtemp(prefix=".preserved-", dir=home))
            path.rename(kept / name)
    if backups is not None:
        command = "bin/anagram-native.exe" if os.name == "nt" else "bin/anagram"
        uv = "bin/uv.exe" if os.name == "nt" else "bin/uv"
        for original, name in (("command.backup", command), ("version.backup", "VERSION"), ("uv.backup", uv)):
            path = Path(backups) / original
            if path.is_symlink() or not path.is_file():
                continue
            signature = file_signature(path)
            if signature == files.get(name):
                continue
            if kept is None:
                kept = Path(tempfile.mkdtemp(prefix=".preserved-", dir=home))
            saved = kept / name
            saved.parent.mkdir(exist_ok=True)
            shutil.copyfile(path, saved)
    if kept:
        print(f"Previous files without a matching install receipt were kept in {kept}", file=sys.stderr)


def removal_files(home):
    files = read_files(home, home / "app" / FILES)
    # Remove empty directories that the native runtime creates on first use.
    for name in ("cache/tmp", "cache/torch", "cache/torch/inductor", "cache/torch/extensions",
                 "cache/triton", "cache/cuda", "cache/matplotlib", "cache/numba",
                 "hf/hub", "hf/datasets", "hf/assets", "native/chrome", "native/firefox"):
        files[name] = "dir"
    # The original digests cover the private runtime. Downloads have their own
    # release-pinned digests and can be removed even after a model switch.
    def manifest(path, limit=65536):
        try:
            safe_path(path, home)
            if not path.is_file():
                return {}
            flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
            with os.fdopen(os.open(path, flags), "rb") as stream:
                info = os.fstat(stream.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_size > limit or not os.path.samestat(info, path.lstat()):
                    return {}
                data = stream.read(limit + 1)
            if len(data) > limit:
                return {}
            value = json.loads(data)
        except (FileNotFoundError, IsADirectoryError, ValueError, UnicodeError):
            return {}
        return value if isinstance(value, dict) else {}

    def receipt_digest(value, keys):
        ordered = {key: value[key] for key in keys}
        return hashlib.sha256(json.dumps(ordered, indent=2).encode("utf-8")).hexdigest()

    # Each state write records the old and proposed file before replacing it.
    # A power loss can leave either one; never adopt a different file at that name.
    tracked_state = set()
    for name in ("component-state.json", "active-detector.json", "pending-detector.json",
                 "download-error.json", "runtime.json", "runtime-crashes.json"):
        state = home / name
        receipt = home / "run" / (".anagram-" + name + ".receipt.json")
        value = manifest(receipt, 4096)
        versions = value.get("versions")
        if (set(value) != {"path", "versions"} or value["path"] != str(state)
                or not isinstance(versions, list) or not 1 <= len(versions) <= 2):
            continue
        try:
            signature = receipt_digest(value, ("path", "versions"))
            if not same_file(receipt, signature):
                continue
            safe_path(state, home)
            info = state.stat()
            for row in versions:
                if (isinstance(row, list) and len(row) == 4 and row[:3] == [info.st_dev, info.st_ino, info.st_size]
                        and isinstance(row[3], str) and re.fullmatch("[0-9a-f]{64}", row[3])
                        and same_file(state, row[3])):
                    files[name] = row[3]
                    files[receipt.relative_to(home).as_posix()] = signature
                    tracked_state.add(name)
                    break
        except (FileNotFoundError, ValueError):
            continue

    def partial(name, digest):
        part = home / (name + ".part")
        receipt = home / (name + ".part.resume")
        value = manifest(receipt, 8192)
        if (set(value) != {"path", "expected", "device", "inode", "versions"}
                or value["path"] != str(part) or value["expected"] != digest
                or not isinstance(value["versions"], list) or not 1 <= len(value["versions"]) <= 2):
            return
        try:
            signature = receipt_digest(value, ("path", "expected", "device", "inode", "versions"))
            if not same_file(receipt, signature):
                return
            # A crash after promoting the verified part can leave just its receipt.
            current = part if part.exists() else home / name
            safe_path(current, home)
            info = current.stat()
            if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
                    or (info.st_dev, info.st_ino) != (value["device"], value["inode"])):
                return
            for row in value["versions"]:
                if (isinstance(row, list) and len(row) == 2 and row[0] == info.st_size
                        and isinstance(row[1], str) and re.fullmatch("[0-9a-f]{64}", row[1])
                        and (current == part or row[1] == digest) and same_file(current, row[1])):
                    files[current.relative_to(home).as_posix()] = row[1]
                    files[receipt.relative_to(home).as_posix()] = signature
                    return
        except (FileNotFoundError, ValueError):
            pass

    def model(folder, entries):
        for entry in entries:
            name = (folder / receipt_path("models/" + entry["path"]).relative_to("models")).as_posix()
            digest = entry["sha256"]
            if not re.fullmatch("[0-9a-f]{64}", digest):
                raise ValueError("Invalid model digest")
            files[name] = digest
            # A full, unpromoted part has the same known digest. A shorter
            # file needs the downloader's exact checkpoint before it can go.
            files[name + ".part"] = digest
            partial(name, digest)
            for parent in Path(name).parents:
                if parent != Path("."):
                    files[parent.as_posix()] = "dir"
    def bundled(name):
        path = home / name
        signature = files.get(name)
        if not isinstance(signature, str) or not re.fullmatch("[0-9a-f]{64}", signature):
            return {}
        value = manifest(path)
        return value if value and same_file(path, signature) else {}

    def entries_for(value):
        entries = value.get("files")
        if not isinstance(entries, list):
            return []
        try:
            for e in entries:
                if not isinstance(e, dict) or not re.fullmatch("[0-9a-f]{64}", str(e.get("sha256"))):
                    return []
                receipt_path("models/" + e["path"])
        except (KeyError, TypeError, ValueError):
            return []
        return entries

    default = bundled("app/detector-release.json")
    paths = {e["path"] for e in entries_for(default)}
    def release(folder, entries):
        for tree in (folder, ".incoming-" + folder, folder + ".old"):
            model(Path("models", tree), entries)
        lock = home / "models" / ("." + folder + ".download.lock")
        receipt = lock.with_name(lock.name + ".receipt.json")
        proof = manifest(receipt, 4096)
        if set(proof) != {"path", "device", "inode"} or proof["path"] != str(lock):
            return
        try:
            safe_path(lock, home)
            info = lock.lstat()
            signature = receipt_digest(proof, ("path", "device", "inode"))
            if (stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size == 0
                    and (info.st_dev, info.st_ino) == (proof["device"], proof["inode"]) and same_file(receipt, signature)):
                files[lock.relative_to(home).as_posix()] = hashlib.sha256(b"").hexdigest()
                files[receipt.relative_to(home).as_posix()] = signature
        except (FileNotFoundError, ValueError):
            pass

    pins = [default, *(manifest(home / n) for n in ("pending-detector.json", "active-detector.json") if n in tracked_state)]
    run = home / "run"
    archives = run.glob(".anagram-detector-*.json") if run.is_dir() and not (
        run.is_symlink() or run.is_mount() or getattr(run, "is_junction", lambda: False)()) else ()
    for archive in archives:
        match = re.fullmatch(r"\.anagram-detector-([0-9a-f]{64})\.json", archive.name)
        value = manifest(archive)
        pin = value.get("pin")
        if (match and value.get("home") == str(home) and isinstance(pin, dict)
                and pin.get("repository") == default.get("repository") and same_file(archive, match[1])):
            pins.append(pin)
            files[archive.relative_to(home).as_posix()] = match[1]
    revisions = set()
    for pin in pins:
        entries = entries_for(pin)
        if (paths and re.fullmatch("[0-9a-f]{40}", str(pin.get("revision")))
                and {e["path"] for e in entries} == paths):
            if pin["revision"] not in revisions:
                release("detector-" + pin["revision"], entries)
                revisions.add(pin["revision"])
    release("editlens_roberta-large", entries_for(bundled("app/modelkit.json")))
    lid = bundled("app/contract.json").get("language_id")
    if isinstance(lid, dict) and lid.get("path") == "lid.176.ftz" and re.fullmatch("[0-9a-f]{64}", str(lid.get("sha256"))):
        model(Path("models"), [lid])
    return files


def register(home, browser, extension_id, language="en", *, user_home=None, platform=None, registry=None, record_install=False, new_python=False, new_uv=False, staged_files=None, transaction=None):
    if transaction is not None:
        transaction_id(transaction)
    validate_selection(browser, extension_id, language)
    home = owned_home(Path(home))
    user_home = Path(user_home or Path.home()).resolve()
    platform = platform or sys.platform
    value = inventory(home, user_home, platform)
    target = manifest_path(home, user_home, browser, platform)
    safe_path(target, home if platform == "win32" or browser == "safari" else user_home)
    launcher = launcher_path(home, platform)
    safe_path(launcher, home)
    if not (home / "app/native_host.py").is_file():
        raise ValueError("Native host program is missing from this release")
    old = next((x for x in value["registrations"] if x["browser"] == browser), None)
    manifest = {"name": HOST, "description": "Anagram local model component", "path": str(launcher), "type": "stdio"}
    manifest["allowed_origins" if browser == "chrome" else "allowed_extensions"] = [
        "chrome-extension://" + extension_id + "/" if browser == "chrome" else extension_id]
    if browser == "safari":
        manifest = {"schema_version": 1, "browser": "safari", "extension_id": extension_id, "home": str(home)}
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
        previous = path.read_bytes() if path.exists() else None
        permissions = path.stat().st_mode & 0o777 if previous is not None else mode
        changed_files.append((path, previous, permissions, content))
        atomic_write(path, content, mode)
    lock = release_hkcu = None
    try:
        if platform != "win32":
            lock = lock_registrations(target, created_dirs)
        else:
            release_hkcu = lock_hkcu(user_home)
        before = target.read_bytes() if target.exists() else None
        if before is not None and not registration_matches(old, before):
            raise ValueError("A different or modified native registration already exists; refusing to replace it")
        if platform != "win32" and browser != "safari":
            # A browser invokes this absolute path. No system Python, shell profile,
            # inherited PYTHONPATH, or stdout logging participates in host startup.
            python = shlex.quote(str(home / "venv/bin/python"))
            script = "#!/bin/sh\nexec " + python + " -I -u " + shlex.quote(str(home / "app/native_host.py")) + " --home " + shlex.quote(str(home)) + ' "$@"\n'
            if launcher.exists() and launcher.read_bytes() != script.encode():
                raise ValueError("The existing native launcher was modified; it was kept")
            write(launcher, script.encode(), 0o700)
        elif platform == "win32" and not launcher.is_file():
            raise ValueError("Compiled Windows native launcher is missing")
        views = {}
        if platform == "win32":
            registry = registry or Registry()
            for view in (32, 64):
                prior = registry.read(browser, view)
                pending_empty = (prior is EMPTY_REGISTRY_KEY and transaction is not None and
                                 value.get("pending_transaction") == transaction and value.get("pending_browser") == browser
                                 and before is not None and registration_matches(old, before))
                if prior is not None and not pending_empty and (old is None or prior != str(target)):
                    raise ValueError("A different native host owns the HKCU registration")
                views[view] = prior
        entry = {"browser": browser, "extension_id": extension_id, "language": language,
                 "manifest": str(target), "sha256": hashlib.sha256(data).hexdigest()}
        owner_data = {"schema_version": 1, "host": HOST, "home": str(home)}
        if (home / OWNER).exists() and json.loads((home / OWNER).read_bytes()) != owner_data:
            raise ValueError("Component ownership marker belongs to another installation")
        if record_install:
            files = installed_files(home, new_python, new_uv, staged_files)
            if platform != "win32":
                if browser != "safari":
                    files["bin/anagram-native"] = hashlib.sha256(script.encode()).hexdigest()
                else:
                    # Another browser may already use the launcher in this home.
                    previous = read_files(home, home / "app.old" / FILES)
                    if "bin/anagram-native" in previous:
                        files["bin/anagram-native"] = previous["bin/anagram-native"]
            receipt_data = encoded(file_receipt(home, files))
            receipt = home / "app" / FILES
            if staged_files and receipt.exists() and receipt.read_bytes() != receipt_data:
                raise ValueError("The file at the staged receipt destination was preserved")
            write(receipt, receipt_data)
        write(home / OWNER, encoded(owner_data))
        # Publish the receipt first. Until the final rename, the on-disk manifest
        # can still have either its former digest or the new one.
        if before is not None and before != data:
            entry["previous_sha256"] = hashlib.sha256(before).hexdigest()
        value["registrations"] = [x for x in value["registrations"] if x["browser"] != browser] + [entry]
        value.pop("install_transaction", None)
        if transaction is not None:
            value["pending_transaction"] = transaction
            value["pending_browser"] = browser
        write(home / INVENTORY, encoded(value))
        if (target.read_bytes() if target.exists() else None) != before:
            raise ValueError("Browser registration changed during installation")
        write(target, data)
        for view, prior in views.items():
            current = registry.read(browser, view)
            # HKCU can expose the same physical key through both WOW64 views.
            if changed_keys and current == str(target):
                continue
            if current != prior:
                raise ValueError("Browser registration changed during installation")
            changed_keys.append((browser, view, prior))
            registry.write(browser, view, str(target))
        entry.pop("previous_sha256", None)
        value.pop("pending_transaction", None)
        value.pop("pending_browser", None)
        if transaction is not None:
            value["install_transaction"] = transaction
        write(home / INVENTORY, encoded(value))
    except BaseException:
        for b, view, prior in reversed(changed_keys):
            current = registry.read(b, view)
            if current == str(target) or (current is EMPTY_REGISTRY_KEY and prior is None):
                registry.write(b, view, prior)
        for path, previous, mode, written in reversed(changed_files):
            if path.is_symlink() or not path.is_file() or path.read_bytes() != written:
                continue
            if previous is None:
                path.unlink(missing_ok=True)
                sync_directory(path.parent)
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
        if release_hkcu is not None:
            release_hkcu()
    return entry


def unregister(home, *, user_home=None, platform=None, registry=None):
    home = owned_home(Path(home), require_owner=True)
    user_home = Path(user_home or Path.home()).resolve()
    platform = platform or sys.platform
    value = inventory(home, user_home, platform, required=True)
    release_hkcu = lock_hkcu(user_home) if platform == "win32" else None
    locks = []
    try:
        if platform != "win32":
            for target in sorted(Path(e["manifest"]) for e in value["registrations"]):
                safe_path(target, home if target.is_relative_to(home) else user_home)
                if target.parent.is_dir():
                    locks.append(lock_registrations(target, set()))
        # Preflight every path/key before deleting any registration.
        for entry in value["registrations"]:
            target = Path(entry["manifest"])
            safe_path(target, home if platform == "win32" or entry["browser"] == "safari" else user_home)
            if target.exists() and not registration_matches(entry, target.read_bytes()):
                raise ValueError("Registration was modified after installation; refusing to delete it")
            if platform == "win32":
                registry = registry or Registry()
                for view in (32, 64):
                    current = registry.read(entry["browser"], view)
                    pending_empty = (current is EMPTY_REGISTRY_KEY and value.get("pending_transaction") and
                                     value.get("pending_browser") == entry["browser"] and target.is_file())
                    if current is not None and not pending_empty and current != str(target):
                        raise ValueError("HKCU registration no longer belongs to this component")
        previous_inventory = encoded(value)
        changed_keys, removed_files = [], []
        try:
            for entry in value["registrations"]:
                target = Path(entry["manifest"])
                if platform == "win32":
                    for view in (32, 64):
                        previous = registry.read(entry["browser"], view)
                        if previous is None:
                            continue
                        pending_empty = (previous is EMPTY_REGISTRY_KEY and value.get("pending_transaction") and
                                         value.get("pending_browser") == entry["browser"] and target.is_file())
                        if not pending_empty and previous != str(target):
                            raise ValueError("HKCU registration changed during removal")
                        changed_keys.append((entry["browser"], view, previous))
                        registry.write(entry["browser"], view, None)
                if target.exists():
                    data = target.read_bytes()
                    if not registration_matches(entry, data):
                        raise ValueError("Registration changed during removal; refusing to delete it")
                    removed_files.append((target, data))
                    target.unlink()
                    sync_directory(target.parent)
            value["registrations"] = []
            atomic_write(home / INVENTORY, encoded(value))
        except BaseException:
            if not value["registrations"] and (home / INVENTORY).read_bytes() == encoded(value):
                atomic_write(home / INVENTORY, previous_inventory)
            for target, data in reversed(removed_files):
                if not target.exists():
                    atomic_write(target, data)
            for browser, view, previous in reversed(changed_keys):
                if registry.read(browser, view) is None:
                    registry.write(browser, view, previous)
            raise
    finally:
        for fd in reversed(locks):
            os.close(fd)
        if release_hkcu is not None:
            release_hkcu()


def schedule_windows(home, operation, release=None):
    data = inventory(home, Path.home().resolve(), sys.platform, required=True)
    language = data["registrations"][0]["language"] if data["registrations"] else "en"
    worker = safe_path(home / "app/maintenance.ps1", home)
    if (home / "app" / FILES).is_file():
        recorded = read_files(home, home / "app" / FILES)
        if not same_file(worker, recorded.get("app/maintenance.ps1")):
            raise ValueError("The installed Windows maintenance script was changed; its file was preserved")
    # PowerShell reads the installed script before removal deletes its matching file.
    powershell = Path(os.environ["SystemRoot"]) / "System32/WindowsPowerShell/v1.0/powershell.exe"
    subprocess.Popen([str(powershell), "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(worker),
                      "-Operation", operation, "-ComponentHome", str(home), "-HostPid", str(os.getppid()),
                      "-Language", language, *(["-Release", release] if release else [])],
                     creationflags=subprocess.CREATE_NEW_CONSOLE, close_fds=True, cwd=os.environ["SystemRoot"],
                     stdin=None, stdout=None, stderr=None)
    return {"status": "scheduled",
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
        run_to_end(command, env=env, stdout=sys.stderr, stderr=sys.stderr, **kwargs)
    return {"status": "completed"}


def run_to_end(command, **kwargs):
    """subprocess.run with check=True that never kills its child. A terminal's Ctrl-C
    reaches the installer too, which rolls back and exits; subprocess.run would SIGKILL
    it 0.25 s into that rollback and leave its lock for the next installer to recover."""
    process = subprocess.Popen(command, **kwargs)
    while process.returncode is None:
        try:
            process.wait()
        except KeyboardInterrupt:
            pass
    if process.returncode:
        raise subprocess.CalledProcessError(process.returncode, command)


def prepare_removal(home):
    plan = safe_path(home / REMOVAL, home)
    if plan.exists():
        read_files(home, plan)
    atomic_write(plan, encoded(file_receipt(home, removal_files(home))))


def late_removal_plan(home, files):
    """A data-only receipt the POSIX CLI can read after its interpreter is gone."""
    retired = safe_path(home / UNINSTALLING, home)
    record = json.loads(retired.read_bytes())
    if "recovery_sha256" in record:
        digest = record["recovery_sha256"]
        if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise ValueError("Invalid recovery receipt digest")
        path = safe_path(home / (".anagram-removal-" + digest + ".tsv"), home)
        if file_signature(path) != digest:
            raise ValueError("Recovery receipt was edited; its file was preserved")
        return path
    files = dict(files)
    for name in ("app/" + FILES, INVENTORY, REMOVAL):
        path = safe_path(home / name, home)
        if path.is_file():
            files[name] = file_signature(path)
    rows = []
    for name in sorted(files, key=lambda n: (-n.count("/"), n)):
        signature = files[name]
        if not any(ord(c) < 32 or ord(c) == 127 for c in name + signature):
            rows.append(f"{signature}\t{name}\n")
    data = "".join(rows).encode("utf-8")
    digest = hashlib.sha256(data).hexdigest()
    path = safe_path(home / (".anagram-removal-" + digest + ".tsv"), home)
    if path.exists():
        if file_signature(path) != digest:
            raise ValueError("Recovery receipt was edited; its file was preserved")
    else:
        atomic_write(path, data)
    atomic_write(retired, encoded({"recovery_sha256": digest, "recovery_home_sha256": hashlib.sha256(os.fsencode(home)).hexdigest(), **record}))
    return path


def remove_home(home):
    plan = safe_path(home / REMOVAL, home)
    files = read_files(home, plan)
    late = {name: sig for name, sig in files.items()
            if name.split("/")[0] in ("python", "venv") or name in ("bin/anagram", "app/native_registration.py")}
    prune_files(home, {name: sig for name, sig in files.items() if name not in late})
    # An interruption after this point can remove part of the standard library.
    # Record the remaining work before touching it, and keep the shell CLI to the end.
    recovery = late_removal_plan(home, late) if os.name == "posix" else None
    command = late.pop("bin/anagram", None)
    prune_files(home, late)
    lock = safe_path(home / ".native-host.lock", home)
    if lock.is_file() and lock.stat().st_size == 0:
        lock.unlink()
    for name in ("app/" + FILES, INVENTORY, REMOVAL):
        path = safe_path(home / name, home)
        path.unlink(missing_ok=True)
    if command and same_file(home / "bin/anagram", command):
        (home / "bin/anagram").unlink()
    if recovery:
        recovery.unlink()
    (home / UNINSTALLING).unlink(missing_ok=True)
    marker = safe_path(home / ".anagram-home", home)
    expected = [f"Anagram installation: {home}", "Anagram installation folder.",
                "Anagram installation folder. Safe to delete with: bin/anagram uninstall"]
    if marker.is_file() and marker.stat().st_size <= len(str(home).encode()) + 128:
        if marker.read_bytes().rstrip(b"\r\n") in [value.encode() for value in expected]:
            marker.unlink()
    for name in ("app", "bin", "native", "models", "hf", "cache", "run"):
        empty_directory(home / name)
    empty_directory(home)
    if home.exists():
        print(f"Unregistered Anagram. Unverified files were kept in {home}", file=sys.stderr)


def uninstall(home, lock_fd=None):
    home = owned_home(home, require_owner=True)
    if sys.platform == "win32":
        return schedule_windows(home, "uninstall")
    with maintenance_lock(home, lock_fd):
        retired = safe_path(home / UNINSTALLING, home)
        if retired.exists():
            raise ValueError(f"Existing uninstall record conflicts with the active component: {retired}")
        prepare_removal(home)
        unregister(home)
        # Revoke startup authority before removing the native lock.
        durable_replace(home / OWNER, retired)
        remove_home(home)
    return {"status": "completed"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=["register", "registration-committed", "registration-pending", "unregister", "update", "uninstall", "prepare-removal", "finish-update", "finish-removal", "check-update", "stage-files"])
    parser.add_argument("--transaction", type=transaction_id, help=argparse.SUPPRESS)
    parser.add_argument("--home", required=True, type=Path)
    parser.add_argument("--browser", choices=["chrome", "firefox", "safari"])
    parser.add_argument("--extension-id")
    parser.add_argument("--language", default="en", choices=["en", "zh_CN"])
    parser.add_argument("--worker", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--lock-fd", type=int, help=argparse.SUPPRESS)
    parser.add_argument("--release", help=argparse.SUPPRESS)
    parser.add_argument("--installed-files", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--new-python", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--new-uv", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--python-backup", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--staged-files", type=Path, help=argparse.SUPPRESS)
    parser.add_argument("--tree", action="append", nargs=2, default=[], help=argparse.SUPPRESS)
    parser.add_argument("--file", action="append", nargs=2, default=[], help=argparse.SUPPRESS)
    parser.add_argument("--include-files", type=Path, help=argparse.SUPPRESS)
    parser.add_argument("--output", type=Path, help=argparse.SUPPRESS)
    parser.add_argument("--backups", type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args()
    try:
        if args.operation == "register":
            register(args.home, args.browser, args.extension_id or "", args.language, record_install=args.installed_files, new_python=args.new_python, new_uv=args.new_uv, staged_files=args.staged_files, transaction=args.transaction)
        elif args.operation == "stage-files":
            if args.output is None:
                raise ValueError("A staged receipt needs an output path")
            files = staged_payload(args.home, args.tree, args.file, args.include_files)
            safe_path(args.output, args.output.parent)
            with args.output.open("xb") as output:
                output.write(encoded(file_receipt(args.home, files)))
        elif args.operation in ("registration-committed", "registration-pending"):
            value = inventory(owned_home(args.home), Path.home().resolve(), sys.platform)
            field = "install_transaction" if args.operation == "registration-committed" else "pending_transaction"
            return 0 if args.transaction and value.get(field) == args.transaction else 1
        elif args.operation == "check-update":
            check_update(owned_home(args.home, require_owner=True))
        elif args.operation == "finish-update":
            finish_update(owned_home(args.home, require_owner=True), args.backups, python_backup=args.python_backup)
        elif args.operation == "prepare-removal":
            prepare_removal(owned_home(args.home, require_owner=True))
        elif args.operation == "finish-removal":
            home = owned_home(args.home)
            marker = json.loads((home / UNINSTALLING).read_bytes())
            marker.pop("recovery_sha256", None)
            location = marker.pop("recovery_home_sha256", None)
            if location is not None and location != hashlib.sha256(os.fsencode(home)).hexdigest():
                raise ValueError("Recovery receipt belongs to another folder")
            if (home / OWNER).exists() or marker != {"schema_version": 1, "host": HOST, "home": str(home)}:
                raise ValueError("Directory is not a retired component")
            remove_home(home)
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
        return 2 if args.operation in ("registration-committed", "registration-pending") else 1


if __name__ == "__main__":
    raise SystemExit(main())
