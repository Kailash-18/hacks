# Deploying the backend (and the Physical Lab viewer)

One container serves everything: the API (`/api/...`), the Physical Lab viewer (`/`), and interactive API docs (`/docs`). The Digital Lab UI (Kailash) can be hosted separately and point at this URL.

Files: `Dockerfile` (repo root), `.dockerignore`, `render.yaml`.

> The image was **not built in the authoring environment** (Docker Hub is blocked there). Build it once locally before relying on a host. See "Check locally" below.

## Check locally (5 min)
```
docker build -t vre .
docker run --rm -p 7860:7860 -e GEMINI_API_KEY=YOUR_KEY -e GEMINI_MODEL=gemini-3.8-flash vre
```
Then open http://localhost:7860/api/health (expect `"status": "ok"`, `"labs": ["physical","digital"]`), http://localhost:7860/ (Physical Lab), and http://localhost:7860/docs.

## Option A: Render (Blueprint)
1. Render dashboard → **New → Blueprint** → select the GitHub repo. It reads `render.yaml`.
2. Fill the secret values it asks for: `GEMINI_API_KEY`, `GEMINI_MODEL` (pin the demo model), `CORS_ORIGINS` (the frontend's URL; leave empty if only the built-in viewer is used).
3. Wait for the health check on `/api/health` to pass.

Free web services on Render go to sleep when idle, and the first request after that takes a while to wake. Open the URL yourself shortly before judging and before recording. Check Render's current free-plan terms when you deploy, since they change.

## Option B: Hugging Face Spaces (Docker)
1. New Space → SDK **Docker** → blank.
2. Push this repo's contents to the Space's git remote. The Space's `README.md` must start with this header (add it only in the Space copy, not on GitHub):
   ```
   ---
   title: Visual Reverse Engineering
   sdk: docker
   app_port: 7860
   ---
   ```
3. Space **Settings → Variables and secrets**: add secret `GEMINI_API_KEY`, variable `GEMINI_MODEL`.

## Settings that matter on a server
| Variable | Value on the host |
|---|---|
| `GEMINI_API_KEY` | secret, never in git |
| `GEMINI_MODEL` | pin it (the auto-pick can change model mid-demo) |
| `VISION_PROVIDER` | `gemini` (set in the image; there is no LM Studio on a server) |
| `CORS_ORIGINS` | deployed frontend URL(s); unset = allow all |
| `PORT` | set by the host; defaults to 7860 |

## Known limits of this setup
- One process, one worker: analyses for what-if and chat live in memory and are lost on restart or sleep. Committed samples always work.
- The disk cache is inside the container, so it resets on each deploy or restart. The first upload of each image after that costs a model call again.
- Free-tier Gemini quota is per key and per model. If it runs out mid-demo, the app returns `provider_rate_limited`; open a sample.
