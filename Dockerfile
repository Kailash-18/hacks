# Visual Reverse Engineering API + Physical Lab viewer, one container.
# Build from the repo root:  docker build -t vre .
# Run:                       docker run -p 7860:7860 -e GEMINI_API_KEY=... vre   ->  http://localhost:7860
# Secrets come from the host's environment/secret store; no .env file is copied into the image.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PORT=7860 \
    VISION_PROVIDER=gemini

# glib is needed by OpenCV even in its headless build
RUN apt-get update \
 && apt-get install -y --no-install-recommends libglib2.0-0 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY apps/api/requirements.txt apps/api/requirements.txt
RUN pip install -r apps/api/requirements.txt

COPY apps/api apps/api
COPY apps/viewer apps/viewer
COPY contracts contracts

# run as a non-root user (uid 1000 also matches Hugging Face Spaces)
RUN useradd -m -u 1000 app && chown -R app:app /app
USER app
WORKDIR /app/apps/api

EXPOSE 7860
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:%s/api/health' % os.environ.get('PORT','7860'), timeout=4)"

# One worker on purpose: the analysis store and what-if state live in process memory.
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT} --proxy-headers --forwarded-allow-ips='*'"]
