"""Quick key check: python check_key.py  (prints which endpoint works; never prints the key)."""
import os
from pathlib import Path

for line in Path(__file__).with_name(".env").read_text(encoding="utf-8-sig").splitlines():
    if "=" in line and not line.strip().startswith("#"):
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

from google import genai

key, model = os.environ.get("GEMINI_API_KEY", ""), os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")
print(f"key length {len(key)}, model {model}")
for vertex in (key.startswith("AQ."), not key.startswith("AQ.")):
    name = "Vertex AI express" if vertex else "AI Studio"
    try:
        r = genai.Client(api_key=key, vertexai=vertex).models.generate_content(model=model, contents="Reply with the word OK.")
        print(f"[OK] {name}: {r.text.strip()!r}")
        break
    except Exception as e:
        print(f"[FAIL] {name}: {str(e)[:200]}")
