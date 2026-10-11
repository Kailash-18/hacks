"""Core tests: no FastAPI or network needed. Model replies are recorded fixtures, not live inference."""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import io
import json

import pytest

from app.contract import SystemAnalysis, is_propagating
from app.errors import ApiError
from app.services.digital_analysis import analyze_digital_image, build_components_and_relationships, normalise_box
from app.services.fixtures import CHAT_FIXTURE, DIGITAL_FIXTURE
from app.services.grounded_chat import DIGITAL_BEHAVIOUR_LIMITATION, answer_question
from app.contract import ChatRequest
from app.services.vision_provider import VisionProviderError, parse_model_json
from app.uploads import MAX_UPLOAD_BYTES, validate_image


class FakeClient:
    name, model = "fake", "fake-1"

    def __init__(self, reply=None, exc=None):
        self.reply, self.exc, self.calls = reply, exc, []

    def generate_json(self, image_bytes, mime, prompt):
        self.calls.append((image_bytes is not None, mime, prompt))
        if self.exc:
            raise self.exc
        return self.reply


def png_bytes(w=64, h=48):
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (w, h), "white").save(buf, "PNG")
    return buf.getvalue()


def base(**kw):
    d = {"analysisId": "a1", "domain": "digital", "title": "t", "source": {"kind": "image", "filename": "x.png"},
         "components": [], "relationships": [], "provider": {"name": "p", "model": "m"}}
    d.update(kw)
    return d


def comp(cid, **kw):
    return {"id": cid, "label": cid, "type": "button", "status": "observed", **kw}


# --- contract ---------------------------------------------------------------
def test_contract_roundtrip_uses_from_alias_and_omits_scene_for_digital():
    a = SystemAnalysis.model_validate(base(
        components=[comp("a"), comp("b")],
        relationships=[{"id": "r", "from": "a", "to": "b", "type": "contains", "status": "inferred"}],
    ))
    out = a.to_api()
    assert out["relationships"][0]["from"] == "a" and "from_" not in out["relationships"][0]
    assert "scene" not in out
    assert out["components"][0]["bbox"] is None and out["components"][0]["confidence"] is None


@pytest.mark.parametrize("bad", [
    {"components": [comp("a"), comp("a")]},
    {"components": [comp("a")], "relationships": [{"id": "r", "from": "a", "to": "zzz", "type": "x", "status": "inferred"}]},
    {"components": [comp("a", bbox={"x": 0.8, "y": 0, "width": 0.5, "height": 0.1})]},
    {"components": [comp("a", status="certain")]},
    {"domain": "other"},
])
def test_contract_rejects_invalid(bad):
    with pytest.raises(ValueError):
        SystemAnalysis.model_validate(base(**bad))


def test_scene_is_physical_only_and_checks_references():
    scene = {"kind": "layered-2.5d", "imageWidth": 10, "imageHeight": 10, "plate": "data:image/png;base64,",
             "plateBbox": {"x": 0, "y": 0, "width": 1, "height": 1},
             "layers": [{"componentId": "a", "bbox": {"x": 0, "y": 0, "width": 0.5, "height": 0.5},
                         "cutout": "data:image/png;base64,", "depthRank": 0}],
             "ghostComponentIds": ["g"]}
    ok = SystemAnalysis.model_validate(base(domain="physical", components=[comp("a"), comp("g", status="inferred")], scene=scene))
    assert ok.to_api()["scene"]["layers"][0]["componentId"] == "a"
    with pytest.raises(ValueError):
        SystemAnalysis.model_validate(base(components=[comp("a"), comp("g")], scene=scene))  # digital + scene
    with pytest.raises(ValueError):
        SystemAnalysis.model_validate(base(domain="physical", components=[comp("a")], scene=scene))  # ghost missing


def test_edge_rule_unknown_types_do_not_propagate():
    assert is_propagating("powers") and is_propagating("mounts")
    assert not is_propagating("contains") and not is_propagating("label_for") and not is_propagating("whatever")


# --- box handling -----------------------------------------------------------
def test_box_2d_converted_from_0_1000_yx_order():
    b, warn = normalise_box({"box_2d": [100, 200, 300, 600]})
    assert (b.x, b.y, b.width, b.height) == (0.2, 0.1, 0.4, 0.2) and warn is None


def test_box_clamped_and_degenerate_dropped():
    b, warn = normalise_box({"box_2d": [-50, 900, 400, 1200]})
    assert b.x + b.width <= 1.0 and b.y == 0.0 and warn == "box clamped to image"
    assert normalise_box({"box_2d": [100, 100, 100, 500]})[0] is None
    assert normalise_box({"box_2d": ["a", 1, 2, 3]})[0] is None
    assert normalise_box({"bbox": {"x": 0.1, "y": 0.1, "width": 0.2, "height": 0.3}})[0].width == 0.2


# --- digital analysis -------------------------------------------------------
def test_fixture_digital_analysis_builds_valid_tree():
    client = FakeClient(json.dumps(DIGITAL_FIXTURE))
    a = analyze_digital_image(png_bytes(), "shot.png", client)
    assert a.domain == "digital" and a.analysisId.startswith("digital-")
    ids = {c.id for c in a.components}
    assert {"hero-cta", "hero-section", "navbar"} <= ids
    edges = {(r.from_, r.to, r.type): r for r in a.relationships}
    # Edge rule: container -> child. Geometry confirms the model's parent => observed.
    assert edges[("hero-section", "hero-cta", "contains")].status == "observed"
    assert all(r.status != "observed" for r in a.relationships if r.type != "contains")
    assert a.provider.name == "fake" and all(c.confidence is None for c in a.components)
    assert client.calls[0][0] is True  # image was sent


def test_behavioural_edges_downgraded_and_bad_refs_dropped():
    raw = {"components": [
        {"id": "btn", "label": "Buy", "type": "button", "box_2d": [10, 10, 50, 200]},
        {"id": "cart", "label": "Cart", "type": "CTA", "box_2d": [10, 300, 50, 500]},
    ], "relationships": [
        {"from": "btn", "to": "cart", "type": "navigates_to"},
        {"from": "btn", "to": "ghost", "type": "adjacent_to"},
        {"from": "btn", "to": "btn", "type": "adjacent_to"},
    ]}
    comps, rels, warnings = build_components_and_relationships(raw)
    assert comps[1].type == "button"  # alias CTA -> button
    assert [(r.type, r.status) for r in rels] == [("appears_related_to", "inferred")]
    assert any("downgraded" in w for w in warnings)


def test_geometry_derives_missing_parent_and_flags_wrong_parent():
    raw = {"components": [
        {"id": "card", "label": "Card", "type": "card", "box_2d": [0, 0, 500, 500]},
        {"id": "title", "label": "Title", "type": "heading", "box_2d": [10, 10, 60, 300]},
        {"id": "far", "label": "Far button", "type": "button", "box_2d": [800, 800, 900, 900], "parentId": "card"},
    ]}
    _, rels, warnings = build_components_and_relationships(raw)
    e = {(r.from_, r.to): r for r in rels}
    assert e[("card", "title")].status == "estimated"
    assert e[("card", "far")].status == "inferred"
    assert any("not confirmed" in w for w in warnings)


def test_parent_cycles_are_broken_and_duplicate_ids_renamed():
    raw = {"components": [
        {"id": "a", "label": "A", "parentId": "b"}, {"id": "b", "label": "B", "parentId": "a"},
        {"id": "a", "label": "A again"},
    ]}
    comps, rels, _ = build_components_and_relationships(raw)
    assert [c.id for c in comps] == ["a", "b", "a-2"]
    assert len([r for r in rels if r.type == "contains"]) == 1


def test_empty_model_result_is_graceful_not_invented():
    a = analyze_digital_image(png_bytes(), "cat.png", FakeClient('{"components": [], "limitations": ["Not a UI"]}'))
    assert a.components == [] and "No interface components" in a.summary
    assert any("Not a UI" in x for x in a.limitations)


@pytest.mark.parametrize("reply", ["", "sorry, I cannot", "[1,2]", "{bad json"])
def test_bad_model_output_is_controlled_error(reply):
    with pytest.raises(VisionProviderError) as ei:
        analyze_digital_image(png_bytes(), "x.png", FakeClient(reply))
    assert ei.value.code == "provider_bad_output"


def test_fenced_json_is_parsed():
    assert parse_model_json('```json\n{"a": 1}\n```') == {"a": 1}
    assert parse_model_json('Here you go: {"a": 2} thanks') == {"a": 2}


def test_provider_errors_propagate_unchanged():
    err = VisionProviderError("provider_rate_limited", "slow down", 429)
    with pytest.raises(VisionProviderError) as ei:
        analyze_digital_image(png_bytes(), "x.png", FakeClient(exc=err))
    assert ei.value.http_status == 429


# --- uploads ----------------------------------------------------------------
def test_upload_validation():
    v = validate_image(png_bytes(), "C:\\fake\\path\\shot.png")
    assert v.mime == "image/png" and v.filename == "shot.png" and (v.width, v.height) == (64, 48)
    for data, code in [(b"", "empty_file"), (b"GIF89a....", "unsupported_media_type"),
                       (b"\x89PNG\r\n\x1a\n" + b"0" * 50, "corrupt_image"),
                       (png_bytes(10, 10), "image_too_small"), (b"\xff\xd8\xff" + b"0" * MAX_UPLOAD_BYTES, "file_too_large")]:
        with pytest.raises(ApiError) as ei:
            validate_image(data, "x")
        assert ei.value.code == code


# --- chat -------------------------------------------------------------------
def _digital():
    return analyze_digital_image(png_bytes(), "shot.png", FakeClient(json.dumps(DIGITAL_FIXTURE)))


def test_chat_filters_unknown_ids_and_adds_behaviour_caveat():
    reply = dict(CHAT_FIXTURE, referencedComponentIds=["hero-cta", "invented-id"])
    client = FakeClient(json.dumps(reply))
    resp = answer_question(_digital(), ChatRequest(question="What API does the button call?",
                                                   selectedComponentIds=["hero-cta"]), client)
    assert resp.referencedComponentIds == ["hero-cta"]
    assert DIGITAL_BEHAVIOUR_LIMITATION in resp.limitations
    assert client.calls[0][0] is False  # text-only call; no image / scene data sent
    assert "data:image" not in client.calls[0][2]


def test_chat_rejects_unknown_selection():
    with pytest.raises(ApiError) as ei:
        answer_question(_digital(), ChatRequest(question="q", selectedComponentIds=["nope"]), FakeClient("{}"))
    assert ei.value.code == "unknown_selection"


def test_chat_empty_answer_admits_insufficient_evidence():
    resp = answer_question(_digital(), ChatRequest(question="Who built this?"), FakeClient("{}"))
    assert "not contain enough evidence" in resp.answer


@pytest.mark.parametrize("q", ["What happens if I click Log in?", "Where does tapping this take me?"])
def test_chat_behaviour_caveat_for_interaction_questions(q):
    resp = answer_question(_digital(), ChatRequest(question=q), FakeClient(json.dumps(CHAT_FIXTURE)))
    assert DIGITAL_BEHAVIOUR_LIMITATION in resp.limitations


def test_chat_no_behaviour_caveat_for_layout_questions():
    resp = answer_question(_digital(), ChatRequest(question="How many feature cards are there?"),
                           FakeClient(json.dumps(dict(CHAT_FIXTURE, limitations=[]))))
    assert DIGITAL_BEHAVIOUR_LIMITATION not in resp.limitations


def test_chat_drops_repeated_analysis_limitations_and_names_the_source():
    a = _digital()
    reply = dict(CHAT_FIXTURE, limitations=[a.limitations[0], "Answer-specific caveat", "Answer-specific caveat"])
    client = FakeClient(json.dumps(reply))
    resp = answer_question(a, ChatRequest(question="How many cards?"), client)
    assert resp.limitations == ["Answer-specific caveat"]
    assert "The source is a screenshot" in client.calls[0][2]
