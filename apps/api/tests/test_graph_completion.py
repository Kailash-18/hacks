"""The system graph connects the board, battery and connectors the model left floating (inferred edges only)."""

import json
import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.schemas import Component, Relationship
from app.services.component_graph import complete_relationships, what_if

SAMPLES = Path(__file__).resolve().parent.parent / "samples"


def _load(name):
    a = json.loads((SAMPLES / name).read_text(encoding="utf-8"))
    return [Component.model_validate(c) for c in a["components"]], [Relationship.model_validate(r) for r in a["relationships"]]


def test_isolated_parts_get_inferred_links_and_observed_edges_are_kept():
    comps, rels = _load("game-boy.json")
    out = complete_relationships(comps, rels)
    assert out[: len(rels)] == rels
    added = out[len(rels):]
    assert added and all(r.status == "inferred" and "inferred from the part types" in r.evidence[0] for r in added)
    used = {x for r in out for x in (r.from_, r.to)}
    assert all(c.id in used for c in comps)  # nothing floats any more
    assert ("battery_terminals", "motherboard", "powers") in {(r.from_, r.to, r.type) for r in added}


def test_completion_is_idempotent_and_drives_the_what_if():
    comps, rels = _load("lenovo-mouse.json")
    once = complete_relationships(comps, rels)
    assert complete_relationships(comps, once) == once
    hit = {a["componentId"] for a in what_if(comps, once, "battery_compartment")["affected"]}
    assert "pcb" in hit and "logo_badge" not in hit  # decorations are never "controlled"


def test_no_board_means_no_invented_power_links():
    comps = [Component(id="a", label="Lid", type="cover"), Component(id="b", label="Battery", type="power_source")]
    out = complete_relationships(comps, [])
    assert [(r.from_, r.to, r.type) for r in out] == [("a", "b", "contains")]


def test_removing_the_board_or_battery_kills_an_electronic_device():
    comps, rels = _load("lenovo-mouse.json")
    rels = complete_relationships(comps, rels)
    board = what_if(comps, rels, "pcb")
    assert board["verdict"] == "dead" and board["health"] <= 10
    assert {"left_button", "right_button", "scroll_wheel", "optical_sensor"} <= {a["componentId"] for a in board["affected"]}
    assert what_if(comps, rels, "battery_compartment")["verdict"] == "dead"
    assert what_if(comps, rels, "logo_badge")["verdict"] == "works"  # a logo is decoration


def test_the_only_sensor_is_core_and_the_only_screen_cripples():
    comps, rels = _load("lenovo-mouse.json")
    rels = complete_relationships(comps, rels)
    w = what_if(comps, rels, "optical_sensor")
    assert w["verdict"] == "dead" and w["health"] <= 10 and "optical tracking sensor" in w["consequence"]
    comps, rels = _load("game-boy.json")
    rels = complete_relationships(comps, rels)
    w = what_if(comps, rels, "lcd_screen")
    assert w["verdict"] == "degraded" and w["health"] <= 30
    assert what_if(comps, rels, "a_button")["health"] > 80  # one button is a small loss


def test_teardown_topic_rejects_other_products():
    from app.services.teardown import topic_words
    must = topic_words("wireless mouse")
    assert must == {"mouse"}
    assert not (must & topic_words("Lenovo IdeaPad 3-15IAU7 Teardown"))
    assert must & topic_words("Logitech M325 Mouse Teardown")
