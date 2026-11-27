"""Isolated Hugging Face HTTP transport; inference remains offline in its parent.

The locked Hub release's high-level downloader discards partials between runs.
Use its HTTP retry/range implementation with Anagram's durable, guarded partial
file instead. No Hub login, global cache, Xet staging copy or raw-text input.
"""
from __future__ import annotations

import json
import hashlib
import logging
import os
from pathlib import Path
import re
import sys
import time
import threading
from urllib.parse import urlsplit

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from safe_files import checkpoint_partial, matches_checkpoint, open_partial, regular_stat, sha256_file


def safe_error(exc):
    # CDN redirects may contain temporary signatures. Never persist their query.
    return re.sub(r"https?://[^\s'\"<>]+", lambda m: m[0].split("?")[0], str(exc))[:1500]


class Unreachable(Exception):
    """The host could not be reached: no byte arrived, over a network error, timeout or 5xx."""


class CheckpointWriter:
    """Record both sides of each chunk write, so a stopped process leaves verifiable bytes."""

    def __init__(self, stream, part, expected, enforce_checkpoint=False):
        self.stream, self.part, self.expected = stream, part, expected
        self.count = -1
        self.enforce_checkpoint = enforce_checkpoint
        self.last_write = regular_stat(part)
        info = os.fstat(stream.fileno())
        self.identity = (info.st_dev, info.st_ino)
        receipt = part.with_name(part.name + ".resume")
        if receipt.exists():
            if not matches_checkpoint(part, expected):
                raise ValueError("Partial checkpoint changed before transfer")
            info = regular_stat(receipt)
            self.receipt = (info.st_dev, info.st_ino, sha256_file(receipt))
        else:
            self.receipt = False

    def __getattr__(self, name):
        return getattr(self.stream, name)

    def check_destination(self):
        current = regular_stat(self.part)
        if (not os.path.samestat(current, os.fstat(self.stream.fileno())) or not os.path.samestat(current, self.last_write)
                or current.st_nlink != 1
                or (current.st_size, current.st_mtime_ns, current.st_ctime_ns) !=
                   (self.last_write.st_size, self.last_write.st_mtime_ns, self.last_write.st_ctime_ns)):
            raise ValueError("Partial file changed during transfer")

    def truncate(self, size=None):
        size = self.stream.tell() if size is None else size
        self.check_destination()
        if size != 0:
            raise ValueError("Refusing an unexpected truncation of partial bytes")
        if self.enforce_checkpoint and not matches_checkpoint(self.part, self.expected):
            raise ValueError("Partial bytes changed before the HTTP range restart")
        previous = [os.fstat(self.stream.fileno()).st_size, sha256_file(self.part)]
        self.digest, self.count = hashlib.sha256(), 0
        self.receipt = checkpoint_partial(self.part, self.expected, [[0, self.digest.hexdigest()], previous],
                                          previous=self.receipt, identity=self.identity)
        truncated = self.stream.truncate(0)
        self.last_write = regular_stat(self.part)
        return truncated

    def write(self, data):
        stream = self.stream
        position = stream.tell()
        if position != self.count:  # first write, or HTTP restarted an ignored Range
            if self.enforce_checkpoint and not matches_checkpoint(self.part, self.expected):
                raise ValueError("Partial bytes changed before resuming the download")
            self.digest = hashlib.sha256()
            if position:
                stream.seek(0)
                while stream.tell() < position:
                    block = stream.read(min(1024 * 1024, position - stream.tell()))
                    if not block:
                        raise ValueError("Partial file changed before a resumed write")
                    self.digest.update(block)
            self.count = position
        previous = [self.count, self.digest.hexdigest()]
        self.count += len(data)
        self.digest.update(data)
        self.check_destination()
        self.receipt = checkpoint_partial(self.part, self.expected, [[self.count, self.digest.hexdigest()], previous],
                                          previous=self.receipt, identity=self.identity)
        written = stream.write(data)
        stream.flush()
        self.last_write = regular_stat(self.part)
        return written


def transfer(url, part, size, offset, progress, *, client_factory=None, sleep=time.sleep, expected=None, identity=None):
    import httpx
    from huggingface_hub import set_client_factory
    from huggingface_hub.errors import HfHubHTTPError
    from huggingface_hub.file_download import http_get
    from huggingface_hub.utils import tqdm

    def https_only(request):
        if request.url.scheme != "https":
            raise ValueError("Refusing a non-HTTPS model download redirect")

    if urlsplit(url).scheme != "https":
        raise ValueError("Model downloads require HTTPS")
    def make_client():
        client = client_factory() if client_factory else httpx.Client(
            follow_redirects=True, timeout=httpx.Timeout(60, connect=20))
        client.event_hooks["request"].append(https_only)
        return client
    set_client_factory(make_client)

    class Progress(tqdm):
        def __init__(self, *args, **kwargs):
            kwargs.update(disable=False, file=sys.stderr, mininterval=1)
            super().__init__(*args, **kwargs)
            progress(int(self.n))

        def update(self, n=1):
            if self.n + n > size:
                raise ValueError("Download exceeds the pinned file size")
            result = super().update(n)
            progress(int(self.n))
            return result

    # HF handles timeouts, connection errors, HTTP retries and ignored ranges.
    # Our file handle preserves the cross-process resume and no-follow policy.
    start = offset
    for attempt in range(3):
        try:
            with open_partial(part, offset, identity=identity) as stream:
                destination = CheckpointWriter(stream, part, expected, enforce_checkpoint=identity is not None) if expected else stream
                http_get(url, destination, resume_size=offset, expected_size=size,
                         displayed_filename=part.name.removesuffix(".part"),
                         headers={"User-Agent": "Anagram-modelkit/1", "Accept-Encoding": "identity"},
                         tqdm_class=Progress)
                stream.flush()
                os.fsync(stream.fileno())
            return
        except Exception as exc:
            transient = isinstance(exc, (httpx.TransportError,)) or (
                isinstance(exc, HfHubHTTPError) and exc.response.status_code in (408, 429, 500, 502, 503, 504))
            short = isinstance(exc, OSError) and exc.errno is None and str(exc).startswith("Consistency check failed")
            if attempt == 2 or not (transient or short):
                unreachable = isinstance(exc, httpx.TransportError) or (
                    isinstance(exc, HfHubHTTPError) and exc.response.status_code >= 500)
                if unreachable and (part.stat().st_size if part.exists() else 0) == start:
                    raise Unreachable(safe_error(exc)) from exc
                raise
            offset = part.stat().st_size
            logging.warning("Retry %s/2 in %ss; %s bytes retained: %s", attempt + 1, 2 ** attempt,
                            offset, safe_error(exc))
            sleep(2 ** attempt)


def main():
    request = json.loads(sys.stdin.buffer.readline(16384))
    def parent_closed():
        os.read(sys.stdin.fileno(), 1)
        os._exit(1)
    threading.Thread(target=parent_closed, daemon=True).start()
    for key in ("HF_HUB_OFFLINE", "HF_TOKEN", "HUGGING_FACE_HUB_TOKEN", "HUGGINGFACE_HUB_TOKEN"):
        os.environ.pop(key, None)
    os.environ.update(HF_HUB_DISABLE_TELEMETRY="1", HF_HUB_DISABLE_IMPLICIT_TOKEN="1",
                      HF_HUB_DOWNLOAD_TIMEOUT="60", HF_HUB_ETAG_TIMEOUT="30")
    class Notices(logging.Handler):
        def emit(self, record):
            message = safe_error(record.getMessage())
            print(json.dumps({"message": message}), flush=True)
            print(message, file=sys.stderr, flush=True)
    logging.basicConfig(handlers=[Notices()], level=logging.WARNING, force=True)
    from huggingface_hub import constants
    # Frequent durable writes and progress updates even on a slow connection.
    constants.DOWNLOAD_CHUNK_SIZE = 1024 * 1024
    logger = logging.getLogger("huggingface_hub")
    logger.handlers.clear()
    logger.propagate = True
    last = 0.0

    def progress(count):
        nonlocal last
        now = time.monotonic()
        if now - last >= .2 or count == request["size"]:
            print(json.dumps({"bytes": count}), flush=True)
            last = now

    try:
        transfer(request["url"], Path(request["part"]), request["size"], request["offset"], progress,
                 expected=request["expected"], identity=request["identity"])
    except Exception as exc:
        print(json.dumps({"error": safe_error(exc), "unreachable": isinstance(exc, Unreachable)}), flush=True)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
