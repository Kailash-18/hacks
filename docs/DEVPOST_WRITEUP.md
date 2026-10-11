# Visual Reverse Engineering — Devpost write-up

<!-- Paste everything between the START/END markers into Devpost. Limit 500 words; 492 words on 12 Oct. Recount after any edit. -->
<!-- START -->
**From visual evidence to explorable systems.**

## Inspiration
Learners open devices they can't name the parts of; developers inherit undocumented interfaces. Both start from a picture. We wanted image AI to turn it into an explorable system, not a caption.

## What it does
**Physical Lab:** photograph any object (up to four views). The app identifies the exact product, finds its parts, checks them against real teardowns, and builds an exploded 3D model you can rotate, pull apart and turn on its side. Click a part to see what it does and what breaks without it; remove it in "what-if" mode to watch the failure spread; try a replacement part and see the pros and cons.

**Digital Lab:** upload a screenshot of any website or app. It rebuilds the page as working HTML or React (compare with a wipe slider, ask for changes), writes a build plan, and maps the components behind it; several screenshots become one clickable app. A chat answers only from what was extracted.

Both labs share one data model: components, relationships, evidence, and a status on everything (observed, inferred, estimated). Hidden parts are shown as guesses, never as facts, and the Digital Lab will not claim what a button does, because a screenshot can't show that.

## How we built it
- **Vision:** Google Gemini (free tier) returns structured JSON: parts with outlines and depth order, or UI components with boxes and parent links.
- **Untrusted-output validation:** every id, box, mask and edge is checked; bad items are dropped, not trusted. UI containment is re-checked against box geometry.
- **Grounded parts check:** Gemini with Google Search plus iFixit teardown steps correct the parts list for the identified model; only web-confirmed parts are marked verified.
- **OpenCV:** GrabCut refinement, overlap resolution, RGBA cut-outs, and inpainting so a removed part never leaves a hole.
- **In the browser:** three.js for the exploded 3D models.
- **Graph what-if:** deterministic traversal over dependency edges. Graph reasoning, not physics.
- **FastAPI + Pydantic** behind one shared contract; results cached by image hash; automatic fallback across Gemini models and to a local LM Studio model when free quota runs out.

## Challenges
Free-tier quotas and slow model calls; turning loose masks into clean cut-outs; keeping the AI honest about what is "observed".

## Accomplishments
We measured instead of claiming. On three team-made mock interfaces with ground truth captured from the HTML, live Digital Lab output found every labelled element (recall 1.0 at IoU ≥ 0.5) with mean box overlap 0.89–0.95. Three synthetic screens are a sanity check, not a benchmark. Physical Lab was tested in Chrome on six real objects.

## What we learned
Strict validation beats prompting harder; showing uncertainty makes results more useful.

## What's next
Comparing two versions of a device, and exporting parts inventories.

## Built with
Gemini API (with Google Search grounding), iFixit API, OpenCV, Depth Anything V2, transformers.js, three.js, FastAPI, Pydantic, Playwright. AI tools used in development: Claude (coding assistant); Gemini is the product's vision model.
<!-- END -->

## Before pasting, confirm
- The live URL and YouTube link are filled in on Devpost (not in this text).
- "Tested on six real objects" still matches Samvit's latest testing.
- If Kailash's frontend changes how a feature is presented, update "What it does".
- If a different model ends up pinned for the demo, the numbers above still refer to the 10 Oct gemini-3.8-flash run.
