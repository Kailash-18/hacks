# Frontend handoff — Physical + Digital Lab API (for Kailash)

_Updated 10 Oct 2026. Physical Lab section first (new); Digital Lab section below is unchanged._

Types: `contracts/system-analysis.ts`. Every route (physical and digital) returns errors as `{"error": {"code", "message"}}`. Full contract and error codes: `docs/API_CONTRACT.md`.


## Physical Lab (photo → exploded 3D model) — updated 10 Oct

**Easiest path: embed the existing viewer.** `apps/viewer/` (index.html, viewer.js, assembly3d.js, textures.js, style.css) is the finished Physical Lab UI: scan screen, cinematic 3D reveal, exploded 3D model, X-ray wiring, What-if cascade, system graph, product identification. The API serves it at `/` (and `/viewer/*`). Put it in an `<iframe src={API + "/"}>` or link to it rather than rebuilding it. three.js 0.160 loads from jsdelivr, so no npm install is needed. Pass `?api=<base url>` if the viewer is hosted on a different origin than the API.

If you build your own UI, everything below is what the viewer uses.

### Calls

```ts
// 1) Analyse 1–4 photos of ONE object (multipart field "images", repeated; JPEG/PNG/WebP, ≤ 8 MB each)
const fd = new FormData();
files.forEach((f, i) => fd.append("images", f, `photo${i + 1}.jpg`));
if (modelHint) fd.append("model_hint", modelHint);   // optional: exact model the user typed/picked
const res = await fetch(`${API}/api/physical/analyze`, { method: "POST", body: fd });
const body = await res.json();
if (!res.ok) throw new Error((body as ApiErrorBody).error.message);
const analysis = body as SystemAnalysis;               // analysis.scene has views, product, assembly

// 2) What-if: remove a part (send the graph so it works even after a server restart)
const wi: WhatIfResponse = await fetch(`${API}/api/physical/whatif`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ analysisId: analysis.analysisId, removedComponentId: id,
                         components: analysis.components, relationships: analysis.relationships }),
}).then(r => r.json());

// 3) Instant demo path: saved real results
const { samples } = await fetch(`${API}/api/physical/samples`).then(r => r.json());   // [{id, title}]
const sample: SystemAnalysis = await fetch(`${API}/api/physical/samples/${samples[0].id}`).then(r => r.json());

// 4) Optional extras
await fetch(`${API}/api/physical/teardown?q=${encodeURIComponent("Lenovo 130 Wireless Mouse")}`); // iFixit guides + photos
// photo URLs from that list must go through /api/physical/teardown/image?u=<url> (allow-listed proxy; CC BY-NC-SA, show credit)
```

Types: `contracts/system-analysis.ts` now includes `Product` (confidence, candidates, visibleText, dimensionsMm, sources, webChecked), `AssemblyDetail`, `Component.function / ifRemoved / importance`, and `WhatIfResponse` / `WhatIfAffected`. All additions are optional, so old results still type-check.

### Timing
- New photos: **~60–120 s** on the free Gemini tier (parts + exact-model lookup + 3D design run per request). Show a progress screen; never block the page.
- The same photos again: much faster (each photo's AI answer is cached on the server). Samples: instant.
- Free quota is ~20 AI requests per model per day, and one analysis uses about 3–5. On `provider_rate_limited`, show the message and offer a sample.

### What to render
- **3D model:** `scene.assembly.parts` (one simple solid per part: `shape`, `size`, `position`, `rotation`, `color`, `material`, `explodeDir`, `explodeDist`; mm, y up, origin = object centre) plus `scene.assembly.details` (screws, vents, ports that move with `parentId`). `apps/viewer/assembly3d.js` is the reference renderer: curved shells, sticker labels, PCB textures, explode, drag, X-ray, cascade.
- **Photo views:** `scene.views[i]` = one photo: `plate` (body cut-out) + `layers[]` (per-part RGBA cut-outs with `bbox`, `depthRank`).
- **Hidden parts:** ids in `scene.ghostComponentIds` are inferred (not seen). Style them dashed/amber with a "?" prefix.
- **Product card:** `scene.product`. Show `brand + model`, `confidence` as "NN% sure", `identifiedFrom`, `visibleText`, and `candidates` as "Not it? Maybe:" buttons. A click re-posts the same photos with `model_hint`. If `webChecked` is false, label it "AI match · not web-verified".
- **System graph:** `relationships` with `from → to` meaning "to depends on from". Colour by type: power (`powers`, `feeds`) amber `#ffb020`; control (`controls`) cyan `#36d6ff`; motion (`drives`, `transmits`) magenta `#ff5fd2`; structure (`supports`, `mounts`) steel `#8fa3bf`. Node size from `importance`.
- **Part details:** `function` ("Does: …") and `ifRemoved` ("Without it: …") when non-empty.
- **What-if:** use `verdict` (dead / degraded / works) as the headline and `health` (0–100) for a meter. List `affected` in `hops` order, as `label` + `impact` with `why` underneath, red for `severity: "fails"` and amber for `"loose"`. The viewer reveals each affected part about 0.7 s apart by `hops` for a cascade effect. Always show `method` (it is a graph what-if, not physics).
- **Notes and limits:** show `scene.notes` and `limitations` in a collapsible section.

### Physical errors worth handling
| code | UI |
|---|---|
| `different_object` (409) | "Photo N shows a different object". When the user *added* a photo, analyse the new photo on its own (the viewer does this). |
| `provider_rate_limited` | show `message` + offer a sample |
| `analysis_failed` (422) | show `message` (e.g. no separable parts found) + photo tips |
| upload errors (`unsupported_media_type`, `file_too_large`, …) | inline at the upload box |

### Deployment notes
- One FastAPI app serves both labs and the viewer: `cd apps/api && uvicorn app.main:app --port 8000`.
- Server env: `GEMINI_API_KEY` (required for live analysis), optional `GEMINI_MODEL`, `CORS_ORIGINS` (add the deployed frontend URL). Never put the key in the frontend.
- `apps/api/.cache/` is a disk cache (it can be empty or wiped; results are recomputed). `apps/api/samples/*.json` are the saved demo results and must be deployed.

---

# Digital Lab

## Base URL and CORS
- Local: `http://localhost:8000` (`cd apps/api && uvicorn app.main:app --reload --port 8000`; serves both labs).
- Allowed origins come from `CORS_ORIGINS` in `apps/api/.env` (default: localhost:3000 and :5173). Add the deployed frontend URL there.
- No API key in the frontend. The Gemini key stays on the server.

## Calls

```ts
const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

// 1) Analyse a screenshot (multipart field name: "image"; JPEG/PNG/WebP, ≤ 8 MB)
const fd = new FormData();
fd.append("image", file);
const res = await fetch(`${API}/api/digital/analyze`, { method: "POST", body: fd });
const body = await res.json();
if (!res.ok) throw new Error((body as ApiErrorBody).error.message); // show message; branch on .error.code
const analysis = body as SystemAnalysis;

// 2) Ask a grounded question
const chat: ChatResponse = await fetch(`${API}/api/analysis/${analysis.analysisId}/chat`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ question, selectedComponentIds: [selectedId] }),
}).then(r => r.json());

// 3) Instant demo path: saved real results
const samples: DigitalSampleSummary[] = await fetch(`${API}/api/digital/samples`).then(r => r.json());
const sample: SystemAnalysis = await fetch(`${API}/api/digital/samples/${samples[0].id}`).then(r => r.json());
const imgSrc = `${API}${sample.sample!.imageUrl}`;
```

## Timing (plan the UI for it)
- A new screenshot takes **~15–55 s** with the current model (measured on 10 Oct). Show a progress state with a cancel/back option; never block the whole page.
- The same image again (or a sample, or a sample's image re-uploaded) returns **instantly** from the cache.
- Chat is a text-only call; expect a few seconds.
- For the demo video: open a sample first (instant), then do one live upload.

## Rendering rules
- **Boxes:** `bbox` is 0–1. Draw over the image at its rendered size: `left = x * renderedWidth`, etc. Skip components whose `bbox` is `null` (list them in the tree only).
- **Tree:** build from `contains` edges (`from` = parent, `to` = child). Components with no incoming `contains` edge are roots.
- **Status styling:** `observed` solid, `inferred` dashed, `estimated` dotted, `unknown` grey. For `contains` edges: `observed` = model said so and boxes agree; `inferred` = model said so but boxes disagree; `estimated` = derived from box geometry only.
- **Graph:** non-`contains` edges are visual relations only (`label_for`, `visually_aligned_with`, `appears_related_to`, `adjacent_to`, `covers`). All are `inferred`. Never label them as navigation or API calls.
- **Limitations:** show `analysis.limitations` near the result (collapsible). They include required caveats.
- **Badges:** `analysis.sample` present → "Saved result"; `provider.name === "fixture"` → "Sample data (not live AI)".
- **Chat:** highlight `referencedComponentIds` on the image/tree; show `limitations` under the answer.

## Errors worth handling specially
| code | UI |
|---|---|
| `unsupported_media_type`, `file_too_large`, `image_too_small`, `corrupt_image`, `empty_file` | inline message at the upload box |
| `provider_rate_limited` | show `message` (it says whether to wait a minute or that today's quota is used up) + offer a sample |
| `provider_timeout`, `provider_unavailable`, `provider_error`, `provider_bad_output`, `analysis_failed` | show `message` + "try again" + offer a sample |
| `analysis_not_found` | analysis expired; re-upload |
