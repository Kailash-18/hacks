# Physical Lab: how it works, contract, limits

Photograph any object (1–4 photos). The Physical Lab finds its parts, identifies the exact product, checks the parts
list against real sources, and builds an exploded 3D model you can rotate, pull apart, question and modify.
No fixed 3D asset, no GPU, no paid service.

Owners: Samvit (pipeline, 3D viewer), Krishna (backend, contract, parts check, what-if, viewer panel and 3D fixes).

## Pipeline

| Step | Where | What |
|---|---|---|
| 1 | browser | Downscale each photo to ≤1600 px JPEG, upload up to 4 views of the same object |
| 2 | API | Validate type/size (≤8 MB); cache by SHA-256 + model, so the same photos never cost a second model call |
| 3 | Gemini | Per photo, one JSON call: object outline, ≤10 visible parts (box, outline, depth order, evidence), ≤10 hidden parts *this* product has, relationships |
| 3b | Gemini + Google Search | In parallel: exact product identification (brand, model, real dimensions, alternatives) from logos, label text and web matches |
| 4 | API | Merge the photos (same part seen twice = one part); refuse to merge photos of different objects |
| 5 | API | Validate everything: ids, boxes, outlines, edges; GrabCut fallback for missing masks; front-most part owns overlapping pixels; RGBA cut-outs; object body inpainted (OpenCV) |
| 6 | API | **Parts check** (`services/bom.py`): iFixit teardown steps + a search-grounded call compare the list with the identified product. Real names, inside guesses the product lacks are removed, missing real parts are added. Parts seen in a photo are never removed. |
| 7 | Gemini | Simplified 3D assembly: one solid per part (shape, size in mm, position, material, colour, explode direction) plus surface details (screws, ports, vents) |
| 8 | API | Graph completion: missing power/control links added by part type and marked inferred; what-if by deterministic traversal |
| 9 | browser | three.js viewer: exploded 3D model, part panel, connections, grounded chat |

Every step is best-effort: if identification or the parts check fails (free quota, no teardown found), the result
says so in its notes and keeps the photo-based list.

## What the viewer does

- **Exploded 3D model** on a lit base. Parts that were not seen are fitted inside the shell, levels come apart without
  overlapping, and the base follows the parts so nothing passes through it.
- **Natural / Horizontal / Vertical**: turns the whole object. Horizontal = lies flat, parts come apart up and down;
  Vertical = stands up (controls on top), parts come apart left and right.
- **Front / Top / Side / 3D** view buttons and a small compass.
- **Select a part**: it turns into a hologram (see-through, scanlines, wireframe); the panel shows what it does,
  what breaks without it, evidence, and a picture (photo cut-out, or a 3D render for parts with no photo).
- **What if I remove it?** System impact (% still working, dead / degraded / works) and the chain of affected parts.
- **Could be replaced with**: three alternatives per part with one advantage and one drawback each; click one to
  see it on the model (new material, finish and proportions). Rules of thumb, not a part-specific database.
- **Panel tabs**: Overview (power path, key parts, identification), Parts (seen / inside, search), Connections
  (plain-language: "Gets power from…", "Controls…"), Ask (chat grounded in this analysis).
- **X-ray**, drag a part out by hand, Shift+drag to turn it, double-click to focus, Esc to deselect.

## Status labels (honesty rules)

- `observed`: seen in a photo. `inferred`: not seen; typical for this product, or added by the graph.
- **✓ verified** only when a real web source (iFixit, spec sheet, FCC photos) confirmed the part for the identified
  product, and only for parts not seen in a photo. "Visual inspection" or model memory never counts. If web search
  is unavailable, nothing is marked verified and the notes say so.
- `confidence` is null unless a source gives one.
- Curated samples (`provider.name == "curated"`) say **outside / inside** instead of seen / inferred, and the page
  labels them "curated reference model".

## Samples

| Id | What | Source |
|---|---|---|
| `iphone-17` | Apple iPhone 17 | Real analysis of a CC0 photo (Wikimedia Commons) |
| `game-boy` | Nintendo Game Boy | Real analysis |
| `lenovo-mouse` | Lenovo wireless mouse | Real analysis |
| `macbook-air` | MacBook Air 13″ (M3), 22 parts | Curated reference model, `scripts/make_curated_samples.py` |
| `gaming-pc` | Gaming PC (Ryzen 7 7800X3D + RTX 4070 Super), 18 parts | Curated reference model, same script |

- Replace a curated sample with a real scan: upload photos, then `python scripts/save_physical_sample.py macbook-air`.
- Re-check a saved sample against real sources: `python scripts/verify_samples.py game-boy` (needs search quota).

## Contract extension (additive)

`SystemAnalysis.scene` (physical only): `layers`, `plate`, `views[]` (one per photo), `ghostComponentIds`
(not-seen parts), `notes`, `product` (brand, model, confidence, dimensionsMm, candidates, sources, webChecked) and
`assembly` (`overallSize` in mm, `parts[]` with shape/size/position/rotation/material/explodeDir, `details[]`).
Components may carry `function`, `ifRemoved` and `importance`. Full field list: `docs/API_CONTRACT.md` and
`contracts/system-analysis.ts`.

## Edge semantics

`from → to` means **`to` depends on `from`**.
Propagating: `powers, drives, controls, supports, transmits, feeds, mounts, depends_on`.
Structural only: `connected_to, contains, attached_to, adjacent_to, covers`. Unknown types become `connected_to`.

## What-if rules (`services/component_graph.py`)

Breadth-first over propagating edges, deterministic. Health = share of part importance still working. Removing the
power source or the main board of an electronic device, or its only sensor (a mouse's optical sensor), is
**dead**; the only screen is **degraded** (≤30 %); a logo or label changes nothing. It is graph reasoning, not physics.

## Known limitations

- Inside parts are only as good as the identification: an unknown model gets generic inside parts.
- The 3D model is made of simple solids sized from the photo and the product's real dimensions; it is not CAD.
- Gemini's free tier runs out (daily quota). Cached results and samples keep the demo working; the identification
  and parts check need search quota and are skipped without it.
- Replacement options are general engineering trade-offs, not specific to the exact model.

## Tests

`cd apps/api && pytest -q`. Physical coverage: malformed model output, boxes/masks, GrabCut fallback, overlaps,
edge validation, deterministic what-if (`test_physical.py`), graph completion and dead/degraded verdicts
(`test_graph_completion.py`), identification parsing (`test_identify.py`), and the parts check: renames, never
dropping seen parts, no "verified" without web sources (`test_bom.py`).
