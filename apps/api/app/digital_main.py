"""Standalone app for the Digital Lab + chat routes.

Use this until Samvit's main.py is merged; afterwards main.py mounts the same router and this
file can be deleted.

    cd apps/api
    uvicorn app.digital_main:app --reload --port 8000
"""

from __future__ import annotations

import os

try:  # load apps/api/.env when python-dotenv is installed
    from dotenv import load_dotenv

    load_dotenv(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env"))
except ImportError:  # pragma: no cover
    pass

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .errors import register_error_handlers
from .routes_digital import router as digital_router
from .services.vision_provider import provider_status

DEFAULT_ORIGINS = "http://localhost:3000,http://127.0.0.1:3000,http://localhost:5173,http://127.0.0.1:5173"


def cors_origins() -> list[str]:
    return [o.strip() for o in os.getenv("CORS_ORIGINS", DEFAULT_ORIGINS).split(",") if o.strip()]


app = FastAPI(title="Visual Reverse Engineering API (digital)", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins(),
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)
register_error_handlers(app)
app.include_router(digital_router)


@app.get("/api/health")
async def health() -> dict:
    return {"status": "ok", "service": "vre-api", "provider": provider_status()}
