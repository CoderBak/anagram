"""Install selected pinned EditLens files, verifying the transaction before replacement.

The models retain Pangram's CC BY-NC-SA 4.0 license. Downloads are anonymous;
no account, saved Hugging Face token, or upstream access approval is required.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import sys
import subprocess
import threading
import queue
from safe_files import is_link, regular_stat

PIN = Path(__file__).with_name("modelkit.json")
LID_URL = "https://dl.fbaipublicfiles.com/fasttext/supervised-models/lid.176.ftz"
LID_ENTRY = {"path": "lid.176.ftz", "size_bytes": 938013,
             "sha256": "8f3472cfe8738a7b6099e8e999c3cbfae0dcd15696aac7d7738a8039db603e83"}


class DownloadPaused(Exception):
    """The caller requested a cooperative pause; verified/staged bytes remain."""


def _check_pause(cancel):
    if cancel is not None and cancel.is_set():
        raise DownloadPaused("Download paused")


def transfer_asset(url, part, size, offset, *, cancel, progress, notice=lambda _text: None):
    """Run the official transport outside the offline inference interpreter."""
    process = subprocess.Popen([sys.executable, "-I", str(Path(__file__).with_name("hub_transfer.py"))],
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
        process.stdin.write(json.dumps({"url": url, "part": str(part), "size": size, "offset": offset}) + "\n")
        process.stdin.flush()  # pipe stays open as the worker's parent-lifetime signal
        reader.start()
        error = None
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
            elif "bytes" in event:
                progress(event["bytes"])
            elif "message" in event:
                notice(event["message"])
        if process.wait() != 0:
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


def download_asset(url: str, target: Path, entry: dict, *, cancel=None,
                   progress=lambda _bytes: None, transfer=None, notice=lambda _text: None) -> None:
    """Anonymous HTTPS download with a resumable .part file and final SHA-256.

    The official HF transport handles network retries/ranges. Cancellation stops
    its child process, preserving the partial for a subsequent invocation.
    """
    from urllib.parse import urlsplit

    if urlsplit(url).scheme != "https":
        raise ValueError("Model downloads require HTTPS")
    target = Path(target)
    if is_link(target) or is_link(target.parent):
        raise ValueError("Refusing a symbolic link in the download destination")
    target.parent.mkdir(parents=True, exist_ok=True)
    part = target.with_name(target.name + ".part")
    if is_link(part):
        raise ValueError("Refusing a symbolic link at the partial download")
    if part.exists() and regular_stat(part).st_nlink != 1:
        raise ValueError("Refusing a hardlinked partial download")
    _check_pause(cancel)
    if matches(target, entry):
        progress(entry["size_bytes"])
        return
    if part.exists() and (not part.is_file() or part.stat().st_size > entry["size_bytes"]):
        if not part.is_file():
            raise ValueError("Partial download is not a regular file")
        part.unlink()
    offset = part.stat().st_size if part.exists() else 0
    if offset == entry["size_bytes"]:
        if matches(part, entry):
            part.replace(target)
            progress(offset)
            return
        part.unlink()
        offset = 0
    progress(offset)
    transfer = transfer or (lambda *args, **kwargs: transfer_asset(*args, notice=notice, **kwargs))
    transfer(url, part, entry["size_bytes"], offset, cancel=cancel, progress=progress)
    _check_pause(cancel)
    if regular_stat(part).st_size < entry["size_bytes"]:
        raise RuntimeError(f"Incomplete download of {entry['path']}; partial bytes retained for retry")
    if not matches(part, entry):
        part.unlink(missing_ok=True)
        raise ValueError("Checksum or size mismatch for " + entry["path"])
    part.replace(target)


def install_streaming(model_dir: Path, pin: dict, *, selected_paths=None, cancel=None,
                      progress=lambda _received, _total, _file: None, transfer=None,
                      notice=lambda _text: None) -> None:
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
    if lock_path.exists() and regular_stat(lock_path).st_nlink != 1:
        raise ValueError("Refusing a hardlinked download lock")
    total = sum(entry["size_bytes"] for entry in entries)
    received = 0
    with FileLock(str(lock_path), timeout=0):
        for folder in (model_dir, incoming, backup):
            plain_tree(folder)
        if backup.exists() and not model_dir.exists():
            backup.rename(model_dir)
        if not invalid_files(model_dir, pin, selected):
            for folder in (incoming, backup):
                if folder.exists():
                    shutil.rmtree(folder)
            progress(total, total, None)
            return
        incoming.mkdir(exist_ok=True)
        # A previously expanded download may have paused before the user chose a
        # smaller pack. Only the new selection's files/partials may be resumed.
        prune_staging(incoming, selected | {name + ".part" for name in selected})
        retained = []
        for entry in pin["files"]:
            _check_pause(cancel)
            if entry["path"] not in selected and matches(model_dir / entry["path"], entry):
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
                if staged_bytes > entry["size_bytes"] or (staged_bytes == entry["size_bytes"] and not matches(part, entry)):
                    staged_bytes = 0
                needed = max(0, entry["size_bytes"] - staged_bytes) + 64 * 1024 * 1024
                if shutil.disk_usage(model_dir.parent).free < needed:
                    raise ValueError("Not enough free disk space to stage " + name)
                url = (f"https://huggingface.co/{pin['repository']}/resolve/{pin['revision']}/"
                       + quote(name, safe="/"))
                download_asset(url, target, entry, cancel=cancel, transfer=transfer, notice=notice,
                               progress=lambda count, base=received, name=name: progress(base + count, total, name))
            received += entry["size_bytes"]
            progress(received, total, name)
        _check_pause(cancel)
        committed = selected | set(retained)
        # No partial, unpinned file or merely staged unselected variant becomes an
        # installed model. Verify the retained files again before atomic promotion.
        prune_staging(incoming, committed)
        if invalid_files(incoming, pin, committed):
            raise ValueError("Modelkit verification failed; nothing was replaced")
        if backup.exists():
            shutil.rmtree(backup)
        if model_dir.exists():
            model_dir.rename(backup)
        try:
            incoming.rename(model_dir)
        except BaseException:
            if backup.exists() and not model_dir.exists():
                backup.rename(model_dir)
            raise
        if backup.exists():
            shutil.rmtree(backup)
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


def prune_staging(root: Path, allowed: set[str]) -> None:
    """Discard staging artifacts outside the current transaction's exact scope."""
    for folder, dirs, files in os.walk(root, topdown=False):
        for name in files:
            path = Path(folder) / name
            if path.relative_to(root).as_posix() not in allowed:
                path.unlink()
        for name in dirs:
            path = Path(folder) / name
            if not any(path.iterdir()):
                path.rmdir()


def plain_tree(root: Path) -> None:
    """Reject links before reading, writing or removing a model/staging tree."""
    if is_link(root):
        raise ValueError(f"{root} is a symbolic link — refusing to use it")
    if root.exists():
        if not root.is_dir():
            raise ValueError(f"{root} is not a directory")
        for folder, dirs, files in os.walk(root):
            for name in dirs + files:
                path = Path(folder) / name
                if is_link(path):
                    raise ValueError(f"{path} is a symbolic link — refusing to use it")
                if not path.is_dir() and not path.is_file():
                    raise ValueError(f"{path} is not a regular model file")


def matches(path: Path, entry: dict) -> bool:
    if is_link(path) or not path.is_file() or path.stat().st_size != entry["size_bytes"]:
        return False
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest() == entry["sha256"]


def invalid_files(root: Path, pin: dict, selected_paths=None) -> list[str]:
    entries = selected_entries(pin, selected_paths)
    root = Path(root)
    plain_tree(root)
    return [entry["path"] for entry in entries if not matches(root / entry["path"], entry)]


def reuse(source: Path, target: Path) -> None:
    """Reuse verified bytes without duplicating gigabytes on the same filesystem."""
    target.parent.mkdir(parents=True, exist_ok=True)
    target.unlink(missing_ok=True)
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
            or type(saved["idle_unload_s"]) is not int
            or (saved["idle_unload_s"] != 0 and not 60 <= saved["idle_unload_s"] <= 86400)
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
