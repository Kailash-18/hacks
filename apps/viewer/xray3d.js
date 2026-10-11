// X-ray look: when X-ray is on, every part becomes a radiograph. Dense parts (metal, battery, chips) glow bright,
// light ones (glass, plastic shells) are faint, edges catch the light. Switching it on sends a scan plane across
// the object that turns it into an X-ray as it passes; a soft band keeps scanning slowly afterwards.
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
  uniform float uTime, uFront, uMin, uMax, uDensity, uSel;
  varying vec3 vN; varying vec3 vV; varying vec3 vW;
  void main() {
    if (vW.x > uFront) discard;                                    // not reached by the scan yet
    float fres = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 1.7);
    float u = clamp((vW.x - uMin) / max(1e-4, uMax - uMin), 0.0, 1.0);
    float band = exp(-pow((fract(u - uTime * 0.16) - 0.5) * 7.0, 2.0));   // the slow scanning band
    float edge = smoothstep(0.18, 0.0, uFront - vW.x) * step(uFront, uMax + 0.01); // bright line at the scan front
    float grain = fract(sin(dot(vW.xy * 91.7 + uTime, vec2(12.9898, 78.233))) * 43758.5453);
    float d = uDensity;
    vec3 deep = vec3(0.10, 0.32, 0.62), lit = vec3(0.78, 0.95, 1.0);
    vec3 col = mix(deep, lit, clamp(fres * (0.6 + d) + d * 0.25, 0.0, 1.0));
    float a = (0.05 + d * 0.16 + fres * (0.35 + d * 0.5) + band * 0.12 + edge * 0.9) * (0.92 + grain * 0.08);
    gl_FragColor = vec4(col * (0.75 + band * 0.5 + edge * 2.2 + uSel * 0.6), a);
  }`;

const DENSE = /battery|cell|metal|steel|alumin|frame|screw|bolt|chip|soc|cpu|processor|board|pcb|motor|magnet|coil|speaker|camera|lens|sensor|connector|spring|gear|shaft|bearing|heat ?sink|shield/i;
const LIGHT = /glass|display|screen|panel|cover|plastic|shell|case|housing|body|lid|cap|button|key|foam|fabric|strap|label|sticker|film|window/i;

export function installXray(View) {
  const P = View.prototype;

  P.xrayBodyFor = function (p) {
    if (p.xb) return p.xb;
    const g = p.mesh.geometry; if (!g.attributes.normal) g.computeVertexNormals();
    const text = `${p.label?.element?.firstChild?.textContent || ""} ${p.type || ""} ${p.material || ""}`;
    const density = DENSE.test(text) ? 1.0 : LIGHT.test(text) ? 0.32 : 0.62;
    const u = { uTime: { value: 0 }, uFront: { value: 1e6 }, uMin: { value: 0 }, uMax: { value: 1 }, uDensity: { value: density }, uSel: { value: 0 } };
    const m = new THREE.Mesh(g, new THREE.ShaderMaterial({ uniforms: u, vertexShader: VERT, fragmentShader: FRAG, transparent: true,
      depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false }));
    m.renderOrder = 20; m.raycast = () => {}; m.visible = false;
    p.mesh.add(m);
    p.xb = { mesh: m, u };
    return p.xb;
  };

  // the glowing plane that passes through the object when X-ray switches on
  P.xrayPlane = function () {
    if (this._xplane) return this._xplane;
    const c = document.createElement("canvas"); c.width = 8; c.height = 256;
    const g = c.getContext("2d"), grd = g.createLinearGradient(0, 0, 0, 256);
    grd.addColorStop(0, "rgba(94,242,255,0)"); grd.addColorStop(.5, "rgba(190,250,255,1)"); grd.addColorStop(1, "rgba(94,242,255,0)");
    g.fillStyle = grd; g.fillRect(0, 0, 8, 256);
    const tex = new THREE.CanvasTexture(c);
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide, toneMapped: false });
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    plane.rotation.y = Math.PI / 2; plane.renderOrder = 40; plane.visible = false; plane.raycast = () => {};
    this.scene.add(plane);
    return (this._xplane = plane);
  };

  P.xrayStart = function () {
    const box = new THREE.Box3();
    for (const p of this.parts) if (p.group.visible) box.expandByObject(p.mesh);
    if (box.isEmpty()) return;
    this._xbox = box; this._xT0 = performance.now();
    const pl = this.xrayPlane(), s = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
    pl.scale.set(Math.max(s.z, 0.2) * 1.35, Math.max(s.y, 0.2) * 1.5, 1); pl.position.set(box.min.x, c.y, c.z); pl.visible = true;
    this.poke?.();
  };

  // called at the end of paint()
  P.applyXrayFx = function (selected) {
    const on = !!this.xray && !this.intro;
    for (const p of this.parts) {
      if (!on && !p.xb) continue;
      const B = this.xrayBodyFor(p);
      B.mesh.visible = on && p.group.visible && p.id !== selected;  // the selected part is the hologram
      B.u.uSel.value = 0;
      if (on && p.id !== selected) { p.mat.opacity = Math.min(p.mat.opacity, 0.07); p.edges.material.opacity = Math.min(p.edges.material.opacity, 0.22); }
    }
    if (!on && this._xplane) this._xplane.visible = false;
  };

  P.updateXrayFx = function (now) {
    if (!this.xray || !this._xbox) return;
    const b = this._xbox, dur = 1100, k = Math.min(1, (now - this._xT0) / dur), e = 1 - Math.pow(1 - k, 3);
    const span = b.max.x - b.min.x, front = k >= 1 ? 1e6 : b.min.x - 0.05 + (span + 0.1) * e;
    for (const p of this.parts) if (p.xb) {
      const u = p.xb.u; u.uTime.value = now / 1000; u.uFront.value = front; u.uMin.value = b.min.x; u.uMax.value = b.max.x;
    }
    const pl = this._xplane;
    if (pl) { pl.visible = k < 1; pl.position.x = Math.min(front, b.max.x + 0.05); pl.material.opacity = 0.6 * (1 - Math.pow(k, 4)); }
  };

  const setXray = P.setXray;
  P.setXray = function (on) {
    setXray.call(this, on);
    if (on) this.xrayStart(); else { this._xbox = null; if (this._xplane) this._xplane.visible = false; }
  };
}
