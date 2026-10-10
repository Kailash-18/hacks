# Submission checklist — Banana Hacks 2026

**Plan to submit by 12 Oct, 08:00 IST.** Feature freeze 07:30 IST. Earliest listed deadline: 12 Oct 09:30 IST (11:59 PM EDT, 11 Oct); other official pages say AoE, so use the earlier one.

Status as of 10 Oct, 10:40 IST. Owner in brackets. Tick in the PR that completes the item.

## Eligibility (blocks submission)
- [ ] [Team] Email team@bananahacks.tech: confirm all three are on the registered team, and disclose that the concept/README existed before the opening ceremony while all code was written in the window. Keep the reply.
- [ ] [Team] Confirm every member meets the age/student rules.

## Required by the rules
- [ ] [Team] Public GitHub repo with in-window commits. Canonical repo: `samvit-srivastava/hacks` (Krishna works on the fork `Krishnasingh94/hacks` and merges via PR). Make sure the repo is public and submit this one.
- [ ] [Kailash] Working live URL (judges may try it). Server needs `GEMINI_API_KEY` set as a host secret, never in the repo.
- [ ] [Team] Public YouTube video, ≤ 3:00 — script in `docs/DEMO_SCRIPT.md`.
- [ ] [Krishna] Devpost write-up ≤ 500 words — `docs/DEVPOST_WRITEUP.md` (482 words now).
- [ ] [Team] Project name, all team members added on Devpost.
- [x] [Krishna] Credits for pre-trained models, libraries and APIs — README "Credits" and write-up "Built with".
- [x] [Krishna] Generative AI tools disclosed — README and write-up (Claude for coding; Gemini as the product's model).
- [ ] [Team] No cross-submission to another hackathon.

## Product must-haves (from the brief)
- [x] [Samvit] Physical: real image-AI inference, explode control, selectable parts, what-if graph.
- [x] [Krishna] Digital: real vision inference, normalized boxes, component tree data, relationship graph with observed/inferred/estimated, grounded chat.
- [x] [Krishna/Samvit] Evidence and uncertainty in every result; samples labelled as saved results.
- [ ] [Kailash] **Digital Lab UI** (boxes on screenshot, tree, graph, chat). Handoff: `docs/FRONTEND_HANDOFF.md`, types: `contracts/system-analysis.ts`.
- [ ] [Kailash] Deployment + CORS for the deployed frontend origin.
- [ ] [Team] Fresh-browser test of the live URL end to end (both labs), or the video proves it.

## Security
- [ ] [Krishna] Rotate the Gemini key that appeared in a screenshot on 10 Oct; new key only in `apps/api/.env` / host secrets.
- [x] `.env` is gitignored; `.env.example` has placeholders only.

## Final checks (07:30–08:00 IST, 12 Oct)
- [ ] `cd apps/api && pytest -q` passes on a clean clone.
- [ ] README run steps work from a clean clone.
- [ ] Write-up word count re-checked after the last edit.
- [ ] Devpost submitted; screenshot of the confirmation saved.
