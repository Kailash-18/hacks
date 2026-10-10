from app.schemas import Component, Relationship, Scene, SystemAnalysis, Provider, Source
from app.services.assembly import apply_system, parse_assembly, parse_extra_parts
from app.services.component_graph import what_if


def _analysis():
    comps = [Component(id="shell", label="Top shell", type="cover", status="observed"),
             Component(id="button", label="Left button", type="interface", status="observed"),
             Component(id="logo", label="Logo", type="cover", status="observed")]
    return SystemAnalysis(analysisId="x", domain="physical", title="mouse", source=Source(filename="a"),
                          components=comps, relationships=[], provider=Provider(name="t", model="t"),
                          scene=Scene(imageWidth=10, imageHeight=10))


RAW = {
    "overall_size": [60, 40, 100],
    "parts": [
        {"id": "shell", "shape": "dome", "size": [60, 30, 100], "position": [0, 5, 0], "importance": 0.4,
         "function": "Encloses everything", "if_removed": "Internals exposed"},
        {"id": "button", "shape": "plate", "size": [25, 2, 40], "position": [-12, 20, 25], "importance": 0.6},
        {"id": "logo", "shape": "plate", "size": [10, 1, 5], "position": [0, 20, -10], "importance": 0.05},
        {"id": "battery", "shape": "cylinder", "size": [14, 50, 14], "position": [0, 0, -10], "importance": 1.0,
         "if_removed": "Mouse is dead: no power"},
        {"id": "pcb", "shape": "plate", "size": [40, 2, 70], "position": [0, -8, 0], "importance": 0.95},
    ],
    "extra_parts": [{"id": "battery", "label": "AA battery", "type": "power_source", "reason": "wireless mouse"},
                    {"id": "pcb", "label": "Main PCB", "type": "controller"},
                    {"id": "shell", "label": "dup", "type": "cover"}],
    "relationships": [
        {"from": "battery", "to": "pcb", "type": "powers", "why": "AA cell feeds the board"},
        {"from": "button", "to": "pcb", "type": "controls", "why": "click switch input"},
        {"from": "shell", "to": "button", "type": "supports"},
        {"from": "pcb", "to": "battery", "type": "powers"},  # same pair again: ignored
        {"from": "ghost", "to": "pcb", "type": "powers"},
    ],
}


def test_extra_parts_skip_duplicates():
    extra = parse_extra_parts(RAW, {"shell", "button", "logo"})
    assert [c.id for c in extra] == ["battery", "pcb"]
    assert all(c.status == "inferred" for c in extra)


def test_apply_system_builds_full_graph():
    a = _analysis()
    extra = parse_extra_parts(RAW, {c.id for c in a.components})
    asm = parse_assembly(RAW, {c.id for c in a.components} | {c.id for c in extra})
    apply_system(a, RAW, extra, asm)
    ids = {c.id for c in a.components}
    assert {"battery", "pcb"} <= ids and {"battery", "pcb"} <= set(a.scene.ghost_component_ids)
    pairs = {(r.from_, r.to, r.type) for r in a.relationships}
    assert ("battery", "pcb", "powers") in pairs and ("pcb", "battery", "powers") not in pairs
    assert ("shell", "logo", "supports") in pairs  # isolated logo gets held by the housing
    linked = {x for r in a.relationships for x in (r.from_, r.to)}
    assert linked == ids
    batt = next(c for c in a.components if c.id == "battery")
    assert batt.importance == 1.0 and "dead" in batt.if_removed


def test_what_if_impact_health_verdict():
    a = _analysis()
    extra = parse_extra_parts(RAW, {c.id for c in a.components})
    asm = parse_assembly(RAW, {c.id for c in a.components} | {c.id for c in extra})
    apply_system(a, RAW, extra, asm)
    res = what_if(a.components, a.relationships, "battery")
    assert res["verdict"] == "dead" and res["consequence"].startswith("Mouse is dead")
    pcb = next(x for x in res["affected"] if x["componentId"] == "pcb")
    assert pcb["impact"] == "loses power" and pcb["severity"] == "fails" and pcb["why"]
    assert 0 <= res["health"] < 50
    shell = what_if(a.components, a.relationships, "shell")
    assert {x["severity"] for x in shell["affected"]} == {"loose"}
    assert what_if(a.components, a.relationships, "logo")["verdict"] == "works"


def test_what_if_old_graph_still_works():
    c = [Component(id="a", label="A"), Component(id="b", label="B")]
    r = [Relationship(**{"id": "1", "from": "a", "to": "b", "type": "drives"})]
    res = what_if(c, r, "a")
    assert res["affected"][0]["impact"] == "stops moving" and "health" in res


def test_duplicate_parts_from_several_photos_are_merged():
    from app.services.assembly import find_duplicates
    comps = [Component(id=i, label=l, type=t, status="observed") for i, l, t in [
        ("pins", "Power Plug Pins", "connector"), ("pins2", "Power Pins", "connector"),
        ("wick", "Wick", "mechanism"), ("wick3", "Vaporizing Wick", "interface"),
        ("casing", "Heater Casing", "structure"), ("heater", "Heating Element", "mechanism"),
        ("plug", "Electrical Plug", "connector")]]
    raw = {"parts": [
        {"id": "pins", "shape": "cylinder", "size": [4, 18, 4], "position": [0, 30, -18], "rotation": [90, 0, 0]},
        {"id": "pins2", "shape": "cylinder", "size": [4, 18, 4], "position": [0, 30, -18], "rotation": [90, 0, 0]},
        {"id": "wick", "shape": "cylinder", "size": [6, 65, 6], "position": [0, 10, 0]},
        {"id": "wick3", "shape": "cylinder", "size": [6, 10, 6], "position": [0, 15, 0]},
        {"id": "casing", "shape": "cylinder", "size": [30, 25, 30], "position": [0, 15, 0]},
        {"id": "heater", "shape": "torus", "size": [20, 8, 20], "position": [0, 15, 0], "rotation": [90, 0, 0]},
        {"id": "plug", "shape": "rounded_box", "size": [35, 35, 20], "position": [0, 30, -17]}]}
    assert find_duplicates(raw, comps) == {"pins2": "pins", "wick3": "wick"}


def test_label_closeup_or_unknown_photo_is_not_a_different_object():
    from app.services.physical_analysis import _clearly_other, _odd_photos_heuristic
    mouse = {"object_name": "Computer Mouse", "product": {"category": "computer mouse", "brand": "Lenovo"}, "view": "top"}
    assert not _clearly_other(mouse, {"object_name": "unknown", "view": "bottom"})
    assert not _clearly_other(mouse, {"object_name": "Product label sticker", "view": "unknown"})
    assert not _clearly_other(mouse, {"object_name": "", "view": "front"})
    assert not _clearly_other(mouse, {"object_name": "Wireless device", "product": {"brand": "Lenovo"}, "view": "front"})
    assert _clearly_other(mouse, {"object_name": "Smartphone", "product": {"category": "mobile phone"}, "view": "front"})
    assert _odd_photos_heuristic([mouse, {"object_name": "unknown"}, {"object_name": "Smartphone"}]) == [3]
