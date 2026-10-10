"""Thin vision-provider adapter (free Gemini API tier).

NOTE: Krishna owns the shared provider adapter. This is a minimal adapter with
the same shape (``generate_json``) so the physical service can be wired into
his version by swapping the client object.
"""
from __future__ import annotations

import os
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

    @property
    def ready(self) -> bool:
        return bool(self.api_key)

    def _get(self):
        if not self.api_key:
            raise ProviderError("GEMINI_API_KEY is not set. Add it to apps/api/.env (free key: aistudio.google.com).", 503)
        if self._client is None:
            from google import genai
            self._client = genai.Client(api_key=self.api_key)
        return self._client

    def generate_json(self, image_bytes: bytes, mime_type: str, prompt: str) -> str:
        from google.genai import types

        client = self._get()
        cfg = {"response_mime_type": "application/json", "temperature": 0.2}
        if "2.5" in self.model:
            # Google recommends disabling thinking for better segmentation output on 2.5.
            cfg["thinking_config"] = types.ThinkingConfig(thinking_budget=0)
        try:
            resp = client.models.generate_content(
                model=self.model,
                contents=[types.Part.from_bytes(data=image_bytes, mime_type=mime_type), prompt],
                config=types.GenerateContentConfig(**cfg),
            )
        except Exception as exc:  # map provider failures to stable errors
            text = str(exc)
            if "429" in text or "RESOURCE_EXHAUSTED" in text:
                raise ProviderError("Gemini free-tier rate limit reached. Wait a minute and retry, or use a sample.", 429) from exc
            if "API key" in text or "401" in text or "403" in text:
                raise ProviderError("Gemini rejected the API key.", 502) from exc
            raise ProviderError("Vision provider request failed.", 502) from exc
        if not resp.text:
            raise ProviderError("Vision provider returned an empty response.", 502)
        return resp.text
