"""List the Gemini models your key can use for generateContent (to pick a faster GEMINI_MODEL).

    cd apps/api
    python scripts/list_models.py
"""

import os
import sys
from pathlib import Path

API = Path(__file__).resolve().parent.parent
try:
    from dotenv import load_dotenv

    load_dotenv(API / ".env")
except ImportError:
    pass

from google import genai  # noqa: E402

key = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
if not key:
    sys.exit("GEMINI_API_KEY is not set in apps/api/.env")
client = genai.Client(api_key=key)
for m in client.models.list():
    actions = getattr(m, "supported_actions", None) or []
    if actions and "generateContent" not in actions:
        continue
    name = (m.name or "").removeprefix("models/")
    if "gemini" in name and not any(x in name for x in ("tts", "embedding", "audio", "live", "image-generation")):
        print(name)
