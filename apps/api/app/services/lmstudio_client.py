"""Local vision model through LM Studio's OpenAI-compatible server (free, no quota, runs on this laptop).

Used as a fallback when Gemini's free quota runs out (VISION_PROVIDER=auto), or on its own
(VISION_PROVIDER=lmstudio). Only works while LM Studio is running with a vision model loaded.
Uses the standard library only (no extra dependency).
"""
from __future__ import annotations

import base64
import json
import logging
import os
import urllib.error
import urllib.request

from .vision_client import ProviderError

log = logging.getLogger("uvicorn.error")

SYSTEM = "You are a precise vision assistant. Reply with ONE valid JSON object only: no prose, no markdown fences."


class LMStudioVisionClient:
    name = "lmstudio-local"

    def __init__(self, base_url: str | None = None, model: str | None = None):
        self.base_url = (base_url or os.getenv("LMSTUDIO_URL", "http://127.0.0.1:1234/v1")).rstrip("/")
        self.model = model or os.getenv("LMSTUDIO_MODEL", "google/gemma-4-e4b")
        self.timeout = float(os.getenv("LMSTUDIO_TIMEOUT_S", "300"))
        self.max_tokens = int(os.getenv("LMSTUDIO_MAX_TOKENS", "6000"))

    @property
    def ready(self) -> bool:
        try:
            with urllib.request.urlopen(self.base_url + "/models", timeout=2) as r:
                return r.status == 200
        except Exception:
            return False

    def _chat(self, content, max_tokens: int | None = None) -> str:
        body = {
            "model": self.model,
            "messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": content}],
            "temperature": 0.2,
            "max_tokens": max_tokens or self.max_tokens,
            "stream": False,
        }
        req = urllib.request.Request(self.base_url + "/chat/completions", data=json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"}, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                data = json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:300]
            if "context" in detail.lower() or "n_ctx" in detail.lower():
                raise ProviderError("The local model's context is too small. In LM Studio, reload it with Context Length 16384.", 502) from exc
            raise ProviderError(f"LM Studio returned an error: {detail}", 502) from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise ProviderError("Can't reach LM Studio. Start its local server (Developer tab) with a vision model loaded.", 503) from exc
        try:
            msg = data["choices"][0]["message"]
            text = msg.get("content") or ""
            if data["choices"][0].get("finish_reason") == "length":
                log.warning("lmstudio: answer hit max_tokens; JSON may be cut off")
        except (KeyError, IndexError, TypeError) as exc:
            raise ProviderError("LM Studio returned an unexpected response.", 502) from exc
        if not text.strip():
            raise ProviderError("The local model returned an empty answer.", 502)
        return text

    @staticmethod
    def _img(b: bytes, mime: str) -> dict:
        return {"type": "image_url", "image_url": {"url": f"data:{mime};base64," + base64.b64encode(b).decode()}}

    def generate_json(self, image_bytes: bytes, mime_type: str, prompt: str) -> str:
        return self._chat([self._img(image_bytes, mime_type), {"type": "text", "text": prompt}])

    def generate_json_images(self, images: list[tuple[bytes, str]], prompt: str) -> str:
        return self._chat([self._img(b, m) for b, m in images] + [{"type": "text", "text": prompt}])

    def generate_text_json(self, prompt: str) -> str:
        return self._chat(prompt, max_tokens=1500)


class FallbackVisionClient:
    """Try providers in order; move to the next when one is out of quota or unreachable."""

    def __init__(self, providers: list):
        self.providers = providers
        self.active = providers[0]

    @property
    def name(self) -> str:
        return self.active.name

    @property
    def model(self) -> str:
        return self.active.model

    @property
    def ready(self) -> bool:
        return any(getattr(p, "ready", True) for p in self.providers)

    def _run(self, method: str, *args):
        last = None
        for p in self.providers:
            try:
                out = getattr(p, method)(*args)
                self.active = p
                return out
            except ProviderError as exc:
                last = exc
                if exc.status in (429, 503):  # quota used up / provider unreachable -> next provider
                    log.warning("vision: %s unavailable (%s); trying next provider", p.name, exc)
                    continue
                raise
        raise last

    def generate_json(self, *a):
        return self._run("generate_json", *a)

    def generate_json_images(self, *a):
        return self._run("generate_json_images", *a)

    def generate_text_json(self, *a):
        return self._run("generate_text_json", *a)

    def generate_grounded(self, *a):  # web search exists only on Gemini
        g = next((p for p in self.providers if hasattr(p, "generate_grounded") and getattr(p, "ready", True)), None)
        if g is None:
            raise ProviderError("No provider with web search.", 503)
        return g.generate_grounded(*a)
