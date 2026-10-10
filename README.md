# Visual Reverse Engineering

**From visual evidence to explorable systems.** Banana Hacks 2026 (Image AI) project.

Photograph any object. The **Physical Lab** finds its parts, cuts each one out, estimates depth, and builds an interactive exploded diagram you can rotate, pull apart, inspect part by part, and question with "what if I remove this?".

> Built during the Banana Hacks 2026 hacking window. Status: work in progress.

## How it works (Physical Lab)

1. **Vision AI (Gemini, free tier):** one structured call returns visible parts with segmentation masks, front-to-back order, likely hidden parts, and relationships.
2. **Untrusted-output validation:** ids, types, boxes, masks and references are checked; bad items are dropped, not trusted.
3. **OpenCV:** masks are cleaned (GrabCut fallback when a mask is missing), overlaps go to the front-most part, each part becomes an RGBA layer, and the object body behind the parts is **inpainted** so pulling a part out never leaves a hole.
4. **Depth in the browser:** Depth Anything V2 (small) runs client-side via transformers.js and gives each layer real relief; a silhouette "dome" and stacked edge slices make parts read as solid.
5. **Graph what-if:** deterministic traversal of dependency edges (`powers`, `drives`, `controls`, `supports`…) with the full path shown. This is graph reasoning, not physics.

Everything shown is labelled **seen in photo** or **inferred**. The 3D view is a layered 2.5D exploded diagram, not a CAD reconstruction.

## Run locally

```bash
cd apps/api
python -m venv .venv && . .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements-dev.txt
cp .env.example .env                               # add your free key from aistudio.google.com/apikey
uvicorn app.main:app --reload --port 8000
```

Open http://localhost:8000 and upload a photo. Tests: `cd apps/api && pytest -q`.

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Provider readiness (no secrets) |
| POST | `/api/physical/analyze` | multipart `image` → `SystemAnalysis` (+ `scene` layers) |
| POST | `/api/physical/whatif` | `{analysisId, removedComponentId}` → affected parts + paths |
| GET | `/api/physical/samples` | Saved results of earlier real analyses (sample mode) |

## Credits

- Google Gemini API (vision + segmentation), free tier
- [Depth Anything V2 Small](https://huggingface.co/onnx-community/depth-anything-v2-small) via [transformers.js](https://github.com/huggingface/transformers.js) (Apache-2.0)
- [three.js](https://threejs.org) (MIT), OpenCV (Apache-2.0), FastAPI (MIT)
- AI tools used in development: Claude (coding assistant), disclosed per event rules.
