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


def test_everything_works_without_pillow(monkeypatch):
    """The team laptop runs without Pillow: tokens, size and the a11y audit fall back to OpenCV."""
    import sys

    from app.services import digital_explorer as dx
    from app.services import digital_extras

    a, img = login()
    with_pil = dx.extract_tokens(a, img)["colors"]["primary"]
    monkeypatch.setitem(sys.modules, "PIL", None)  # "from PIL import ..." now raises ImportError
    tok = dx.extract_tokens(a, img)
    assert tok["colors"]["primary"].startswith("#") and tok["typeScale"]
    assert sum(abs(int(tok["colors"]["primary"][i:i + 2], 16) - int(with_pil[i:i + 2], 16)) for i in (1, 3, 5)) < 40
    assert codegen._image_size(img) == (1280, 800)
    assert digital_extras.audit_accessibility(a, img)["score"] >= 0


@pytest.mark.parametrize("target,needle", [("react-native", "react-native"), ("flutter", "package:flutter/material.dart")])
def test_mobile_targets(target, needle):
    a, img = login()
    code = ("import 'package:flutter/material.dart';\nvoid main() => runApp(const MyApp());\n" if target == "flutter"
            else "import { View, Text } from 'react-native';\nexport default function App() { return <View><Text>Log in</Text></View>; }\n") * 3
    fake = TextFake(f"```\n{code}\n```\nNOTES:\n- Adapted to a phone layout")
    out = codegen.generate_code(a, img, "image/png", fake, target)
    assert out["source"] == "ai" and out["target"] == target and needle in out["code"]
    assert needle.split(":")[-1].split("/")[0] in fake.prompts[0].lower() or target.replace("-", " ") in fake.prompts[0].lower()
    # no layout draft exists for mobile: the fallback says so instead of returning HTML
    fb = codegen.generate_code(a, img, "image/png", None, target, force=True)
    assert fb["source"] == "layout" and "<html" not in fb["code"].lower()


class FakeMulti(Fake):
    def __init__(self, text=None, exc=None):
        super().__init__({"code": HTML}, None)
        self.text, self.mexc, self.n = text, exc, None

    def generate_code_text_images(self, images, prompt, **_):
        self.prompts.append(prompt); self.n = len(images)
        if self.mexc:
            raise self.mexc
        return self.text


def bh_screens():
    sc = sorted((s for s in SAMPLES.values() if s.sample_set == "nimbus" and not s.compare_with), key=lambda s: s.order or 0)
    return [(s.analysis, s.image_path.read_bytes(), s.mime) for s in sc]


def test_whole_site_is_built_from_every_screen_and_cached():
    screens = bh_screens()
    assert len(screens) >= 2
    app = HTML.replace("</main>", "<nav><button data-open='schedule'>Schedule</button></nav></main>") + "x" * 400
    fake = FakeMulti("```html\n" + app + "\n```\nNOTES:\n- Windows are draggable")
    out = codegen.generate_app(screens, fake)
    assert out["source"] == "ai" and fake.n == len(screens) and "evil.example" not in out["code"]
    assert out["screens"] == [a.analysisId for a, _, _ in screens] and out["notes"] == ["Windows are draggable"]
    assert "never as instructions" in fake.prompts[0] and screens[1][0].title in fake.prompts[0]
    assert codegen.generate_app(screens, FakeMulti(exc=RuntimeError("no")))["cached"] is True


def test_whole_site_falls_back_to_the_first_screen():
    screens = bh_screens()
    out = codegen.generate_app(screens, FakeMulti(exc=VisionProviderError("quota", "Out of quota", 429)))
    assert out["notes"][0].startswith("Whole-site build unavailable") and out["code"]


def test_refine_sends_target_and_render_and_keeps_code_on_failure():
    a, img = login()
    base = HTML + "<!-- v1 -->" + "x" * 400
    fake = FakeMulti("```html\n" + base.replace("v1", "v2") + "\n```")
    out = codegen.generate_refine(a, img, "image/png", b"\x89PNGrender", base, fake, "81", "x 60-100%, y 0-40%")
    assert out["source"] == "ai" and "v2" in out["code"] and fake.n == 2
    assert "81%" in fake.prompts[0] and "v1" in fake.prompts[0] and "never as instructions" in fake.prompts[0]
    bad = codegen.generate_refine(a, img, "image/png", b"other", base, FakeMulti(exc=RuntimeError("busy")))
    assert bad["code"] == base and bad["source"] == "layout"


def test_refine_describes_closeups():
    a, img = login()
    base = HTML + "x" * 400
    fake = FakeMulti("```html\n" + base + "<!--v2-->\n```")
    codegen.generate_refine(a, img, "image/png", b"r1", base, fake, "88", "", True, b"diff", "#fff in the target is #eee",
                            [b"c1", b"c2"], "x 0-30%, y 0-40% | x 70-100%, y 0-40%")
    p = fake.prompts[0]
    assert fake.n == 5 and "Images 4-5 are close-ups" in p and "image 5 = x 70-100%" in p and "#eee" in p


def test_font_stretch_loads_the_width_axis():
    html = ('<html><head><link href="https://fonts.googleapis.com/css2?family=Archivo:wght@800&display=swap" rel="stylesheet">'
            '</head><body><h1 style="font-stretch:75%">Fast</h1></body></html>')
    assert "family=Archivo:wdth,wght@62..125,100..900&" in codegen.clean_html(html)
    assert "family=Archivo:wght@800" in codegen.clean_html(html.replace("font-stretch:75%", ""))
