"""Tests for box metrics, the mock screens and the eval script (fake model; no live inference)."""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import importlib.util
import json
from pathlib import Path

import pytest

from app.services.box_eval import iou, match_ground_truth
from app.uploads import validate_image

API = Path(__file__).resolve().parent.parent
SCREENS = API / "tests" / "fixtures" / "screens"


def test_iou_basics():
    a = {"x": 0, "y": 0, "width": 0.5, "height": 0.5}
    assert iou(a, a) == 1.0
    assert iou(a, {"x": 0.5, "y": 0.5, "width": 0.5, "height": 0.5}) == 0.0
    assert abs(iou(a, {"x": 0.25, "y": 0, "width": 0.5, "height": 0.5}) - 1 / 3) < 1e-9


def test_matching_is_one_to_one_and_reports_types():
    gt = [{"id": "a", "type": "button", "bbox": {"x": 0, "y": 0, "width": 0.2, "height": 0.1}},
          {"id": "b", "type": "card", "bbox": {"x": 0.5, "y": 0.5, "width": 0.2, "height": 0.2}}]
    pred = [{"id": "p1", "type": "button", "bbox": {"x": 0, "y": 0, "width": 0.2, "height": 0.1}},
            {"id": "p2", "type": "button", "bbox": {"x": 0.01, "y": 0, "width": 0.2, "height": 0.1}},
            {"id": "p3", "type": "text", "bbox": None}]
    m = match_ground_truth(gt, pred)
    assert m["recall"] == 0.5 and m["rows"][0]["predId"] == "p1" and m["typeAgreementOfHits"] == 1.0
    assert m["rows"][1]["hit"] is False and m["predictedWithBox"] == 2


def test_mock_screens_are_valid_uploads_with_ground_truth():
    pngs = sorted(SCREENS.glob("*.png"))
    assert len(pngs) == 3
    for png in pngs:
        img = validate_image(png.read_bytes(), png.name)
        gt = json.loads(png.with_suffix(".gt.json").read_text(encoding="utf-8"))
        assert (img.width, img.height) == (gt["width"], gt["height"]) and len(gt["elements"]) >= 8
        for e in gt["elements"]:
            b = e["bbox"]
            assert 0 <= b["x"] and b["x"] + b["width"] <= 1.0001 and 0 <= b["y"] and b["y"] + b["height"] <= 1.0001


class PerfectFake:
    """Answers with the ground-truth boxes in Gemini's box_2d format for whichever screen it gets."""

    name, model = "fake", "fake-1"

    def __init__(self):
        self.by_size = {}
        for gt_file in SCREENS.glob("*.gt.json"):
            gt = json.loads(gt_file.read_text(encoding="utf-8"))
            self.by_size[(gt["width"], gt["height"])] = gt["elements"]

    def generate_json(self, image_bytes, mime, prompt):
        import io

        from PIL import Image

        size = Image.open(io.BytesIO(image_bytes)).size
        comps = [{"id": e["id"], "label": e["id"], "type": e["type"], "status": "observed",
                  "box_2d": [e["bbox"]["y"] * 1000, e["bbox"]["x"] * 1000,
                             (e["bbox"]["y"] + e["bbox"]["height"]) * 1000, (e["bbox"]["x"] + e["bbox"]["width"]) * 1000]}
                 for e in self.by_size[size]]
        return json.dumps({"title": "t", "summary": "s", "components": comps, "relationships": []})


def test_eval_script_end_to_end_with_fake_model(tmp_path, monkeypatch):
    spec = importlib.util.spec_from_file_location("eval_digital", API / "scripts" / "eval_digital.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    monkeypatch.setattr(mod, "get_vision_client", lambda: PerfectFake())
    monkeypatch.setattr(mod, "OUT", tmp_path)
    assert mod.main([]) == 0
    summary = json.loads((tmp_path / "eval_summary.json").read_text(encoding="utf-8"))
    assert len(summary["screens"]) == 3
    assert all(s["recall"] == 1.0 and s["meanIoUOfHits"] > 0.97 for s in summary["screens"])
    assert len(list(tmp_path.glob("*.overlay.png"))) == 3


def test_eval_script_refuses_fixture_mode(monkeypatch):
    spec = importlib.util.spec_from_file_location("eval_digital2", API / "scripts" / "eval_digital.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    class Fixture:
        name, model = "fixture", "x"

    monkeypatch.setattr(mod, "get_vision_client", lambda: Fixture())
    assert mod.main([]) == 2


def test_type_groups_accept_equivalent_labels():
    from app.services.box_eval import types_agree

    assert types_agree("hero", "section") and types_agree("paragraph", "text")
    assert not types_agree("button", "text") and not types_agree(None, "text")


def test_shared_adapter_routes_text_only_calls_and_maps_errors():
    """Chat (image None) goes to the shared client's generate_text_json; ProviderError -> VisionProviderError."""
    import pytest as _pytest

    from app.services.vision_client import ProviderError
    from app.services.vision_provider import SharedClientAdapter, VisionProviderError

    class Inner:
        name, model = "google-gemini", "g-1"

        def __init__(self):
            self.calls = []

        def generate_json(self, b, m, p):
            self.calls.append(("image", m))
            return "{}"

        def generate_text_json(self, p):
            self.calls.append(("text", None))
            return "{}"

    inner = Inner()
    ad = SharedClientAdapter(inner)
    ad.generate_json(b"x", "image/webp", "p")
    ad.generate_json(None, None, "p")
    assert inner.calls == [("image", "image/webp"), ("text", None)]
    assert ad.name == "google-gemini" and ad.last_call["model"] == "g-1"

    for status, code in [(429, "provider_rate_limited"), (503, "provider_unavailable"), (504, "provider_timeout"), (502, "provider_error")]:
        def boom(*a, _s=status):
            raise ProviderError("friendly message", _s)
        inner.generate_text_json = boom
        with _pytest.raises(VisionProviderError) as ei:
            ad.generate_json(None, None, "p")
        assert (ei.value.code, ei.value.http_status, ei.value.message) == (code, status, "friendly message")


def test_shared_client_is_reused_and_fixture_mode_wins(monkeypatch):
    from app.services import vision_provider as vp

    sentinel = type("C", (), {"name": "n", "model": "m"})()
    vp.set_shared_client(sentinel)
    a1, a2 = vp.get_vision_client(), vp.get_vision_client()
    assert a1 is a2 and a1.inner is sentinel
    monkeypatch.setenv("VRE_FIXTURE_MODE", "1")
    assert vp.get_vision_client().name == "fixture"
    vp.set_shared_client(None)


def test_eval_chat_flag_asks_one_grounded_question(tmp_path, monkeypatch):
    spec = importlib.util.spec_from_file_location("eval_digital3", API / "scripts" / "eval_digital.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    class WithChat(PerfectFake):
        def generate_json(self, image_bytes, mime, prompt):
            if image_bytes is None:
                return json.dumps({"answer": "The button.", "referencedComponentIds": ["hero-cta", "made-up"],
                                   "referencedRelationshipIds": [], "limitations": []})
            return super().generate_json(image_bytes, mime, prompt)

    monkeypatch.setattr(mod, "get_vision_client", lambda: WithChat())
    monkeypatch.setattr(mod, "OUT", tmp_path)
    assert mod.main(["--chat", str(SCREENS / "landing.png")]) == 0
    row = json.loads((tmp_path / "eval_summary.json").read_text(encoding="utf-8"))["screens"][0]
    assert row["chat"]["referencedComponentIds"] == ["hero-cta"]  # invented id filtered out
    assert any("runtime behaviour" in x for x in row["chat"]["limitations"])  # "clicked" -> caveat added
