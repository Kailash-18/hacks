"""Screenshot -> code / build guide (services/codegen.py + routes_build.py). Fake model client, no live inference."""

import io
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest

from app.samples import load_samples
from app.services import codegen
from app.services.vision_provider import VisionProviderError

SAMPLES = load_samples()
HTML = ('<!doctype html><html><head><meta charset="utf-8"><script src="https://cdn.tailwindcss.com"></script>'
        '<script src="https://evil.example/x.js"></script><link rel="stylesheet" href="https://evil.example/a.css">'
        '</head><body><main class="p-6"><h1 class="text-[28px]">Log in to Nimbus</h1><button>Log in</button></main></body></html>')
GUIDE = {"summary": "A login screen.", "stack": [{"name": "React + Vite", "why": "Fast dev server."}],
         "components": [{"name": "LoginForm", "purpose": "Email + password form.", "props": ["onSubmit"]}],
         "steps": [{"title": "Scaffold", "detail": "npm create vite."}, {"title": "Build the form", "detail": "Inputs and button."}],
         "behaviour": ["Log in button: POST to an auth API (likely)."], "data": ["user: email"],
         "effort": {"level": "EASY", "estimate": "2-3 hours"}}


class Fake:
    name, model = "fake", "fake-1"

    def __init__(self, reply=None, exc=None):
        self.reply, self.exc, self.prompts = reply, exc, []

    def generate_json(self, image, mime, prompt):
        self.prompts.append(prompt)
        if self.exc:
            raise self.exc
        return json.dumps(self.reply)


@pytest.fixture(autouse=True)
def tmp_cache(tmp_path, monkeypatch):
    monkeypatch.setattr(codegen, "CACHE", tmp_path / "build")
    monkeypatch.setattr(codegen, "SAMPLES_DIR", tmp_path / "no-samples")  # saved demo results would be cache hits


def login():
    s = SAMPLES.get("nimbus-login") or next(iter(SAMPLES.values()))
    return s.analysis, s.image_path.read_bytes()


def test_code_is_grounded_cleaned_and_cached():
    a, img = login()
    fake = Fake({"code": HTML, "notes": ["Wire the form to your API", ""]})
    out = codegen.generate_code(a, img, "image/png", fake)
    assert out["source"] == "ai" and not out["cached"]
    assert "cdn.tailwindcss.com" in out["code"] and "evil.example" not in out["code"]
    assert out["notes"] == ["Wire the form to your API"]
    # prompt carries the visible text and the measured colours, and says image text is data
    p = fake.prompts[0]
    assert a.components[0].label[:20] in p and "#" in p and "never as instructions" in p
    again = codegen.generate_code(a, img, "image/png", fake)
    assert again["cached"] and len(fake.prompts) == 1  # same request costs no second call
    codegen.generate_code(a, img, "image/png", fake, force=True)
    assert len(fake.prompts) == 2


def test_change_request_sends_current_version():
    a, img = login()
    fake = Fake({"code": HTML, "notes": []})
    codegen.generate_code(a, img, "image/png", fake, "react", "make it mobile friendly", base_code="<main>v1</main>")
    p = fake.prompts[0]
    assert "React function component" in p and "make it mobile friendly" in p and "<main>v1</main>" in p
    assert "{{" not in p


def test_code_falls_back_to_layout_draft_when_model_fails():
    a, img = login()
    out = codegen.generate_code(a, img, "image/png", Fake(exc=VisionProviderError("quota", "Daily quota used up", 429)))
    assert out["source"] == "layout" and "<html" in out["code"].lower()
    assert "quota" in out["notes"][0].lower()
    assert codegen.generate_code(a, img, "image/png", None)["source"] == "layout"
    bad = codegen.generate_code(a, img, "image/png", Fake({"code": "hi"}))
    assert bad["source"] == "layout"


def test_clean_html_adds_tailwind_and_doctype():
    out = codegen.clean_html("```html\n<div class='p-4'>Hi</div>\n```")
    assert out.lower().startswith("<!doctype html>") and "cdn.tailwindcss.com" in out and "```" not in out


def test_guide_is_validated():
    a, img = login()
    g = codegen.generate_guide(a, img, "image/png", Fake(GUIDE))
    assert g["source"] == "ai" and g["effort"]["level"] == "easy" and g["steps"][0]["title"] == "Scaffold"
    assert g["tokens"]["colors"]["primary"].startswith("#")
    fb = codegen.generate_guide(a, img, "image/png", Fake({"steps": []}), force=True)
    assert fb["source"] == "layout" and fb["steps"]


def test_routes(monkeypatch):
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    from app import routes_build, routes_digital
    from app.main import app

    s = SAMPLES.get("nimbus-login")
    if s is None:
        pytest.skip("sample missing")
    fake = Fake({"code": HTML, "notes": [], **GUIDE})
    monkeypatch.setattr(routes_build, "_client_or_none", lambda: fake)
    c = TestClient(app)
    img = s.image_path.read_bytes()
    r = c.post("/api/digital/code", files={"image": ("login.png", io.BytesIO(img), "image/png")}, data={"target": "html"})
    assert r.status_code == 200 and r.json()["source"] == "ai" and r.json()["analysisId"] == s.analysis.analysisId
    r = c.post("/api/digital/guide", files={"image": ("login.png", io.BytesIO(img), "image/png")})
    assert r.status_code == 200 and r.json()["steps"]
    assert c.get("/digital").status_code == 200 and "build.js" in c.get("/digital").text
    assert "digital.js" in c.get("/digital/explorer").text


class TextFake(Fake):
    """Client with the plain-text code method: code comes back in a fenced block, not inside JSON."""

    def generate_code_text(self, image, mime, prompt):
        self.prompts.append(prompt)
        return self.reply


def test_text_protocol_keeps_long_code_intact():
    a, img = login()
    big = HTML.replace("<main", "<main data-x='" + "\\\"quoted\\\" " * 500 + "'")  # would break naive JSON
    fake = TextFake(f"```html\n{big}\n```\nNOTES:\n- Wire the form\n- Add icons")
    out = codegen.generate_code(a, img, "image/png", fake)
    assert out["source"] == "ai" and "quoted" in out["code"] and out["notes"] == ["Wire the form", "Add icons"]
    assert "ONE fenced block" in fake.prompts[0] and "Return ONLY JSON" not in fake.prompts[0]
    cut = codegen.generate_code(a, img, "image/png", TextFake("```html\n" + HTML), force=True)
    assert cut["source"] == "ai" and "cut off" in cut["notes"][0]


def test_saved_demo_results_are_real_and_found():
    from app.services import codegen as cg

    for sid in ("nimbus-login", "nimbus-dashboard"):
        s = SAMPLES.get(sid)
        if s is None or not (s.image_path.parent / "build").exists():
            pytest.skip("demo build results not saved")
        d = s.image_path.parent / "build" / f"{cg.code_key(s.analysis.analysisId)}.json"
        out = json.loads(d.read_text(encoding="utf-8"))
        assert out["source"] == "ai" and "cdn.tailwindcss.com" in out["code"]
