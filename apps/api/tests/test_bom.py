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
    bom = {"product": "Logitech M185", "parts": [
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
    assert st == {"renamed": 1, "dropped": 1, "added": 1, "confirmed": 1}


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
