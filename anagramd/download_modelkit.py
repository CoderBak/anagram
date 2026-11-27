"""Install selected pinned model files, verifying the transaction before replacement.

Legacy EditLens files retain Pangram’s CC BY-NC-SA 4.0 license. Downloads are anonymous;
no account, saved Hugging Face token, or upstream access approval is required.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import sys
import subprocess
import tempfile
import threading
import queue
from safe_files import atomic_json, checkpoint_partial, is_link, matches_checkpoint, read_json, regular_stat, sha256_file
from runtime_controller import CONTRACT, valid_idle

PIN = Path(__file__).with_name("modelkit.json")
# fastText's language identifier, pinned in the engine contract: the browser package carries the
# same bytes (scripts/webengine.mjs).
LID_URL = CONTRACT["language_id"]["url"]
LID_ENTRY = {key: CONTRACT["language_id"][key] for key in ("path", "size_bytes", "sha256")}


# Where Hugging Face cannot be reached (mainland China, for one) hf-mirror.com serves the same
# repositories under the same paths. The pinned SHA-256 still decides what is kept.
HF_HOST = "huggingface.co"
MIRROR_HOST = "hf-mirror.com"
# fastText's own file has a byte-identical copy (same SHA-256) in a public Hub repository.
LID_HUB_URL = f"https://{HF_HOST}/julien-c/fasttext-language-id/resolve/9f2e94d2fd6b2615d26f5ec5b34cf7e2f38cb86e/lid.176.ftz"


def mirror_of(url: str) -> str | None:
    return url.replace("https://" + HF_HOST + "/", "https://" + MIRROR_HOST + "/", 1) if url.startswith("https://" + HF_HOST + "/") else None


class HostUnreachable(RuntimeError):
    """The host answered no byte: a network error, timeout or 5xx. A missing file or a
    checksum mismatch is never this."""


class DownloadPaused(Exception):
    """The caller requested a cooperative pause; verified/staged bytes remain."""


def _check_pause(cancel):
    if cancel is not None and cancel.is_set():
        raise DownloadPaused("Download paused")


def transfer_asset(url, part, size, offset, *, cancel, progress, expected, identity, notice=lambda _text: None):
    """Run the official transport outside the offline inference interpreter."""
    process = subprocess.Popen([sys.executable, "-I", "-B", str(Path(__file__).with_name("hub_transfer.py"))],
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    events = queue.Queue()
    def read():
        try:
            for line in process.stdout:
                events.put(json.loads(line))
        except Exception as exc:
            events.put({"error": str(exc)})
        finally:
            events.put(None)
    reader = threading.Thread(target=read, daemon=True)
    try:
        process.stdin.write(json.dumps({"url": url, "part": str(part), "size": size, "offset": offset,
                                        "expected": expected, "identity": identity}) + "\n")
        process.stdin.flush()  # pipe stays open as the worker's parent-lifetime signal
        reader.start()
        error = None
        unreachable = False
        while True:
            _check_pause(cancel)
            try:
                event = events.get(timeout=.1)
            except queue.Empty:
                continue
            if event is None:
                break
            if "error" in event:
                error = event["error"]
                unreachable = bool(event.get("unreachable"))
            elif "bytes" in event:
                progress(event["bytes"])
            elif "message" in event:
                notice(event["message"])
        if process.wait() != 0:
            if unreachable:
                raise HostUnreachable(error)
            raise RuntimeError(error or "The Hugging Face download process stopped; retry to resume")
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        if reader.ident is not None:
            reader.join(timeout=3)
        process.stdin.close()
        process.stdout.close()


def partial_stamp(part, entry):
    info = regular_stat(part)
    if info.st_nlink != 1:
        raise ValueError("Refusing a hardlinked partial download")
    return f"{entry['sha256']} {info.st_dev} {info.st_ino} {info.st_size} {info.st_mtime_ns} {info.st_ctime_ns}\n".encode("ascii")


def recorded_partial(part, receipt, entry, *, current=None, legacy=True):
    current = current or part
    if not current.exists() or not receipt.exists():
        return False
    info = regular_stat(current)
    if info.st_nlink != 1:
        raise ValueError("Refusing a hardlinked partial download")
    if matches_checkpoint(part, entry["sha256"], current=current):
        return True
    if not legacy or current != part:
        return False
    # Timestamp-only receipts allow old downloads to resume; deletion needs
    # a digest of the partial bytes or the pinned digest of the complete file.
    stamp = partial_stamp(part, entry)
    return regular_stat(receipt).st_size == len(stamp) and receipt.read_bytes() == stamp


@contextmanager
def remember_partial(part, receipt, entry, worker_checkpoints, resumable):
    if not resumable:
        with os.fdopen(os.open(part, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600), "wb") as stream:
            initial = os.fstat(stream.fileno())
            checkpoint_partial(part, entry["sha256"], [[0, hashlib.sha256(b"").hexdigest()]],
                               previous=False, identity=(initial.st_dev, initial.st_ino))
    else:
        initial = regular_stat(part)
    if resumable and not matches_checkpoint(part, entry["sha256"]):
        # Migrate a legacy timestamp receipt without adopting different bytes
        # if the file was edited during the hash or its receipt changed.
        proof = regular_stat(receipt)
        previous = (proof.st_dev, proof.st_ino, sha256_file(receipt))
        digest = sha256_file(part)
        if not recorded_partial(part, receipt, entry):
            raise ValueError("Partial bytes changed before resuming")
        checkpoint_partial(part, entry["sha256"], [[initial.st_size, digest]], previous=previous,
                           identity=(initial.st_dev, initial.st_ino))
    original_receipt = sha256_file(receipt)
    try:
        yield (initial.st_dev, initial.st_ino), original_receipt
    except BaseException:
        if (not worker_checkpoints and part.exists() and os.path.samestat(regular_stat(part), initial)
                and receipt.is_file() and not is_link(receipt) and sha256_file(receipt) == original_receipt):
            checkpoint_partial(part, entry["sha256"], [[part.stat().st_size, sha256_file(part, reuse=False)]])
        raise


def download_asset(url: str, target: Path, entry: dict, *, cancel=None,
                   progress=lambda _bytes: None, transfer=None, notice=lambda _text: None,
                   fallbacks=(), route=None, on_fallback=lambda _host: None) -> None:
    """Anonymous HTTPS download with a resumable .part file and final SHA-256.

    The official HF transport handles network retries/ranges. Cancellation stops
    its child process, preserving the partial for a subsequent invocation.

    `fallbacks` are other addresses of the same bytes, tried in order only when the host
    is unreachable before any byte arrives. Resuming carries the partial across the
    switch; `route` (a dict shared by a session's downloads) remembers a mirror that worked.
    """
    from urllib.parse import urlsplit

    if urlsplit(url).scheme != "https":
        raise ValueError("Model downloads require HTTPS")
    target = Path(target)
    if is_link(target) or is_link(target.parent):
        raise ValueError("Refusing a symbolic link in the download destination")
    target.parent.mkdir(parents=True, exist_ok=True)
    part = target.with_name(target.name + ".part")
    receipt = part.with_name(part.name + ".resume")
    if is_link(part) or is_link(receipt):
        raise ValueError("Refusing a symbolic link at the partial download")
    if part.exists() and regular_stat(part).st_nlink != 1:
        raise ValueError("Refusing a hardlinked partial download")
    _check_pause(cancel)
    if matches(target, entry):
        if not part.exists() and recorded_partial(part, receipt, entry, current=target, legacy=False):
            receipt.unlink()
        progress(entry["size_bytes"])
        return
    resumable = recorded_partial(part, receipt, entry)
    if not resumable and receipt.exists():
        preserve(receipt, target.parent)
    if part.exists():
        if matches(part, entry):
            if target.exists():
                preserve(target, target.parent)
            part.replace(target)
            if resumable:
                receipt.unlink()
            progress(entry["size_bytes"])
            return
        if not resumable or part.stat().st_size >= entry["size_bytes"]:
            preserve(part, target.parent)
            if resumable:
                preserve(receipt, target.parent)
                resumable = False
    offset = part.stat().st_size if part.exists() else 0
    with remember_partial(part, receipt, entry, worker_checkpoints=transfer is None, resumable=resumable) as (identity, initial_receipt):
        progress(offset)
        transfer = transfer or (lambda *args, **kwargs: transfer_asset(*args, notice=notice, expected=entry["sha256"], identity=identity, **kwargs))
        route = route if route is not None else {}
        sources = [url, *fallbacks]
        if route.get("mirror"):  # the mirror already worked in this session
            sources.sort(key=lambda source: urlsplit(source).hostname != MIRROR_HOST)
        for index, source in enumerate(sources):
            try:
                transfer(source, part, entry["size_bytes"], offset, cancel=cancel, progress=progress)
                break
            except HostUnreachable:
                if index == len(sources) - 1:
                    raise
                offset = part.stat().st_size if part.is_file() else 0
                following = sources[index + 1]
                if urlsplit(following).hostname == MIRROR_HOST:
                    route["mirror"] = True
                    on_fallback(MIRROR_HOST)
                progress(offset)
        _check_pause(cancel)
        if regular_stat(part).st_size < entry["size_bytes"]:
            raise RuntimeError(f"Incomplete download of {entry['path']}; partial bytes retained for retry")
        if not matches(part, entry):
            if recorded_partial(part, receipt, entry, legacy=False):
                part.unlink()
                receipt.unlink()
            else:
                preserve(part, target.parent)
            raise ValueError("Checksum or size mismatch for " + entry["path"])
        owned_receipt = recorded_partial(part, receipt, entry, legacy=False)
        if not owned_receipt and receipt.is_file() and not is_link(receipt):
            owned_receipt = sha256_file(receipt) == initial_receipt
        if target.exists():
            preserve(target, target.parent)
        part.replace(target)
        if owned_receipt:
            receipt.unlink(missing_ok=True)


def remove_verified(root, entries):
    """Remove only exact pinned files, then their empty parent directories."""
    plain_tree(root)
    if not root.exists():
        return
    parents = {root}
    for entry in entries:
        path = root / entry["path"]
        remove_partial(path, entry)
        if matches(path, entry):
            path.unlink()
        parents.update(parent for parent in path.parents if parent.is_relative_to(root))
    for folder in sorted(parents, key=lambda p: -len(p.parts)):
        if folder.is_dir() and not any(folder.iterdir()):
            folder.rmdir()


def remove_partial(target, entry):
    part = target.with_name(target.name + ".part")
    receipt = part.with_name(part.name + ".resume")
    if part.exists():
        if matches_checkpoint(part, entry["sha256"]):
            part.unlink()
            receipt.unlink()
        elif matches(part, entry):
            part.unlink()
    elif target.exists() and matches_checkpoint(part, entry["sha256"], current=target):
        receipt.unlink()


def remove_model_trees(model_dir, entries):
    for name in (model_dir.name, ".incoming-" + model_dir.name, model_dir.name + ".old"):
        remove_verified(model_dir.with_name(name), entries)
    lock = model_dir.with_name("." + model_dir.name + ".download.lock")
    receipt = lock.with_name(lock.name + ".receipt.json")
    try:
        info = regular_stat(lock)
        expected = {"path": str(lock.absolute()), "device": info.st_dev, "inode": info.st_ino}
        if (info.st_nlink == 1 and info.st_size == 0 and read_json(receipt, max_bytes=4096) == expected
                and receipt.read_bytes() == json.dumps(expected, indent=2).encode("utf-8")):
            lock.unlink()
            receipt.unlink()
    except (FileNotFoundError, UnicodeError, ValueError):
        pass


def preserve(path, directory):
    kept = Path(tempfile.mkdtemp(prefix=".preserved-", dir=directory))
    path.rename(kept / path.name)
    print(f"Kept unverified files in {kept}", file=sys.stderr)


def retire_download_tree(folder, entries):
    remove_verified(folder, entries)
    if folder.exists():
        preserve(folder, folder.parent)


def install_streaming(model_dir: Path, pin: dict, *, selected_paths=None, cancel=None,
                      progress=lambda _received, _total, _file: None, transfer=None,
                      notice=lambda _text: None, on_fallback=lambda _host: None, route=None) -> None:
    """Install pinned files with progress and cooperative pause; no stdout.

    None selects the whole pin. Otherwise only the selected files are required;
    valid installed variants outside that selection are preserved by hardlink.
    Unselected staging leftovers are never promoted. Hub tokens and offline
    inference environment flags are irrelevant to this explicit HTTPS operation.
    """
    from filelock import FileLock
    from urllib.parse import quote

    entries = selected_entries(pin, selected_paths)  # reject invalid scope before any mutation
    selected = {entry["path"] for entry in entries}
    model_dir = Path(model_dir).absolute()
    if model_dir in (Path(model_dir.anchor), Path.home()) or is_link(model_dir.parent):
        raise ValueError("Choose a dedicated, non-symlink model directory")
    model_dir.parent.mkdir(parents=True, exist_ok=True)
    incoming = model_dir.with_name(".incoming-" + model_dir.name)
    backup = model_dir.with_name(model_dir.name + ".old")
    lock_path = model_dir.with_name("." + model_dir.name + ".download.lock")
    if is_link(lock_path):
        raise ValueError("Refusing a symbolic link at the download lock")
    if lock_path.exists() and (regular_stat(lock_path).st_nlink != 1 or lock_path.stat().st_size != 0):
        raise ValueError("Refusing a hardlinked or nonempty download lock")
    # Existing locks may belong to another process or predate ownership receipts.
    # Only a lock this invocation created exclusively gets a removal receipt.
    try:
        with os.fdopen(os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600), "wb") as stream:
            info = os.fstat(stream.fileno())
        receipt = lock_path.with_name(lock_path.name + ".receipt.json")
        if not receipt.exists() and not is_link(receipt):
            atomic_json(receipt, {"path": str(lock_path), "device": info.st_dev, "inode": info.st_ino}, previous=False)
    except FileExistsError:
        pass
    total = sum(entry["size_bytes"] for entry in entries)
    received = 0
    route = route if route is not None else {}
    with FileLock(str(lock_path), timeout=0, preserve_lock_file=True):
        for folder in (model_dir, incoming, backup):
            plain_tree(folder)
        if backup.exists() and not model_dir.exists():
            backup.rename(model_dir)
        if not invalid_files(model_dir, pin, selected):
            for folder in (incoming, backup):
                if folder.exists():
                    retire_download_tree(folder, pin["files"])
            progress(total, total, None)
            return
        known = {e["path"] for e in pin["files"]}
        if model_dir.is_dir():
            for path in model_dir.rglob("*"):
                if path.is_file() and path.relative_to(model_dir).as_posix() not in known:
                    raise ValueError(f"Model update stopped to preserve an unrelated file: {path}")
        incoming.mkdir(exist_ok=True)
        # A previously expanded download may have paused before the user chose a
        # smaller pack. Only the new selection's files/partials may be resumed.
        prune_staging(incoming, {name + suffix for name in selected for suffix in ("", ".part", ".part.resume")}, pin)
        retained = []
        for entry in pin["files"]:
            _check_pause(cancel)
            if entry["path"] not in selected and matches(model_dir / entry["path"], entry):
                if not matches(incoming / entry["path"], entry):
                    reuse(model_dir / entry["path"], incoming / entry["path"])
                retained.append(entry["path"])
        for entry in entries:
            _check_pause(cancel)
            name = entry["path"]
            target = incoming / name
            progress(received, total, name)
            if not matches(target, entry) and matches(model_dir / name, entry):
                reuse(model_dir / name, target)
            if not matches(target, entry):
                part = target.with_name(target.name + ".part")
                staged_bytes = part.stat().st_size if part.is_file() and not part.is_symlink() else 0
                if staged_bytes and not matches(part, entry) and (staged_bytes >= entry["size_bytes"] or not recorded_partial(part, part.with_name(part.name + ".resume"), entry)):
                    staged_bytes = 0
                needed = max(0, entry["size_bytes"] - staged_bytes) + 64 * 1024 * 1024
                if shutil.disk_usage(model_dir.parent).free < needed:
                    raise ValueError("Not enough free disk space to stage " + name)
                url = (f"https://huggingface.co/{pin['repository']}/resolve/{pin['revision']}/"
                       + quote(name, safe="/"))
                download_asset(url, target, entry, cancel=cancel, transfer=transfer, notice=notice,
                               fallbacks=[] if "release" in pin else [mirror_of(url)], route=route, on_fallback=on_fallback,
                               progress=lambda count, base=received, name=name: progress(base + count, total, name))
            received += entry["size_bytes"]
            progress(received, total, name)
        _check_pause(cancel)
        committed = selected | set(retained)
        # No partial, unpinned file or merely staged unselected variant becomes an
        # installed model. Verify the retained files again before atomic promotion.
        prune_staging(incoming, committed, pin)
        if invalid_files(incoming, pin, committed):
            raise ValueError("Modelkit verification failed; nothing was replaced")
        if backup.exists():
            retire_download_tree(backup, pin["files"])
        if model_dir.exists():
            model_dir.rename(backup)
        try:
            incoming.rename(model_dir)
        except BaseException:
            if backup.exists() and not model_dir.exists():
                backup.rename(model_dir)
            raise
        if backup.exists():
            retire_download_tree(backup, pin["files"])
        progress(total, total, None)


def load_pin(path: Path) -> dict:
    return validate_pin(json.loads(path.read_text()))


def validate_pin(pin: dict) -> dict:
    if (not isinstance(pin, dict) or type(pin.get("schema_version")) is not int or pin["schema_version"] != 1
            or not isinstance(pin.get("repository"), str) or not isinstance(pin.get("revision"), str)
            or not re.fullmatch(r"[\w.-]+/[\w.-]+", pin.get("repository", ""))
            or not re.fullmatch(r"[0-9a-f]{40}", pin.get("revision", ""))
            or not isinstance(pin.get("files"), list) or not pin["files"]):
        raise ValueError("Invalid pinned modelkit manifest")
    seen = set()
    for entry in pin["files"]:
        if not isinstance(entry, dict):
            raise ValueError("Invalid pinned modelkit file entry")
        name = entry.get("path", "")
        if not isinstance(name, str):
            raise ValueError("Invalid pinned modelkit file path")
        parts = PurePosixPath(name).parts
        if (not parts or PurePosixPath(name).is_absolute() or ".." in parts
                or "\\" in name or ":" in name or name != PurePosixPath(name).as_posix()
                or any(p.startswith(".") for p in parts) or name in seen
                or not isinstance(entry.get("sha256"), str)
                or not re.fullmatch(r"[0-9a-f]{64}", entry.get("sha256", ""))
                or type(entry.get("size_bytes")) is not int or entry["size_bytes"] < 0):
            raise ValueError("Invalid pinned modelkit file entry: " + name)
        seen.add(name)
    return pin


def selected_entries(pin: dict, selected_paths=None) -> list[dict]:
    """Resolve a nonempty explicit subset in pin order, without touching disk."""
    validate_pin(pin)
    if selected_paths is None:
        return pin["files"]
    if not isinstance(selected_paths, (list, tuple, set, frozenset)) or not selected_paths:
        raise ValueError("Selected model paths must be a nonempty collection of pinned paths")
    if any(not isinstance(name, str) for name in selected_paths):
        raise ValueError("Selected model paths must be strings")
    selected = set(selected_paths)
    if len(selected) != len(selected_paths):
        raise ValueError("Duplicate selected model paths")
    unknown = selected - {entry["path"] for entry in pin["files"]}
    if unknown:
        raise ValueError("Selected paths are not pinned: " + ", ".join(sorted(unknown)))
    return [entry for entry in pin["files"] if entry["path"] in selected]


def prune_staging(root: Path, allowed: set[str], pin) -> None:
    """Only verified surplus artifacts may be discarded from an earlier staging area."""
    entries = {e["path"]: e for e in pin["files"]}
    for name, entry in entries.items():
        if name + ".part" not in allowed:
            remove_partial(root / name, entry)
    for folder, dirs, files in os.walk(root, topdown=False):
        for name in files:
            path = Path(folder) / name
            relative = path.relative_to(root).as_posix()
            if relative not in allowed:
                if relative in entries and matches(path, entries[relative]):
                    path.unlink()
                else:
                    preserve(path, root.parent)
        for name in dirs:
            path = Path(folder) / name
            if not any(path.iterdir()):
                path.rmdir()


def plain_tree(root: Path) -> None:
    """Reject links before reading, writing or removing a model/staging tree."""
    if is_link(root) or root.is_mount():
        raise ValueError(f"{root} is a symbolic link — refusing to use it")
    if root.exists():
        if not root.is_dir():
            raise ValueError(f"{root} is not a directory")
        for folder, dirs, files in os.walk(root):
            for name in dirs + files:
                path = Path(folder) / name
                if is_link(path) or (path.is_dir() and path.is_mount()):
                    raise ValueError(f"{path} is a symbolic link — refusing to use it")
                if not path.is_dir() and not path.is_file():
                    raise ValueError(f"{path} is not a regular model file")


def matches(path: Path, entry: dict) -> bool:
    if is_link(path) or not path.is_file() or path.stat().st_size != entry["size_bytes"]:
        return False
    try:
        return sha256_file(path, reuse=False) == entry["sha256"]
    except ValueError:
        return False  # bytes that changed while being read are not verified


def invalid_files(root: Path, pin: dict, selected_paths=None) -> list[str]:
    entries = selected_entries(pin, selected_paths)
    root = Path(root)
    plain_tree(root)
    return [entry["path"] for entry in entries if not matches(root / entry["path"], entry)]


def reuse(source: Path, target: Path) -> None:
    """Reuse verified bytes without duplicating gigabytes on the same filesystem."""
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        preserve(target, target.parent)
    try:
        os.link(source, target)
    except OSError:
        shutil.copyfile(source, target)


def installed_profile(model_dir: Path) -> str:
    """Read the installed preference without importing or starting the native host."""
    home = Path(model_dir).absolute().parent.parent
    path = home / "component-state.json"
    if home.is_symlink() or path.is_symlink():
        raise ValueError("Component preferences are a symbolic link")
    try:
        if not path.is_file():
            if not path.exists():
                return "recommended"
            raise ValueError("Component preferences are not a regular file")
        with path.open("rb") as stream:
            data = stream.read(65537)
    except FileNotFoundError:
        return "recommended"
    if len(data) > 65536:
        raise ValueError("Component preferences exceed the size limit")
    def reject_constant(_value):
        raise ValueError("Invalid JSON constant in component preferences")
    def unique_object(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("Duplicate field in component preferences")
            result[key] = value
        return result
    saved = json.loads(data, parse_constant=reject_constant, object_pairs_hook=unique_object)
    if isinstance(saved, dict) and "model_profile" not in saved:
        saved["model_profile"] = "recommended"  # older preferences predate the field
    flags = {"initialized", "download_pending", "download_paused", "download_failed", "engine_stopped", "models_deleted"}
    if (not isinstance(saved, dict) or set(saved) != flags | {"schema_version", "idle_unload_s", "model_profile"}
            or type(saved["schema_version"]) is not int or saved["schema_version"] != 1
            or any(type(saved[key]) is not bool for key in flags)
            or not valid_idle(saved["idle_unload_s"])
            or saved["model_profile"] not in ("recommended", "expanded")):
        raise ValueError("Invalid component preferences; reconnect Anagram and choose the model profile explicitly")
    return saved["model_profile"]


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify local pinned model files without downloading or changing them")
    parser.add_argument("--model-dir", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, default=PIN,
                        help="Pinned local manifest (defaults to the copy shipped with Anagram)")
    parser.add_argument("--lid-model", type=Path, help="Also verify this local fastText model")
    scope = parser.add_mutually_exclusive_group()
    scope.add_argument("--profile", choices=("installed", "recommended", "expanded", "all"),
                       help="Verify the installed profile (default), a device-specific pack, or every pinned file")
    scope.add_argument("--all", dest="profile", action="store_const", const="all",
                       help="Verify every pinned file without hardware discovery")
    parser.set_defaults(profile="installed")
    args = parser.parse_args()
    try:
        pin = load_pin(args.manifest)
        profile = installed_profile(args.model_dir) if args.profile == "installed" else args.profile
        selected_paths = None
        if profile != "all":
            from model_plan import build_plan, discover_hardware
            selected_paths = build_plan(pin, discover_hardware(), profile=profile)["selected_paths"]
        entries = selected_entries(pin, selected_paths)
        invalid = invalid_files(args.model_dir, pin, selected_paths)
        if invalid:
            raise ValueError("Missing or invalid modelkit files: " + ", ".join(invalid))
        if args.lid_model and not matches(args.lid_model, LID_ENTRY):
            raise ValueError("Missing or invalid language model: " + str(args.lid_model))
        label = f"installed: {profile}" if args.profile == "installed" else profile
        print(f"All {len(entries)} pinned modelkit files verified ({label})")
    except Exception as exc:
        print("Model verification failed: " + str(exc), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
