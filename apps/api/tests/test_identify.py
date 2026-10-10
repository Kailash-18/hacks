from app.schemas import Product
from app.services.assembly import product_context
from app.services.identify import identify_product, parse_identification


def test_parse_identification_cleans_values():
    d = parse_identification('```json\n{"brand":"Logitech","model":"M185","confidence":1.4,'
                             '"dimensions_mm":[56,38,99],"candidates":[{"brand":"Logitech","model":"M170","confidence":0.2},'
                             '{"model":"null"}],"evidence":"logo + shape"}\n```')
    assert d["model"] == "M185" and d["confidence"] == 1.0
    assert d["dimensions_mm"] == [56.0, 38.0, 99.0]
    assert [c["model"] for c in d["candidates"]] == ["M170"]


def test_parse_identification_rejects_bad_dims_and_nulls():
    d = parse_identification('Here: {"brand":"unknown","model":null,"dimensions_mm":[0,9999999,3]}')
    assert d["brand"] is None and d["model"] is None and d["dimensions_mm"] is None
    assert parse_identification("no json") is None


def test_identify_without_web_search_provider_returns_none():
    class NoSearch:  # e.g. LM Studio only
        pass
    assert identify_product([b"x"], NoSearch()) is None


def test_identify_uses_hint_and_sources(tmp_path):
    seen = {}

    class Fake:
        def generate_grounded(self, images, prompt):
            seen["prompt"] = prompt
            return '{"brand":"Apple","model":"Magic Mouse 2","confidence":0.9}', [{"title": "Apple", "url": "https://apple.com"}]
    out = identify_product([b"img"], Fake(), tmp_path, hint="Magic Mouse")
    assert "Magic Mouse" in seen["prompt"] and out["user_hint"] == "Magic Mouse"
    assert out["sources"][0]["url"] == "https://apple.com"
    assert identify_product([b"img"], Fake(), tmp_path, hint="Magic Mouse") == out  # cached


def test_product_context_adds_name_and_real_size():
    p = Product(brand="Logitech", model="Logitech M185", dimensionsMm=[56, 38, 99])
    t = product_context(p)
    assert "Logitech M185" in t and "Logitech Logitech" not in t and "56 x 38 x 99 mm" in t
    assert product_context(None) == "" and product_context(Product()) == ""
