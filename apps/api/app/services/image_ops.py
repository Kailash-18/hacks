"""OpenCV helpers: decoding, Gemini mask handling, cleanup, cutouts, inpainting."""
from __future__ import annotations

import base64
import re

import cv2
import numpy as np

MAX_SIDE = 1024


def decode_image(data: bytes) -> np.ndarray:
    arr = np.frombuffer(data, np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("Could not decode image.")
    return img


def fit(img: np.ndarray, max_side: int = MAX_SIDE) -> np.ndarray:
    h, w = img.shape[:2]
    s = max_side / max(h, w)
    if s >= 1:
        return img
    return cv2.resize(img, (round(w * s), round(h * s)), interpolation=cv2.INTER_AREA)


def encode_jpeg(img: np.ndarray) -> bytes:
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 90])
    if not ok:
        raise ValueError("JPEG encode failed")
    return buf.tobytes()


def to_data_url(rgba: np.ndarray) -> str:
    ok, buf = cv2.imencode(".webp", rgba, [cv2.IMWRITE_WEBP_QUALITY, 88])
    mime = "image/webp"
    if not ok:
        ok, buf = cv2.imencode(".png", rgba)
        mime = "image/png"
    return f"data:{mime};base64," + base64.b64encode(buf.tobytes()).decode()


def box_to_pixels(box_2d, w: int, h: int) -> tuple[int, int, int, int] | None:
    """Gemini box_2d = [ymin, xmin, ymax, xmax] on a 0-1000 grid -> pixel x0,y0,x1,y1."""
    try:
        y0, x0, y1, x1 = (float(v) for v in box_2d)
    except (TypeError, ValueError):
        return None
    y0, y1 = sorted((max(0, min(1000, y0)), max(0, min(1000, y1))))
    x0, x1 = sorted((max(0, min(1000, x0)), max(0, min(1000, x1))))
    px = (int(x0 / 1000 * w), int(y0 / 1000 * h), int(round(x1 / 1000 * w)), int(round(y1 / 1000 * h)))
    if px[2] - px[0] < 4 or px[3] - px[1] < 4:
        return None
    return px


def decode_gemini_mask(mask_str, box_px, w: int, h: int) -> np.ndarray | None:
    """Gemini mask: base64 PNG (probability map) covering the box. Returns full-size uint8 0/255."""
    if not isinstance(mask_str, str) or not mask_str:
        return None
    b64 = re.sub(r"^data:image/\w+;base64,", "", mask_str.strip())
    try:
        raw = base64.b64decode(b64, validate=False)
    except Exception:
        return None
    m = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_GRAYSCALE)
    if m is None:
        return None
    x0, y0, x1, y1 = box_px
    m = cv2.resize(m, (x1 - x0, y1 - y0), interpolation=cv2.INTER_LINEAR)
    full = np.zeros((h, w), np.uint8)
    full[y0:y1, x0:x1] = np.where(m > 127, 255, 0).astype(np.uint8)
    return full


def polygon_mask(points, w: int, h: int) -> np.ndarray | None:
    """Model outline [[y, x], ...] on a 0-1000 grid -> filled uint8 mask (None if unusable)."""
    if not isinstance(points, list) or len(points) < 3:
        return None
    pts = []
    for pt in points[:64]:
        try:
            y, x = float(pt[0]), float(pt[1])
        except (TypeError, ValueError, IndexError):
            continue
        pts.append([int(max(0, min(1000, x)) / 1000 * (w - 1)), int(max(0, min(1000, y)) / 1000 * (h - 1))])
    if len(pts) < 3:
        return None
    m = np.zeros((h, w), np.uint8)
    cv2.fillPoly(m, [np.array(pts, np.int32)], 255)
    return m if m.sum() > 0 else None


def grabcut_refine(img: np.ndarray, rough: np.ndarray, box_px) -> np.ndarray:
    """Snap a rough outline to real edges with GrabCut, working on a small ROI for speed."""
    h, w = img.shape[:2]
    x0, y0, x1, y1 = box_px
    pad = int(0.08 * max(x1 - x0, y1 - y0)) + 4
    rx0, ry0, rx1, ry1 = max(0, x0 - pad), max(0, y0 - pad), min(w, x1 + pad), min(h, y1 + pad)
    roi, r = img[ry0:ry1, rx0:rx1], rough[ry0:ry1, rx0:rx1]
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))
    inner = cv2.erode(r, k, iterations=2)
    outer = cv2.dilate(r, k, iterations=2)
    gc = np.full(r.shape, cv2.GC_BGD, np.uint8)
    gc[outer > 0] = cv2.GC_PR_BGD
    gc[r > 0] = cv2.GC_PR_FGD
    gc[inner > 0] = cv2.GC_FGD
    out = np.zeros((h, w), np.uint8)
    try:
        bgd, fgd = np.zeros((1, 65), np.float64), np.zeros((1, 65), np.float64)
        cv2.grabCut(roi, gc, None, bgd, fgd, 2, cv2.GC_INIT_WITH_MASK)
        res = np.where((gc == cv2.GC_FGD) | (gc == cv2.GC_PR_FGD), 255, 0).astype(np.uint8)
    except cv2.error:
        res = r.copy()
    # Guard: if GrabCut collapsed or exploded, trust the outline instead.
    a, b = res.sum() / 255, max(1, r.sum() / 255)
    if not 0.5 < a / b < 1.6:
        res = r.copy()
    out[ry0:ry1, rx0:rx1] = res
    return out


def grabcut_mask(img: np.ndarray, box_px) -> np.ndarray:
    """Fallback when the model gives no usable mask: GrabCut initialised from the box."""
    h, w = img.shape[:2]
    x0, y0, x1, y1 = box_px
    mask = np.zeros((h, w), np.uint8)
    rect = (x0, y0, max(1, x1 - x0), max(1, y1 - y0))
    try:
        bgd, fgd = np.zeros((1, 65), np.float64), np.zeros((1, 65), np.float64)
        cv2.grabCut(img, mask, rect, bgd, fgd, 3, cv2.GC_INIT_WITH_RECT)
        out = np.where((mask == cv2.GC_FGD) | (mask == cv2.GC_PR_FGD), 255, 0).astype(np.uint8)
    except cv2.error:
        out = np.zeros((h, w), np.uint8)
    if out.sum() == 0:  # grabcut failed -> plain box
        out[y0:y1, x0:x1] = 255
    return out


def clean_mask(mask: np.ndarray, min_area_frac: float = 0.15, fill_holes: bool = True) -> np.ndarray:
    """Close gaps, remove specks, keep the significant connected regions, fill holes."""
    if mask.max() == 0:
        return mask
    k = max(3, int(round(min(mask.shape) * 0.006)) | 1)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))
    m = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel, iterations=2)
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, kernel, iterations=1)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(m, 8)
    if n <= 1:
        return m if not fill_holes else _fill(m)
    areas = stats[1:, cv2.CC_STAT_AREA]
    keep = [i + 1 for i, a in enumerate(areas) if a >= areas.max() * min_area_frac]
    m = np.isin(labels, keep).astype(np.uint8) * 255
    if not fill_holes:
        return m
    return _fill(m)


def _fill(m: np.ndarray) -> np.ndarray:
    contours, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    filled = np.zeros_like(m)
    cv2.drawContours(filled, contours, -1, 255, thickness=cv2.FILLED)
    return filled


def bbox_of(mask: np.ndarray) -> tuple[int, int, int, int] | None:
    ys, xs = np.nonzero(mask)
    if len(xs) == 0:
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def cutout(img: np.ndarray, mask: np.ndarray, box) -> np.ndarray:
    """RGBA crop with a slightly feathered alpha edge."""
    x0, y0, x1, y1 = box
    alpha = cv2.GaussianBlur(mask, (3, 3), 0)
    rgba = cv2.cvtColor(img, cv2.COLOR_BGR2BGRA)
    rgba[:, :, 3] = alpha
    return rgba[y0:y1, x0:x1].copy()


def inpainted_plate(img: np.ndarray, object_mask: np.ndarray, holes: np.ndarray) -> np.ndarray:
    """Object body with the part regions filled in, so exploding parts never leaves holes."""
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))
    hole = cv2.dilate(holes, k, iterations=1)
    # Inpaint at reduced size for speed on large holes, then upsample the fill only.
    h, w = img.shape[:2]
    # Fill from the object's own colours, not the background: paint everything outside the object
    # (and the holes) with the object's median colour before inpainting.
    body = (object_mask > 0) & (hole == 0)
    src = img.copy()
    if body.any():
        src[~body] = np.median(img[body], axis=0).astype(np.uint8)
    else:
        obj = object_mask > 0
        if obj.any():
            src[~obj] = np.median(img[obj], axis=0).astype(np.uint8)
    s = min(1.0, 512 / max(h, w))
    small = cv2.resize(src, (max(1, int(w * s)), max(1, int(h * s))), interpolation=cv2.INTER_AREA)
    small_hole = cv2.resize(hole, (small.shape[1], small.shape[0]), interpolation=cv2.INTER_NEAREST)
    filled_small = cv2.inpaint(small, small_hole, 5, cv2.INPAINT_TELEA)
    filled = cv2.resize(filled_small, (w, h), interpolation=cv2.INTER_CUBIC)
    out = img.copy()
    out[hole > 0] = filled[hole > 0]
    # Darken the filled area a touch so it reads as "the cavity behind the part".
    shade = out.astype(np.float32)
    shade[hole > 0] *= 0.72
    out = np.clip(shade, 0, 255).astype(np.uint8)
    rgba = cv2.cvtColor(out, cv2.COLOR_BGR2BGRA)
    rgba[:, :, 3] = cv2.GaussianBlur(object_mask, (3, 3), 0)
    return rgba
