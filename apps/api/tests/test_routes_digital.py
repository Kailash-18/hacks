"""API tests for the digital router (requires fastapi + httpx). Uses a fake client: no live inference."""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import io
import json

import pytest

fastapi = pytest.importorskip("fastapi")
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import routes_digital  # noqa: E402
from app.errors import register_error_handlers  # noqa: E402
from app.services.fixtures import CHAT_FIXTURE, DIGITAL_FIXTURE  # noqa: E402
from app.services.vision_provider import VisionProviderError  # noqa: E402
from app.store import store  # noqa: E402


class FakeClient:
    name, model = "fake", "fake-1"

    def __init__(self, exc=None):
        self.exc, self.calls = exc, 0

    def generate_json(self, image_bytes, mime, prompt):
        self.calls += 1
        if self.exc:
            raise self.exc
        return json.dumps(DIGITAL_FIXTURE if image_bytes is not None else CHAT_FIXTURE)


def png():
    from PIL import Image

    b = io.BytesIO()
    Image.new("RGB", (80, 60), "white").save(b, "PNG")
    return b.getvalue()


@pytest.fixture
def make_app(monkeypatch):
    def _make(client):
        store.clear()
        monkeypatch.setattr(routes_digital, "get_vision_client", lambda: client)
        app = FastAPI()
        app.include_router(routes_digital.router)
        register_error_handlers(app)
        return TestClient(app)
    return _make


def test_analyze_then_cache_then_chat(make_app):
    client = FakeClient()
    api = make_app(client)
    r = api.post("/api/digital/analyze", files={"image": ("s.png", png(), "image/png")})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["domain"] == "digital" and "scene" not in body
    again = api.post("/api/digital/analyze", files={"image": ("s.png", png(), "image/png")})
    assert again.json()["analysisId"] == body["analysisId"] and client.calls == 1  # cached
    c = api.post(f"/api/analysis/{body['analysisId']}/chat", json={"question": "Main CTA?", "selectedComponentIds": ["hero-cta"]})
    assert c.status_code == 200 and "hero-cta" in c.json()["referencedComponentIds"]
    assert api.get(f"/api/analysis/{body['analysisId']}").status_code == 200


def test_error_shapes(make_app):
    api = make_app(FakeClient(exc=VisionProviderError("provider_timeout", "timed out", 504)))
    r = api.post("/api/digital/analyze", files={"image": ("s.txt", b"hello", "text/plain")})
    assert r.status_code == 415 and r.json()["error"]["code"] == "unsupported_media_type"
    r = api.post("/api/digital/analyze", files={"image": ("s.png", png(), "image/png")})
    assert r.status_code == 504 and r.json() == {"error": {"code": "provider_timeout", "message": "timed out"}}
    r = api.post("/api/analysis/missing/chat", json={"question": "hi"})
    assert r.status_code == 404 and r.json()["error"]["code"] == "analysis_not_found"
    r = api.post("/api/digital/analyze")
    assert r.status_code == 422 and r.json()["error"]["code"] == "invalid_request"
