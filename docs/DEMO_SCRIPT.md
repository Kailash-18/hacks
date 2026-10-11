# Demo video script (≤ 3:00, public YouTube)

Rules: public YouTube, **3:00 or less**, product on screen in the first 15 seconds. Rehearse once with a stopwatch.
Record at 1080p; zoom the browser to 110–125% so text is readable.

## Before recording
- [ ] Pin `GEMINI_MODEL` in `apps/api/.env` and restart the server.
- [ ] Warm the cache: run every live upload you will show once beforehand, so the take shows an instant result. Say on camera that the first run of a new image takes 15–55 s (or show one real wait, sped up and labelled "2× speed").
- [ ] Digital Lab UI from Kailash is deployed and loads the samples. **The digital part of this script needs that UI.**
- [ ] Have ready: one physical object photo, one real screenshot that is not one of our mock screens (a public website is fine).
- [ ] Close the `.env` file and any tab showing keys.

## Timeline

| Time | Screen | Voice-over (suggested) |
|---|---|---|
| 0:00–0:15 | Physical Lab, object photo already exploded | "A photo of a thing, or a screenshot of an app, is evidence. Visual Reverse Engineering turns it into a system you can take apart." |
| 0:15–0:55 | Upload object photo → parts appear with "seen in photo" / "inferred" labels → drag explode slider, rotate | "Gemini finds the parts; we validate every box and outline, cut each part out with OpenCV and rebuild it as an exploded view. Hidden parts are marked as guesses." |
| 0:55–1:20 | Click battery (or power part) → what-if remove → affected parts + path highlighted | "Remove a part and the dependency graph shows what stops working, and why. This is graph reasoning, not physics." |
| 1:20–1:50 | Digital Lab: upload a real website screenshot → boxes appear, tree on the side | "Same idea for software. Any screenshot becomes a component tree with every element boxed." |
| 1:50–2:10 | Click a tree item → box highlights; open graph, click an edge → evidence + status | "Every relationship carries its evidence and whether it was observed, inferred or estimated from geometry." |
| 2:10–2:30 | Ask: "What happens when I click Start free trial?" → answer cites components and adds the caveat | "It answers only from what it saw, and says so when a screenshot can't tell. It won't invent an API call." |
| 2:30–2:45 | Eval overlay image (green vs orange boxes) + numbers | "We measured it: on our ground-truth screens it found every element, with box overlap of 0.89 to 0.95." |
| 2:45–3:00 | Back to the exploded object; product name + live URL on screen | "Visual Reverse Engineering. From visual evidence to explorable systems." |

## Fallbacks during recording
- Gemini quota or rate limit: open a **sample** (physical: `iphone-17`, `game-boy`, `lenovo-mouse`; digital: `landing-page`, `ops-dashboard`, `mobile-login`). They are saved results of real runs, and the UI marks them as such. Don't present a sample as a fresh upload.
- A slow live call: cut the wait in editing and label it, don't hide it.

## Assets for the eval moment
`apps/api/out/*.overlay.png` after running `python scripts/eval_digital.py` (green = ground truth, orange = model).
