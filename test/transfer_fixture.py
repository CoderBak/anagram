"""Tiny in-memory transport for offline transaction/lifecycle tests."""
from urllib.request import Request
from safe_files import open_partial
from download_modelkit import DownloadPaused
from hub_transfer import CheckpointWriter


def transfer_with(opener, paused=DownloadPaused):
    def transfer(url, part, size, offset, *, cancel, progress, expected=None, identity=None, notice=None):
        request = Request(url, headers={"Range": f"bytes={offset}-"} if offset else {})
        with opener(request, timeout=60) as response:
            if response.status == 200:
                offset = 0
            with open_partial(part, offset, identity=identity) as stream:
                destination = CheckpointWriter(stream, part, expected, enforce_checkpoint=identity is not None) if expected else stream
                while True:
                    if cancel is not None and cancel.is_set():
                        raise paused()
                    chunk = response.read(64 * 1024)
                    if not chunk:
                        break
                    destination.write(chunk)
                    offset += len(chunk)
                    progress(offset)
    return transfer
