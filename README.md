# Visual Reverse Engineering

**From visual evidence to explorable systems.** Banana Hacks 2026 (Image AI) project.

Photograph any object. The **Physical Lab** finds its parts, cuts each one out, estimates depth, and builds an interactive exploded diagram you can rotate, pull apart, inspect part by part, and question with "what if I remove this?".

Paste a screenshot of any website or app. The **Digital Lab** rebuilds it as working HTML or React (compare it with the original using a wipe slider, then ask for changes), writes a step-by-step plan for building it for real, and shows the component structure behind it. Several screenshots of one app become one clickable app; the rebuild can be refined against its own render, edited by clicking it, checked on phone/tablet/laptop and opened as a live StackBlitz project. A multi-screen explorer maps user workflows between screens and compares versions.

Both labs produce the same `SystemAnalysis` shape: components, relationships, evidence and an observed / inferred status for every item.

> Built during the Banana Hacks 2026 hacking window. Status: work in progress.

## How it works (Physical Lab)

1. **Vision AI (Gemini, free tier):** one structured call per photo (up to 4 views) returns the visible parts with outlines and front-to-back order, the parts this product has inside, and how they connect.
2. **Exact product identification:** in parallel, Gemini with Google Search reads logos and label text and finds the exact model and its real dimensions.
3. **Parts check against real sources:** iFixit teardown steps and a search-grounded check rename parts to what they really are, drop inside guesses the product does not have and add real missing ones. A part is marked **✓ verified** only when a web source confirms it.
4. **Validation + OpenCV:** ids, boxes, outlines and edges are checked; masks are cleaned (GrabCut fallback), each part becomes an RGBA cut-out and the body behind it is inpainted.
5. **3D model:** every part becomes a simple solid with real proportions and materials; the viewer fits inside parts into the shell, explodes the levels without overlap and keeps everything above the base. Turn it Horizontal or Vertical, view from Front / Top / Side.
6. **Explore:** click a part (it turns into a hologram) to see what it does and what breaks without it; **what if I remove it?** traces the failure through the dependency graph (graph reasoning, not physics); **could be replaced with** shows three alternatives with one pro and one con each and swaps them onto the model; the Ask tab answers questions from this analysis only.

Everything shown is labelled **seen in photo** or **inferred**. Samples: three saved real analyses (iPhone 17, Game Boy, mouse) and two curated reference models (MacBook Air M3, gaming PC), labelled as such. Details: `docs/PHYSICAL_LAB.md`.

## How it works (Digital Lab)

1. **Vision AI:** one structured call returns visible UI components with boxes (Gemini `box_2d`, converted to 0–1), types, evidence and parent links.
2. **Validation and geometry checks:** boxes are clamped or dropped; each model-reported parent is checked against box geometry (`observed` if the boxes agree, `inferred` if not); missing parents are derived from geometry (`estimated`).
3. **Truthfulness guard:** a screenshot cannot show handlers, API calls or navigation, so such relationships are downgraded to `appears_related_to` with a note.
4. **Grounded chat:** questions are answered only from the extracted graph; cited ids are verified and behaviour questions get an explicit caveat.
5. **Measured, not claimed:** `scripts/eval_digital.py` scores live output against ground truth from three team-made mock screens (recall at IoU ≥ 0.5, mean IoU, type agreement). On 10 Oct with gemini-3.8-flash: recall 1.0 on all three screens, mean IoU 0.89–0.95. Three synthetic screens are a sanity check, not a benchmark.

## Digital explorer (Explore · Workflow · Compare · Rebuild)

Open `/digital`. Upload several screens to map the **workflow** (hypothesised transitions labelled with the control that triggers them), two versions to **compare** (added / removed / moved / reworded, plus optional AI style check), or one screen to **rebuild** it as a starter HTML/React draft with measured design tokens and generated docs. Click any component for its tree position, evidence and a **what-if** (same engine shape as the Physical Lab). Details: `docs/DIGITAL_LAB.md`.

**Guided tour (for the demo video):** open `http://localhost:8000/?tour`. A title card, the Physical Lab (iPhone 17: exact-model identification, 3D model seen from the right, explode with every part lifting out, parts pulled out by hand, X-ray wiring, part details, battery failure cascade, system graph), a bridge, the Digital Lab (teardown, compare, X-ray, Inspect, a change request, React Native, build plan, backend, accessibility) and a closing card play by themselves with captions in a bar over the page header, about 2.5 minutes, from saved results only (no live AI call). `/digital?demo` plays only the Digital Lab part. Keep the Chrome window in front while recording.

## Run locally

```bash
cd apps/api
python -m venv .venv && . .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements-dev.txt
cp .env.example .env                               # add your free key from aistudio.google.com/apikey
uvicorn app.main:app --reload --port 8000
```

Open http://localhost:8000 and upload a photo. Deploying (Docker, Render or Hugging Face Spaces): `docs/DEPLOY.md`. Tests: `cd apps/api && pytest -q`. Live Digital Lab check (uses your key): `python scripts/eval_digital.py --chat`.

Both labs share one vision client: Gemini first, switching Flash models when a free daily quota runs out, then a local LM Studio model (`VISION_PROVIDER=auto`). Results are cached by image hash, so the same image never costs a second call. Frontend types: `contracts/system-analysis.ts`; full contract: `docs/API_CONTRACT.md`.

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Provider readiness (no secrets) |
| POST | `/api/physical/analyze` | multipart `image` → `SystemAnalysis` (+ `scene` layers) |
| POST | `/api/physical/identify` | photos (+ optional typed model) → exact product, dimensions, alternatives |
| POST | `/api/physical/whatif` | `{analysisId, removedComponentId}` → verdict, % working, affected parts + paths |
| GET | `/api/physical/teardown?q=&topic=` | iFixit teardown guides for the product (credited, CC BY-NC-SA) |
| GET | `/api/physical/samples` | Saved real analyses and curated reference models (sample mode) |
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
- [iFixit](https://www.ifixit.com) public API: teardown steps and photos (CC BY-NC-SA, credited in the app)
- iPhone 17 sample photo: ["Black iPhone 17.jpg"](https://commons.wikimedia.org/wiki/File:Black_iPhone_17.jpg) by Ahmad Ali Karim, CC0, Wikimedia Commons
- AI tools used in development: Claude (coding assistant), disclosed per event rules.
