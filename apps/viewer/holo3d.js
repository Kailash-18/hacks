// Selected part becomes a hologram blueprint: see-through body, glowing rim, drifting scanlines, a bright
// wireframe, and a build-up sweep from bottom to top when it is first selected.
import * as THREE from "three";

const VERT = /* glsl */`
  uniform float uMinY, uMaxY;
  varying vec3 vN; varying vec3 vV; varying float vY; varying float vWY;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vN = normalize(normalMatrix * normal); vV = -mv.xyz;
    vY = clamp((position.y - uMinY) / max(1e-4, uMaxY - uMinY), 0.0, 1.0);
    vWY = (modelMatrix * vec4(position, 1.0)).y;
    gl_Position = projectionMatrix * mv;
  }`;
const FRAG = /* glsl */`
  uniform float uTime, uReveal; uniform vec3 uColor;
  varying vec3 vN; varying vec3 vV; varying float vY; varying float vWY;
  void main() {
    if (vY > uReveal) discard;
    float fres = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.2);
    float lines = smoothstep(0.55, 1.0, 0.5 + 0.5 * sin(vWY * 70.0 - uTime * 5.0));       // fine scanlines drifting up
    float band = exp(-pow((fract(vY - uTime * 0.35) - 0.5) * 9.0, 2.0));                   // a brighter band sweeping through
    float front = smoothstep(0.08, 0.0, uReveal - vY) * step(uReveal, 1.0);                // glowing build-up edge
    float flick = 0.93 + 0.07 * sin(uTime * 37.0) * sin(uTime * 13.0);
    float a = (0.10 + fres * 0.75 + lines * 0.16 + band * 0.22 + front * 0.9) * flick;
    gl_FragColor = vec4(uColor * (0.6 + fres * 1.4 + front * 2.0 + band * 0.6), a);
  }`;
const LVERT = /* glsl */`
  uniform float uMinY, uMaxY; varying float vY;
  void main() { vY = clamp((position.y - uMinY) / max(1e-4, uMaxY - uMinY), 0.0, 1.0); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const LFRAG = /* glsl */`
  uniform float uTime, uReveal; uniform vec3 uColor; varying float vY;
  void main() {
    if (vY > uReveal) discard;
    float band = exp(-pow((fract(vY - uTime * 0.35) - 0.5) * 9.0, 2.0));
    gl_FragColor = vec4(uColor * (1.3 + band * 1.5), 0.55 + band * 0.45);
  }`;

export function installHolo(View) {
  const P = View.prototype;

  P.holoFor = function (p) {
    if (p.holo) return p.holo;
    const g = p.mesh.geometry; g.computeBoundingBox();
    if (!g.attributes.normal) g.computeVertexNormals();
    const u = { uTime: { value: 0 }, uReveal: { value: 0 }, uColor: { value: new THREE.Color(0x4fd8ff) },
      uMinY: { value: g.boundingBox.min.y }, uMaxY: { value: g.boundingBox.max.y } };
    const common = { uniforms: u, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false };
    const body = new THREE.Mesh(g, new THREE.ShaderMaterial({ ...common, vertexShader: VERT, fragmentShader: FRAG, side: THREE.DoubleSide }));
    const wire = new THREE.LineSegments(new THREE.EdgesGeometry(g, 9), new THREE.ShaderMaterial({ ...common, vertexShader: LVERT, fragmentShader: LFRAG }));
    body.renderOrder = 30; wire.renderOrder = 31; body.visible = wire.visible = false;
    body.raycast = wire.raycast = () => {}; // picking still hits the real part
    p.mesh.add(body, wire);
    p.holo = { body, wire, u };
    return p.holo;
  };

  // called at the end of paint(): only the selected part is a hologram
  P.applyHolo = function (selected) {
    for (const p of this.parts) {
      const on = p.id === selected && p.group.visible && !this.intro;
      if (!on && !p.holo) continue;
      const H = this.holoFor(p);
      H.body.visible = H.wire.visible = on;
      if (on) { // the solid part fades to a faint ghost so the hologram reads through it
        p.mat.transparent = true; p.mat.opacity = 0.14; p.mat.depthWrite = false; p.mat.emissive.setHex(0x0a3a66); p.mat.emissiveIntensity = 0.6;
        p.edges.material.opacity = 0; p.mat.needsUpdate = true;
        if (p.decal?.isObject3D) p.decal.visible = false;
      } else if (p.decal?.isObject3D && !p.swapped) p.decal.visible = true;
    }
  };

  P.updateHolo = function (now, sel) {
    if (!sel) { this._holoId = null; return; }
    const H = this.holoFor(sel);
    if (this._holoId !== sel.id) { this._holoId = sel.id; this._holoT0 = now; this._selAnimUntil = now + 2600; }
    const age = now - this._holoT0;
    const still = this.lowQuality && age > 2400; // slow computers: build up once, then hold
    H.u.uTime.value = still ? 2.4 : age / 1000;
    H.u.uReveal.value = 1.1 * Math.min(1, 1 - Math.pow(1 - Math.min(1, age / 750), 3));
  };
}
