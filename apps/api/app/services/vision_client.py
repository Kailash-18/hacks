"""Thin vision-provider adapter (free Gemini API tier).

NOTE: Krishna owns the shared provider adapter. This is a minimal adapter with
the same shape (``generate_json``) so the physical service can be wired into
his version by swapping the client object.
"""
from __future__ import annotations

import os
import re
from typing import Protocol


class ProviderError(Exception):
    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.status = status


class VisionClient(Protocol):
    name: str
    model: str

    def generate_json(self, image_bytes: bytes, mime_type: str, prompt: str) -> str: ...


class GeminiVisionClient:
    name = "google-gemini"

    def __init__(self, api_key: str | None = None, model: str | None = None):
        self.api_key = api_key or os.getenv("GEMINI_API_KEY")
        self.model = model or os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
        self._client = None
        # AI Studio endpoint by default; falls back to Vertex express automatically on auth errors.
        self._vertex = os.getenv("GEMINI_USE_VERTEX", "").lower() in ("1", "true")
        self._model_checked = False

    @property
    def ready(self) -> bool:
        return bool(self.api_key)

    def _get(self):
        if not self.api_key:
            raise ProviderError("GEMINI_API_KEY is not set. Add it to apps/api/.env (free key: aistudio.google.com).", 503)
        if self._client is None:
            from google import genai
            self._client = genai.Client(api_key=self.api_key, vertexai=self._vertex, http_options=self._http())
        return self._client

    @staticmethod
    def _http():
        from google.genai import types
        return types.HttpOptions(timeout=int(os.getenv("GEMINI_TIMEOUT_MS", "100000")))

    def _pick_model(self, client) -> str | None:
        """Newest available Flash model for this key (model names change over time)."""
        best = None
        for m in client.models.list():
            name = (m.name or "").removeprefix("models/")
            actions = getattr(m, "supported_actions", None) or []
            if "flash" not in name or any(x in name for x in ("lite", "image", "tts", "live", "audio", "embed", "thinking")):
                continue
            if actions and "generateContent" not in actions:
                continue
            ver = tuple(int(p) for p in re.findall(r"\d+", name.split("flash")[0])[:2]) or (0,)
            key = (ver, "preview" not in name and "exp" not in name, -len(name))
            if best is None or key > best[0]:
                best = (key, name)
        return best[1] if best else None

    def _call(self, client, types, cfg, image_bytes, mime_type, prompt):
        return client.models.generate_content(
            model=self.model,
            contents=[types.Part.from_bytes(data=image_bytes, mime_type=mime_type), prompt],
            config=types.GenerateContentConfig(**cfg),
        )

    def generate_json(self, image_bytes: bytes, mime_type: str, prompt: str) -> str:
        from google.genai import types

        client = self._get()
        cfg = {"response_mime_type": "application/json", "temperature": 0.2,
               "max_output_tokens": int(os.getenv("GEMINI_MAX_TOKENS", "12000"))}
        if "2.5" in self.model:
            # Google recommends disabling thinking for better segmentation output on 2.5.
            cfg["thinking_config"] = types.ThinkingConfig(thinking_budget=0)
        elif self.model.startswith("gemini-3") and not getattr(self, "_no_thinking_cfg", False):
            try:  # low thinking = much faster; dropped automatically if the model rejects it
                cfg["thinking_config"] = types.ThinkingConfig(thinking_level="low")
            except Exception:
                pass
        try:
            try:
                resp = self._call(client, types, cfg, image_bytes, mime_type, prompt)
            except Exception as first:
                t = str(first)
                if not any(s in t for s in ("API key", "API_KEY", "401", "403", "UNAUTHENTICATED", "PERMISSION_DENIED")):
                    raise
                # Wrong endpoint for this key type: switch between AI Studio and Vertex express once.
                from google import genai
                self._vertex = not self._vertex
                self._client = client = genai.Client(api_key=self.api_key, vertexai=self._vertex, http_options=self._http())
                resp = self._call(client, types, cfg, image_bytes, mime_type, prompt)
        except Exception as exc:
            t = str(exc)
            if "thinking_config" in cfg and ("400" in t or "INVALID_ARGUMENT" in t) and "hinking" in t:
                self._no_thinking_cfg = True
                return self.generate_json(image_bytes, mime_type, prompt)
            if "timed out" in t.lower() or "timeout" in t.lower() or "DEADLINE" in t:
                raise ProviderError("The AI took too long (over 100 s). Try again, or use a simpler photo.", 504) from exc
            if ("404" in str(exc) or "NOT_FOUND" in str(exc)) and not self._model_checked:
                self._model_checked = True
                picked = self._pick_model(self._get())
                if picked and picked != self.model:
                    self.model = picked
                    return self.generate_json(image_bytes, mime_type, prompt)
            raise self._map(exc) from exc
        if not resp.text:
            raise ProviderError("Vision provider returned an empty response.", 502)
        return resp.text

    def generate_text_json(self, prompt: str) -> str:
        """Small text-only JSON call (used to match part names across photos)."""
        from google.genai import types
        cfg = {"response_mime_type": "application/json", "temperature": 0, "max_output_tokens": 2000}
        if self.model.startswith("gemini-3") and not getattr(self, "_no_thinking_cfg", False):
            cfg["thinking_config"] = types.ThinkingConfig(thinking_level="low")
        try:
            resp = self._get().models.generate_content(model=self.model, contents=prompt,
                                                       config=types.GenerateContentConfig(**cfg))
        except Exception as exc:
            raise self._map(exc) from exc
        return resp.text or "{}"

    def _map(self, exc: Exception) -> "ProviderError":
        """Map provider failures to stable, user-readable errors."""
        if True:
            text = str(exc)
            if "429" in text or "RESOURCE_EXHAUSTED" in text:
                return ProviderError("Gemini free-tier rate limit reached. Wait a minute and retry, or use a sample.", 429)
            if any(s in text for s in ("API key", "API_KEY", "401", "403", "UNAUTHENTICATED", "PERMISSION_DENIED")):
                return ProviderError("Google rejected the API key (tried both AI Studio and Vertex). Check the key in apps/api/.env.", 502)
            if "404" in text or "NOT_FOUND" in text:
                return ProviderError(f"Model '{self.model}' is not available for this key; no newer Flash model found. Set GEMINI_MODEL in apps/api/.env.", 502)
            return ProviderError("Vision provider request failed.", 502)
