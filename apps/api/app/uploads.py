"""Upload validation shared by digital (and usable by physical) analysis.

Limits match Samvit's physical endpoint: <= 8 MB, JPEG / PNG / WebP.
MIME is decided from the file's magic bytes, not the client-supplied content type.
"""

from __future__ import annotations

import io
from dataclasses import dataclass

from .errors import ApiError

MAX_UPLOAD_BYTES = 8 * 1024 * 1024
MIN_SIDE_PX = 32
MAX_PIXELS = 40_000_000


@dataclass(frozen=True)
class ValidatedImage:
    data: bytes
    mime: str
    width: int
    height: int
    filename: str


def sniff_mime(data: bytes) -> str | None:
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def validate_image(data: bytes, filename: str | None) -> ValidatedImage:
    name = (filename or "upload").replace("\\", "/").split("/")[-1][:200] or "upload"
    if not data:
        raise ApiError(400, "empty_file", "The uploaded file is empty.")
    if len(data) > MAX_UPLOAD_BYTES:
        raise ApiError(413, "file_too_large", "Image must be 8 MB or smaller.")
    mime = sniff_mime(data)
    if mime is None:
        raise ApiError(415, "unsupported_media_type", "Upload a JPEG, PNG or WebP image.")

    try:
        from PIL import Image

        with Image.open(io.BytesIO(data)) as img:
            width, height = img.size
            img.verify()
    except ImportError:  # Pillow missing: header checks above still apply
        return ValidatedImage(data, mime, 0, 0, name)
    except Exception:
        raise ApiError(400, "corrupt_image", "The image could not be decoded.") from None

    if min(width, height) < MIN_SIDE_PX:
        raise ApiError(400, "image_too_small", f"Image must be at least {MIN_SIDE_PX}px on each side.")
    if width * height > MAX_PIXELS:
        raise ApiError(400, "image_too_large", "Image resolution is too large; please downscale it.")
    return ValidatedImage(data, mime, width, height, name)
