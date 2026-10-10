"""Vision-provider adapter.

Interface (shared with Samvit's physical service): any client exposing
    .name: str, .model: str, .generate_json(image_bytes | None, mime | None, prompt) -> str
Passing image_bytes=None makes a text-only call (used by grounded chat).

Gemini notes (from Samvit's testing on our keys):
  * AI Studio endpoint (api key), not Vertex.
  * Older Flash IDs may 404 for new keys; GEMINI_MODEL overrides, else the newest
    available Flash model is picked once at start-up. Pin GEMINI_MODEL for the demo.
  * Keep a reference to the google-genai Client or it gets closed.
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


def provider_not_configured() -> VisionProviderError:
    return VisionProviderError(
        "provider_not_configured",
        "No vision provider is configured on the server (set GEMINI_API_KEY in apps/api/.env).",
        503,
    )


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


# --- Gemini ------------------------------------------------------------------
_EXCLUDE = ("lite", "image", "tts", "audio", "live", "embedding", "thinking", "exp")


def _version_key(name: str) -> tuple:
    nums = re.findall(r"\d+(?:\.\d+)?", name)
    return tuple(float(n) for n in nums[:1]) + (0 if "preview" in name else 1,)


class GeminiVisionClient:
    name = "gemini"

    def __init__(self, api_key: str, model: str | None = None, timeout_s: float = 60.0) -> None:
        try:
            from google import genai
            from google.genai import types
        except ImportError as exc:  # pragma: no cover - depends on install
            raise VisionProviderError(
                "provider_not_configured", "google-genai is not installed (pip install -r requirements.txt).", 503
            ) from exc
        self._types = types
        # Keep this reference alive for the process lifetime (see module notes).
        self._client = genai.Client(api_key=api_key, http_options=types.HttpOptions(timeout=int(timeout_s * 1000)))
        self.model = model or self._pick_flash_model()

    def _pick_flash_model(self) -> str:
        try:
            names = []
            for m in self._client.models.list():
                name = (getattr(m, "name", "") or "").removeprefix("models/")
                actions = getattr(m, "supported_actions", None) or []
                if "flash" in name and not any(x in name for x in _EXCLUDE):
                    if not actions or "generateContent" in actions:
                        names.append(name)
        except Exception as exc:
            raise self._map_error(exc) from None
        if not names:
            raise VisionProviderError("provider_model_unavailable", "No Gemini Flash model is available for this key.", 503)
        chosen = max(names, key=_version_key)
        log.info("Auto-selected Gemini model %s (set GEMINI_MODEL to pin)", chosen)
        return chosen

    def generate_json(self, image_bytes: bytes | None, mime: str | None, prompt: str) -> str:
        types = self._types
        contents: list[Any] = []
        if image_bytes is not None:
            contents.append(types.Part.from_bytes(data=image_bytes, mime_type=mime or "image/png"))
        contents.append(prompt)
        config = types.GenerateContentConfig(response_mime_type="application/json", temperature=0.2)

        last: VisionProviderError | None = None
        for attempt in range(2):  # one retry, only for transient server errors
            try:
                resp = self._client.models.generate_content(model=self.model, contents=contents, config=config)
                return resp.text or ""
            except Exception as exc:
                last = self._map_error(exc)
                if last.code != "provider_unavailable" or attempt == 1:
                    raise last from None
                time.sleep(1.5)
        raise last  # pragma: no cover

    @staticmethod
    def _map_error(exc: Exception) -> VisionProviderError:
        code = getattr(exc, "code", None) or getattr(exc, "status_code", None)
        kind = type(exc).__name__
        log.warning("Gemini call failed: %s (status=%s)", kind, code)  # never log payloads or keys
        if "Timeout" in kind:
            return VisionProviderError("provider_timeout", "The vision model timed out. Try again.", 504)
        if code == 429:
            return VisionProviderError("provider_rate_limited", "The vision model is rate-limited. Wait a moment and retry.", 429)
        if code in (401, 403):
            return VisionProviderError("provider_auth_failed", "The server's model API key was rejected.", 503)
        if code == 404:
            return VisionProviderError("provider_model_unavailable", "The configured model is not available for this key; check GEMINI_MODEL.", 503)
        if code == 400:
            return VisionProviderError("provider_rejected_input", "The model rejected this input.", 422)
        if isinstance(code, int) and code >= 500:
            return VisionProviderError("provider_unavailable", "The vision model is temporarily unavailable.", 502)
        return VisionProviderError("provider_error", "The vision model call failed.", 502)


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


_client_singleton: VisionClient | None = None


def get_vision_client() -> VisionClient:
    """Process-wide client. Raises VisionProviderError if nothing is configured."""
    global _client_singleton
    if _client_singleton is not None:
        return _client_singleton
    if os.getenv("VRE_FIXTURE_MODE") == "1":
        from .fixtures import default_fixture_client

        _client_singleton = default_fixture_client()
        return _client_singleton
    key = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
    if not key:
        raise provider_not_configured()
    _client_singleton = GeminiVisionClient(key, os.getenv("GEMINI_MODEL") or None)
    return _client_singleton


def provider_status() -> dict[str, Any]:
    """Safe for /api/health: booleans and model name only."""
    configured = bool(os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY"))
    return {
        "name": "fixture" if os.getenv("VRE_FIXTURE_MODE") == "1" else "gemini",
        "configured": configured or os.getenv("VRE_FIXTURE_MODE") == "1",
        "fixtureMode": os.getenv("VRE_FIXTURE_MODE") == "1",
        "model": _client_singleton.model if _client_singleton else (os.getenv("GEMINI_MODEL") or "auto"),
    }
