"""Install the pinned public EditLens modelkit, verifying every file before replacement.

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

PIN = Path(__file__).with_name("modelkit.json")
LID_URL = "https://dl.fbaipublicfiles.com/fasttext/supervised-models/lid.176.ftz"
LID_ENTRY = {"path": "lid.176.ftz", "size_bytes": 938013,
             "sha256": "8f3472cfe8738a7b6099e8e999c3cbfae0dcd15696aac7d7738a8039db603e83"}


class DownloadPaused(Exception):
    """The caller requested a cooperative pause; verified/staged bytes remain."""


def _check_pause(cancel):
    if cancel is not None and cancel.is_set():
        raise DownloadPaused("Download paused")


def _https_open(request, timeout=10):
    from urllib.request import HTTPRedirectHandler, build_opener
    from urllib.parse import urlsplit

    class HTTPSOnly(HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            if urlsplit(newurl).scheme != "https":
                raise ValueError("Refusing a non-HTTPS model download redirect")
            return super().redirect_request(req, fp, code, msg, headers, newurl)

    return build_opener(HTTPSOnly()).open(request, timeout=timeout)


def download_asset(url: str, target: Path, entry: dict, *, cancel=None,
                   progress=lambda _bytes: None, opener=None) -> None:
    """Anonymous HTTPS download with a resumable .part file and final SHA-256.

    Pause is checked between bounded reads; a pending network read has a 10s
    timeout. A server ignoring Range safely restarts that file. No partial file
    replaces a verified installed file. The URL comes only from shipped pins.
    """
    from urllib.request import Request
    from urllib.parse import urlsplit

    if urlsplit(url).scheme != "https":
        raise ValueError("Model downloads require HTTPS")
    target = Path(target)
    if target.is_symlink() or target.parent.is_symlink():
        raise ValueError("Refusing a symbolic link in the download destination")
    target.parent.mkdir(parents=True, exist_ok=True)
    part = target.with_name(target.name + ".part")
    if part.is_symlink():
        raise ValueError("Refusing a symbolic link at the partial download")
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
    headers = {"User-Agent": "Anagram-modelkit/1", "Accept-Encoding": "identity"}
    if offset:
        headers["Range"] = f"bytes={offset}-"
    request = Request(url, headers=headers)
    with (opener or _https_open)(request, timeout=10) as response:
        status = response.status
        if status == 206:
            content_range = response.headers.get("Content-Range", "")
            match = re.fullmatch(r"bytes (\d+)-(\d+)/(\d+)", content_range)
            if (not match or int(match[1]) != offset or int(match[3]) != entry["size_bytes"]
                    or int(match[2]) != entry["size_bytes"] - 1):
                raise ValueError("Unexpected range response for pinned model file")
        elif status == 200:
            offset = 0  # this server ignored Range; truncate instead of appending
            progress(0)
        else:
            raise ValueError(f"Model download returned HTTP {status}")
        with part.open("ab" if offset else "wb") as stream:
            reader = getattr(response, "read1", response.read)
            while True:
                _check_pause(cancel)
                chunk = reader(64 * 1024)
                if not chunk:
                    break
                if offset + len(chunk) > entry["size_bytes"]:
                    raise ValueError("Download exceeds the pinned file size")
                stream.write(chunk)
                offset += len(chunk)
                progress(offset)
            stream.flush()
            os.fsync(stream.fileno())
    _check_pause(cancel)
    if not matches(part, entry):
        part.unlink(missing_ok=True)
        raise ValueError("Checksum or size mismatch for " + entry["path"])
    part.replace(target)


def install_streaming(model_dir: Path, pin: dict, *, cancel=None,
                      progress=lambda _received, _total, _file: None, opener=None) -> None:
    """Install pinned files with progress and cooperative pause; no stdout.

    Existing verified installed/staged files are reused. The staged tree commits
    only after every pinned variant passes verification. Hub tokens and offline
    inference environment flags are irrelevant to this explicit HTTPS operation.
    """
    from filelock import FileLock
    from urllib.parse import quote

    model_dir = Path(model_dir).absolute()
    if model_dir in (Path(model_dir.anchor), Path.home()) or model_dir.parent.is_symlink():
        raise ValueError("Choose a dedicated, non-symlink model directory")
    model_dir.parent.mkdir(parents=True, exist_ok=True)
    incoming = model_dir.with_name(".incoming-" + model_dir.name)
    backup = model_dir.with_name(model_dir.name + ".old")
    lock_path = model_dir.with_name("." + model_dir.name + ".download.lock")
    if lock_path.is_symlink():
        raise ValueError("Refusing a symbolic link at the download lock")
    total = sum(entry["size_bytes"] for entry in pin["files"])
    received = 0
    with FileLock(str(lock_path), timeout=0):
        for folder in (model_dir, incoming, backup):
            plain_tree(folder)
        if backup.exists() and not model_dir.exists():
            backup.rename(model_dir)
        if not invalid_files(model_dir, pin):
            for folder in (incoming, backup):
                if folder.exists():
                    shutil.rmtree(folder)
            progress(total, total, None)
            return
        incoming.mkdir(exist_ok=True)
        for entry in pin["files"]:
            _check_pause(cancel)
            name = entry["path"]
            target = incoming / name
            progress(received, total, name)
            if not matches(target, entry) and matches(model_dir / name, entry):
                reuse(model_dir / name, target)
            if not matches(target, entry):
                part = target.with_name(target.name + ".part")
                staged_bytes = part.stat().st_size if part.is_file() and not part.is_symlink() else 0
                needed = max(0, entry["size_bytes"] - staged_bytes) + 64 * 1024 * 1024
                if shutil.disk_usage(model_dir.parent).free < needed:
                    raise ValueError("Not enough free disk space to stage " + name)
                url = (f"https://huggingface.co/{pin['repository']}/resolve/{pin['revision']}/"
                       + quote(name, safe="/"))
                download_asset(url, target, entry, cancel=cancel, opener=opener,
                               progress=lambda count, base=received, name=name: progress(base + count, total, name))
            received += entry["size_bytes"]
            progress(received, total, name)
        _check_pause(cancel)
        if invalid_files(incoming, pin):
            raise ValueError("Modelkit verification failed; nothing was replaced")
        # Metadata from an older HF downloader is not part of the modelkit.
        if (incoming / ".cache").exists():
            shutil.rmtree(incoming / ".cache")
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
    pin = json.loads(path.read_text())
    if (pin.get("schema_version") != 1
            or not re.fullmatch(r"[\w.-]+/[\w.-]+", pin.get("repository", ""))
            or not re.fullmatch(r"[0-9a-f]{40}", pin.get("revision", ""))
            or not isinstance(pin.get("files"), list) or not pin["files"]):
        raise ValueError("Invalid pinned modelkit manifest")
    seen = set()
    for entry in pin["files"]:
        name = entry.get("path", "")
        parts = PurePosixPath(name).parts
        if (not parts or PurePosixPath(name).is_absolute() or ".." in parts
                or "\\" in name or ":" in name or name != PurePosixPath(name).as_posix()
                or any(p.startswith(".") for p in parts) or name in seen
                or not re.fullmatch(r"[0-9a-f]{64}", entry.get("sha256", ""))
                or type(entry.get("size_bytes")) is not int or entry["size_bytes"] < 0):
            raise ValueError("Invalid pinned modelkit file entry: " + name)
        seen.add(name)
    return pin


def plain_tree(root: Path) -> None:
    """Reject links before reading, writing or removing a model/staging tree."""
    if root.is_symlink():
        raise ValueError(f"{root} is a symbolic link — refusing to use it")
    if root.exists():
        if not root.is_dir():
            raise ValueError(f"{root} is not a directory")
        for folder, dirs, files in os.walk(root):
            for name in dirs + files:
                path = Path(folder) / name
                if path.is_symlink():
                    raise ValueError(f"{path} is a symbolic link — refusing to use it")


def matches(path: Path, entry: dict) -> bool:
    if path.is_symlink() or not path.is_file() or path.stat().st_size != entry["size_bytes"]:
        return False
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest() == entry["sha256"]


def invalid_files(root: Path, pin: dict) -> list[str]:
    plain_tree(root)
    return [entry["path"] for entry in pin["files"] if not matches(root / entry["path"], entry)]


def reuse(source: Path, target: Path) -> None:
    """Reuse verified bytes without duplicating gigabytes on the same filesystem."""
    target.parent.mkdir(parents=True, exist_ok=True)
    target.unlink(missing_ok=True)
    try:
        os.link(source, target)
    except OSError:
        shutil.copyfile(source, target)


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify local pinned model files without downloading or changing them")
    parser.add_argument("--model-dir", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, default=PIN,
                        help="Pinned local manifest (defaults to the copy shipped with Anagram)")
    parser.add_argument("--lid-model", type=Path, help="Also verify this local fastText model")
    args = parser.parse_args()
    try:
        pin = load_pin(args.manifest)
        invalid = invalid_files(args.model_dir, pin)
        if invalid:
            raise ValueError("Missing or invalid modelkit files: " + ", ".join(invalid))
        if args.lid_model and not matches(args.lid_model, LID_ENTRY):
            raise ValueError("Missing or invalid language model: " + str(args.lid_model))
        print(f"All {len(pin['files'])} pinned modelkit files verified")
    except Exception as exc:
        print("Model verification failed: " + str(exc), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
