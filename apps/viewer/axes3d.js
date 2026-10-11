// XYZ measurement graph, stack layouts (vertical / horizontal) and a view gizmo for the 3D model.
// Installed onto AssemblyView as extra methods, so assembly3d.js only needs a few hooks.
import * as THREE from "three";
import { CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";

const AX = [
  { key: "x", name: "X", label: "width", col: 0xff5470, css: "#ff5470", v: new THREE.Vector3(1, 0, 0) },
  { key: "y", name: "Y", label: "height", col: 0x3ccf8e, css: "#3ccf8e", v: new THREE.Vector3(0, 1, 0) },
  { key: "z", name: "Z", label: "depth", col: 0x4f8cff, css: "#4f8cff", v: new THREE.Vector3(0, 0, 1) },
];
const ease = (k) => 1 - Math.pow(1 - k, 3);
const niceStep = (mm) => [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000].find((s) => mm / s <= 8) || 2000;
const fmt = (mm) => (Math.abs(mm) >= 100 ? Math.round(mm) : Math.round(mm * 10) / 10).toString();

function tag(cls, html) { const d = document.createElement("div"); d.className = cls; d.innerHTML = html; return d; }

export function installAxes(View) {
  const P = View.prototype;

  // ------------------------------------------------------------ layout: which way the parts fly apart
  P.edir = function (p) { return p._edir || p.dir; };
  P.layoutTarget = function (mode) {
    const e = new THREE.Vector3(); e.setComponent(this.mainAxis ?? 1, 1);
    if (mode === "vertical") return new THREE.Quaternion().setFromUnitVectors(e, new THREE.Vector3(0, 1, 0));
    if (mode === "horizontal") return new THREE.Quaternion().setFromUnitVectors(e, new THREE.Vector3(1, 0, 0));
    return new THREE.Quaternion();
  };
  P.setLayout = function (mode, ms = 1100) {
    this.layout = mode;
    const q = this.layoutTarget(mode);
    const from = this.parts.map((p) => this.edir(p).clone()), to = this.parts.map((p) => p.dir.clone().applyQuaternion(q));
    this.parts.forEach((p, i) => { p._edirTo = to[i]; });
    const t0 = performance.now(), fromT = this.explode, toT = Math.max(this.explode, 0.75);
    // where the camera should end up for the new layout
    const cp = this.camera.position.clone(), ct = this.controls.target.clone();
    this.frame(toT); const np = this.camera.position.clone(), nt = this.controls.target.clone();
    this.camera.position.copy(cp); this.controls.target.copy(ct); this.controls.update();
    const id = (this._layoutRun = (this._layoutRun || 0) + 1);
    const tick = (now) => {
      if (id !== this._layoutRun) return;
      const k = Math.min(1, (now - t0) / ms), e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2; // ease in-out
      this.parts.forEach((p, i) => { (p._edir ||= new THREE.Vector3()).copy(from[i]).lerp(to[i], e); if (p._edir.lengthSq() < 1e-6) p._edir.copy(to[i]); });
      // parts swing through a little arc instead of sliding straight: brief lift in the middle of the move
      const arc = Math.sin(Math.PI * e) * 0.25;
      this.explode = fromT + (toT - fromT) * e + arc * 0.15;
      this.camera.position.lerpVectors(cp, np, e); this.controls.target.lerpVectors(ct, nt, e); this.controls.update();
      this.setExplode(this.explode); this.onExplode?.(this.explode);
      if (k < 1) requestAnimationFrame(tick);
      else { this.parts.forEach((p, i) => p._edir.copy(to[i])); this.setExplode(toT); this.onExplode?.(toT); }
    };
    requestAnimationFrame(tick);
  };

  // ------------------------------------------------------------ XYZ graph that wraps the (exploded) object
  // Origin at the lower-back-left corner of whatever is on screen; the axes, ticks, grids and size readouts
  // follow the parts as they fly apart. Ticks are real millimetres from the analysis' overall size.
  P.buildAxes = function () {
    if (this.axes) { this.root.remove(this.axes.group); this.axes.group.traverse((o) => { o.geometry?.dispose(); o.material?.dispose?.(); if (o.element) o.element.remove(); }); }
    this.renderer.localClippingEnabled = true;
    const s = this.size, k = this.scale || 1, LMAX = 40;
    const step = niceStep(Math.max(s.x, s.y, s.z) / k), stepW = step * k;
    const g = new THREE.Group();
    const clip = [new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0), new THREE.Plane(new THREE.Vector3(0, -1, 0), 0), new THREE.Plane(new THREE.Vector3(0, 0, -1), 0)];
    const lines = [], labels = [], planes = [], axes = [];
    AX.forEach((a, i) => {
      const ax = new THREE.Group();
      const mat = new THREE.LineBasicMaterial({ color: a.col, transparent: true, opacity: 0.95, toneMapped: false, depthTest: false });
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), a.v.clone()]), mat); ax.add(line);
      const perp = i === 1 ? new THREE.Vector3(-1, 0, 0) : new THREE.Vector3(0, -1, 0);
      const pts = [];
      for (let t = stepW, n = 1; t < LMAX; t += stepW, n++) { const L = n % 5 === 0 ? 0.16 : 0.08, p0 = a.v.clone().multiplyScalar(t); pts.push(p0, p0.clone().addScaledVector(perp, L)); }
      const ticks = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: a.col, transparent: true, opacity: 0.55, toneMapped: false, depthTest: false })); ax.add(ticks);
      const cone = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.22, 20), new THREE.MeshBasicMaterial({ color: a.col, toneMapped: false, depthTest: false, transparent: true }));
      cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), a.v); ax.add(cone);
      const end = new CSS2DObject(tag("ax-end " + a.key, `<b>${a.name}</b>`)); ax.add(end);
      const dim = new CSS2DObject(tag("ax-dim " + a.key, `<span>${a.label}</span><b></b><i>mm</i>`)); ax.add(dim);
      const edge = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), perp.clone().multiplyScalar(0.22)]), mat); ax.add(edge);
      ax.scale.setScalar(1e-3); g.add(ax);
      lines.push(ax); labels.push(end, dim);
      axes.push({ a, line, ticks, cone, end, dim, edge, perp, stepW, last: "" });
    });
    const mkPlane = (rot) => { // a big millimetre grid, cut to the size of the diagram by clipping planes
      const n = Math.ceil(LMAX / stepW), pts = [];
      for (let i = 0; i <= n; i++) { pts.push(new THREE.Vector3(i * stepW, 0, 0), new THREE.Vector3(i * stepW, LMAX, 0), new THREE.Vector3(0, i * stepW, 0), new THREE.Vector3(LMAX, i * stepW, 0)); }
      const m = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: 0x7fb2ff, transparent: true, opacity: 0, depthWrite: false, toneMapped: false, clippingPlanes: clip }));
      m.rotation.set(...rot); m.userData.maxOp = 0.08; g.add(m); planes.push(m); return m;
    };
    mkPlane([0, 0, 0]); mkPlane([Math.PI / 2, 0, 0]); mkPlane([0, -Math.PI / 2, 0]);
    const env = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
      new THREE.LineBasicMaterial({ color: 0x8fd0ff, transparent: true, opacity: 0, depthWrite: false, toneMapped: false }));
    env.userData.maxOp = 0.2; g.add(env); planes.push(env);
    const origin = new CSS2DObject(tag("ax-origin", "0")); g.add(origin); labels.push(origin);
    const marks = AX.map((a) => { const m = new CSS2DObject(tag("ax-mark " + a.key, "")); m.visible = false; g.add(m); return m; });
    this.root.add(g);
    this.axes = { group: g, lines, labels, planes, marks, axes, env, clip, len: [1, 1, 1], ext: new THREE.Vector3(1, 1, 1), on: this.axes?.on ?? true };
    for (const l of labels) l.element.classList.add("pre");
    this.updateAxisMarkers();
    this.showAxes(this.axes.on, true);
  };

  P.showAxes = function (on, replay = false) {
    const A = this.axes; if (!A) return; A.on = on;
    const id = (A.run = (A.run || 0) + 1), t0 = performance.now(), from = on && replay ? 0 : A.k ?? (on ? 0 : 1), to = on ? 1 : 0;
    A.group.visible = true;
    const dur = on ? 1400 : 450;
    const tick = (now) => {
      if (id !== A.run) return;
      const k = Math.min(1, (now - t0) / dur), v = from + (to - from) * k; A.k = v;
      A.lines.forEach((ax, i) => { // each axis grows out of the origin in turn
        const e = ease(Math.min(1, Math.max(0, (v * 1.6 - i * 0.25))));
        ax.scale.setScalar(Math.max(1e-3, e));
      });
      A.planes.forEach((m) => { m.material.opacity = m.userData.maxOp * ease(Math.max(0, v * 1.5 - 0.5)); });
      for (const l of A.labels) l.element.classList.toggle("pre", v < 0.8);
      this.poke();
      if (k < 1) requestAnimationFrame(tick);
      else { A.group.visible = on; this.updateAxisMarkers(); }
    };
    requestAnimationFrame(tick);
  };

  P.updateAxisMarkers = function () {
    const A = this.axes; if (!A) return;
    const k = this.scale || 1, box = new THREE.Box3();
    for (const p of this.parts) if (p.group.visible) { p.group.updateMatrixWorld(true); box.expandByObject(p.mesh); }
    if (box.isEmpty()) return;
    const M = 0.12, min = box.min.clone().subScalar(M), ext = box.getSize(new THREE.Vector3()).addScalar(2 * M);
    A.group.position.copy(min); A.ext.copy(ext);
    const L = [ext.x, ext.y, ext.z];
    A.axes.forEach((X, i) => {
      const len = Math.max(L[i] + 0.55, 1.6), v = X.a.v; A.len[i] = len;
      const P = X.line.geometry.attributes.position; P.setXYZ(1, v.x * len, v.y * len, v.z * len); P.needsUpdate = true; X.line.geometry.computeBoundingSphere();
      X.ticks.geometry.setDrawRange(0, 2 * Math.max(0, Math.floor((len - 0.15) / X.stepW)));
      X.cone.position.copy(v).multiplyScalar(len + 0.08);
      X.end.position.copy(v).multiplyScalar(len + 0.38);
      X.edge.position.copy(v).multiplyScalar(L[i]);
      X.dim.position.copy(v).multiplyScalar(L[i] / 2).addScaledVector(X.perp, 0.36);
      const txt = fmt((L[i] - 2 * M) / k); if (txt !== X.last) { X.last = txt; X.dim.element.querySelector("b").textContent = txt; }
    });
    A.env.scale.copy(ext); A.env.position.copy(ext).multiplyScalar(0.5);
    const wmax = min.clone().add(ext); this.root.localToWorld(wmax);
    A.clip[0].constant = wmax.x; A.clip[1].constant = wmax.y; A.clip[2].constant = wmax.z;
    // cursor markers: where the selected / hovered part sits, measured from the origin, on the side opposite the size readouts
    const id = this.hoverId || this.lastPaint?.selected, p = id && this.parts.find((q) => q.id === id);
    if (!A.on || !p || !p.group.visible) { A.marks.forEach((m) => (m.visible = false)); return; }
    const c = this.root.worldToLocal(this.centerOf(p)).sub(min);
    A.marks.forEach((m, i) => {
      const v = c.getComponent(i), X = A.axes[i];
      m.position.copy(AX[i].v).multiplyScalar(Math.min(A.len[i], Math.max(0, v))).addScaledVector(X.perp, -0.3); m.visible = true;
      if (!m.element.firstChild) m.element.innerHTML = `<span class="mk"><i></i><b>${AX[i].name}</b><em></em></span>`;
      const txt = fmt((v - M) / k), em = m.element.querySelector("em"); if (em.textContent !== txt) em.textContent = txt;
    });
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
