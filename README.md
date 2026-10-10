# Visual Reverse Engineering

**From visual evidence to explorable systems.** Banana Hacks 2026 (Image AI) project.

Photograph any object. The **Physical Lab** finds its parts, cuts each one out, estimates depth, and builds an interactive exploded diagram you can rotate, pull apart, inspect part by part, and question with "what if I remove this?".

Paste a screenshot of any website or app. The **Digital Lab** rebuilds it as working HTML or React (compare it with the original using a wipe slider, then ask for changes), writes a step-by-step plan for building it for real, and shows the component structure behind it. A multi-screen explorer maps user workflows between screens and compares versions.

Both labs produce the same `SystemAnalysis` shape: components, relationships, evidence and an observed / inferred status for every item.

> Built during the Banana Hacks 2026 hacking window. Status: work in progress.

## How it works (Physical Lab)

1. **Vision AI (Gemini, free tier):** one structured call returns visible parts with segmentation masks, front-to-back order, likely hidden parts, and relationships.
2. **Untrusted-output validation:** ids, types, boxes, masks and references are checked; bad items are dropped, not trusted.
3. **OpenCV:** masks are cleaned (GrabCut fallback when a mask is missing), overlaps go to the front-most part, each part becomes an RGBA layer, and the object body behind the parts is **inpainted** so pulling a part out never leaves a hole.
4. **Depth in the browser:** Depth Anything V2 (small) runs client-side via transformers.js and gives each layer real relief; a silhouette "dome" and stacked edge slices make parts read as solid.
5. **Graph what-if:** deterministic traversal of dependency edges (`powers`, `drives`, `controls`, `supports`…) with the full path shown. This is graph reasoning, not physics.

Everything shown is labelled **seen in photo** or **inferred**. The 3D view is a layered 2.5D exploded diagram, not a CAD reconstruction.

## How it works (Digital Lab)

1. **Vision AI:** one structured call returns visible UI components with boxes (Gemini `box_2d`, converted to 0–1), types, evidence and parent links.
2. **Validation and geometry checks:** boxes are clamped or dropped; each model-reported parent is checked against box geometry (`observed` if the boxes agree, `inferred` if not); missing parents are derived from geometry (`estimated`).
3. **Truthfulness guard:** a screenshot cannot show handlers, API calls or navigation, so such relationships are downgraded to `appears_related_to` with a note.
4. **Grounded chat:** questions are answered only from the extracted graph; cited ids are verified and behaviour questions get an explicit caveat.
5. **Measured, not claimed:** `scripts/eval_digital.py` scores live output against ground truth from three team-made mock screens (recall at IoU ≥ 0.5, mean IoU, type agreement). On 10 Oct with gemini-3.8-flash: recall 1.0 on all three screens, mean IoU 0.89–0.95. Three synthetic screens are a sanity check, not a benchmark.

## Digital explorer (Explore · Workflow · Compare · Rebuild)

Open `/digital`. Upload several screens to map the **workflow** (hypothesised transitions labelled with the control that triggers them), two versions to **compare** (added / removed / moved / reworded, plus optional AI style check), or one screen to **rebuild** it as a starter HTML/React draft with measured design tokens and generated docs. Click any component for its tree position, evidence and a **what-if** (same engine shape as the Physical Lab). Details: `docs/DIGITAL_LAB.md`.

## Run locally

```bash
cd apps/api
python -m venv .venv && . .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements-dev.txt
cp .env.example .env                               # add your free key from aistudio.google.com/apikey
uvicorn app.main:app --reload --port 8000
```

Open http://localhost:8000 and upload a photo. Tests: `cd apps/api && pytest -q`. Live Digital Lab check (uses your key): `python scripts/eval_digital.py --chat`.

Both labs share one vision client: Gemini first, switching Flash models when a free daily quota runs out, then a local LM Studio model (`VISION_PROVIDER=auto`). Results are cached by image hash, so the same image never costs a second call. Frontend types: `contracts/system-analysis.ts`; full contract: `docs/API_CONTRACT.md`.

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Provider readiness (no secrets) |
| POST | `/api/physical/analyze` | multipart `image` → `SystemAnalysis` (+ `scene` layers) |
| POST | `/api/physical/whatif` | `{analysisId, removedComponentId}` → affected parts + paths |
| GET | `/api/physical/samples` | Saved results of earlier real analyses (sample mode) |
| POST | `/api/digital/analyze` | multipart `image` (screenshot) → `SystemAnalysis` (domain `digital`) |
| GET | `/api/digital/samples` | Saved real Digital Lab results (+ `/{id}`, `/{id}/image`) |
| POST | `/api/digital/whatif` · `/workflow` · `/diff` · `/reconstruct` | Digital explorer (see `docs/DIGITAL_LAB.md`) |
| GET | `/api/analysis/{analysisId}` | Any stored analysis (either lab) |
| POST | `/api/analysis/{analysisId}/chat` | `{question, selectedComponentIds}` → grounded answer with cited ids |

All errors use one shape: `{"error": {"code": "...", "message": "..."}}`.

## Credits

- Google Gemini API (vision + segmentation), free tier
- [Depth Anything V2 Small](https://huggingface.co/onnx-community/depth-anything-v2-small) via [transformers.js](https://github.com/huggingface/transformers.js) (Apache-2.0)
- [three.js](https://threejs.org) (MIT), OpenCV (Apache-2.0), FastAPI (MIT), Pydantic (MIT), Pillow (MIT-CMU)
- [Playwright](https://playwright.dev) (Apache-2.0) to render the team-made mock UI screens used for evaluation
- AI tools used in development: Claude (coding assistant), disclosed per event rules.
