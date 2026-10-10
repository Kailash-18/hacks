"""Regenerate contracts/system-analysis.schema.json from the Pydantic contract.

Run from apps/api:  python scripts/export_schema.py
"""

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from app.contract import ChatRequest, ChatResponse, ErrorResponse, SystemAnalysis  # noqa: E402

ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
schema = SystemAnalysis.model_json_schema(by_alias=True)
schema["$schema"] = "https://json-schema.org/draft/2020-12/schema"
schema["$id"] = "system-analysis.schema.json"
for model in (ChatRequest, ChatResponse, ErrorResponse):
    sub = model.model_json_schema(by_alias=True)
    schema["$defs"].update(sub.pop("$defs", {}))  # hoist nested defs so #/$defs refs resolve
    schema["$defs"][model.__name__] = sub
out = os.path.join(ROOT, "contracts", "system-analysis.schema.json")
with open(out, "w", encoding="utf-8") as f:
    json.dump(schema, f, indent=2)
    f.write("\n")
print("wrote", out)
