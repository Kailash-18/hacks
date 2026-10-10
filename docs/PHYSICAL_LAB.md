# Physical Lab — pipeline, contract extension, limits

Owner: Samvit. Direction (10 Oct 2026, 07:21 IST): **any photographed object → layered 2.5D exploded diagram**. No fixed 3D asset, no GPU, no paid service.

## Pipeline

| Step | Where | What |
|---|---|---|
| 1 | browser | Downscale photo to ≤1600 px JPEG, upload |
| 2 | API | Validate MIME/size (≤8 MB), cache by SHA-256 + model (same photo never costs a second model call) |
| 3 | Gemini | One JSON call: object mask, ≤12 visible parts (box + mask + depth_rank + evidence + role), ≤6 hidden parts, relationships |
| 4 | API | Validate everything; GrabCut fallback for missing masks; morphology cleanup; front-most part owns overlapping pixels; RGBA cut-outs; object body inpainted (OpenCV TELEA) where parts were |
| 5 | browser | Depth Anything V2 small (transformers.js, WebGPU→WASM) on the recomposed object; per-part relief = depth + silhouette dome; 7 stacked slices = solid edge |
| 6 | browser | Explode slider (depth-ordered layers + radial spread), limited orbit (±43°), click/hover with alpha-accurate picking, isolate, bring forward / send back to fix order |
| 7 | API | What-if: BFS over propagating edges, deterministic, returns path + edge ids + "uncertain" flag |

If the depth model can't load, the viewer falls back to silhouette relief and says so.

## Contract extension (additive, does not change existing fields)

`SystemAnalysis.scene` (physical only):

```json
{
  "kind": "layered-2.5d",
  "imageWidth": 1024, "imageHeight": 768,
  "plate": "data:image/webp;base64,...",          // object body, holes inpainted
  "plateBbox": {"x":0.1,"y":0.1,"width":0.8,"height":0.8},
  "layers": [{"componentId":"screen","bbox":{...},"cutout":"data:image/webp;base64,...","depthRank":0}],
  "ghostComponentIds": ["battery"],                 // hidden parts, status=inferred, bbox=null
  "notes": ["Skipped a part with an invalid box (...)"]
}
```

- Visible parts: `status="observed"`, `bbox` set, evidence includes the segmentation method.
- Hidden parts: `status="inferred"`, `bbox=null`, evidence starts with "Not visible in the photo."
- Relationship `status="observed"` only if the model says the connection is visible and neither end is hidden.
- `confidence` is always `null` (model gives no calibrated score).

## Edge semantics

`from → to` means **`to` depends on `from`**.
Propagating: `powers, drives, controls, supports, transmits, feeds, mounts, depends_on`.
Structural only: `connected_to, contains, attached_to, adjacent_to, covers`. Unknown types become `connected_to`.

## Known limitations

- One photo: back sides and internals are not observed; hidden parts are typical-design guesses.
- 2.5D: convincing within ±40°, flat beyond (rotation is limited on purpose).
- Gemini masks can be loose; depth order can be wrong (user can fix order).
- Free tier rate limits: cached results + sample mode protect the demo.

## Tests

`cd apps/api && pytest -q` covers malformed model output, invalid boxes/masks, GrabCut fallback, overlap ownership, duplicate/invalid/self-loop edges, cycles, deterministic what-if paths, and the API end-to-end (scripted test-only vision client).

## Integration notes

- **Krishna:** call `analyze_physical_image(image_bytes, filename, vision_client)`; any client with `name`, `model`, `generate_json(bytes, mime, prompt) -> str` works. Routes in `apps/api/app/main.py` can be merged into your app.
- **Kailash:** `apps/viewer/` is a working reference viewer (plain three.js). Port to Next.js/R3F if wanted; the data you need is `scene.layers`, `scene.plate`, `scene.ghostComponentIds`, `components`, `relationships`.
