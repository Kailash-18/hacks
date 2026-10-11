// "Could be replaced with": show the replacement on the 3D model. The part shrinks away in a burst of light,
// comes back in the new material, finish and proportions, and its callout names the replacement.
import * as THREE from "three";

const KEEP = ["alphaTest", "color", "metalness", "roughness", "opacity", "transparent", "clearcoat", "clearcoatRoughness", "map", "bumpMap", "roughnessMap"];

export function installSwap(View) {
  const P = View.prototype;

  P.swapPart = function (id, look, name, ms = 900) {
    const p = this.parts.find((q) => q.id === id); if (!p) return false;
    const m = p.mat;
    if (!p.orig) { // remember the original once, so any number of swaps can be undone
      p.orig = { label: p.label.element.firstChild.textContent, scale: p.mesh.scale.clone(), decal: p.decal?.isObject3D ? p.decal.visible : null };
      for (const k of KEEP) p.orig[k] = m[k] && m[k].clone && !m[k].isTexture ? m[k].clone() : m[k];
    }
    const apply = () => {
      for (const k of KEEP) { const v = p.orig[k]; m[k] = v && v.clone && !v.isTexture ? v.clone() : v; } // start from the original
      m.map = null; m.bumpMap = null; m.roughnessMap = null; m.alphaTest = 0;
      m.color.set(look.color);
      m.metalness = look.metalness ?? 0.1; m.roughness = look.roughness ?? 0.5;
      m.clearcoat = look.clearcoat ?? (m.roughness < 0.2 ? 0.8 : 0.2); m.clearcoatRoughness = 0.2;
      m.transparent = look.opacity != null && look.opacity < 1; m.opacity = look.opacity ?? 1;
      m.userData.baseOpacity = m.opacity;
      m.needsUpdate = true;
      const s = look.scale || [1, 1, 1];
      p.mesh.scale.set(p.orig.scale.x * s[0], p.orig.scale.y * s[1], p.orig.scale.z * s[2]); p.edges.scale.copy(p.mesh.scale);
      if (p.decal?.isObject3D) p.decal.visible = false;
      setLabel(p, name, true);
      p.swapped = name;
    };
    this.animateSwap(p, apply, ms);
    return true;
  };

  P.restorePart = function (id, ms = 700) {
    const p = this.parts.find((q) => q.id === id); if (!p?.orig) return false;
    this.animateSwap(p, () => {
      for (const k of KEEP) { const v = p.orig[k]; p.mat[k] = v && v.clone && !v.isTexture ? v.clone() : v; }
      p.mat.userData.baseOpacity = p.mat.opacity; p.mat.needsUpdate = true;
      p.mesh.scale.copy(p.orig.scale); p.edges.scale.copy(p.orig.scale);
      if (p.decal?.isObject3D) p.decal.visible = p.orig.decal ?? true;
      setLabel(p, p.orig.label, false);
      p.swapped = null;
    }, ms);
    return true;
  };

  P.restoreAllSwaps = function () {
    for (const p of this.parts) if (p.swapped) {
      for (const k of KEEP) { const v = p.orig[k]; p.mat[k] = v && v.clone && !v.isTexture ? v.clone() : v; }
      p.mat.userData.baseOpacity = p.mat.opacity; p.mat.needsUpdate = true;
      p.mesh.scale.copy(p.orig.scale); p.edges.scale.copy(p.orig.scale);
      if (p.decal?.isObject3D) p.decal.visible = p.orig.decal ?? true;
      setLabel(p, p.orig.label, false); p.swapped = null;
    }
    this.poke();
  };

  // shrink + twist out, swap at the smallest point (with a spark burst), then spring back in with a little overshoot
  P.animateSwap = function (p, apply, ms) {
    const t0 = performance.now(), axis = new THREE.Vector3(0.3, 1, 0.2).normalize(), id = (p._swapRun = (p._swapRun || 0) + 1);
    let swapped = false;
    p.label.element.classList.add("swapping");
    const tick = (now) => {
      if (id !== p._swapRun) return;
      const k = Math.min(1, (now - t0) / ms);
      let sc, ang;
      if (k < 0.42) { const e = k / 0.42; sc = 1 - 0.92 * e * e; ang = e * Math.PI * 0.9; }
      else {
        if (!swapped) {
          swapped = true; apply();
          p.group.updateMatrixWorld(true); this.spark(this.centerOf(p), 0x59d8ff); this.bloomT0 = now;
          if (this.lastPaint) this.paint(this.lastPaint);
        }
        const e = (k - 0.42) / 0.58, back = 1 + 2.2 * (e - 1) ** 3 + 1.2 * (e - 1) ** 2; // ease-out-back
        sc = 0.08 + 0.92 * back; ang = Math.PI * 0.9 + e * Math.PI * 1.1; // finishes one full turn
      }
      p.fx.scale = Math.max(0.02, sc);
      p.fx.quat.setFromAxisAngle(axis, ang);
      p.mat.emissive.setHex(0x59d8ff); p.mat.emissiveIntensity = 1.2 * Math.sin(Math.PI * k);
      this.applyPose(); this.poke();
      if (k < 1) requestAnimationFrame(tick);
      else {
        p.fx.scale = 1; p.fx.quat.identity(); this.applyPose();
        p.label.element.classList.remove("swapping");
        if (this.lastPaint) this.paint(this.lastPaint);
      }
    };
    requestAnimationFrame(tick);
  };
}

function setLabel(p, text, swapped) {
  const el = p.label.element;
  el.firstChild.textContent = text;
  el.classList.toggle("swapped", swapped);
  let tag = el.querySelector("small.sw");
  if (swapped && !tag) { tag = document.createElement("small"); tag.className = "sw"; tag.textContent = "replacement"; el.append(tag); }
  if (!swapped && tag) tag.remove();
  el.querySelectorAll("small:not(.sw)").forEach((s) => (s.hidden = swapped));
}
