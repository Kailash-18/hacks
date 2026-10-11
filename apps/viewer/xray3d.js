// X-ray switch-on moment. The object spreads apart, the camera moves to a view that shows every part, then a
// glowing scan plane sweeps across it: each part flashes into a radiograph as the plane passes (dense parts
// bright, glass and plastic faint) and fades back to the normal X-ray view, where the wiring is the star.
import * as THREE from "three";

const VERT = /* glsl */`
  varying vec3 vN; varying vec3 vV; varying vec3 vW;
  void main() {
    vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz;
    vec4 mv = viewMatrix * w;
    vN = normalize(normalMatrix * normal); vV = -mv.xyz;
    gl_Position = projectionMatrix * mv;
  }`;
const FRAG = /* glsl */`
  uniform float uFront, uTail, uDensity; uniform vec3 uAxis, uTint;
  varying vec3 vN; varying vec3 vV; varying vec3 vW;
  void main() {
    float s = dot(vW, uAxis);
    if (s > uFront) discard;                                       // the scan has not reached this yet
    float behind = uFront - s;
    float glow = exp(-behind / uTail);                             // flashes as the plane passes, then fades
    if (glow < 0.01) discard;
    float fres = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 1.8);
    float edge = smoothstep(uTail * 0.35, 0.0, behind);
    vec3 col = mix(uTint * 0.55, vec3(0.85, 0.97, 1.0), clamp(fres * (0.5 + uDensity) + edge * 0.6, 0.0, 1.0));
    float a = (0.04 + uDensity * 0.14 + fres * (0.3 + uDensity * 0.45) + edge * 0.8) * glow;
    gl_FragColor = vec4(col * (0.8 + edge * 1.8), a);
  }`;

const DENSE = /battery|cell|metal|steel|alumin|frame|screw|bolt|chip|soc|cpu|processor|board|pcb|motor|magnet|coil|speaker|camera|lens|sensor|connector|spring|gear|shaft|bearing|heat ?sink|shield|engine/i;
const LIGHT = /glass|display|screen|panel|cover|plastic|shell|case|housing|body|lid|cap|button|key|foam|fabric|strap|label|sticker|film|window|logo/i;

export function installXray(View) {
  const P = View.prototype;

  P.xrayBodyFor = function (p) {
    if (p.xb) return p.xb;
    const g = p.mesh.geometry; if (!g.attributes.normal) g.computeVertexNormals();
    const text = `${p.label?.element?.firstChild?.textContent || ""} ${p.type || ""} ${p.material || ""}`;
    const density = DENSE.test(text) ? 1.0 : LIGHT.test(text) ? 0.3 : 0.6;
    const u = { uFront: { value: -1e6 }, uTail: { value: 1 }, uDensity: { value: density }, uAxis: { value: new THREE.Vector3(1, 0, 0) },
      uTint: { value: new THREE.Color(0x4fb8ff) } };
    const m = new THREE.Mesh(g, new THREE.ShaderMaterial({ uniforms: u, vertexShader: VERT, fragmentShader: FRAG, transparent: true,
      depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false }));
    m.renderOrder = 20; m.raycast = () => {}; m.visible = false;
    p.mesh.add(m);
    return (p.xb = { mesh: m, u });
  };

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

  // fly to the view that frame() picks for the fully exploded object: across the explode axis, everything in shot
  P.xrayShowAll = function (ms = 1200, t = 1) {
    const fromPos = this.camera.position.clone(), fromT = this.controls.target.clone();
    this.frame(t);
    const toPos = this.camera.position.clone(), toT = this.controls.target.clone();
    // look side-on to the explode axis, so the layers stand apart instead of in front of each other
    const sum = [0, 0, 0];
    for (const p of this.parts) { const d = p.dir.clone().applyQuaternion(this.orientQ || new THREE.Quaternion()); sum[0] += Math.abs(d.x) * p.dist; sum[1] += Math.abs(d.y) * p.dist; sum[2] += Math.abs(d.z) * p.dist; }
    const main = sum.indexOf(Math.max(...sum));
    const [az, el] = main === 2 ? [0.98, 0.3] : main === 0 ? [0.55, 0.3] : [0.75, 0.14];
    const r = toPos.distanceTo(toT) * 0.92;
    toPos.set(toT.x + r * Math.sin(az) * Math.cos(el), toT.y + r * Math.sin(el), toT.z + r * Math.cos(az) * Math.cos(el));
    this.camera.position.copy(fromPos); this.controls.target.copy(fromT); this.controls.update();
    this.sweep = null;
    const t0 = performance.now();
    const tick = (now) => {
      const k = Math.min(1, (now - t0) / ms), e = k < .5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      this.camera.position.lerpVectors(fromPos, toPos, e); this.controls.target.lerpVectors(fromT, toT, e); this.controls.update(); this.poke?.();
      if (k < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };

  P.xrayStart = function () {
    // scan across the screen: along the camera's right direction, left to right
    const axis = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0).normalize();
    let min = Infinity, max = -Infinity; const box = new THREE.Box3(), v = new THREE.Vector3();
    for (const p of this.parts) {
      if (!p.group.visible) continue;
      p.group.updateMatrixWorld(true); box.setFromObject(p.mesh);
      for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
        const s = v.set(x, y, z).dot(axis); min = Math.min(min, s); max = Math.max(max, s); }
      box.makeEmpty();
    }
    if (!isFinite(min)) return;
    const all = new THREE.Box3(); for (const p of this.parts) if (p.group.visible) all.expandByObject(p.mesh);
    const span = Math.max(0.2, max - min);
    this._xs = { axis, min, max, span, tail: span * 0.22, t0: performance.now(), dur: 1900, center: all.getCenter(new THREE.Vector3()), size: all.getSize(new THREE.Vector3()) };
    for (const p of this.parts) { const B = this.xrayBodyFor(p); B.u.uAxis.value.copy(axis); B.u.uTail.value = this._xs.tail; B.mesh.visible = p.group.visible; }
    const pl = this.xrayPlane(), up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
    pl.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3().crossVectors(up, axis).normalize(), up, axis).multiply(new THREE.Matrix4().makeRotationY(Math.PI / 2)));
    const ext = Math.max(this._xs.size.length(), 1);
    pl.scale.set(ext * 0.45, ext * 1.1, 1); pl.visible = true;
    this.poke?.();
  };

  P.xrayStop = function () {
    this._xs = null; this._xPending = 0;
    if (this._xplane) this._xplane.visible = false;
    for (const p of this.parts) if (p.xb) p.xb.mesh.visible = false;
  };

  // called at the end of paint(): the radiograph only lives during the scan
  P.applyXrayFx = function () {
    if (!this.xray || this.intro) for (const p of this.parts) if (p.xb) p.xb.mesh.visible = false;
  };

  P.updateXrayFx = function (now) {
    if (!this.xray) return;
    if (this._xPending && now >= this._xPending) { this._xPending = 0; this.xrayStart(); }
    const X = this._xs; if (!X) return;
    const k = Math.min(1, (now - X.t0) / X.dur), e = k < .5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
    const front = X.min - 0.05 + (X.span + X.tail * 5) * e;
    for (const p of this.parts) if (p.xb) p.xb.u.uFront.value = front;
    const pl = this._xplane;
    if (pl) {
      const f = Math.min(front, X.max + 0.05);
      pl.position.copy(X.center).addScaledVector(X.axis, f - X.center.dot(X.axis));
      pl.visible = front < X.max + 0.05; pl.material.opacity = 0.5;
    }
    if (k >= 1) this.xrayStop();
    this.poke?.();
  };

  const setXray = P.setXray;
  P.setXray = function (on, { delay = 0 } = {}) {
    setXray.call(this, on);
    this.xrayStop();
    if (on) this._xPending = performance.now() + delay;
  };
}
