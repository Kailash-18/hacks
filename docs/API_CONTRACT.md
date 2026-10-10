# API Contract — Visual Reverse Engineering

Owner: Krishna. Canonical implementation: `apps/api/app/contract.py` (Pydantic).
Machine-readable: `contracts/system-analysis.schema.json` (regenerate with `cd apps/api && python scripts/export_schema.py`).
Changes after integration are **additive only**.

## Changes from the original brief (10 Oct)

| Change | Why |
|---|---|
| New optional `scene` field (physical only, digital omits it) | Physical Lab is now photo → layered 2.5D exploded diagram. Spec: `docs/PHYSICAL_LAB.md` (Samvit). |
| `assetId` and `modelNodeId` are `null` for physical results | No fixed GLB asset any more. |
| Edge direction rule fixed (below) | Old digital example `hero-cta → hero-section (contains)` was backwards. |
| `confidence` is always `null` from both labs | Model scores are not calibrated. |
| `GET /api/assets` dropped | Replaced by `GET /api/physical/samples`. |
| Added `GET /api/analysis/{analysisId}` | Lets the frontend reload a result by ID. |

## Edge rule (both labs)

`from → to` means **"`to` depends on `from`"**.

- Propagating (removal can affect `to` in what-if): `powers, drives, controls, supports, transmits, feeds, mounts, depends_on`
- Structural (never propagate): `connected_to, contains, attached_to, adjacent_to, covers`
- Digital visual types (structural): `contains, label_for, visually_aligned_with, appears_related_to, adjacent_to, covers`
- Any other type is kept as-is and treated as **structural** by `is_propagating()`. Types are not rewritten.
- `contains`: container → child (e.g. `hero-section → hero-cta`). `label_for`: label → labelled control.
- Digital never emits `navigates_to`, `calls_api`, etc.: a screenshot cannot prove them. If the model suggests one it becomes `appears_related_to` (status `inferred`) with a note in evidence.

## `SystemAnalysis`

```json
{
  "analysisId": "digital-3f2a9c01b7d4e8aa",
  "domain": "digital",
  "title": "Landing page",
  "source": {"kind": "image", "filename": "screen.png"},
  "assetId": null,
  "components": [
    {
      "id": "hero-cta", "label": "Get started button", "type": "button",
      "status": "observed", "confidence": null,
      "evidence": ["Visible label: Get started"],
      "bbox": {"x": 0.1, "y": 0.33, "width": 0.18, "height": 0.06},
      "modelNodeId": null, "transform": null
    }
  ],
  "relationships": [
    {"id": "hero-section--contains--hero-cta", "from": "hero-section", "to": "hero-cta",
     "type": "contains", "status": "observed", "confidence": null,
     "evidence": ["Model-reported parent; child box lies inside parent box"]}
  ],
  "summary": "...",
  "limitations": ["A single screenshot shows layout and visible text only; ..."],
  "provider": {"name": "gemini", "model": "<GEMINI_MODEL>"}
}
```

Rules (enforced by validation):
- `domain`: `physical | digital`. `status`: `observed | inferred | estimated | unknown`.
- `bbox`: normalized 0–1, top-left origin; `x+width ≤ 1`, `y+height ≤ 1`; `null` when there is no box.
- Component IDs are unique; relationship IDs are unique; every `from`/`to` references a component.
- `scene` is only allowed when `domain = "physical"`; every `scene.layers[].componentId` and `scene.ghostComponentIds[]` must be a component.
- Unknown extra fields are preserved (so either lab can add fields without breaking the other).

### Digital status meanings
- Component `observed`: clearly visible; `inferred`: partly hidden/ambiguous.
- `contains` edge `observed`: model-reported parent confirmed by box geometry. `inferred`: model-reported but geometry disagrees or boxes missing. `estimated`: derived purely from box geometry (smallest enclosing box).
- All other digital edges are `inferred`.

### Physical `scene` (summary; full spec in `docs/PHYSICAL_LAB.md`)
```json
{"kind": "layered-2.5d", "imageWidth": 1024, "imageHeight": 768,
 "plate": "data:image/png;base64,...", "plateBbox": {"x":0,"y":0,"width":1,"height":1},
 "layers": [{"componentId": "battery", "bbox": {...}, "cutout": "data:image/png;base64,...", "depthRank": 0}],
 "ghostComponentIds": ["esc"], "notes": []}
```
Visible parts: `observed` with `bbox`; hidden parts: `inferred`, `bbox: null`, listed in `ghostComponentIds`.

## Endpoints

All errors: `{"error": {"code": "stable_code", "message": "human readable"}}`.

| Method | Path | Owner | Request | Response |
|---|---|---|---|---|
| GET | `/api/health` | shared (`main.py`) | – | safe status: labs, active provider/model, key configured (bool), digital sample count; no secrets |
| POST | `/api/physical/analyze` | Samvit | multipart `image` | `SystemAnalysis` (physical, with `scene`) |
| POST | `/api/physical/whatif` | Samvit | `{"analysisId","removedComponentId"}` | affected parts + path |
| GET | `/api/physical/samples`, `/api/physical/samples/{id}` | Samvit | – | saved real results (sample mode) |
| POST | `/api/digital/analyze` | Krishna | multipart `image` | `SystemAnalysis` (digital, no `scene`) |
| GET | `/api/digital/samples` | Krishna | – | list of saved real results (`id, title, imageUrl, analysisId, ...`) |
| GET | `/api/digital/samples/{id}` | Krishna | – | `SystemAnalysis` + `sample` block |
| GET | `/api/digital/samples/{id}/image` | Krishna | – | the sample's screenshot |
| GET | `/api/analysis/{analysisId}` | Krishna | – | `SystemAnalysis` |
| POST | `/api/analysis/{analysisId}/chat` | Krishna | `ChatRequest` | `ChatResponse` |

Uploads (both labs): field name `image`, ≤ 8 MB, JPEG/PNG/WebP (checked by file signature), ≥ 32 px per side.
Results are cached by image SHA-256 in memory and on disk (`apps/api/.cache/analyses/`, gitignored; the Physical Lab keeps its own cache files in `apps/api/.cache/`), so the same image never costs a second model call, even after a restart. Identical uploads that arrive while a call is running share that call. At most `VRE_MAX_CONCURRENT_CALLS` (default 2) model calls run at once; extra requests wait.

### Digital samples
Saved results of real model runs, in `apps/api/samples/digital/<id>/` (`analysis.json`, `image.png`, `meta.json`). Responses add an additive `sample` field: `{"id","title","savedAt","note","imageUrl"}`. Samples are loaded into the store at start-up, so chat works on them and re-uploading a sample's image is instant. Create one from a real run with `python scripts/save_digital_sample.py <image> --title "..."` (reuses `out/<stem>.analysis.json` from the eval if present; refuses fixture output). Committed samples: `landing-page`, `ops-dashboard`, `mobile-login` (gemini-3.8-flash, 10 Oct, on the team-made mock screens).

### Chat
```json
// request
{"question": "Which elements form the main call to action?", "selectedComponentIds": ["hero-cta"], "selectedRelationshipIds": []}
// response
{"answer": "...", "referencedComponentIds": ["hero-cta"], "referencedRelationshipIds": [],
 "limitations": ["The screenshot alone does not establish runtime behaviour ..."]}
```
- Model sees only the structured graph (never images or `scene` data URLs).
- Returned IDs are filtered to IDs that exist in the analysis. Unknown selected IDs → `400 unknown_selection`.
- Works for physical results too: every physical analysis and physical sample is added to the shared store (memory only), so `/api/analysis/{id}` and chat accept physical ids.

### Error codes
| HTTP | code |
|---|---|
| 400 | `empty_file`, `corrupt_image`, `image_too_small`, `image_too_large`, `unknown_selection`, `bad_request` (physical) |
| 404 | `analysis_not_found`, `sample_not_found`, `not_found` |
| 413 | `file_too_large` |
| 415 | `unsupported_media_type` |
| 422 | `invalid_request`, `analysis_failed` (physical, depends on its status) |
| 429 | `provider_rate_limited` (also: daily free quota used up on every model) |
| 502 | `provider_error` (includes rejected key), `provider_bad_output` |
| 503 | `provider_unavailable` (busy, or LM Studio fallback unreachable) |
| 504 | `provider_timeout` |

`message` is always human-readable and safe to show; branch UI logic on `code`.

## How the labs fit together (`apps/api/app/main.py`)

- One FastAPI app. Physical routes live in `main.py` (Samvit); `routes_digital.py` (Krishna) is mounted with `app.include_router`.
- One vision client for both labs: `make_shared_client()` (Samvit's quota-aware Gemini client, falling back to a local LM Studio model). `main.py` registers it with `set_shared_client`, and digital analysis and chat reach it through `SharedClientAdapter`, which turns text-only calls into `generate_text_json` and provider errors into stable codes.
- One error shape for every route, including FastAPI's own 404/405/422.
- Two Pydantic mirrors of the contract exist: `schemas.py` (physical, snake_case attributes) and `contract.py` (digital, chat, store). Physical results are validated into `contract.py` before entering the shared store. Keep them in sync when adding fields.

TypeScript types for the frontend: `contracts/system-analysis.ts`; UI guidance: `docs/FRONTEND_HANDOFF.md`.

## Environment (`apps/api/.env`, gitignored; never put keys in `.env.example`)

| Var | Meaning |
|---|---|
| `GEMINI_API_KEY` | AI Studio key (server-side only) |
| `GEMINI_MODEL` | Pin the model for the demo; if unset, newest available Flash is auto-picked |
| `GEMINI_TIMEOUT_MS` | Milliseconds per Gemini call (default 100000). Reasoning effort is set low automatically |
| `VISION_PROVIDER` | `auto` (Gemini, then LM Studio), `gemini`, or `lmstudio` |
| `LMSTUDIO_URL`, `LMSTUDIO_MODEL` | Local fallback model (LM Studio's OpenAI-compatible server) |
| `CORS_ORIGINS` | Comma-separated allowed frontend origins |
| `VRE_CACHE_DIR` | Shared analysis cache folder (default `apps/api/.cache/analyses`; `off` disables) |
| `VRE_MAX_CONCURRENT_CALLS` | Max simultaneous model calls (default 2) |
| `VRE_FIXTURE_MODE=1` | Dev only: recorded responses labelled `provider.name="fixture"`; not live inference |

## Limits
- Analysis store is in memory plus a local disk cache; not shared across multiple server processes. Raw uploaded images are never stored (only committed sample images are).
- Box coordinates are model estimates. `confidence` is not calibrated, so it is always `null`.

## Run locally

```
cd apps/api
python -m venv .venv
.venv\Scripts\activate            # Windows  (macOS/Linux: source .venv/bin/activate)
pip install -r requirements-dev.txt
copy .env.example .env            # then put your key in GEMINI_API_KEY  (macOS/Linux: cp)
uvicorn app.main:app --reload --port 8000
```
- Health: http://localhost:8000/api/health. Interactive docs: http://localhost:8000/docs
- Try it: `curl -F "image=@tests/fixtures/screens/landing.png" http://localhost:8000/api/digital/analyze`
- Frontend without a key: set `VRE_FIXTURE_MODE=1` (responses are labelled `provider.name="fixture"`).

## Live evaluation (real model calls)

`python scripts/eval_digital.py` sends the 3 team-made mock screens in `tests/fixtures/screens/` to the model and scores the boxes against ground truth captured from the HTML (`*.gt.json`): recall at IoU ≥ 0.5, mean IoU of matched boxes, and type agreement. It writes overlays (green = ground truth, orange = model) and JSON to `apps/api/out/`. It refuses fixture mode. Pass any screenshot path to get an overlay without scoring.

These are 3 synthetic screens, so treat the numbers as a sanity check, not a benchmark. Text elements (headings, labels, links) are scored against the box of the visible text (`data-gt-box="text"`), not the full-width HTML block. Type agreement treats near-synonyms as matching (e.g. `hero`/`section`; see `TYPE_GROUPS` in `box_eval.py`).

First live run (10 Oct, gemini-3.8-flash, default thinking, before the prompt and ground-truth fixes), re-scored against the corrected ground truth: recall@0.5 = 1.0 on all 3 screens; mean IoU 0.95 / 0.92 / 0.90 (dashboard / landing / mobile). Latency was 15–54 s per screen. A second run with `GEMINI_THINKING_LEVEL=low` kept recall at 1.0 on all screens (type agreement 1.0 / 0.9 / 1.0) but did not reduce latency (54 / 37 / 44 s), and the eval now prints which provider/model served each call and how long it took. `python scripts/list_models.py` lists the models the key can use, to try a faster one via `GEMINI_MODEL`. Regenerate screens with `python scripts/render_mock_screens.py` (needs Playwright).

## Tests
`cd apps/api && pytest -q`: Physical Lab tests (Samvit) plus contract validation, box normalisation, containment geometry, edge-type guards, upload validation, bad/empty model output, provider errors, chat ID filtering, API error shapes, box metrics, the eval script (with a fake model), the shared-client adapter, disk cache, samples, and the merged app (both labs, one error shape, chat on a physical sample). All use recorded/fake model replies. Live inference is covered only by `scripts/eval_digital.py`.
