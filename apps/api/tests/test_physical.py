"""Tests for the physical pipeline, graph logic and API. The vision model is replaced
by a scripted fake client here (test-only); the real path calls Gemini."""
import base64
import json

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.schemas import Component, Relationship
from app.services import image_ops as ops
from app.services.component_graph import validate_relationships, what_if
from app.services.physical_analysis import AnalysisError, analyze_physical_image, parse_model_json

W, H = 400, 300


def synthetic_device() -> bytes:
    img = np.full((H, W, 3), 235, np.uint8)
    cv2.rectangle(img, (60, 50), (340, 250), (90, 90, 90), -1)       # body
    cv2.rectangle(img, (90, 80), (230, 200), (200, 120, 40), -1)     # screen
    cv2.circle(img, (290, 150), 30, (40, 40, 220), -1)               # button
    ok, buf = cv2.imencode(".png", img)
    return buf.tobytes()


def mask_png(shape_fn, box) -> str:
    """Build a Gemini-style mask: PNG probability map covering the box (0-1000 coords)."""
    y0, x0, y1, x1 = box
    px = (int(x0 / 1000 * W), int(y0 / 1000 * H), int(round(x1 / 1000 * W)), int(round(y1 / 1000 * H)))
    full = np.zeros((H, W), np.uint8)
    shape_fn(full)
    crop = full[px[1]:px[3], px[0]:px[2]]
    ok, buf = cv2.imencode(".png", crop)
    return "data:image/png;base64," + base64.b64encode(buf.tobytes()).decode()


def box(x0, y0, x1, y1):
    return [round(y0 / H * 1000), round(x0 / W * 1000), round(y1 / H * 1000), round(x1 / W * 1000)]


def good_response() -> dict:
    b_body, b_screen, b_btn = box(60, 50, 340, 250), box(90, 80, 230, 200), box(260, 120, 320, 180)
    return {
        "object_name": "Test gadget",
        "summary": "A box with a screen and a button.",
        "object": {"box_2d": b_body, "mask": mask_png(lambda m: cv2.rectangle(m, (60, 50), (340, 250), 255, -1), b_body)},
        "parts": [
            {"id": "screen", "label": "Screen", "type": "display", "box_2d": b_screen,
             "mask": mask_png(lambda m: cv2.rectangle(m, (90, 80), (230, 200), 255, -1), b_screen),
             "depth_rank": 0, "evidence": "Orange panel", "role": "Shows output"},
            {"id": "button", "label": "Button", "type": "interface", "box_2d": b_btn,
             "mask": "",  # no mask, no outline -> GrabCut fallback
             "depth_rank": 0, "evidence": "Red disc"},
            {"id": "shell", "label": "Shell", "type": "cover", "box_2d": b_body,
             "mask": "not-base64!!", "depth_rank": 2, "evidence": "Grey body"},
            {"id": "bad", "label": "Bad box", "box_2d": "nope"},
            "garbage",
        ],
        "hidden_parts": [
            {"id": "battery", "label": "Battery", "type": "power_source", "reason": "Portable device"},
            {"id": "board", "label": "Circuit board", "type": "controller", "reason": "Electronics"},
        ],
        "relationships": [
            {"from": "battery", "to": "board", "type": "powers", "visible": True, "evidence": "typical"},
            {"from": "board", "to": "screen", "type": "controls", "visible": False},
            {"from": "button", "to": "board", "type": "weird_type"},
            {"from": "screen", "to": "ghost_part", "type": "powers"},
            {"from": "shell", "to": "shell", "type": "supports"},
        ],
    }


class FakeVision:
    name, model = "fake", "fake-model"

    def __init__(self, payload):
        self.payload = payload

    def generate_json(self, image_bytes, mime_type, prompt):
        return self.payload if isinstance(self.payload, str) else json.dumps(self.payload)


def test_pipeline_builds_valid_scene():
    a = analyze_physical_image(synthetic_device(), "dev.png", FakeVision(good_response()))
    d = a.dump()
    ids = [c["id"] for c in d["components"]]
    assert len(ids) == len(set(ids))
    assert {"screen", "button", "shell", "battery", "board"} <= set(ids)
    assert "bad" not in ids
    by = {c["id"]: c for c in d["components"]}
    assert by["battery"]["status"] == "inferred" and by["battery"]["bbox"] is None
    assert by["screen"]["status"] == "observed"
    assert any("GrabCut" in e for e in by["button"]["evidence"])
    # layers ordered/owned front-to-back; ghost parts listed
    assert {l["componentId"] for l in d["scene"]["layers"]} == {"screen", "button", "shell"}
    assert set(d["scene"]["ghostComponentIds"]) == {"battery", "board"}
    for l in d["scene"]["layers"]:
        b = l["bbox"]
        assert 0 <= b["x"] <= 1 and 0 <= b["y"] <= 1 and b["x"] + b["width"] <= 1.0001
        assert l["cutout"].startswith("data:image/")
    assert d["scene"]["plate"].startswith("data:image/")
    # relationships: invalid endpoints/self-loops dropped, unknown type normalised, ghost edge not "observed"
    rel = {r["id"]: r for r in d["relationships"]}
    assert "battery--powers--board" in rel and rel["battery--powers--board"]["status"] == "inferred"
    assert "button--connected_to--board" in rel
    assert all(r["from"] != r["to"] for r in d["relationships"])
    assert all(r["to"] in by and r["from"] in by for r in d["relationships"])
    assert d["provider"] == {"name": "fake", "model": "fake-model"}


def test_shell_does_not_steal_front_parts():
    a = analyze_physical_image(synthetic_device(), "dev.png", FakeVision(good_response()))
    layers = {l.component_id: l for l in a.scene.layers}
    # shell (rank 2) box covers the screen, but the screen (rank 0) owns those pixels
    shell = layers["shell"]
    assert shell.depth_rank == 2


def test_malformed_outputs():
    with pytest.raises(AnalysisError):
        parse_model_json("I cannot help with that")
    assert parse_model_json("```json\n{\"parts\": []}\n```") == {"parts": []}
    assert parse_model_json('[{"label": "x"}]') == {"parts": [{"label": "x"}]}
    with pytest.raises(AnalysisError):
        analyze_physical_image(synthetic_device(), "x.png", FakeVision({"parts": []}))
    with pytest.raises(AnalysisError):
        analyze_physical_image(b"not an image", "x.png", FakeVision({"parts": []}))


def test_box_and_mask_helpers():
    assert ops.box_to_pixels([0, 0, 1000, 1000], 100, 50) == (0, 0, 100, 50)
    assert ops.box_to_pixels([500, 500, 200, 100], 100, 100) == (10, 20, 50, 50)  # swapped -> sorted
    assert ops.box_to_pixels([0, 0, 1, 1], 100, 100) is None  # too small
    assert ops.box_to_pixels(None, 100, 100) is None
    assert ops.decode_gemini_mask(None, (0, 0, 10, 10), 20, 20) is None


def comps(*ids):
    return [Component(id=i, label=i.title()) for i in ids]


def rel(a, b, t="powers", status="inferred"):
    return Relationship(**{"id": f"{a}-{b}", "from": a, "to": b, "type": t, "status": status})


def test_what_if_chain_and_determinism():
    c = comps("battery", "esc", "motor", "prop", "frame", "camera")
    r = [rel("battery", "esc"), rel("esc", "motor", "drives", "observed"), rel("motor", "prop", "drives", "observed"),
         rel("frame", "motor", "supports"), rel("battery", "camera"), rel("camera", "frame", "connected_to")]
    res = what_if(c, r, "battery")
    assert [a["componentId"] for a in res["affected"]] == ["camera", "esc", "motor", "prop"]
    prop = next(a for a in res["affected"] if a["componentId"] == "prop")
    assert prop["path"] == ["battery", "esc", "motor", "prop"] and prop["hops"] == 3
    assert prop["explanation"] == "Battery --powers--> Esc --drives--> Motor --drives--> Prop"
    assert prop["uncertain"] is True
    assert "frame" in res["unaffectedComponentIds"]  # connected_to does not propagate
    assert what_if(c, r, "battery") == res
    assert what_if(c, r, "prop")["affected"] == []


def test_what_if_cycles_and_unknown():
    c = comps("a", "b")
    r = [rel("a", "b"), rel("b", "a")]
    assert [x["componentId"] for x in what_if(c, r, "a")["affected"]] == ["b"]
    with pytest.raises(KeyError):
        what_if(c, r, "zzz")


def test_validate_relationships():
    c = comps("a", "b")
    valid, warnings = validate_relationships(c, [rel("a", "b"), rel("a", "b"), rel("a", "x"), rel("a", "a")])
    assert len(valid) == 1 and len(warnings) == 3


def test_api_end_to_end(monkeypatch, tmp_path):
    from app import main
    monkeypatch.setattr(main, "vision", FakeVision(good_response()))
    monkeypatch.setattr(main, "CACHE_DIR", tmp_path)
    client = TestClient(main.app)
    assert client.get("/api/health").status_code == 200
    assert client.post("/api/physical/analyze", files={"image": ("a.txt", b"hi", "text/plain")}).status_code == 415
    r = client.post("/api/physical/analyze", files={"image": ("d.png", synthetic_device(), "image/png")})
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["domain"] == "physical" and d["analysisId"].startswith("physical-")
    w = client.post("/api/physical/whatif", json={"analysisId": d["analysisId"], "removedComponentId": "battery"})
    assert w.status_code == 200
    assert [a["componentId"] for a in w.json()["affected"]] == ["board", "screen"]
    # cached second call
    assert client.post("/api/physical/analyze", files={"image": ("d.png", synthetic_device(), "image/png")}).json() == d


def test_back_part_keeps_holes_for_front_parts():
    a = analyze_physical_image(synthetic_device(), "dev.png", FakeVision(good_response()))
    shell = next(l for l in a.scene.layers if l.component_id == "shell")
    raw = base64.b64decode(shell.cutout.split(",", 1)[1])
    rgba = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_UNCHANGED)
    # screen centre (160,140) relative to shell crop must be transparent
    bx, by = round(shell.bbox.x * W), round(shell.bbox.y * H)
    assert rgba[140 - by, 160 - bx, 3] < 50


def test_model_auto_pick():
    from types import SimpleNamespace as NS
    from app.services.vision_client import GeminiVisionClient
    models = [NS(name=n, supported_actions=["generateContent"]) for n in
              ["models/gemini-2.0-flash", "models/gemini-3-flash-preview", "models/gemini-3-flash",
               "models/gemini-3-flash-lite", "models/gemini-3-pro", "models/gemini-2.5-flash-image"]]
    client = NS(models=NS(list=lambda: models))
    assert GeminiVisionClient(api_key="x")._pick_model(client) == "gemini-3-flash"


def test_outline_path():
    resp = good_response()
    b = box(260, 120, 320, 180)
    # circle approximated by a 12-point outline (y, x on 0-1000 grid)
    import math
    pts = [[round((150 + 30 * math.sin(a)) / H * 1000), round((290 + 30 * math.cos(a)) / W * 1000)]
           for a in [i * math.pi / 6 for i in range(12)]]
    resp["parts"][1] = {"id": "button", "label": "Button", "type": "interface", "box_2d": b, "outline": pts, "depth_rank": 0}
    a = analyze_physical_image(synthetic_device(), "d.png", FakeVision(resp))
    btn = next(c for c in a.components if c.id == "button")
    assert any("outline" in e for e in btn.evidence)
    layer = next(l for l in a.scene.layers if l.component_id == "button")
    assert 0.1 < layer.bbox.width < 0.2  # ~60px of 400


def bottom_photo() -> bytes:
    img = np.full((H, W + 100, 3), 235, np.uint8)  # different size so the fake can tell photos apart
    cv2.rectangle(img, (60, 50), (340, 250), (70, 70, 70), -1)        # base
    cv2.circle(img, (200, 150), 25, (30, 160, 30), -1)               # sensor window
    ok, buf = cv2.imencode(".png", img)
    return buf.tobytes()


def bottom_response() -> dict:
    def bx(x0, y0, x1, y1, ww=W + 100):
        return [round(y0 / H * 1000), round(x0 / ww * 1000), round(y1 / H * 1000), round(x1 / ww * 1000)]
    def ol(x0, y0, x1, y1, ww=W + 100):
        return [[round(y / H * 1000), round(x / ww * 1000)] for x, y in ((x0, y0), (x1, y0), (x1, y1), (x0, y1))]
    return {
        "object_name": "Test gadget (bottom)", "view": "bottom",
        "product": {"brand": "Acme", "model": None, "category": "gadget", "search_query": "acme gadget"},
        "object": {"box_2d": bx(60, 50, 340, 250), "outline": ol(60, 50, 340, 250)},
        "parts": [
            {"id": "sensor", "label": "Battery pack", "type": "power_source", "box_2d": bx(175, 125, 225, 175),
             "outline": ol(175, 125, 225, 175), "depth_rank": 0, "evidence": "visible through window"},
            {"id": "base", "label": "Base plate", "type": "structure", "box_2d": bx(60, 50, 340, 250),
             "outline": ol(60, 50, 340, 250), "depth_rank": 1},
        ],
        "hidden_parts": [{"id": "pcb", "label": "Circuit Boards", "type": "controller", "reason": "electronics"}],
        "relationships": [{"from": "sensor", "to": "pcb", "type": "powers", "visible": False}],
    }


class MultiFake:
    name, model = "fake", "fake-model"

    def generate_json(self, image_bytes, mime_type, prompt):
        img = cv2.imdecode(np.frombuffer(image_bytes, np.uint8), cv2.IMREAD_COLOR)
        return json.dumps(bottom_response() if img.shape[1] > W else good_response())

    def generate_text_json(self, prompt):
        assert "Photo 1" in prompt and "Photo 2" in prompt
        return json.dumps({"groups": [["Battery", "Battery pack"]]})


def test_multi_view_merge(tmp_path):
    from app.services.physical_analysis import analyze_physical_images
    a = analyze_physical_images([(synthetic_device(), "top.png"), (bottom_photo(), "bottom.png")], MultiFake(), tmp_path)
    d = a.dump()
    by = {c["id"]: c for c in d["components"]}
    # hidden "Battery" in photo 1 became observed via "Battery pack" in photo 2 (merged by the label groups)
    battery = [c for c in d["components"] if c["label"] in ("Battery", "Battery pack")]
    assert len(battery) == 1 and battery[0]["status"] == "observed"
    assert battery[0]["id"] not in d["scene"]["ghostComponentIds"]
    # "Circuit Boards" (photo 2, plural) merges with "Circuit board" (photo 1) by normalized name
    assert len([c for c in d["components"] if "ircuit" in c["label"]]) == 1
    assert [v["view"] for v in d["scene"]["views"]] == ["unknown", "bottom"]
    assert all(l["viewIndex"] == 1 for l in d["scene"]["views"][1]["layers"])
    assert d["scene"]["layers"] == d["scene"]["views"][0]["layers"]
    assert d["scene"]["product"]["brand"] == "Acme"
    assert by["base"]["label"] == "Base plate"
    # raw model answers are cached per photo
    assert len(list(tmp_path.glob("raw-*.json"))) == 2


def test_api_multi_upload(monkeypatch, tmp_path):
    from app import main
    monkeypatch.setattr(main, "vision", MultiFake())
    monkeypatch.setattr(main, "CACHE_DIR", tmp_path)
    client = TestClient(main.app)
    files = [("images", ("t.png", synthetic_device(), "image/png")), ("images", ("b.png", bottom_photo(), "image/png"))]
    r = client.post("/api/physical/analyze", files=files)
    assert r.status_code == 200, r.text
    assert len(r.json()["scene"]["views"]) == 2
    five = [("images", (f"{i}.png", synthetic_device(), "image/png")) for i in range(5)]
    assert client.post("/api/physical/analyze", files=five).status_code == 400


def test_small_part_inside_big_part_survives():
    """Model ranks the shell in front of the wheel; the wheel must still be cut out and be in front."""
    def bx(x0, y0, x1, y1):
        return [round(y0 / H * 1000), round(x0 / W * 1000), round(y1 / H * 1000), round(x1 / W * 1000)]
    def ol(x0, y0, x1, y1):
        return [[round(y / H * 1000), round(x / W * 1000)] for x, y in ((x0, y0), (x1, y0), (x1, y1), (x0, y1))]
    resp = {"object_name": "Mouse", "view": "top",
            "parts": [{"id": "wheel", "label": "Scroll Wheel", "box_2d": bx(270, 130, 310, 170), "outline": ol(270, 130, 310, 170), "depth_rank": 1},
                      {"id": "shell", "label": "Top shell", "box_2d": bx(60, 50, 340, 250), "outline": ol(60, 50, 340, 250), "depth_rank": 0}]}
    a = analyze_physical_image(synthetic_device(), "m.png", FakeVision(resp))
    layers = {l.component_id: l for l in a.scene.layers}
    assert "wheel" in layers and "shell" in layers
    assert layers["wheel"].depth_rank < layers["shell"].depth_rank


def test_whatif_without_server_state():
    from app import main
    client = TestClient(main.app)
    body = {"analysisId": "gone", "removedComponentId": "a",
            "components": [{"id": "a", "label": "A"}, {"id": "b", "label": "B"}],
            "relationships": [{"id": "r", "from": "a", "to": "b", "type": "powers"}]}
    r = client.post("/api/physical/whatif", json=body)
    assert r.status_code == 200 and r.json()["affected"][0]["componentId"] == "b"


def test_assembly_parse_and_validate():
    from app.services.assembly import parse_assembly
    raw = {"overall_size": [60, 40, 110], "parts": [
        {"id": "shell", "shape": "dome", "size": [60, 30, 110], "position": [0, 10, 0], "color": "#222222",
         "material": "plastic", "explode_dir": [0, 5, 0], "explode_dist": 1.2},
        {"id": "pcb", "shape": "weird", "size": [-40, 2, 80], "position": [0, -5, 0], "color": "green",
         "explode_dir": [0, 0, 0]},
        {"id": "pcb", "shape": "box", "size": [1, 1, 1], "position": [0, 0, 0]},   # duplicate -> ignored
        {"id": "ghost", "shape": "box", "size": [1, 1, 1], "position": [0, 0, 0]},  # unknown id -> ignored
        {"id": "wheel", "shape": "cylinder", "size": [8, "nan", 8], "position": [0, 30, 40], "rotation": [0, 0, 90]},
    ]}
    a = parse_assembly(raw, {"shell", "pcb", "wheel"})
    by = {p.component_id: p for p in a.parts}
    assert set(by) == {"shell", "pcb", "wheel"}
    assert by["shell"].explode_dir == [0.0, 1.0, 0.0]
    assert by["pcb"].shape == "rounded_box" and by["pcb"].size[0] == 40 and by["pcb"].color == "#9aa0a6"
    assert by["pcb"].explode_dir == [0.0, 1.0, 0.0]  # zero vector -> default up
    assert by["wheel"].size[1] == 10.0  # NaN -> default
    assert parse_assembly({"parts": []}, {"a"}) is None


def test_pipeline_attaches_assembly(tmp_path):
    from app.services.physical_analysis import analyze_physical_images

    class WithAsm(MultiFake):
        def generate_json_images(self, images, prompt):
            assert 'id "screen"' in prompt
            return json.dumps({"parts": [
                {"id": "screen", "shape": "plate", "size": [50, 2, 40], "position": [0, 10, 0]},
                {"id": "shell", "shape": "rounded_box", "size": [70, 20, 50], "position": [0, 0, 0]}]})

    a = analyze_physical_images([(synthetic_device(), "t.png")], WithAsm(), tmp_path)
    assert a.scene.assembly and {p.component_id for p in a.scene.assembly.parts} == {"screen", "shell"}
    assert a.scene.assembly.overall_size[0] == 70


def test_daily_quota_switches_model(monkeypatch):
    from types import SimpleNamespace as NS
    from app.services.vision_client import GeminiVisionClient
    calls = []

    def gen(model, contents, config):
        calls.append(model)
        if model == "gemini-9-flash":
            raise Exception("429 RESOURCE_EXHAUSTED quotaId: GenerateRequestsPerDayPerProjectPerModel-FreeTier")
        return NS(text='{"ok": true}')

    models = [NS(name=f"models/{n}", supported_actions=["generateContent"]) for n in ("gemini-9-flash", "gemini-8-flash", "gemini-9-flash-lite")]
    vc = GeminiVisionClient(api_key="x", model="gemini-9-flash")
    vc._client = NS(models=NS(generate_content=gen, list=lambda: models))
    assert vc.generate_text_json("hi") == '{"ok": true}'
    assert calls == ["gemini-9-flash", "gemini-8-flash"] and vc.model == "gemini-8-flash"


def test_assembly_parts_fit_inside_shell():
    from app.services.assembly import parse_assembly
    raw = {"parts": [
        {"id": "shell", "shape": "dome", "size": [60, 30, 100], "position": [0, 10, 0]},
        {"id": "base", "shape": "plate", "size": [60, 6, 100], "position": [0, -8, 0]},
        {"id": "battery", "shape": "box", "size": [20, 15, 160], "position": [0, 0, 70]},   # too long + sticks out
    ]}
    a = parse_assembly(raw, {"shell", "base", "battery"}, {"shell": "cover", "base": "structure", "battery": "power_source"})
    b = next(p for p in a.parts if p.component_id == "battery")
    assert b.size[2] <= 100 * 0.92 + 1e-6
    assert b.position[2] + b.size[2] / 2 <= 50 + 1e-6


def test_rotated_part_fits_inside_shell():
    from app.services.assembly import parse_assembly
    raw = {"parts": [
        {"id": "shell", "shape": "dome", "size": [60, 30, 100], "position": [0, 10, 0]},
        {"id": "button", "shape": "plate", "size": [80, 3, 20], "position": [0, 20, -40], "rotation": [0, 90, 0]},
    ]}
    a = parse_assembly(raw, {"shell", "button"}, {"shell": "cover", "button": "actuator"})
    b = next(p for p in a.parts if p.component_id == "button")
    # rotated 90 deg about y: its 80 mm length lies along z, so it must end inside z = +/-50
    assert abs(b.position[2]) + b.size[0] / 2 <= 50 + 1e-6


def test_fallback_provider_on_quota():
    from app.services.lmstudio_client import FallbackVisionClient
    from app.services.vision_client import ProviderError

    class Out:
        name, model = "gemini", "g"
        def generate_text_json(self, p): raise ProviderError("quota", 429)

    class Local:
        name, model = "lmstudio-local", "gemma"
        def generate_text_json(self, p): return "{}"

    class Broken:
        name, model = "x", "y"
        def generate_text_json(self, p): raise ProviderError("bad key", 502)

    f = FallbackVisionClient([Out(), Local()])
    assert f.generate_text_json("p") == "{}" and f.name == "lmstudio-local" and f.model == "gemma"
    with pytest.raises(ProviderError):  # non-quota errors are not hidden
        FallbackVisionClient([Broken(), Local()]).generate_text_json("p")
