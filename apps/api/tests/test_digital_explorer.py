"""Digital explorer engine + routes: tree, what-if, workflow, diff, tokens, reconstruction. No live inference."""

import io
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest

from app.contract import Provider
from app.services import digital_explorer as dx
from app.services.digital_analysis import build_digital_analysis

PROV = Provider(name="fake", model="fake-1")


def screen(title, comps, sha="a" * 64, filename="s.png"):
    return build_digital_analysis({"title": title, "summary": f"{title} screen", "components": comps},
                                  filename=filename, sha256=sha, provider=PROV)


LOGIN = [
    {"id": "form", "label": "Login form", "type": "form", "box_2d": [200, 100, 800, 900]},
    {"id": "email-label", "label": "Email", "type": "text", "box_2d": [250, 150, 280, 300], "parentId": "form"},
    {"id": "email", "label": "Email address", "type": "input", "box_2d": [290, 150, 350, 850], "parentId": "form"},
    {"id": "submit", "label": "Sign in", "type": "button", "box_2d": [600, 150, 680, 850], "parentId": "form"},
    {"id": "go-dash", "label": "Go to dashboard", "type": "link", "box_2d": [900, 400, 930, 600]},
]
DASH = [
    {"id": "nav", "label": "Top navigation", "type": "navbar", "box_2d": [0, 0, 80, 1000]},
    {"id": "nav-settings", "label": "Settings", "type": "link", "box_2d": [20, 800, 60, 900], "parentId": "nav"},
    {"id": "title", "label": "Dashboard", "type": "heading", "box_2d": [100, 50, 150, 400]},
    {"id": "card-1", "label": "Revenue", "type": "card", "box_2d": [200, 50, 400, 300]},
    {"id": "card-2", "label": "Orders", "type": "card", "box_2d": [200, 350, 400, 600]},
    {"id": "card-3", "label": "Refunds", "type": "card", "box_2d": [200, 650, 400, 900]},
]
SETTINGS = [{"id": "h", "label": "Settings", "type": "heading", "box_2d": [100, 50, 150, 400]},
            {"id": "save", "label": "Save changes", "type": "button", "box_2d": [800, 50, 860, 300]}]


def test_tree_follows_containment_in_reading_order():
    a = screen("Login", LOGIN)
    tree = dx.build_tree(a)
    form = next(n for n in tree if n["id"] == "form")
    assert [k["id"] for k in form["children"]] == ["email-label", "email", "submit"]
    assert {n["id"] for n in tree} == {"form", "go-dash"}


def test_whatif_container_removes_children_and_matches_physical_shape():
    a = screen("Login", LOGIN)
    out = dx.digital_impact(a, "form")
    ids = {x["componentId"] for x in out["affected"]}
    assert {"email-label", "email", "submit"} <= ids
    assert out["verdict"] == "broken"  # removing the whole form breaks the screen's purpose
    for key in ("removedComponentId", "health", "verdict", "affected", "unaffectedComponentIds", "summary", "method"):
        assert key in out
    assert "go-dash" in out["unaffectedComponentIds"]
    with pytest.raises(KeyError):
        dx.digital_impact(a, "nope")


def test_workflow_label_matching_without_model():
    screens = [screen("Login", LOGIN, "1" * 64), screen("Dashboard", DASH, "2" * 64), screen("Settings", SETTINGS, "3" * 64)]
    wf, notes = dx.build_workflow(screens, None)
    edges = {(r.from_, r.to) for r in wf.relationships}
    sid = {c.label: c.id for c in wf.components}
    assert (sid["Login"], sid["Dashboard"]) in edges           # "Go to dashboard" link
    assert (sid["Dashboard"], sid["Settings"]) in edges        # "Settings" nav link
    assert all(r.status == "inferred" and r.type == "may_navigate_to" for r in wf.relationships)
    rel = wf.to_api()["relationships"][0]
    assert rel["trigger"]["componentId"] and rel["source"] == "label-match"
    assert any(c.model_dump().get("isEntry") for c in wf.components)
    assert any("hypothesis" in l for l in wf.limitations)


class ModelClient:
    name, model = "fake", "fake-1"

    def __init__(self, payload):
        self.payload = payload

    def generate_json(self, image_bytes, mime, prompt):
        return json.dumps(self.payload)

    def generate_json_images(self, images, prompt):
        return json.dumps(self.payload)


def test_workflow_model_hypotheses_are_validated():
    screens = [screen("Login", LOGIN, "1" * 64), screen("Settings", SETTINGS, "3" * 64)]
    s1, s2 = dx._screen_id(screens[0], 0), dx._screen_id(screens[1], 1)
    payload = {"transitions": [{"from": s1, "to": s2, "triggerComponentId": "submit", "reason": "after sign in"},
                               {"from": "ghost", "to": s2}, {"from": s1, "to": s1}],
               "entryScreen": s1, "flowSummary": "Users sign in then adjust settings."}
    wf, _ = dx.build_workflow(screens, ModelClient(payload))
    assert len(wf.relationships) == 1 and wf.relationships[0].to == s2
    assert wf.summary.startswith("Users sign in")


def test_workflow_survives_model_failure():
    class Broken(ModelClient):
        def generate_json(self, *a):
            raise RuntimeError("quota")
    wf, notes = dx.build_workflow([screen("Login", LOGIN, "1" * 64), screen("Dashboard", DASH, "2" * 64)], Broken({}))
    assert wf.relationships and any("unavailable" in n for n in notes)


def test_diff_detects_added_removed_moved_and_text():
    before = screen("Dashboard", DASH, "2" * 64)
    after_comps = [dict(c) for c in DASH if c["id"] != "card-3"]
    after_comps[2] = {**after_comps[2], "label": "Overview"}                    # title text changed
    after_comps[3] = {**after_comps[3], "box_2d": [500, 50, 700, 300]}           # card moved down
    after_comps.append({"id": "export", "label": "Export CSV", "type": "button", "box_2d": [100, 800, 150, 950]})
    after = screen("Dashboard v2", after_comps, "4" * 64)
    diff, chat = dx.diff_analyses(before, after)
    kinds = {(c["kind"], c["label"]) for c in diff["changes"]}
    assert ("removed", "Refunds") in kinds and ("added", "Export CSV") in kinds
    assert ("text_changed", "Overview") in kinds and ("moved", "Revenue") in kinds
    assert diff["counts"]["unchanged"] >= 2
    assert chat.analysisId == diff["diffId"] and len(chat.components) == len(diff["changes"])


def test_diff_style_changes_are_validated_and_inferred():
    before, after = screen("A", DASH, "2" * 64), screen("B", DASH, "5" * 64)
    client = ModelClient({"styleChanges": [{"componentId": "card-1", "kind": "color", "description": "Card is now blue"},
                                           {"componentId": "made-up", "kind": "text", "description": "Something"},
                                           {"description": ""}], "summary": "Cards recoloured."})
    diff, _ = dx.diff_analyses(before, after, client, ((b"x", "image/png"), (b"y", "image/png")))
    assert [s["componentId"] for s in diff["styleChanges"]] == ["card-1", None]
    assert all(s["status"] == "inferred" for s in diff["styleChanges"])


def _png(w=400, h=300):
    from PIL import Image, ImageDraw
    img = Image.new("RGB", (w, h), (250, 250, 252))
    d = ImageDraw.Draw(img)
    d.rectangle([60, 180, 340, 204], fill=(79, 70, 229))   # the "Sign in" button (box 600-680 -> y 180-204)
    d.rectangle([60, 75, 120, 84], fill=(20, 20, 30))      # "Email" label ink
    b = io.BytesIO()
    img.save(b, "PNG")
    return b.getvalue()


def test_tokens_and_reconstruction():
    a = screen("Login", LOGIN)
    out = dx.reconstruct(a, _png())
    t = out["tokens"]
    assert t["colors"]["primary"] == "#4f46e5"
    assert t["colors"]["background"] == "#fafafc"
    assert ":root" in t["css"] and "--color-primary" in t["css"]
    html = out["prototype"]["html"]
    assert "<form" in html and "<button" in html and "<input" in html and "DRAFT" in html
    assert "export default function Login()" in out["prototype"]["react"]
    assert "## Structure" in out["docs"] and "Sign in" in out["docs"]


def test_repeated_cards_become_one_component():
    groups = dx.find_repeated(screen("Dashboard", DASH))
    assert groups and groups[0]["name"] == "Card" and groups[0]["count"] == 3


# --- routes --------------------------------------------------------------------
fastapi = pytest.importorskip("fastapi")
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import routes_digital, routes_explorer  # noqa: E402
from app.errors import register_error_handlers  # noqa: E402
from app.store import store  # noqa: E402


@pytest.fixture
def api(monkeypatch):
    store.clear()
    monkeypatch.setattr(store, "_dir", None)
    monkeypatch.setattr(routes_digital, "get_vision_client", lambda: ModelClient({"transitions": []}))
    app = FastAPI()
    app.include_router(routes_digital.router)
    app.include_router(routes_explorer.router)
    register_error_handlers(app)
    for a in (screen("Login", LOGIN, "1" * 64), screen("Dashboard", DASH, "2" * 64)):
        store.put(a, persist=False)
    return TestClient(app)


def test_routes_tree_whatif_workflow(api):
    login, dash = "digital-" + "1" * 16, "digital-" + "2" * 16
    assert api.get(f"/api/digital/{login}/tree").json()["tree"]
    r = api.post("/api/digital/whatif", json={"analysisId": login, "componentId": "form"})
    assert r.status_code == 200 and r.json()["verdict"] == "broken"
    assert api.post("/api/digital/whatif", json={"analysisId": login, "componentId": "x"}).json()["error"]["code"] == "component_not_found"
    wf = api.post("/api/digital/workflow", json={"analysisIds": [login, dash]}).json()
    assert len(wf["screens"]) == 2 and wf["relationships"]
    assert api.get(f"/api/analysis/{wf['analysisId']}").status_code == 200   # stored -> chat-able
    bad = api.post("/api/digital/workflow", json={"analysisIds": [login, login]})
    assert bad.json()["error"]["code"] == "need_two_screens"


def test_routes_diff_and_reconstruct_by_id(api):
    login, dash = "digital-" + "1" * 16, "digital-" + "2" * 16
    d = api.post("/api/digital/diff", data={"beforeId": login, "afterId": dash}).json()
    assert d["diff"]["changes"] and d["before"]["analysisId"] == login
    assert api.post("/api/digital/diff", data={"beforeId": login, "afterId": login}).json()["error"]["code"] == "same_image"
    r = api.post("/api/digital/reconstruct", data={"analysisId": login}).json()
    assert r["prototype"]["html"].startswith("<!doctype html>") and r["tokens"] is None
    assert api.post("/api/digital/reconstruct", data={}).json()["error"]["code"] == "missing_input"
