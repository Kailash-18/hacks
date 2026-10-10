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
        monkeypatch.setattr(store, "_dir", None)  # never write the real disk cache from tests
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


def test_samples_endpoints(make_app):
    api = make_app(FakeClient())
    listing = api.get("/api/digital/samples").json()
    ids = {s["id"] for s in listing}
    assert {"landing-page", "ops-dashboard", "mobile-login"} <= ids
    one = api.get("/api/digital/samples/landing-page").json()
    assert one["sample"]["id"] == "landing-page" and one["domain"] == "digital"
    img = api.get("/api/digital/samples/landing-page/image")
    assert img.status_code == 200 and img.headers["content-type"] == "image/png"
    assert api.get("/api/digital/samples/nope").json()["error"]["code"] == "sample_not_found"


def test_concurrent_identical_uploads_share_one_model_call(monkeypatch):
    import asyncio
    import threading

    from app.uploads import validate_image

    store.clear()
    monkeypatch.setattr(store, "_dir", None)
    gate = threading.Event()

    class SlowClient(FakeClient):
        def generate_json(self, image_bytes, mime, prompt):
            gate.wait(5)
            return super().generate_json(image_bytes, mime, prompt)

    client = SlowClient()
    monkeypatch.setattr(routes_digital, "get_vision_client", lambda: client)
    img = validate_image(png(), "s.png")

    async def both():
        sha = "dedupe-test"
        t1 = asyncio.ensure_future(routes_digital._analyze_once(sha, img))
        t2 = asyncio.ensure_future(routes_digital._analyze_once(sha, img))
        await asyncio.sleep(0.05)
        gate.set()
        return await asyncio.gather(t1, t2)

    a, b = asyncio.run(both())
    assert a.analysisId == b.analysisId and client.calls == 1


def test_main_app_serves_both_labs_with_one_error_shape(monkeypatch):
    """The merged app: physical + digital routes, one error shape, physical results usable by chat."""
    from app import main

    store.clear()
    monkeypatch.setattr(store, "_dir", None)
    monkeypatch.setattr(routes_digital, "get_vision_client", lambda: FakeClient())
    api = TestClient(main.app)

    h = api.get("/api/health").json()
    assert h["labs"] == ["physical", "digital"] and h["digitalSamples"] >= 3
    r = api.post("/api/physical/analyze", files={"image": ("a.txt", b"hi", "text/plain")})
    assert r.status_code == 415 and r.json()["error"]["code"] == "unsupported_media_type"
    assert api.get("/api/no-such-route").json()["error"]["code"] == "not_found"
    assert api.get("/api/digital/samples").status_code == 200

    phys = api.get("/api/physical/samples/lenovo-mouse").json()
    assert api.get(f"/api/analysis/{phys['analysisId']}").json()["domain"] == "physical"
    c = api.post(f"/api/analysis/{phys['analysisId']}/chat", json={"question": "What does the wheel connect to?"})
    assert c.status_code == 200 and any("not measured" in x for x in c.json()["limitations"])
