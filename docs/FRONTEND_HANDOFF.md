# Frontend handoff — Digital Lab API (for Kailash)

Types: `contracts/system-analysis.ts`. Every route (physical and digital) returns errors as `{"error": {"code", "message"}}`. Full contract and error codes: `docs/API_CONTRACT.md`.

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
