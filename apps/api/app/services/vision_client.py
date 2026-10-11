"""Vision-provider adapter for the free Gemini API tier.

Every call goes through ``_generate``, which:
- retries free-tier per-minute limits and transient 5xx errors with backoff;
- when a model's DAILY free quota is used up (free tier: ~20 requests/day/model), switches to the next
  available Flash model, since every model has its own quota;
- picks the newest available Flash model if the configured one does not exist (404);
- drops the thinking config if a model rejects it.

NOTE: Krishna owns the shared provider adapter; this exposes the same ``generate_json`` shape.
"""
from __future__ import annotations

import datetime as _dt
import logging
import os
import re
import time
from pathlib import Path
from typing import Protocol

log = logging.getLogger("uvicorn.error")
CACHE = Path(__file__).resolve().parents[2] / ".cache"


class ProviderError(Exception):
    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.status = status


class VisionClient(Protocol):
    name: str
    model: str

    def generate_json(self, image_bytes: bytes, mime_type: str, prompt: str) -> str: ...


def _is_daily_quota(t: str) -> bool:
    return ("429" in t or "RESOURCE_EXHAUSTED" in t) and ("PerDay" in t or "per day" in t.lower())


def _is_rate_limit(t: str) -> bool:
    return "429" in t or "RESOURCE_EXHAUSTED" in t


def _is_transient(t: str) -> bool:
    return any(x in t for x in ("503", "UNAVAILABLE", "500 INTERNAL", "overloaded", "504", "DEADLINE_EXCEEDED",
                                "timed out", "Timeout", "ReadTimeout"))


def _is_auth(t: str) -> bool:
    return any(x in t for x in ("API key", "API_KEY", "401", "UNAUTHENTICATED")) or ("403" in t and "PERMISSION_DENIED" in t)


def _is_not_found(t: str) -> bool:
    return "404" in t or "NOT_FOUND" in t


class GeminiVisionClient:
    name = "google-gemini"

    def __init__(self, api_key: str | None = None, model: str | None = None):
        self.api_key = api_key or os.getenv("GEMINI_API_KEY")
        # An empty GEMINI_MODEL (as in .env.example) means "pick automatically" on the first call.
        self.model = model or (os.getenv("GEMINI_MODEL") or "").strip()
        self._client = None
        self._vertex = os.getenv("GEMINI_USE_VERTEX", "").lower() in ("1", "true")
        self._exhausted: dict[str, str] = {}   # model -> UTC date its daily quota ran out
        self._no_thinking: set[str] = set()
        self._candidates: list[str] | None = None

    @property
    def ready(self) -> bool:
        return bool(self.api_key)

    # ------------------------------------------------------------------ client / models
    def _get(self):
        if not self.api_key:
            raise ProviderError("GEMINI_API_KEY is not set. Add it to apps/api/.env (free key: aistudio.google.com).", 503)
        if self._client is None:
            from google import genai
            from google.genai import types
            self._client = genai.Client(api_key=self.api_key, vertexai=self._vertex,
                                        http_options=types.HttpOptions(timeout=int(os.getenv("GEMINI_TIMEOUT_MS", "100000"))))
        return self._client

    def _rank_models(self) -> list[str]:
        """Available Flash models, best first: newest full Flash, then older Flash, then Flash-Lite."""
        if self._candidates is not None:
            return self._candidates
        ranked = []
        try:
            for m in self._get().models.list():
                name = (m.name or "").removeprefix("models/")
                acts = getattr(m, "supported_actions", None) or []
                if "flash" not in name or any(x in name for x in ("image", "tts", "live", "audio", "embed", "thinking")):
                    continue
                if acts and "generateContent" not in acts:
                    continue
                ver = tuple(int(p) for p in re.findall(r"\d+", name.split("flash")[0])[:2]) or (0,)
                lite = "lite" in name
                stable = "preview" not in name and "exp" not in name
                ranked.append(((not lite, ver, stable, -len(name)), name))
        except Exception as exc:  # listing is best-effort
            log.warning("gemini: could not list models (%s)", str(exc)[:120])
        self._candidates = [n for _, n in sorted(ranked, reverse=True)]
        return self._candidates

    def _pick_model(self, client=None) -> str | None:  # kept for check_key.py / tests
        if client is not None:
            self._client = client
            self._candidates = None
        today = _dt.datetime.utcnow().date().isoformat()
        for name in self._rank_models():
            if self._exhausted.get(name) != today:
                return name
        return None

    # ------------------------------------------------------------------ core call
    def _generate(self, contents, cfg: dict, raw: bool = False):
        from google.genai import types
        if not self.model:  # no model configured: newest available Flash, else a known default
            self.model = self._pick_model() or "gemini-2.5-flash"
            log.warning("gemini: no GEMINI_MODEL set; using %s", self.model)
        today = _dt.datetime.utcnow().date().isoformat()
        tried = set()
        busy: dict[str, int] = {}
        cfg = dict(cfg)
        attempts = cfg.pop("_attempts", 10)  # long answers (a whole site) are not retried ten times
        for _ in range(attempts):  # bounded: model switches + retries
            model = self.model
            c = dict(cfg)
            if model.startswith("gemini-3") and model not in self._no_thinking:
                c["thinking_config"] = types.ThinkingConfig(thinking_level="low")
            elif "2.5" in model and model not in self._no_thinking:
                c["thinking_config"] = types.ThinkingConfig(thinking_budget=0)
            try:
                resp = self._get().models.generate_content(model=model, contents=contents,
                                                           config=types.GenerateContentConfig(**c))
                if not resp.text:
                    raise ProviderError("Vision provider returned an empty response.", 502)
                return resp if raw else resp.text
            except ProviderError:
                raise
            except Exception as exc:
                t = str(exc)
                self._save_error(t)
                if "thinking" in t.lower() and ("400" in t or "INVALID_ARGUMENT" in t) and model not in self._no_thinking:
                    self._no_thinking.add(model)
                    continue
                if _is_daily_quota(t) or _is_not_found(t):
                    if _is_daily_quota(t):
                        self._exhausted[model] = today
                        log.warning("gemini: daily free quota used up for %s; switching model", model)
                    tried.add(model)
                    nxt = next((m for m in self._rank_models() if m not in tried and self._exhausted.get(m) != today), None)
                    if nxt:
                        self.model = nxt
                        log.warning("gemini: now using %s", nxt)
                        continue
                    raise self._map(exc) from exc
                if _is_transient(t) or (_is_rate_limit(t) and not _is_daily_quota(t)):
                    busy[model] = busy.get(model, 0) + 1
                    if busy[model] >= 2:  # overloaded twice: try a different model instead of waiting
                        tried.add(model)
                        nxt = next((m for m in self._rank_models() if m not in tried and self._exhausted.get(m) != today), None)
                        if nxt:
                            log.warning("gemini: %s is busy; switching to %s", model, nxt)
                            self.model = nxt
                            continue
                if _is_rate_limit(t) or _is_transient(t):
                    m = re.search(r"retry in (\d+(?:\.\d+)?)s|retryDelay['\"]?:\s*['\"](\d+)s", t)
                    wait = float(next(g for g in m.groups() if g)) + 1 if m else 8.0
                    if wait > 40:  # long waits mean a quota, not a burst: try another model instead
                        self._exhausted[model] = today
                        continue
                    log.warning("gemini: rate limited on %s, retrying in %.0f s", model, wait)
                    time.sleep(wait)
                    continue
                if _is_auth(t) and not self._vertex_switched:
                    self._vertex_switched = True
                    from google import genai
                    self._vertex = not self._vertex
                    self._client = None
                    continue
                raise self._map(exc) from exc
        raise ProviderError("The AI service is busy. Please try again in a minute, or open a sample.", 503)

    _vertex_switched = False

    # ------------------------------------------------------------------ public API
    def generate_json(self, image_bytes: bytes, mime_type: str, prompt: str) -> str:
        from google.genai import types
        return self._generate([types.Part.from_bytes(data=image_bytes, mime_type=mime_type), prompt], self._cfg())

    def generate_json_images(self, images: list[tuple[bytes, str]], prompt: str) -> str:
        from google.genai import types
        return self._generate([types.Part.from_bytes(data=b, mime_type=m) for b, m in images] + [prompt], self._cfg())

    def generate_grounded(self, images: list[tuple[bytes, str]], prompt: str) -> tuple[str, list[dict]]:
        """Image(s) + prompt with the Google Search tool. Returns (text, web sources).

        Search grounding has its own (small) free quota: try it once on the current model, never switch
        models over it, and fall back to a plain call (model knowledge only, no sources) when it fails.
        """
        from google.genai import types
        parts = [types.Part.from_bytes(data=b, mime_type=m) for b, m in images] + [prompt]
        cfg = {"temperature": 0.1, "max_output_tokens": 4000,
               "tools": [types.Tool(google_search=types.GoogleSearch())]}
        if self.model.startswith("gemini-3") and self.model not in self._no_thinking:
            cfg["thinking_config"] = types.ThinkingConfig(thinking_level="low")
        today = _dt.datetime.utcnow().date().isoformat()
        if self._search_off != today:
            try:
                resp = self._get().models.generate_content(model=self.model, contents=parts,
                                                           config=types.GenerateContentConfig(**cfg))
                if resp.text:
                    sources, seen = [], set()
                    try:
                        for ch in (resp.candidates[0].grounding_metadata.grounding_chunks or []):
                            web = getattr(ch, "web", None)
                            if web and web.uri and web.uri not in seen:
                                seen.add(web.uri)
                                sources.append({"title": (web.title or "")[:100], "url": web.uri})
                    except (AttributeError, IndexError, TypeError):
                        pass
                    return resp.text, sources
            except Exception as exc:
                t = str(exc)
                self._save_error("search grounding: " + t)
                if "429" in t or "RESOURCE_EXHAUSTED" in t or "400" in t or "403" in t:
                    self._search_off = today  # out of search quota / unsupported: retry tomorrow
                log.warning("gemini: web search unavailable (%s); identifying without it", t[:120])
        return self._generate(parts, self._cfg(max_tokens=4000, temperature=0.1)), []

    _search_off = ""

    def generate_text_json(self, prompt: str) -> str:
        return self._generate(prompt, self._cfg(max_tokens=2000, temperature=0))

    def generate_code_text(self, image_bytes: bytes, mime_type: str, prompt: str) -> str:
        """Plain-text answer (no JSON mode): long code survives intact instead of being escaped inside JSON."""
        from google.genai import types
        return self._generate([types.Part.from_bytes(data=image_bytes, mime_type=mime_type), prompt],
                              {"temperature": 0.2, "max_output_tokens": int(os.getenv("GEMINI_CODE_MAX_TOKENS", "20000"))})

    def generate_code_text_images(self, images: list[tuple[bytes, str]], prompt: str, max_tokens: int = 32000,
                                  timeout_s: int = 360) -> str:
        """Several screenshots + prompt -> plain text (a whole multi-screen app in one file)."""
        from google.genai import types
        # a whole site is a long answer: give this one call minutes, not the default 100 s
        return self._generate([types.Part.from_bytes(data=b, mime_type=m) for b, m in images] + [prompt],
                              {"temperature": 0.2, "max_output_tokens": max_tokens, "_attempts": 3,
                               "http_options": types.HttpOptions(timeout=timeout_s * 1000)})

    @staticmethod
    def _cfg(max_tokens: int | None = None, temperature: float = 0.2) -> dict:
        return {"response_mime_type": "application/json", "temperature": temperature,
                "max_output_tokens": max_tokens or int(os.getenv("GEMINI_MAX_TOKENS", "12000"))}

    # ------------------------------------------------------------------ errors
    @staticmethod
    def _save_error(text: str) -> None:
        try:
            CACHE.mkdir(exist_ok=True)
            (CACHE / "last_provider_error.txt").write_text(text[:4000], encoding="utf-8")
        except OSError:
            pass

    def _map(self, exc: Exception) -> ProviderError:
        t = str(exc)
        if _is_daily_quota(t):
            return ProviderError("Today's free Gemini quota is used up for every available model. "
                                 "Open a sample, or try again after the daily reset.", 429)
        if _is_rate_limit(t):
            return ProviderError("Gemini free-tier rate limit reached. Wait a minute and retry, or open a sample.", 429)
        if any(x in t for x in ("503", "UNAVAILABLE", "overloaded", "high demand")):
            return ProviderError("Google's AI is overloaded right now. Wait a minute and retry, or open a sample.", 503)
        if "timed out" in t.lower() or "timeout" in t.lower() or "DEADLINE" in t:
            return ProviderError("The AI took too long (over 100 s). Try again, or use a simpler photo.", 504)
        if _is_auth(t):
            return ProviderError("Google rejected the API key. Check the key in apps/api/.env.", 502)
        if _is_not_found(t):
            return ProviderError(f"Model '{self.model}' is not available for this key; no other Flash model found.", 502)
        return ProviderError("Vision provider request failed.", 502)
