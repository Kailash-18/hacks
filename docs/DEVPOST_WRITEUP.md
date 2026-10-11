# Visual Reverse Engineering — Devpost write-up

<!-- Paste everything between the START/END markers into Devpost. Limit 500 words; currently 482 (10 Oct). Recount after any edit. -->
<!-- START -->
**From visual evidence to explorable systems.**

## Inspiration
Learners open devices they can't name the parts of; developers inherit undocumented interfaces. Both start from a picture. We wanted image AI to turn that picture into a system you can explore, not a caption.

## What it does
**Physical Lab:** photograph any object (up to four views). The app finds its parts, cuts each one out of the photo, and builds an exploded view you can pull apart and rotate: a layered 2.5D diagram with depth relief, plus a simplified 3D model of the parts. Click a part to see its evidence; remove it in "what-if" mode to see which parts depend on it, with the full dependency path.

**Digital Lab:** upload a screenshot of any website, app or dashboard. You get every component boxed on the screenshot, a component tree, a graph of visual relationships, and a chat that answers only from what was extracted, citing the components it used.

Both labs share one data model: components, relationships, evidence, and a status on everything: observed, inferred or estimated. Hidden parts are shown as guesses, never as facts, and the Digital Lab will not claim what a button does, because a screenshot can't show that.

## How we built it
- **Vision:** Google Gemini (free tier) returns structured JSON: parts with outlines and depth order, or UI components with boxes and parent links.
- **Untrusted-output validation:** every id, box, mask and edge is checked; bad items are dropped, not trusted. UI containment is re-checked against box geometry.
- **OpenCV:** GrabCut refinement, overlap resolution, RGBA cut-outs, and inpainting so a removed part never leaves a hole.
- **In the browser:** Depth Anything V2 (transformers.js) for relief; three.js for the exploded views.
- **Graph what-if:** deterministic traversal over dependency edges. Graph reasoning, not physics.
- **FastAPI + Pydantic** behind one shared contract; results cached by image hash so the same image never costs a second call; automatic fallback across Gemini models and to a local LM Studio model when free quota runs out.

## Challenges
Free-tier quotas and 15–55 s model calls; turning loose model masks into clean cut-outs; and keeping the AI honest: deciding what may be labelled "observed".

## Accomplishments
We measured instead of claiming. On three team-made mock interfaces with ground truth captured from the HTML, live Digital Lab output found every labelled element (recall 1.0 at IoU ≥ 0.5) with mean box overlap 0.89–0.95. Three synthetic screens are a sanity check, not a benchmark. Physical Lab was tested in Chrome on six real objects.

## What we learned
Strict validation beats prompting harder, and showing uncertainty makes results more useful.

## What's next
Ordered screen sequences to infer navigation, comparing two versions of a device or UI, and exporting component inventories.

## Built with
Gemini API, OpenCV, Depth Anything V2, transformers.js, three.js, FastAPI, Pydantic, Playwright. AI tools used in development: Claude (coding assistant); Gemini is the product's vision model.
<!-- END -->

## Before pasting, confirm
- The live URL and YouTube link are filled in on Devpost (not in this text).
- "Tested on six real objects" still matches Samvit's latest testing.
- If Kailash's frontend changes how a feature is presented, update "What it does".
- If a different model ends up pinned for the demo, the numbers above still refer to the 10 Oct gemini-3.8-flash run.
