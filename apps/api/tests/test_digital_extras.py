import io
import json

import numpy as np
from PIL import Image

from app.contract import BBox, Component, Provider, Relationship, Source, SystemAnalysis
from app.services import digital_extras as dx2


def _analysis(comps, rels=()):
    return SystemAnalysis(analysisId="digital-test", domain="digital", title="t", source=Source(kind="image", filename="a.png"),
                          components=comps, relationships=list(rels), provider=Provider(name="t", model="t"))


def _png(draw) -> bytes:
    img = np.full((400, 800, 3), 255, np.uint8)
    draw(img)
    buf = io.BytesIO(); Image.fromarray(img).save(buf, "PNG"); return buf.getvalue()


def test_contrast_ratio_matches_wcag():
    assert round(dx2.contrast_ratio((0, 0, 0), (255, 255, 255)), 1) == 21.0
    assert round(dx2.contrast_ratio((119, 119, 119), (255, 255, 255)), 2) == 4.48


def test_audit_finds_low_contrast_small_target_and_unlabelled_input():
    def draw(img):
        img[40:80, 40:400] = 255; img[52:68, 60:380:3] = (200, 200, 200)     # faint grey text on white
        img[120:160, 40:400] = 255; img[132:148, 60:380:3] = (20, 20, 20)    # strong text
        img[200:214, 40:54] = (30, 90, 220)                                   # tiny button 14x14
    comps = [Component(id="faint", label="Faint caption", type="text", status="observed", bbox=BBox(x=40/800, y=40/400, width=360/800, height=40/400)),
             Component(id="ok", label="Strong text", type="text", status="observed", bbox=BBox(x=40/800, y=120/400, width=360/800, height=40/400)),
             Component(id="tiny", label="x", type="button", status="observed", bbox=BBox(x=40/800, y=200/400, width=14/800, height=14/400)),
             Component(id="email", label="Email field", type="input", status="observed", bbox=BBox(x=40/800, y=300/400, width=300/800, height=40/400)),
             Component(id="tiny2", label="y", type="button", status="observed", bbox=BBox(x=58/800, y=200/400, width=14/800, height=14/400)),
             Component(id="alone", label="z", type="button", status="observed", bbox=BBox(x=700/800, y=20/400, width=14/800, height=14/400)),
             Component(id="h", label="Title", type="heading", status="observed", bbox=None)]
    out = dx2.audit_accessibility(_analysis(comps), _png(draw))
    kinds = {(i["componentId"], i["kind"]) for i in out["issues"]}
    assert ("faint", "contrast") in kinds and ("ok", "contrast") not in kinds
    assert ("tiny", "target") in kinds and ("email", "label") in kinds
    assert ("alone", "target") not in kinds  # WCAG 2.2 spacing exception: nothing within 24px
    assert 0 <= out["score"] < 100 and out["method"]


def test_label_for_edge_counts_as_label():
    comps = [Component(id="lbl", label="Email", type="text", status="observed", bbox=None),
             Component(id="email", label="Email field", type="input", status="observed", bbox=BBox(x=0.1, y=0.1, width=0.4, height=0.1))]
    rels = [Relationship(**{"id": "r", "from": "lbl", "to": "email", "type": "label_for", "status": "inferred"})]
    out = dx2.audit_accessibility(_analysis(comps, rels), _png(lambda i: None))
    assert not any(i["kind"] == "label" for i in out["issues"])


def test_clean_backend_validates_untrusted_output():
    raw = {"entities": [{"name": "task item", "fields": [{"name": "title", "type": "weird", "example": "Ship v2", "visible": True}],
                         "components": ["card1", "ghost"]},
                        {"name": "Task Item"}],
           "relations": [{"from": "TaskItem", "to": "Nope", "kind": "one-to-many"}],
           "endpoints": [{"method": "get", "path": "/api/tasks", "components": ["card1"], "response": [{"id": 1}]},
                         {"method": "HACK", "path": "/x"}, {"method": "POST", "path": "no-slash"}]}
    out = dx2.clean_backend(raw, {"card1"})
    assert [e["name"] for e in out["entities"]] == ["Taskitem"]
    e = out["entities"][0]
    assert e["fields"][0]["name"] == "id" and e["fields"][1]["type"] == "string" and e["components"] == ["card1"]
    assert out["relations"] == [] and [p["path"] for p in out["endpoints"]] == ["/api/tasks"]
    assert out["endpoints"][0]["request"] == {}


def test_backend_falls_back_without_model():
    comps = [Component(id=f"c{i}", label=f"Project {i}", type="card", status="observed",
                       bbox=BBox(x=0.1 + i * 0.25, y=0.2, width=0.2, height=0.2)) for i in range(3)]
    out = dx2.generate_backend(_analysis(comps), None, None, None, force=True)
    assert out["source"] == "layout" and out["entities"] and out["endpoints"][0]["method"] == "GET"


def test_endpoints_return_json_for_a_sample(monkeypatch):
    """The audit result must survive JSON serialisation (numpy numbers once caused a 500)."""
    import json
    from pathlib import Path
    from fastapi.testclient import TestClient
    from app import routes_build
    from app.main import app
    root = Path(__file__).resolve().parents[1] / "samples/digital/nimbus-dashboard"
    a = SystemAnalysis.model_validate(json.loads((root / "analysis.json").read_text()))
    img = (root / "image.png").read_bytes()

    async def fake_resolve(form, file_key, id_key):
        return a, (img, "image/png")
    monkeypatch.setattr(routes_build, "_resolve", fake_resolve)
    monkeypatch.setattr(routes_build, "_client_or_none", lambda: None)  # never spend real AI quota in tests
    r = TestClient(app).post("/api/digital/a11y", data={"analysisId": a.analysisId})
    assert r.status_code == 200, r.text[:300]
    body = r.json()
    assert body["issues"] and isinstance(body["issues"][0].get("ratio", 1.0), float)
    r2 = TestClient(app).post("/api/digital/backend", data={"analysisId": a.analysisId, "force": "1"})
    assert r2.status_code == 200 and r2.json()["entities"] is not None
