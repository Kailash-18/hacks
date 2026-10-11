"""Verified parts list: renames, drops only unseen guesses, adds real inside parts with links."""
import json
from pathlib import Path

from app.schemas import SystemAnalysis
from app.services.bom import apply_bom, parse_bom, verify_parts

SAMPLE = Path(__file__).resolve().parents[1] / "samples" / "lenovo-mouse.json"


def _mouse():
    return SystemAnalysis.model_validate(json.loads(SAMPLE.read_text(encoding="utf-8")))


def test_apply_renames_adds_and_never_drops_seen_parts():
    a = _mouse()
    bom = {"product": "Logitech M185", "sources": [{"title": "iFixit: M185 teardown", "url": "https://www.ifixit.com/x"}], "parts": [
        {"id": "battery_compartment", "action": "keep", "label": "1x AA battery compartment", "source": "spec sheet", "confidence": 0.9},
        {"id": "left_button", "action": "drop"},
        {"id": "base_chassis", "action": "drop"}],
        "add": [{"label": "Omron microswitch", "type": "actuator", "source": "iFixit teardown", "confidence": 0.8,
                 "links": [{"from": "Omron microswitch", "to": "pcb", "type": "connected_to"}]}]}
    st = apply_bom(a, bom)
    ids = {c.id for c in a.components}
    assert "left_button" in ids                      # seen in the photo: kept
    assert "base_chassis" not in ids                 # unseen guess the product does not have: removed
    assert not any("base_chassis" in (r.from_, r.to) for r in a.relationships)
    bat = next(c for c in a.components if c.id == "battery_compartment")
    assert bat.label == "1x AA battery compartment" and bat.evidence[0].startswith("Confirmed for Logitech M185")
    assert "omron_microswitch" in ids and "omron_microswitch" in a.scene.ghost_component_ids
    assert any(r.from_ == "omron_microswitch" and r.to == "pcb" for r in a.relationships)
    assert st == {"renamed": 1, "dropped": 1, "added": 1, "confirmed": 2}


def test_parse_and_skip_without_identified_model():
    assert parse_bom('```json\n{"parts": []}\n```') == {"parts": []}
    assert parse_bom("no json") is None

    class Client:
        name, model = "x", "m"
        def generate_grounded(self, images, prompt):
            raise AssertionError("must not be called without an identified product")
    a = _mouse()
    a.scene.product.model = None
    a.scene.product.user_hint = ""
    assert verify_parts(a, [], Client()) is None


def test_no_web_sources_means_nothing_is_verified_and_seen_parts_never_are():
    a = _mouse()
    bom = {"product": "Lenovo 130", "sources": [], "parts": [
        {"id": "battery_compartment", "action": "keep", "label": "AA battery", "source": "Lenovo 130 specs", "confidence": 0.9},
        {"id": "left_button", "action": "keep", "label": "Left button", "source": "Lenovo 130 specs", "confidence": 0.9},
        {"id": "bottom_shell", "action": "keep", "label": "Bottom shell", "type": "structure", "source": "specs", "confidence": 0.9}]}
    apply_bom(a, bom)
    verified = [c.id for c in a.components if any(e.startswith("Confirmed for") for e in c.evidence)]
    assert verified == []                                   # model memory only: not verified
    assert "bottom_shell" in {c.id for c in a.components}   # a real part the photo pass missed is added
    assert "web search was unavailable" in a.scene.notes[-1]


def test_visual_inspection_is_not_a_source_and_seen_parts_are_not_tagged():
    a = _mouse()
    bom = {"product": "X", "sources": [{"title": "s", "url": "u"}], "parts": [
        {"id": "pcb", "action": "keep", "label": "Main board", "source": "visual inspection", "confidence": 0.9},
        {"id": "left_button", "action": "keep", "label": "Left button", "source": "iFixit teardown", "confidence": 0.9}]}
    apply_bom(a, bom)
    assert not any(any(e.startswith("Confirmed for") for e in c.evidence) for c in a.components)
