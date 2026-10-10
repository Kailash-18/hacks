"""Box metrics for evaluating digital analysis against ground truth (normalized boxes)."""

from __future__ import annotations

from typing import Any, Mapping

Box = Mapping[str, float]


def iou(a: Box, b: Box) -> float:
    ix = max(0.0, min(a["x"] + a["width"], b["x"] + b["width"]) - max(a["x"], b["x"]))
    iy = max(0.0, min(a["y"] + a["height"], b["y"] + b["height"]) - max(a["y"], b["y"]))
    inter = ix * iy
    union = a["width"] * a["height"] + b["width"] * b["height"] - inter
    return inter / union if union > 0 else 0.0


def match_ground_truth(gt: list[dict[str, Any]], pred: list[dict[str, Any]], threshold: float = 0.5) -> dict[str, Any]:
    """Greedy one-to-one matching by IoU (highest first).

    gt items: {"id", "type", "bbox"}; pred items: components from the API (bbox may be null).
    Returns per-element matches plus recall@threshold, mean IoU of matches and type agreement.
    """
    pairs = []
    for gi, g in enumerate(gt):
        for pi, p in enumerate(pred):
            if p.get("bbox"):
                score = iou(g["bbox"], p["bbox"])
                if score > 0:
                    pairs.append((score, gi, pi))
    pairs.sort(reverse=True)
    used_g, used_p, matches = set(), set(), {}
    for score, gi, pi in pairs:
        if gi in used_g or pi in used_p:
            continue
        used_g.add(gi)
        used_p.add(pi)
        matches[gi] = (pi, score)

    rows, hits, type_ok, ious = [], 0, 0, []
    for gi, g in enumerate(gt):
        pi, score = matches.get(gi, (None, 0.0))
        p = pred[pi] if pi is not None else None
        hit = score >= threshold
        same_type = bool(p and p.get("type") == g.get("type"))
        if hit:
            hits += 1
            ious.append(score)
            type_ok += same_type
        rows.append({"gtId": g["id"], "gtType": g.get("type"), "predId": p["id"] if p else None,
                     "predType": p.get("type") if p else None, "iou": round(score, 3), "hit": hit,
                     "typeMatch": same_type if hit else None})
    n = len(gt)
    return {
        "threshold": threshold,
        "groundTruth": n,
        "predictedWithBox": sum(1 for p in pred if p.get("bbox")),
        "recall": round(hits / n, 3) if n else None,
        "meanIoUOfHits": round(sum(ious) / len(ious), 3) if ious else None,
        "typeAgreementOfHits": round(type_ok / hits, 3) if hits else None,
        "rows": rows,
    }
