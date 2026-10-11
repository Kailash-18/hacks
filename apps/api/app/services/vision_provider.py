"""Vision-provider adapter.

Interface (shared with Samvit's physical service): any client exposing
    .name: str, .model: str, .generate_json(image_bytes | None, mime | None, prompt) -> str
Passing image_bytes=None makes a text-only call (used by grounded chat).

Both labs use ONE shared client (make_shared_client: Samvit's quota-aware Gemini client with a
local LM Studio fallback). Digital analysis and chat reach it through SharedClientAdapter.
"""

from __future__ import annotations

import json
import logging
import os
import re
import time
from typing import Any, Protocol

log = logging.getLogger(__name__)


class VisionClient(Protocol):
    name: str
    model: str

    def generate_json(self, image_bytes: bytes | None, mime: str | None, prompt: str) -> str: ...


class VisionProviderError(Exception):
    """Controlled provider failure. `code` is stable and safe to show; never contains secrets."""

    def __init__(self, code: str, message: str, http_status: int = 502) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.http_status = http_status


# --- JSON extraction ---------------------------------------------------------
_FENCE = re.compile(r"^\s*```(?:json)?\s*|\s*```\s*$", re.IGNORECASE)


def parse_model_json(text: str | None) -> dict[str, Any]:
    """Parse a model reply into a JSON object, tolerating code fences and leading prose."""
    if not text or not text.strip():
        raise VisionProviderError("provider_bad_output", "The model returned an empty response.")
    cleaned = _FENCE.sub("", text.strip())
    try:
        value = json.loads(cleaned)
    except json.JSONDecodeError:
        start, end = cleaned.find("{"), cleaned.rfind("}")
        if start == -1 or end <= start:
            raise VisionProviderError("provider_bad_output", "The model did not return JSON.") from None
        try:
            value = json.loads(cleaned[start : end + 1])
        except json.JSONDecodeError:
            raise VisionProviderError("provider_bad_output", "The model returned malformed JSON.") from None
    if not isinstance(value, dict):
        raise VisionProviderError("provider_bad_output", "The model returned JSON that is not an object.")
    return value


# --- Shared client (Samvit's Gemini client with LM Studio fallback) -------------------
def make_shared_client():
    """The one vision client both labs use. VISION_PROVIDER: auto (Gemini, then local LM Studio when
    Gemini's free quota runs out), gemini, or lmstudio. See services/vision_client.py (quota-aware
    model switching, retries, thinking level) and services/lmstudio_client.py."""
    from .lmstudio_client import FallbackVisionClient, LMStudioVisionClient
    from .vision_client import GeminiVisionClient

    mode = os.getenv("VISION_PROVIDER", "auto").lower()
    if mode == "lmstudio":
        return LMStudioVisionClient()
    if mode == "gemini":
        return GeminiVisionClient()
    providers = [GeminiVisionClient()] if os.getenv("GEMINI_API_KEY") else []
    return FallbackVisionClient(providers + [LMStudioVisionClient()])


_CODE_BY_STATUS = {429: "provider_rate_limited", 503: "provider_unavailable", 504: "provider_timeout"}


class SharedClientAdapter:
    """Adapts the shared client to this module's interface:
    generate_json(None, None, prompt) -> text-only call; ProviderError -> VisionProviderError."""

    def __init__(self, inner: Any) -> None:
        self.inner = inner
        self.last_call: dict[str, Any] | None = None

    @property
    def name(self) -> str:
        return self.inner.name

    @property
    def model(self) -> str:
        return self.inner.model

    def generate_json(self, image_bytes: bytes | None, mime: str | None, prompt: str) -> str:
        from .vision_client import ProviderError

        t0 = time.perf_counter()
        try:
            if image_bytes is None:
                text = self.inner.generate_text_json(prompt)
            else:
                text = self.inner.generate_json(image_bytes, mime or "image/png", prompt)
        except ProviderError as exc:
            status = int(getattr(exc, "status", 502) or 502)
            raise VisionProviderError(_CODE_BY_STATUS.get(status, "provider_error"), str(exc), status) from None
        finally:
            self.last_call = {"seconds": round(time.perf_counter() - t0, 1), "provider": self.name, "model": self.model}
        return text

    def generate_code_text(self, image_bytes: bytes, mime: str | None, prompt: str) -> str:
        """Image + prompt -> plain text (Digital Lab code generation). Same error mapping as generate_json."""
        from .vision_client import ProviderError

        if not hasattr(self.inner, "generate_code_text"):
            return self.generate_json(image_bytes, mime, prompt)
        t0 = time.perf_counter()
        try:
            return self.inner.generate_code_text(image_bytes, mime or "image/png", prompt)
        except ProviderError as exc:
            status = int(getattr(exc, "status", 502) or 502)
            raise VisionProviderError(_CODE_BY_STATUS.get(status, "provider_error"), str(exc), status) from None
        finally:
            self.last_call = {"seconds": round(time.perf_counter() - t0, 1), "provider": self.name, "model": self.model}

    def generate_code_text_images(self, images: list[tuple[bytes, str]], prompt: str) -> str:
        """Several screenshots -> plain text (a whole multi-screen app). Same error mapping as generate_json."""
        from .vision_client import ProviderError

        if not hasattr(self.inner, "generate_code_text_images"):
            raise VisionProviderError("provider_error", "This provider cannot build from several screenshots.", 501)
        t0 = time.perf_counter()
        try:
            return self.inner.generate_code_text_images(images, prompt)
        except ProviderError as exc:
            status = int(getattr(exc, "status", 502) or 502)
            raise VisionProviderError(_CODE_BY_STATUS.get(status, "provider_error"), str(exc), status) from None
        finally:
            self.last_call = {"seconds": round(time.perf_counter() - t0, 1), "provider": self.name, "model": self.model}

    def generate_json_images(self, images: list[tuple[bytes, str]], prompt: str) -> str:
        """Several images in one call (Digital Lab visual diff). Same error mapping as generate_json."""
        from .vision_client import ProviderError

        if not hasattr(self.inner, "generate_json_images"):
            raise VisionProviderError("provider_error", "This provider cannot compare several images.", 501)
        t0 = time.perf_counter()
        try:
            return self.inner.generate_json_images(images, prompt)
        except ProviderError as exc:
            status = int(getattr(exc, "status", 502) or 502)
            raise VisionProviderError(_CODE_BY_STATUS.get(status, "provider_error"), str(exc), status) from None
        finally:
            self.last_call = {"seconds": round(time.perf_counter() - t0, 1), "provider": self.name, "model": self.model}


# --- Fixture (explicit development mode only) --------------------------------
class FixtureVisionClient:
    """Returns recorded JSON. Enabled only with VRE_FIXTURE_MODE=1 and always labelled as fixture."""

    name = "fixture"
    model = "fixture-not-live-inference"

    def __init__(self, responses: dict[str, str] | None = None) -> None:
        self.responses = responses or {}

    def generate_json(self, image_bytes: bytes | None, mime: str | None, prompt: str) -> str:
        key = "chat" if image_bytes is None else "digital"
        if key not in self.responses:
            raise VisionProviderError("provider_error", f"No fixture response recorded for {key!r}.")
        return self.responses[key]


_shared: Any = None
_adapter: SharedClientAdapter | None = None


def set_shared_client(client: Any) -> None:
    """main.py registers its client here so both labs share one instance (and one quota tracker)."""
    global _shared, _adapter
    _shared, _adapter = client, None


def get_vision_client() -> VisionClient:
    """Client for digital analysis and chat. Raises VisionProviderError if nothing is configured."""
    global _shared, _adapter
    if os.getenv("VRE_FIXTURE_MODE") == "1":
        from .fixtures import default_fixture_client

        return default_fixture_client()
    if _shared is None:
        _shared = make_shared_client()
    if _adapter is None or _adapter.inner is not _shared:
        _adapter = SharedClientAdapter(_shared)
    return _adapter


def provider_status() -> dict[str, Any]:
    """Safe for /api/health: names, models and booleans only."""
    fixture = os.getenv("VRE_FIXTURE_MODE") == "1"
    inner = _shared
    return {
        "fixtureMode": fixture,
        "geminiKeyConfigured": bool(os.getenv("GEMINI_API_KEY")),
        "active": None if inner is None else {"name": inner.name, "model": inner.model},
    }
