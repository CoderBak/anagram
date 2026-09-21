"""Small, bounded file operations for the component's owned state and downloads."""
from __future__ import annotations

import json
import os
from pathlib import Path
import stat
import tempfile


def is_link(path: Path) -> bool:
    return path.is_symlink() or getattr(path, "is_junction", lambda: False)()


def regular_stat(path: Path):
    """Inspect the entry itself, never a symlink or Windows junction target."""
    if is_link(path):
        raise ValueError(f"Refusing a symbolic link or junction: {path}")
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode):
        raise ValueError(f"Not a regular file: {path}")
    return info


def read_json(path: Path, *, max_bytes: int = 1024 * 1024):
    path = Path(path)
    before = regular_stat(path)
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    try:
        actual = os.fstat(fd)
        if (not stat.S_ISREG(actual.st_mode)
                or (before.st_dev, before.st_ino) != (actual.st_dev, actual.st_ino)
                or actual.st_size > max_bytes):
            raise ValueError(f"Configuration is oversized or changed while opening: {path}")
        with os.fdopen(fd, "rb", closefd=False) as stream:
            data = stream.read(max_bytes + 1)
        if len(data) > max_bytes:
            raise ValueError(f"Configuration is oversized: {path}")
        return json.loads(data.decode("utf-8"))
    finally:
        os.close(fd)


def atomic_json(path: Path, value) -> None:
    """Replace an entry with a newly created file, without truncating aliases."""
    path = Path(path)
    if is_link(path.parent):
        raise ValueError(f"Refusing a symbolic link or junction: {path.parent}")
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        regular_stat(path)
    except FileNotFoundError:
        pass
    fd, name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    temp = Path(name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(value, stream, allow_nan=False, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        # Replacement itself never follows the destination, even if its entry
        # changes after this check. A pre-existing hardlink is detached safely.
        try:
            regular_stat(path)
        except FileNotFoundError:
            pass
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def open_partial(path: Path, offset: int):
    """Open a private resumable file; check before truncating or appending."""
    path = Path(path)
    if is_link(path) or is_link(path.parent):
        raise ValueError(f"Refusing a symbolic link or junction: {path}")
    fd = os.open(path, os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
                 | getattr(os, "O_NONBLOCK", 0), 0o600)
    try:
        actual, current = os.fstat(fd), regular_stat(path)
        if (not stat.S_ISREG(actual.st_mode) or actual.st_nlink != 1
                or (actual.st_dev, actual.st_ino) != (current.st_dev, current.st_ino)):
            raise ValueError(f"Partial file is linked or changed while opening: {path}")
        if offset:
            if actual.st_size != offset:
                raise ValueError("Partial download changed before resuming")
            os.lseek(fd, offset, os.SEEK_SET)
        else:
            os.ftruncate(fd, 0)
        return os.fdopen(fd, "r+b")
    except BaseException:
        os.close(fd)
        raise
