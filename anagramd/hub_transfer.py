"""Isolated Hugging Face HTTP transport; inference remains offline in its parent.

The locked Hub release's high-level downloader discards partials between runs.
Use its HTTP retry/range implementation with Anagram's durable, guarded partial
file instead. No Hub login, global cache, Xet staging copy or raw-text input.
"""
from __future__ import annotations

import json
import logging
import os
from pathlib import Path
import re
import sys
import time
import threading
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent))
from safe_files import open_partial


def safe_error(exc):
    # CDN redirects may contain temporary signatures. Never persist their query.
    return re.sub(r"https?://[^\s'\"<>]+", lambda m: m[0].split("?")[0], str(exc))[:1500]


def transfer(url, part, size, offset, progress, *, client_factory=None, sleep=time.sleep):
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
    for attempt in range(3):
        try:
            with open_partial(part, offset) as stream:
                http_get(url, stream, resume_size=offset, expected_size=size,
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
        transfer(request["url"], Path(request["part"]), request["size"], request["offset"], progress)
    except Exception as exc:
        print(json.dumps({"error": safe_error(exc)}), flush=True)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
