"""Disk cache, samples and the save-sample script (no FastAPI, no live inference)."""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import importlib.util
import json
import shutil
from pathlib import Path

from app.contract import SystemAnalysis
from app.samples import SAMPLES_DIR, load_samples
from app.store import AnalysisStore

API = Path(__file__).resolve().parent.parent


def analysis(aid="digital-abc", provider="gemini"):
    return SystemAnalysis.model_validate({
        "analysisId": aid, "domain": "digital", "title": "t", "source": {"kind": "image", "filename": "x.png"},
        "components": [{"id": "a", "label": "A", "type": "button", "status": "observed"}],
        "relationships": [], "provider": {"name": provider, "model": "m"}})


def test_store_survives_restart_via_disk(tmp_path):
    s1 = AnalysisStore(cache_dir=tmp_path)
    s1.put(analysis(), "f" * 64)
    s2 = AnalysisStore(cache_dir=tmp_path)  # simulated restart
    assert s2.get("digital-abc").title == "t"
    assert s2.get_by_image("digital", "f" * 64).analysisId == "digital-abc"
    assert s2.get_by_image("physical", "f" * 64) is None  # domains do not collide


def test_store_ignores_corrupt_and_foreign_cache_files(tmp_path):
    (tmp_path / "digital-bad.json").write_text("{not json", encoding="utf-8")
    (tmp_path / ("ab" * 32 + ".json")).write_text('{"physical": "lab cache"}', encoding="utf-8")  # Samvit's cache file
    s = AnalysisStore(cache_dir=tmp_path)
    s.put(analysis("digital-nohash"))  # no hash -> memory only
    assert s.get("digital-nohash") is not None
    assert sorted(p.name for p in tmp_path.glob("digital-*.json")) == ["digital-bad.json"]


def test_store_evicts_oldest(tmp_path):
    s = AnalysisStore(max_entries=2, cache_dir=None)
    for i in range(3):
        s.put(analysis(f"digital-{i}"), str(i) * 64)
    assert s.get("digital-0") is None and s.get_by_image("digital", "0" * 64) is None
    assert s.get("digital-2") is not None


def test_committed_samples_are_real_and_consistent():
    samples = load_samples()
    assert {"landing-page", "ops-dashboard", "mobile-login"} <= set(samples)
    for s in samples.values():
        assert s.analysis.provider.name != "fixture"
        assert s.analysis.analysisId == "digital-" + s.image_sha256[:16]  # re-upload hits the cache
        out = s.to_api()
        assert out["sample"]["imageUrl"].endswith(f"/{s.id}/image") and "scene" not in out


def test_bad_samples_are_skipped(tmp_path):
    good = tmp_path / "good"
    shutil.copytree(SAMPLES_DIR / "mobile-login", good)
    fixture = tmp_path / "fixture-one"
    shutil.copytree(SAMPLES_DIR / "mobile-login", fixture)
    data = json.loads((fixture / "analysis.json").read_text(encoding="utf-8"))
    data["provider"]["name"] = "fixture"
    (fixture / "analysis.json").write_text(json.dumps(data), encoding="utf-8")
    (tmp_path / "no-image").mkdir()
    (tmp_path / "Bad Name").mkdir()
    assert list(load_samples(tmp_path)) == ["good"]


def _script():
    spec = importlib.util.spec_from_file_location("save_digital_sample", API / "scripts" / "save_digital_sample.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_save_sample_reuses_eval_output_and_refuses_fixture(tmp_path):
    mod = _script()
    out = tmp_path / "out"
    out.mkdir()
    img = API / "tests" / "fixtures" / "screens" / "mobile_login.png"
    (out / "mobile_login.analysis.json").write_text(json.dumps(analysis().to_api()), encoding="utf-8")
    assert mod.main([str(img), "--title", "Login"], samples_dir=tmp_path / "s", out_dir=out) == 0
    saved = tmp_path / "s" / "mobile-login"
    assert (saved / "image.png").exists() and json.loads((saved / "meta.json").read_text())["title"] == "Login"

    (out / "mobile_login.analysis.json").write_text(json.dumps(analysis(provider="fixture").to_api()), encoding="utf-8")
    assert mod.main([str(img), "--id", "fx"], samples_dir=tmp_path / "s", out_dir=out) == 2
    assert not (tmp_path / "s" / "fx").exists()
