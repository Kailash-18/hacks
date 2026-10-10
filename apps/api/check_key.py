"""Quick key check: python check_key.py  (never prints the key).
Lists the Flash models your key can use and tests the one the app will pick."""
import os
import sys
from pathlib import Path

for line in Path(__file__).with_name(".env").read_text(encoding="utf-8-sig").splitlines():
    if "=" in line and not line.strip().startswith("#"):
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

sys.path.insert(0, str(Path(__file__).parent))
from app.services.vision_client import GeminiVisionClient  # noqa: E402

vc = GeminiVisionClient()
client = vc._get()
print(f"key length {len(vc.api_key or '')}, configured model {vc.model}")
names = [m.name.removeprefix("models/") for m in client.models.list() if "flash" in (m.name or "")]
print("Flash models available to this key:", ", ".join(names) or "none")
picked = vc._pick_model(client)
print("App will use:", picked)
try:
    r = client.models.generate_content(model=picked, contents="Reply with the word OK.")
    print(f"[OK] {picked}: {r.text.strip()!r}")
    print(f"Tip: set GEMINI_MODEL={picked} in .env to skip the auto-pick step.")
except Exception as e:
    print(f"[FAIL] {picked}: {str(e)[:300]}")
