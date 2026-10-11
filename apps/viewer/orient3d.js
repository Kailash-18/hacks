// Whole-object orientation (horizontal / vertical) and a view gizmo for the 3D model.
// Installed onto AssemblyView as extra methods, so assembly3d.js only needs a few hooks.
import * as THREE from "three";

const AX = [
  { key: "x", name: "X", label: "width", col: 0xff5470, css: "#ff5470", v: new THREE.Vector3(1, 0, 0) },
  { key: "y", name: "Y", label: "height", col: 0x3ccf8e, css: "#3ccf8e", v: new THREE.Vector3(0, 1, 0) },
  { key: "z", name: "Z", label: "depth", col: 0x4f8cff, css: "#4f8cff", v: new THREE.Vector3(0, 0, 1) },
];


export function installAxes(View) {
  const P = View.prototype;

  // ------------------------------------------------------------ orientation: show the whole object lying down or standing up
  // Horizontal: the object lies flat (longest side left-right) and its layers come apart up and down.
  // Vertical: the object stands up (longest side up-down) and its layers come apart left and right.
  P.orientTarget = function (mode) {
    if (mode !== "horizontal" && mode !== "vertical") return new THREE.Quaternion();
    const st = this.mainAxis ?? 1, sz = [this.size.x, this.size.y, this.size.z];
    const others = [0, 1, 2].filter((i) => i !== st), lg = sz[others[0]] >= sz[others[1]] ? others[0] : others[1];
    const e = new THREE.Vector3(), l = new THREE.Vector3(); e.setComponent(st, 1); l.setComponent(lg, this.upSign(mode, lg));
    const S = mode === "horizontal" ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);   // where the layers stack
    const L = mode === "horizontal" ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);   // where the long side points
    const from = new THREE.Matrix4().makeBasis(e, l, e.clone().cross(l)), to = new THREE.Matrix4().makeBasis(S, L, S.clone().cross(L));
    return new THREE.Quaternion().setFromRotationMatrix(to.multiply(from.transpose()));
  };
  // Which end of the long side goes up (vertical) or right (horizontal). An object that already stands
  // (long side vertical) keeps its own up. A lying object is stood up the way a person would hold it:
  // the end with its buttons, wheel, screen or lights on top (a mouse stands on its tail, buttons up).
  P.upSign = function (mode, lg) {
    if (lg === 1) return 1;
    const FRONT = new Set(["interface", "actuator", "display", "wheel", "light"]);
    const DECOR = /logo|label|badge|sticker|brand|decal|print|text|screw|foot|feet/i;
    const front = this.parts.filter((p) => FRONT.has(p.type) && !p.inferred && !DECOR.test(p.label.element.firstChild?.textContent || p.id));
    // controls on the top side (buttons, wheel, screen) decide; switches and LEDs on the underside do not
    const topSide = front.filter((p) => p.base.y > -this.size.y * 0.1);
    let sum = 0, n = 0;
    for (const p of (topSide.length ? topSide : front)) { sum += p.base.getComponent(lg); n++; }
    const span = this.size.getComponent(lg) || 1;
    if (n && Math.abs(sum / n) > span * 0.04) return Math.sign(sum / n);
    return -1; // no clear front: the end farther from the camera rises, like tilting the object up toward you
  };
  P.orientedSize = function () {
    const v = this.size.clone().applyQuaternion(this.orientQ || new THREE.Quaternion());
    return new THREE.Vector3(Math.abs(v.x), Math.abs(v.y), Math.abs(v.z));
  };
  P.setOrientation = function (mode, ms = 1200) {
    this.orientation = mode;
    const fromQ = (this.orientQ || new THREE.Quaternion()).clone(), toQ = this.orientTarget(mode);
    const t0 = performance.now(), fromT = this.explode, toT = Math.max(this.explode, 0.7);
    const cp = this.camera.position.clone(), ct = this.controls.target.clone();
    this.orientQ = toQ; this.buildEffects(); this.frame(toT);                    // where things end up
    const np = this.camera.position.clone(), nt = this.controls.target.clone();
    this.camera.position.copy(cp); this.controls.target.copy(ct); this.controls.update();
    const id = (this._orientRun = (this._orientRun || 0) + 1);
    const tick = (now) => {
      if (id !== this._orientRun) return;
      const k = Math.min(1, (now - t0) / ms), e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      this.orientQ = fromQ.clone().slerp(toQ, e);
      // fold the parts together while turning, then let them fly apart in the new direction
      const fold = Math.sin(Math.PI * e);
      this.explode = (fromT + (toT - fromT) * e) * (1 - 0.75 * fold);
      this.camera.position.lerpVectors(cp, np, e); this.controls.target.lerpVectors(ct, nt, e); this.controls.update();
      this.setExplode(this.explode); this.onExplode?.(this.explode);
      if (k < 1) requestAnimationFrame(tick);
      else { this.orientQ = toQ; this.setExplode(toT); this.onExplode?.(toT); if (this.fx) this.fx.group.position.y = this.floor.position.y + 0.01; this.poke(); }
    };
    requestAnimationFrame(tick);
  };

  // ------------------------------------------------------------ view gizmo: an axis triad in the corner, click to snap
  P.buildGizmo = function () {
    if (this.gizmo) return;
    const box = document.createElement("div"); box.className = "gizmo";
    box.innerHTML = `<svg viewBox="-50 -50 100 100" aria-hidden="true"><circle r="46" class="gz-ring"/><g class="gz-axes"></g></svg>
      <div class="gz-views"><button type="button" data-v="front">Front</button><button type="button" data-v="top">Top</button><button type="button" data-v="side">Side</button><button type="button" data-v="iso">3D</button></div>`;
    this.stage.append(box);
    const g = box.querySelector(".gz-axes");
    const items = [];
    for (const a of AX) for (const sgn of [1, -1]) {
      const el = document.createElementNS("http://www.w3.org/2000/svg", "g"); el.setAttribute("class", `gz-a ${a.key} ${sgn > 0 ? "pos" : "neg"}`);
      el.innerHTML = `<line x1="0" y1="0" x2="0" y2="0" stroke="${a.css}"/><circle r="${sgn > 0 ? 8 : 5}" fill="${sgn > 0 ? a.css : "#0d1118"}" stroke="${a.css}"/>${sgn > 0 ? `<text dy="3.5">${a.name}</text>` : ""}`;
      el.style.cursor = "pointer";
      el.addEventListener("click", () => this.viewFrom(a.key === "y" ? (sgn > 0 ? "top" : "bottom") : a.key === "z" ? (sgn > 0 ? "front" : "back") : sgn > 0 ? "side" : "left"));
      g.append(el); items.push({ el, v: a.v.clone().multiplyScalar(sgn) });
    }
    box.querySelector(".gz-views").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) this.viewFrom(b.dataset.v); });
    this.gizmo = { box, items, last: "" };
  };
  P.updateGizmo = function () {
    const G = this.gizmo; if (!G) return;
    G.box.hidden = !this.root.visible;
    const q = this.camera.quaternion.clone().invert(), key = this.camera.quaternion.toArray().map((x) => x.toFixed(3)).join();
    if (key === G.last) return; G.last = key;
    const rows = G.items.map((it) => ({ it, p: it.v.clone().applyQuaternion(q) })).sort((a, b) => a.p.z - b.p.z); // back to front
    for (const { it, p } of rows) {
      const x = p.x * 34, y = -p.y * 34;
      const line = it.el.querySelector("line"); line.setAttribute("x2", x); line.setAttribute("y2", y);
      it.el.querySelector("circle").setAttribute("cx", x); it.el.querySelector("circle").setAttribute("cy", y);
      const t = it.el.querySelector("text"); if (t) { t.setAttribute("x", x); t.setAttribute("y", y); }
      it.el.style.opacity = 0.45 + 0.55 * (p.z + 1) / 2;
      it.el.parentNode.append(it.el); // keep depth order
    }
  };
  P.viewFrom = function (v, ms = 900) {
    const tgt = this.controls.target.clone(), d = this.camera.position.distanceTo(tgt);
    const dirs = { front: [0, 0.001, 1], back: [0, 0.001, -1], top: [0, 1, 0.001], bottom: [0, -1, 0.001], side: [1, 0.001, 0], left: [-1, 0.001, 0], iso: [0.62, 0.42, 0.66] };
    if (v === "iso") { // the 3D button: the usual three-quarter view, fitted to the current explode level
      const cp = this.camera.position.clone(), ct = this.controls.target.clone();
      this.frame(Math.max(0.3, this.explode)); const np = this.camera.position.clone(), nt = this.controls.target.clone();
      this.camera.position.copy(cp); this.controls.target.copy(ct);
      const t0 = performance.now();
      const tick = (now) => { const k = Math.min(1, (now - t0) / ms), e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
        this.camera.position.lerpVectors(cp, np, e); this.controls.target.lerpVectors(ct, nt, e); this.controls.update(); this.poke();
        if (k < 1) requestAnimationFrame(tick); };
      this.controls.autoRotate = false; this.onViewChange?.(v); requestAnimationFrame(tick); return;
    }
    const dir = new THREE.Vector3(...(dirs[v] || dirs.iso)).normalize();
    const from = this.camera.position.clone().sub(tgt), t0 = performance.now();
    const r0 = from.length(), u0 = from.clone().normalize();
    this.controls.autoRotate = false; this.onViewChange?.(v);
    const tick = (now) => { // swing around the target on a sphere instead of cutting through the model
      const k = Math.min(1, (now - t0) / ms), e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      const u = u0.clone().lerp(dir, e).normalize();
      this.camera.position.copy(tgt).addScaledVector(u, r0 + (d - r0) * e); this.controls.update(); this.poke();
      if (k < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
}
