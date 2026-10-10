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
