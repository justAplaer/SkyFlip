"""
StorageBackend interface for observation cutout blobs.

Local disk for the hackathon. S3/Supabase/GCS can plug in later.
**Ask before choosing a production backend** — do not hard-code cloud vendors.
"""

from __future__ import annotations

import hashlib
import os
import secrets
import uuid
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Optional

# Default under cache root; override with SKYFLIP_OBSERVATION_STORAGE
DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024
DEFAULT_MAX_SUBMISSION_BYTES = 20 * 1024 * 1024

ALLOWED_MAGIC = {
    b"\x89PNG\r\n\x1a\n": "png",
    b"SIMPLE": "fits",  # FITS starts with SIMPLE=
    # npz is a zip archive
    b"PK\x03\x04": "npz",
}


class StorageError(Exception):
    pass


class StorageBackend(ABC):
    @abstractmethod
    def put_bytes(
        self,
        data: bytes,
        *,
        submission_id: str,
        kind: str,
        content_type: str = "application/octet-stream",
    ) -> str:
        """Store bytes; return opaque storage key (never a user-supplied path)."""

    @abstractmethod
    def get_bytes(self, key: str) -> bytes:
        ...

    @abstractmethod
    def delete_prefix(self, submission_id: str) -> None:
        ...


class LocalDiskStorage(StorageBackend):
    def __init__(self, root: Path, *, max_file_bytes: int = DEFAULT_MAX_FILE_BYTES):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.max_file_bytes = max_file_bytes

    def _safe_subdir(self, submission_id: str) -> Path:
        # Only hex/uuid-like ids
        sid = "".join(ch for ch in submission_id if ch.isalnum() or ch in "-_")
        if not sid or sid != submission_id:
            raise StorageError("invalid submission_id for storage path")
        d = self.root / sid
        d.mkdir(parents=True, exist_ok=True)
        return d

    def put_bytes(
        self,
        data: bytes,
        *,
        submission_id: str,
        kind: str,
        content_type: str = "application/octet-stream",
    ) -> str:
        if len(data) > self.max_file_bytes:
            raise StorageError(f"file exceeds max size ({self.max_file_bytes} bytes)")
        if not _magic_ok(data):
            raise StorageError("file type not allowed (magic bytes)")
        kind_safe = "".join(ch for ch in kind if ch.isalnum() or ch in "-_")[:32] or "bin"
        name = f"{kind_safe}_{secrets.token_hex(16)}"
        # Extension from magic, never from user
        ext = _ext_from_magic(data)
        path = self._safe_subdir(submission_id) / f"{name}.{ext}"
        path.write_bytes(data)
        # Opaque key relative to root
        return f"{submission_id}/{path.name}"

    def get_bytes(self, key: str) -> bytes:
        path = self._resolve(key)
        return path.read_bytes()

    def delete_prefix(self, submission_id: str) -> None:
        d = self.root / submission_id
        if d.is_dir():
            for p in d.iterdir():
                p.unlink(missing_ok=True)
            d.rmdir()

    def _resolve(self, key: str) -> Path:
        # Prevent path traversal
        if ".." in key or key.startswith("/") or "\\" in key:
            raise StorageError("invalid storage key")
        path = (self.root / key).resolve()
        if not str(path).startswith(str(self.root.resolve())):
            raise StorageError("path traversal blocked")
        if not path.is_file():
            raise StorageError("not found")
        return path


def _magic_ok(data: bytes) -> bool:
    if len(data) < 8:
        return False
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return True
    if data[:6] == b"SIMPLE":
        return True
    if data[:4] == b"PK\x03\x04":
        return True
    # float32 npz sometimes; also allow raw little-endian float dump with header marker
    if data[:4] == b"SF32":  # SkyFlip float32 sidecar magic
        return True
    return False


def _ext_from_magic(data: bytes) -> str:
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if data[:6] == b"SIMPLE":
        return "fits"
    if data[:4] == b"PK\x03\x04":
        return "npz"
    if data[:4] == b"SF32":
        return "bin"
    return "bin"


def content_hash(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def new_storage_key_name() -> str:
    return uuid.uuid4().hex


def local_storage_from_env() -> LocalDiskStorage:
    root = os.environ.get("SKYFLIP_OBSERVATION_STORAGE")
    if root:
        path = Path(root)
    else:
        from ..cache import cache_root

        path = cache_root() / "observations"
    return LocalDiskStorage(path)
