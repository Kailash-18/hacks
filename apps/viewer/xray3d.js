// X-ray switch-on moment: a glowing scan plane sweeps across the object from left to right on screen, and the
// wiring appears behind it, wire by wire, as the light passes. Then the normal X-ray view stays.
import * as THREE from "three";

export function installXray(View) {
  const P = View.prototype;

  P.xrayPlane = function () {
    if (this._xplane) return this._xplane;
    const c = document.createElement("canvas"); c.width = 256; c.height = 8;
    const g = c.getContext("2d"), grd = g.createLinearGradient(0, 0, 256, 0);
    grd.addColorStop(0, "rgba(94,242,255,0)"); grd.addColorStop(.5, "rgba(200,252,255,1)"); grd.addColorStop(1, "rgba(94,242,255,0)");
    g.fillStyle = grd; g.fillRect(0, 0, 256, 8);
    const mat = new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, opacity: 0.5, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false });
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    plane.renderOrder = 40; plane.visible = false; plane.raycast = () => {};
    this.scene.add(plane);
    return (this._xplane = plane);
  };

  // the view that shows every part: side-on to the explode axis, a little from above, all of it in frame
  P.xrayView = function () {
    const fromPos = this.camera.position.clone(), fromT = this.controls.target.clone();
    this.frame(Math.max(this.explode || 0, 0.35));
    const toPos = this.camera.position.clone(), toT = this.controls.target.clone();
    this.camera.position.copy(fromPos); this.controls.target.copy(fromT); this.controls.update();
    const sum = [0, 0, 0];
    for (const p of this.parts) { const d = p.dir.clone().applyQuaternion(this.orientQ || new THREE.Quaternion()); sum[0] += Math.abs(d.x) * p.dist; sum[1] += Math.abs(d.y) * p.dist; sum[2] += Math.abs(d.z) * p.dist; }
    const main = sum.indexOf(Math.max(...sum));
    const [az, el] = main === 2 ? [0.98, 0.3] : main === 0 ? [0.55, 0.3] : [0.75, 0.14];
    const r = toPos.distanceTo(toT) * 0.95;
    toPos.set(toT.x + r * Math.sin(az) * Math.cos(el), toT.y + r * Math.sin(el), toT.z + r * Math.cos(az) * Math.cos(el));
    return { fromPos, fromT, toPos, toT };
  };

  P.flyTo = function ({ fromPos, fromT, toPos, toT }, ms = 1100) {
    this.sweep = null;
    const t0 = performance.now();
    const tick = (now) => {
      const k = Math.min(1, (now - t0) / ms), e = k < .5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      this.camera.position.lerpVectors(fromPos, toPos, e); this.controls.target.lerpVectors(fromT, toT, e); this.controls.update(); this.poke?.();
      if (k < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };

  P.xrayStart = function (view) {
    this.camera.updateMatrixWorld();
    // sweep left -> right on screen, as seen from where the camera is going
    const fwd = view ? view.toT.clone().sub(view.toPos).normalize() : new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const axis = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
    let min = Infinity, max = -Infinity; const box = new THREE.Box3(), all = new THREE.Box3(), v = new THREE.Vector3();
    for (const p of this.parts) {
      if (!p.group.visible) continue;
      p.group.updateMatrixWorld(true); box.setFromObject(p.mesh); all.union(box);
      for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
        const s = v.set(x, y, z).dot(axis); min = Math.min(min, s); max = Math.max(max, s); }
    }
    if (!isFinite(min)) return;
    this._xs = { axis, min: min - 0.1, max: max + 0.1, t0: performance.now(), dur: 1700, center: all.getCenter(new THREE.Vector3()) };
    const pl = this.xrayPlane(), up = new THREE.Vector3().crossVectors(axis, fwd).normalize();
    const n = new THREE.Vector3().crossVectors(axis, up).normalize();   // the plane holds the camera's up and depth directions
    pl.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(n, up, axis));
    const ext = Math.max(all.getSize(new THREE.Vector3()).length(), 1);
    pl.scale.set(ext * 0.5, ext * 1.15, 1); pl.visible = true;
    this.poke?.();
  };

  P.xrayStop = function () { this._xs = null; if (this._xplane) this._xplane.visible = false; };
  P.applyXrayFx = function () {};

  // runs after updateWires(): a wire shows once the scan has passed the middle of it
  P.updateXrayFx = function (now) {
    const X = this._xs; if (!this.xray || !X) return;
    const k = Math.min(1, (now - X.t0) / X.dur), e = k < .5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
    const front = X.min + (X.max - X.min) * e;
    for (const w of this.wires || []) {
      if (!w.curve || !w.mesh.visible) continue;
      const passed = w.curve.getPoint(0.5).dot(X.axis) <= front;
      w.mesh.visible = passed; w.sprites.forEach((sp) => (sp.visible = passed));
    }
    const pl = this._xplane;
    if (pl) { pl.position.copy(X.center).addScaledVector(X.axis, front - X.center.dot(X.axis)); pl.material.opacity = 0.55 * Math.sin(Math.PI * Math.min(1, k * 1.02)) ** 0.35; }
    if (k >= 1) this.xrayStop();
    this.poke?.();
  };

  const setXray = P.setXray;
  P.setXray = function (on) {
    setXray.call(this, on);
    this.xrayStop();
    if (on) {
      const view = this.xrayView();
      this.flyTo(view, 1100);                       // glide to the view that shows everything
      this.updateWires?.(performance.now()); this.xrayStart(view);  // while the scan already sweeps
    }
  };
}
