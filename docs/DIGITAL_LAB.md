# Digital Lab — build from a screenshot, explorer, workflow, diff

## Main view: `/digital` (screenshot → code)

Paste (Ctrl+V), drop or choose one screenshot, or click an example. Three tabs:

| Tab | What you get | Model calls |
|---|---|---|
| Rebuilt code | Working single-file HTML + Tailwind, a React component, a **React Native (Expo) screen** (live preview in a phone frame via react-native-web) or a **Flutter screen** (runs in DartPad: one click copies the code and opens it), shown live over the original with a **wipe slider** (drag to compare), side by side, or as code. Copy / download / open. **Change it**: describe a change ("dark theme", "mobile friendly") and get a new version; every version is kept. | 1 per version (cached) |
| How to build it | Stack, step-by-step plan, components with props, behaviour the screenshot cannot show, data needed, effort, measured design tokens | 1 (cached) |
| Structure | Detected parts as boxes on the screenshot + the component tree; ask questions about the screen | 0 (+1 per question) |

How the code is grounded: the screenshot itself, plus the analysis' component labels and boxes
(text is copied verbatim) and pixel-measured colours / font sizes. The answer comes back as a fenced
code block (not JSON), so long pages are not broken by escaping; output is cleaned (only the Tailwind
CDN and Google Fonts may load, nothing else external) and previewed in a sandboxed iframe. If the
model is unavailable, the deterministic layout draft is shown and labelled.
Results are cached by screenshot + request; the examples' results are saved in
`apps/api/samples/digital/<id>/build/` (`python scripts/save_build_samples.py`), so they open instantly.

Code: `apps/api/app/services/codegen.py`, `apps/api/app/routes_build.py`, `apps/viewer/build.{html,js,css}`.
API: `POST /api/digital/code` (multipart `image`, `target=html|react|react-native|flutter`, optional `change`, `baseCode`, `force`),
`POST /api/digital/guide` (multipart `image`, optional `force`).

### Teardown, X-ray and demo mode (`apps/viewer/build-fx.{js,css}`)

- **Teardown:** while a screenshot is processed it is scanned, its parts light up, the screen explodes into 3D
  layers by nesting depth (from the analysis' `contains` relationships), the real generated code types out beside
  it with each part lighting up as its text is written, then it reassembles and the compare slider sweeps.
  Skip button; off for `prefers-reduced-motion`.
- **X-ray** (button next to the view switch): hover the rebuilt page and the matching part of the original and the
  element's code light up; hover the original and the rebuilt element lights up. A small script inside the
  sandboxed preview reports the hovered element; it is matched to the analysis by visible text.
- **Demo mode:** open `/digital?demo` to play the whole story with captions (paste, teardown, compare, X-ray,
  a change request, React Native, build guide, accessibility). Every step uses results saved with the Log in
  example (`python scripts/save_build_samples.py`), so it needs no live AI call. Keep the Chrome window in front
  while recording: Chrome does not paint sandboxed previews in a window hidden behind others.

## Multi-screen explorer: `/digital/explorer`


For several screens of one product: user workflow, version compare, linking to source code.

**Demo path:** *Load samples* opens **Nimbus**, a team-made project-tracker app (landing → log in →
dashboard → settings, plus a v2 redesign of the dashboard). Every screen is a saved result of a real
Gemini run (`python scripts/make_demo_samples.py`; sources in `apps/api/samples/demo-app/src`).
Workflow maps the journey, Compare pre-selects dashboard v1 → v2, Rebuild drafts any screen.
A second click on *Load samples* adds the three unrelated older samples.

Every view reads the same `SystemAnalysis` shape as the Physical Lab: components, relationships,
evidence and an `observed / inferred / estimated` status. Workflows and diffs are stored as
`SystemAnalysis` objects too, so one grounded chat answers questions about a screen, a workflow or a
set of changes.

## Views

| Tab | What it does | Model calls |
|---|---|---|
| Explore | Screenshot with component boxes, collapsible component tree, details, connections, "What if I remove it?" | 1 per new screenshot (cached by image hash) |
| Workflow | Screens as nodes, hypothesised transitions as dashed arrows labelled with the control that triggers them | 0 (label matching) + 1 optional text-only call |
| Compare | Two versions side by side: added / removed / moved / resized / reworded components, plus optional AI style changes | 0 + 1 optional two-image call |
| Rebuild | Starter HTML/CSS + React draft, measured design tokens, reusable-component suggestions, markdown docs | 0 |
| Chat (all tabs) | Grounded answers that cite component ids; citations highlight on the screenshot | 1 text-only call per question |

## How it works

- **Tree:** `contains` edges (model parent, checked against box geometry), sorted in reading order.
- **What-if (digital):** removing a container removes everything inside it (from boxes); one hop of
  visual relationships (`label_for`, `appears_related_to`, …) marks other parts as possibly affected.
  Same response shape as the Physical Lab what-if (`verdict`, `health`, `affected[]`, `method`).
- **Workflow:** a control whose text names another screen ("Sign in" → *Login screen*) becomes a
  `may_navigate_to` edge with the trigger component and its box. An optional text-only model call adds
  more hypotheses; ids are validated and every edge is `status: inferred`. Screen names come from the
  title and short page headings only (a long hero headline is not a screen name); words on every screen
  (usually the app name) are ignored. Pattern rule: the sign-in button of a login screen *may* open the
  dashboard/home screen, labelled as a common pattern, not as seen. Entry screen: the model's
  pick, else the only screen that leads somewhere and that nothing leads to, else a login/landing title.
- **Diff:** greedy one-to-one matching on label similarity, type, box overlap / centre distance and id.
  Unmatched = added or removed; matched pairs report text, type, position (>3 %) and size (>20 %) changes.
  Naming noise is ignored: types a model swaps between runs (button/menu_item/link, section/card/table)
  and descriptive words ("Recent projects" vs "Recent projects table"). A renamed control that keeps a
  word is one change ("+ New project" → "+ Create project"), not removed + added.
  **Pixel check:** before an element is reported as added or removed, its crop is searched for in the
  other screenshot (OpenCV template match ≥ 0.92). Found = the model just missed it in one run, so it is
  not reported, and the limitations list says so.
  Optional two-image model call for colour / typography / spacing changes (validated, `inferred`).
- **Design tokens:** colours from pixel quantisation (page, buttons, surfaces) and the median "ink" of
  text boxes; font sizes from text box heights; spacing from sibling gaps snapped to a 4 px grid.
- **Reconstruction:** recursive XY-cut over the boxes (stacked bands first, then columns) turns the
  hierarchy into nested flex rows/columns; types map to semantic tags (`nav`, `button`, `input`, `article`…).
  Repeated same-size siblings are flagged as one reusable component. Output is labelled DRAFT.

## API (additive)

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/digital/{analysisId}/tree` | — | `{tree, repeated}` |
| POST | `/api/digital/whatif` | `{analysisId, componentId}` | what-if result (Physical shape) |
| POST | `/api/digital/workflow` | `{analysisIds: [2-8], useModel}` | `SystemAnalysis` (screens + `may_navigate_to`) + `screens[]` |
| POST | `/api/digital/diff` | multipart `before`,`after` images **or** `beforeId`,`afterId`; `useModel` | `{diff, before, after}` |
| POST | `/api/digital/reconstruct` | multipart `image` **or** `analysisId` | `{tree, tokens, repeated, prototype{html,css,react}, docs, limitations}` |

Workflow and diff results are cached per input ids, so repeat clicks cost no model call.
Code: `apps/api/app/services/digital_explorer.py`, `apps/api/app/routes_explorer.py`,
`apps/viewer/digital.{html,js,css}`. Tests: `apps/api/tests/test_digital_explorer.py`.

## Limits (shown in the UI)

- A screenshot cannot show handlers, API calls, data or navigation: transitions and behavioural effects are hypotheses.
- Diff matching can report a heavily redesigned element as removed + added.
- Tokens are measured approximations, not values from source code. Generated code is a starting draft.

### More on the result page

- **Whole app** (side panel): the screen plus the app's other pages (a saved set brings its screens; add your own with
  *Add a screen* or by dropping images, up to 6). *Build the whole app* sends all screenshots in one call
  (`POST /api/digital/app`) and returns one HTML page: each screen is a `<section data-screen>`, only the `.active`
  one shows, and the visible navigation switches between them. Nested screens are detected and retried once.
- **Refine to 95%**: the page renders the rebuild (with its real web fonts), measures the match, and sends the model
  the screenshot, its own render, a red difference map, close-ups of the worst regions, wrong-shade colours and the
  headline font found by pixel matching (`POST /api/digital/refine`). Measured fixes run between rounds (colour shades,
  text widths); the best-scoring version is kept.
- **Edit**: click text, a button or a box in the rebuilt page (side by side view) to change its words, text or fill
  colour and size; *Save as a new version* writes the edits into the code.
- **Devices**: the rebuild at phone (390), tablet (820) and laptop (1440) widths side by side.
- **Open in StackBlitz**: the HTML as a project, or the React version as a Vite + React app that installs and runs in
  the browser (free, no account).
