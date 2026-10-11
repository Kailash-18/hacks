// 360-degree exploded 3D model built from the AI's part geometry (simple solids, studio lighting).
// Geometry is an AI estimate from photos: clean and coherent, not a measured CAD model.
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { pcbTexture, brushedTexture, grainTexture, knurlTexture, screenTexture, weaveTexture, glowSprite, tiled } from "./textures.js";

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const easeOut = (k) => 1 - Math.pow(1 - k, 3);
const easeInOut = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
const bounce = (k) => { const n = 7.5625, d = 2.75; if (k < 1 / d) return n * k * k; if (k < 2 / d) return n * (k -= 1.5 / d) * k + 0.75; if (k < 2.5 / d) return n * (k -= 2.25 / d) * k + 0.9375; return n * (k -= 2.625 / d) * k + 0.984375; };
const hashStr = (t) => { let h = 2166136261; for (const ch of t) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); return h >>> 0; };
// relationship type -> wire colour (power amber, signal cyan, motion magenta, structure steel)
const WIRE = { powers: 0xffb020, feeds: 0xffb020, controls: 0x36d6ff, depends_on: 0x9b8cff, drives: 0xff5fd2, transmits: 0xff5fd2,
  supports: 0x8fa3bf, mounts: 0x8fa3bf };
const FLOW_SPEED = { powers: 0.32, feeds: 0.32, controls: 0.62, depends_on: 0.4, drives: 0.45, transmits: 0.45 };
export const WIRE_COLORS = WIRE;
const DARK = new THREE.Color(0x15171c);

function backdropTexture() { // deep navy studio gradient with a soft glow behind the model
  const c = document.createElement("canvas"); c.width = 1024; c.height = 1024;
  const g = c.getContext("2d");
  const r = g.createRadialGradient(512, 430, 40, 512, 520, 760);
  r.addColorStop(0, "#22324d"); r.addColorStop(0.45, "#111a2b"); r.addColorStop(1, "#05070c");
  g.fillStyle = r; g.fillRect(0, 0, 1024, 1024);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

const TARGET_SIZE = 6; // largest object dimension in world units

const MATERIALS = {
  plastic: { roughness: 0.6, metalness: 0.0, clearcoat: 0.05, clearcoatRoughness: 0.6, envMapIntensity: 0.45 },
  glossy_plastic: { roughness: 0.25, metalness: 0.0, clearcoat: 0.6, clearcoatRoughness: 0.2, envMapIntensity: 0.6 },
  rubber: { roughness: 0.95, metalness: 0.0, envMapIntensity: 0.3 },
  metal: { roughness: 0.28, metalness: 0.9 },
  aluminum: { roughness: 0.38, metalness: 0.8 },
  glass: { roughness: 0.05, metalness: 0.0, transmission: 0.65, thickness: 0.5, transparent: true, opacity: 0.55 },
  pcb: { roughness: 0.6, metalness: 0.1, clearcoat: 0.3, envMapIntensity: 0.5 },
  fabric: { roughness: 1.0, metalness: 0.0, sheen: 0.6, envMapIntensity: 0.3 },
  screen: { roughness: 0.12, metalness: 0.2, clearcoat: 1.0 },
};

function geometryFor(shape, s) {
  const [x, y, z] = s, m = Math.min(x, y, z);
  let g;
  switch (shape) {
    case "box": g = new THREE.BoxGeometry(x, y, z); break;
    case "plate": g = new RoundedBoxGeometry(x, y, z, 3, Math.min(m * 0.45, Math.max(x, z) * 0.06)); break;
    case "cylinder": case "disc": g = new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 1); g.scale(x, y, z); break;
    case "cone": g = new THREE.ConeGeometry(0.5, 1, 48); g.scale(x, y, z); break;
    case "sphere": case "ellipsoid": g = new THREE.SphereGeometry(0.5, 56, 36); g.scale(x, y, z); break;
    case "dome": // upper half ellipsoid, open at the bottom, centred on its bounding box
      g = new THREE.SphereGeometry(0.5, 64, 32, 0, Math.PI * 2, 0, Math.PI / 2); g.scale(x, y * 2, z); g.translate(0, -y / 2, 0); break;
    case "capsule": { const r = Math.min(x, z) / 2; g = new THREE.CapsuleGeometry(r, Math.max(0.001, y - 2 * r), 10, 32); g.scale(1, 1, z / x || 1); break; }
    case "torus": { const R = x / 2, t = Math.max(0.01, Math.min(y, R) / 2); g = new THREE.TorusGeometry(Math.max(t, R - t), t, 24, 72); g.rotateX(Math.PI / 2); g.scale(1, 1, z / x || 1); break; }
    default: g = new RoundedBoxGeometry(x, y, z, 4, Math.min(m * 0.45, Math.max(x, y, z) * 0.08));
  }
  g.computeVertexNormals();
  return g;
}

export class AssemblyView {
  constructor({ scene, renderer, camera, controls, stage }) {
    Object.assign(this, { scene, renderer, camera, controls });
    this.root = new THREE.Group(); this.root.visible = false; scene.add(this.root);
    this.parts = []; this.explode = 0;
    const pmrem = new THREE.PMREMGenerator(renderer);
    this.env = pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture;
    // soft studio lights + shadow-catching floor
    this.lights = new THREE.Group(); this.root.add(this.lights);
    const keyL = new THREE.DirectionalLight(0xffffff, 1.4); keyL.position.set(4, 9, 6); keyL.castShadow = true;
    keyL.shadow.mapSize.set(2048, 2048); Object.assign(keyL.shadow.camera, { left: -9, right: 9, top: 9, bottom: -9, near: 0.5, far: 40 });
    keyL.shadow.radius = 6; keyL.shadow.bias = -0.0004; this.lights.add(keyL, keyL.target);
    this.lights.add(new THREE.HemisphereLight(0xdfe8ff, 0x1a1d24, 0.9));
    const fill = new THREE.DirectionalLight(0xbcd0ff, 0.6); fill.position.set(-6, 3, -5); this.lights.add(fill);
    // rim lights: cool cyan from back-left, warm from back-right, for glowing silhouettes
    const rimC = new THREE.DirectionalLight(0x59d8ff, 1.5); rimC.position.set(-7, 4, -6); this.lights.add(rimC);
    const rimW = new THREE.DirectionalLight(0xff9b54, 0.7); rimW.position.set(7, 2, -5); this.lights.add(rimW);
    this.grid = new THREE.GridHelper(40, 80, 0x3d5f8f, 0x1e2d45);
    this.grid.material.transparent = true; this.grid.material.opacity = 0.45; this.grid.material.depthWrite = false;
    this.root.add(this.grid);
    this.background = backdropTexture();
    this.fog = new THREE.Fog(0x070b13, 12, 34);
    this.floor = new THREE.Mesh(new THREE.CircleGeometry(14, 64), new THREE.ShadowMaterial({ opacity: 0.45 }));
    this.floor.rotation.x = -Math.PI / 2; this.floor.receiveShadow = true; this.root.add(this.floor);
    // labels
    this.labels = new CSS2DRenderer(); this.labels.domElement.className = "labels3d"; stage.append(this.labels.domElement);
    this.stage = stage;
    // post-processing: gentle bloom makes highlights, selections and metal glints glow
    this.composer = new EffectComposer(renderer);
    this.composer.addPass(new RenderPass(scene, camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(512, 512), 0.18, 0.4, 0.97);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this._size = "";
  }

  setActive(on) {
    this.root.visible = on; this.labels.domElement.hidden = !on;
    this.stage.classList.toggle("studio", on);
    this.scene.background = on ? this.background : null;
    this.scene.fog = on ? this.fog : null;
    this.scene.environment = on ? this.env : null;
    this.renderer.shadowMap.enabled = true; this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = on ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    const c = this.controls;
    if (on) { c.minAzimuthAngle = -Infinity; c.maxAzimuthAngle = Infinity; c.minPolarAngle = 0.05; c.maxPolarAngle = Math.PI - 0.05; c.minDistance = 2; c.maxDistance = 60; }
  }

  build(assembly, components, views = [], relationships = []) {
    for (const p of this.parts) { this.root.remove(p.group); p.label.element.remove(); }
    if (this._leaderEls) { for (const g of this._leaderEls.values()) g.remove(); this._leaderEls.clear(); }
    this.parts = []; this.whatif = null; this.intro = null;
    for (const sp of this.sparks || []) this.root.remove(sp.s);
    this.sparks = [];
    const comp = Object.fromEntries(components.map((c) => [c.id, c]));
    const [ox, oy, oz] = assembly.overallSize;
    this.scale = TARGET_SIZE / Math.max(ox, oy, oz, 1);
    const k = this.scale;
    // curved shells ("dome") that thin parts and base plates should conform to
    // only upright domes (open side down) act as shells that other parts conform to / fit inside
    const upright = (a) => a.rotation.every((r) => Math.abs(((r % 360) + 540) % 360 - 180) < 5); // rotation ~0: open side down
    const domes = assembly.parts.filter((a) => a.shape === "dome" && upright(a)).map((a) => ({
      cx: a.position[0] * k, cz: a.position[2] * k, ax: (a.size[0] * k) / 2, az: (a.size[2] * k) / 2,
      h: a.size[1] * k, baseY: a.position[1] * k - (a.size[1] * k) / 2 }));
    const domeTop = (d, x, z) => { const q = 1 - ((x - d.cx) / d.ax) ** 2 - ((z - d.cz) / d.az) ** 2; return q > 0 ? d.baseY + d.h * Math.sqrt(q) : null; };
    const main = [...domes].sort((a, b) => b.ax * b.az - a.ax * a.az)[0];
    this.mainDome = main ? { ...main } : null; // used after centring to keep every part inside the shell's outline
    // 1) Housing parts (side shell, lower shell, chassis) with the dome's footprint become curved bands that
    //    follow the dome, and the dome is trimmed to sit on them: one seamless body, no box corners sticking out.
    const bands = {};
    if (main) for (const a of assembly.parts) {
      const c = comp[a.componentId];
      if (!c || a.shape === "dome" || !["box", "rounded_box", "plate", "cylinder"].includes(a.shape)) continue;
      if (!["cover", "structure"].includes(c.type)) continue;
      const sx = a.size[0] * k, sy = a.size[1] * k, sz = a.size[2] * k, py = a.position[1] * k;
      if (sx < main.ax * 2 * 0.72 || sz < main.az * 2 * 0.72) continue;  // not a housing-sized part
      if (sy < 0.3 * Math.min(sx, sz)) continue;                          // thin base plates are handled below
      const y0 = py - sy / 2, y1 = Math.min(py + sy / 2, main.baseY + main.h * 0.9);
      if (y1 <= y0) continue;
      bands[a.componentId] = { y0, y1 };
      if (y1 > main.baseY) main.cutY = Math.max(main.cutY ?? -Infinity, y1); // the dome starts where the band ends
    }
    // 2) Internal parts must fit inside the curved shell: shrink them / pull them in until they do.
    const inner = new Set(["controller", "sensor", "power_source", "storage", "mechanism", "cable", "connector", "fastener", "unknown", "structure"]);
    const fitted = {};
    if (main) for (const a of assembly.parts) {
      const c = comp[a.componentId];
      if (!c || a.shape === "dome" || bands[a.componentId] || !inner.has(c.type)) continue;
      // a flat base plate under the shell is not squeezed inside it: it gets the shell's oval footprint below
      if (["structure", "cover"].includes(c.type) && a.size[1] < 0.3 * Math.min(a.size[0], a.size[2])) continue;
      const size = a.size.map((v) => v * k), pos = a.position.map((v) => v * k);
      if (domeTop(main, pos[0], pos[2]) === null || pos[1] > (domeTop(main, pos[0], pos[2]) ?? 0)) continue; // not inside the shell
      const R = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...a.rotation.map((d) => THREE.MathUtils.degToRad(d)))).elements;
      for (let it = 0; it < 14; it++) {
        const hx = (Math.abs(R[0]) * size[0] + Math.abs(R[4]) * size[1] + Math.abs(R[8]) * size[2]) / 2;
        const hy = (Math.abs(R[1]) * size[0] + Math.abs(R[5]) * size[1] + Math.abs(R[9]) * size[2]) / 2;
        const hz = (Math.abs(R[2]) * size[0] + Math.abs(R[6]) * size[1] + Math.abs(R[10]) * size[2]) / 2;
        let ok = true;
        for (const [dx, dz] of [[-hx, -hz], [hx, -hz], [-hx, hz], [hx, hz]]) {
          const x = pos[0] + dx, z = pos[2] + dz;
          const inFoot = ((x - main.cx) / (main.ax * 0.94)) ** 2 + ((z - main.cz) / (main.az * 0.94)) ** 2 <= 1;
          const top = domeTop(main, x, z);
          if (!inFoot || top === null || pos[1] + hy > main.baseY + (top - main.baseY) * 0.94) { ok = false; break; }
        }
        if (ok) break;
        for (let i = 0; i < 3; i++) size[i] *= 0.9;
        pos[0] += (main.cx - pos[0]) * 0.15; pos[2] += (main.cz - pos[2]) * 0.15;
        pos[1] = Math.max(main.baseY + hy * 0.9, pos[1] - hy * 0.12);
      }
      fitted[a.componentId] = { size, pos };
    }
    for (const a of assembly.parts) {
      const c = comp[a.componentId]; if (!c) continue;
      const inferred = c.status !== "observed";
      const size = fitted[a.componentId] ? fitted[a.componentId].size.map((v) => Math.max(0.02, v)) : a.size.map((v) => Math.max(0.02, v * k));
      const pos = fitted[a.componentId] ? fitted[a.componentId].pos : a.position.map((v) => v * k);
      let geom = null, conformed = false;
      if (bands[a.componentId]) { geom = this.bandGeometry(main, bands[a.componentId], pos); conformed = true; }
      else if (a.shape === "dome" && main && a.componentId && main.cutY != null && Math.abs(a.position[0] * k - main.cx) < 1e-6
        && Math.abs(a.size[0] * k / 2 - main.ax) < 1e-6) { geom = this.cutDome(size, (main.cutY - main.baseY) / main.h); }
      const thin = size[1] < 0.3 * Math.min(size[0], size[2]);
      const host = a.shape !== "dome" && domes.find((d) => domeTop(d, pos[0], pos[2]) !== null);
      if (geom) { /* band or trimmed dome built above */ }
      else if (host && thin && pos[1] > host.baseY + host.h * 0.3 && ["plate", "box", "rounded_box"].includes(a.shape)) {
        // thin part on top of a curved shell (button, badge): bend it onto the shell surface
        const g = new THREE.PlaneGeometry(size[0], size[2], 24, 24); g.rotateX(-Math.PI / 2);
        const P = g.attributes.position;
        for (let i = 0; i < P.count; i++) {
          let x = pos[0] + P.getX(i), z = pos[2] + P.getZ(i);
          const r = Math.hypot((x - host.cx) / host.ax, (z - host.cz) / host.az);
          if (r > 0.97) { x = host.cx + (x - host.cx) * 0.97 / r; z = host.cz + (z - host.cz) * 0.97 / r; }
          P.setXYZ(i, x - pos[0], domeTop(host, x, z) + Math.max(0.02, size[1] * 0.5) - pos[1], z - pos[2]);
        }
        g.computeVertexNormals(); geom = g; conformed = true;
      } else if (!geom) {
        const d = domes.find((d) => Math.abs((pos[1] + size[1] / 2) - d.baseY) < d.h * 0.35
          && size[0] > d.ax * 1.4 && size[2] > d.az * 1.4 && ["plate", "box", "rounded_box"].includes(a.shape));
        if (d) { // base plate under a curved shell: give it the shell's oval footprint
          geom = new THREE.CylinderGeometry(0.5, 0.5, 1, 64); geom.scale(d.ax * 2, size[1], d.az * 2);
          geom.translate(d.cx - pos[0], 0, d.cz - pos[2]); conformed = true;
        }
      }
      const inverted = a.shape === "dome" && !upright(a);
      geom = geom || geometryFor(a.shape, size);
      const mp = MATERIALS[a.material] || MATERIALS.plastic;
      const mat = new THREE.MeshPhysicalMaterial({ color: new THREE.Color(a.color), envMapIntensity: 1.0, ...mp,
        side: a.shape === "dome" || conformed ? THREE.DoubleSide : THREE.FrontSide });
      const isBoard = this.dressMaterial(mat, a, c, size);
      const mesh = new THREE.Mesh(geom, mat); mesh.castShadow = true; mesh.receiveShadow = true;
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geom, 28),
        new THREE.LineBasicMaterial({ color: 0x0b0d12, transparent: true, opacity: 0.28 }));
      const group = new THREE.Group(); group.add(mesh, edges);
      if (inverted) { // a flipped dome would be an open bowl: close it with a lid
        const lid = new THREE.Mesh(new THREE.CircleGeometry(0.5, 64).rotateX(Math.PI / 2).scale(size[0], 1, size[2]).translate(0, -size[1] / 2, 0), mat);
        lid.castShadow = true; group.add(lid); var lidMesh = lid;
      }
      if (!conformed) group.rotation.set(...a.rotation.map((d) => THREE.MathUtils.degToRad(d)));
      group.traverse((o) => (o.userData.partId = a.componentId));
      const div = document.createElement("div"); div.className = "lbl" + (inferred ? " inferred" : "");
      div.textContent = c.label;
      if (inferred) { const tag = document.createElement("small"); tag.textContent = "inferred"; div.append(tag); }
      geom.computeBoundingBox();
      div.addEventListener("pointerenter", () => this.setHover(a.componentId, "label"));
      div.addEventListener("pointerleave", () => this.setHover(null, "label"));
      div.addEventListener("click", (e) => { e.stopPropagation(); this.onPick?.(a.componentId); });
      const label = new CSS2DObject(div); label.position.set(0, geom.boundingBox.max.y + 0.12, 0); label.center.set(0.5, 1);
      group.add(label);
      this.root.add(group);
      geom.computeBoundingBox();
      this.parts.push({ id: a.componentId, group, mesh, edges, mat, label, inferred, extras: [], pickables: inverted ? [mesh, lidMesh] : [mesh], conformed,
        type: c.type, shape: a.shape, isBoard,
        printable: ["interface", "display"].includes(c.type) || /label|logo|badge|sticker|screen|display|decal|print/i.test(c.label), material: a.material, size, localCenter: geom.boundingBox.getCenter(new THREE.Vector3()),
        dragT: 0, fx: { offset: new THREE.Vector3(), quat: new THREE.Quaternion(), scale: 1 }, edgeColor: edges.material.color.clone(),
        baseEdgeOpacity: edges.material.opacity,
        offset: new THREE.Vector3(), baseQuat: group.quaternion.clone(), userQuat: new THREE.Quaternion(),
        base: new THREE.Vector3(...pos), thinAxis: size.indexOf(Math.min(...size)),
        // only surface parts (labels, badges, buttons, switches) wrap onto the shell; boards and base plates stay flat
        sheetCandidate: !conformed && !inferred && !["controller", "structure", "power_source", "storage", "mechanism", "connector", "sensor"].includes(c.type)
          && ["plate", "box", "rounded_box"].includes(a.shape) && Math.min(...size) < 0.28 * [...size].sort((x, y) => x - y)[1],
        dir: new THREE.Vector3(...a.explodeDir).normalize(), dist: a.explodeDist ?? 1, halfH: size[1] / 2 });
    }
    this.wrapStickers();
    // centre the assembly on its bounding box
    const box = new THREE.Box3();
    for (const p of this.parts) { p.group.position.copy(p.base); p.group.updateMatrixWorld(true); box.expandByObject(p.mesh); }
    const ctr = box.getCenter(new THREE.Vector3());
    for (const p of this.parts) p.base.sub(ctr);
    this._ctr = ctr;
    this.size = box.getSize(new THREE.Vector3());
    this.containInternals();
    this.orderExplode();
    this.addDetails(assembly.details || [], k, ctr);
    this.addAutoDetails(assembly.details || []);
    this.addDecals(views);
    this.buildWires(relationships);
    this.setExplode(this.explode);
  }

  // The AI sometimes places an internal part (board, battery, connector, speaker) so that it pokes out of the
  // housing. Shrink it a little if it is too big and slide it back inside the housing's box.
  containInternals() {
    const boxOf = (p) => { p.group.position.copy(p.base); p.group.quaternion.copy(p.baseQuat); p.group.scale.setScalar(1);
      p.group.updateMatrixWorld(true); return new THREE.Box3().setFromObject(p.mesh); };
    const all = new THREE.Box3(); const boxes = new Map();
    for (const p of this.parts) { const b = boxOf(p); boxes.set(p, b); all.union(b); }
    const S = all.getSize(new THREE.Vector3()), big = (b) => { const z = b.getSize(new THREE.Vector3());
      return [z.x / S.x, z.y / S.y, z.z / S.z].filter((r) => r > 0.6).length >= 2; };
    this.housing = new Set(this.parts.filter((p) => ["cover", "structure"].includes(p.type) && big(boxes.get(p))));
    if (!this.housing.size) return;
    const env = new THREE.Box3(); for (const p of this.housing) env.union(boxes.get(p));
    const inset = env.getSize(new THREE.Vector3()).multiplyScalar(0.03); env.min.add(inset); env.max.sub(inset);
    const E = env.getSize(new THREE.Vector3());
    // buttons, screens and wheels may sit proud of the surface a little; nothing may hang outside the body
    const outside = new Set(["actuator", "display", "wheel", "interface"]);
    const loose = env.clone().expandByVector(env.getSize(new THREE.Vector3()).multiplyScalar(0.06));
    for (const p of this.parts) {
      if (this.housing.has(p) || p.sheet) continue;
      const box = outside.has(p.type) && !p.inferred ? loose : env, E2 = box.getSize(new THREE.Vector3());
      const b = boxes.get(p), z = b.getSize(new THREE.Vector3());
      if (box.containsBox(b)) continue;
      const k = Math.min(1, 0.96 * E2.x / Math.max(1e-6, z.x), 0.96 * E2.y / Math.max(1e-6, z.y), 0.96 * E2.z / Math.max(1e-6, z.z));
      p.fit = k;
      const c = b.getCenter(new THREE.Vector3()), h = z.multiplyScalar(k / 2), want = c.clone();
      for (const ax of ["x", "y", "z"]) want[ax] = Math.min(box.max[ax] - h[ax], Math.max(box.min[ax] + h[ax], c[ax]));
      // scaling happens around the group's pivot, which is not always the box centre
      const off = c.clone().sub(p.base).multiplyScalar(k);
      p.base.copy(want).sub(off);
    }
    // a rounded shell (mouse, helmet, bottle cap) has an oval outline: box corners can still poke out of it
    const d = this.mainDome;
    if (!d) return;
    const ctr = this._ctr || new THREE.Vector3(), cx = d.cx - ctr.x, cz = d.cz - ctr.z;
    for (const p of this.parts) {
      if (this.housing.has(p) || p.sheet || p.conformed) continue;
      for (let it = 0; it < 16; it++) {
        p.group.position.copy(p.base); p.group.quaternion.copy(p.baseQuat); p.group.scale.setScalar(p.fit || 1); p.group.updateMatrixWorld(true);
        const b = new THREE.Box3().setFromObject(p.mesh);
        const lim = outside.has(p.type) && !p.inferred ? 1.06 : 0.97;
        const worst = Math.max(...[[b.min.x, b.min.z], [b.max.x, b.min.z], [b.min.x, b.max.z], [b.max.x, b.max.z]]
          .map(([x, z]) => Math.hypot((x - cx) / d.ax, (z - cz) / d.az)));
        if (worst <= lim) break;
        p.fit = (p.fit || 1) * 0.93;
        p.base.x += (cx - p.base.x) * 0.12; p.base.z += (cz - p.base.z) * 0.12;
      }
    }
    for (const p of this.parts) { p.group.scale.setScalar(1); }
  }

  // Inside the body = not a housing part and not something you can see or touch from outside.
  isInside(p) {
    if (!this.housing?.size || this.housing.has(p) || p.sheet) return false;
    return p.inferred || ["controller", "power_source", "storage", "cable", "connector", "mechanism", "sensor"].includes(p.type);
  }

  // Parts must leave the assembly in the order they are stacked: the screen in front of the housing it sits
  // in, the board behind it. The AI's distances often break that order (the screen ends up hidden behind the
  // housing). Internal parts that fly off sideways are put back on the main axis so they stay in the stack.
  orderExplode() {
    const sum = [0, 0, 0];
    for (const p of this.parts) { sum[0] += Math.abs(p.dir.x) * p.dist; sum[1] += Math.abs(p.dir.y) * p.dist; sum[2] += Math.abs(p.dir.z) * p.dist; }
    const e = new THREE.Vector3(); e.setComponent(sum.indexOf(Math.max(...sum)), 1);
    const span = this.size.getComponent(sum.indexOf(Math.max(...sum))) || 1;
    for (const p of this.parts) {
      const along = p.dir.dot(e);
      const internal = p.inferred || ["controller", "power_source", "storage", "connector", "cable"].includes(p.type);
      if (Math.abs(along) < 0.5 && internal && !this.housing?.has(p)) {
        const side = Math.sign(p.base.dot(e)) || Math.sign(along) || 1;
        p.dir.copy(e).multiplyScalar(side);
      }
    }
    const GAP = 0.14, EPS = span * 0.04;
    for (const side of [1, -1]) {
      const members = this.parts.filter((p) => p.dir.dot(e) * side >= 0.5).map((p) => ({
        p, along: p.dir.dot(e) * side, key: p.base.dot(e) * side + (this.housing?.has(p) ? EPS * 0.5 : 0) }));
      members.sort((a, b) => a.key - b.key);
      let prev = null, i = 0;
      while (i < members.length) { // parts at about the same depth form one level; each level clears the one inside it
        const lvl = [members[i]];
        while (i + lvl.length < members.length && members[i + lvl.length].key - members[i].key <= EPS) lvl.push(members[i + lvl.length]);
        i += lvl.length;
        const req = prev === null ? 0 : prev + GAP;
        let top = 0;
        for (const m of lvl) { const ev = Math.max(m.p.dist * m.along, req); m.p.dist = ev / m.along; top = Math.max(top, ev); }
        prev = Math.max(prev ?? 0, top);
      }
      const top = Math.max(0, ...members.map((m) => m.p.dist * m.along));
      if (top > 2.2) for (const m of members) m.p.dist *= 2.2 / top; // keep the whole diagram on screen
    }
  }

  // Realistic surface: procedural PCB print, brushed metal, rubber grain, knurled wheels, screen glass.
  dressMaterial(mat, a, c, size) {
    const tile = 1.4, big = Math.max(...size);
    const rep = (t, k = tile) => tiled(t, Math.max(size[0], size[1]) / k, Math.max(size[2], size[1]) / k);
    const flat = ["plate", "box", "rounded_box"].includes(a.shape);
    if (a.material === "pcb" || (c.type === "controller" && flat && size[1] < 0.4 * Math.min(size[0], size[2]))) {
      mat.map = tiled(pcbTexture(a.color, hashStr(a.componentId) % 97 + 1), Math.max(1, big / 4), Math.max(1, big / 4));
      mat.color.set(0xffffff); mat.roughness = 0.5; mat.clearcoat = 0.4; mat.clearcoatRoughness = 0.35;
      return true;
    } else if (a.material === "metal" || a.material === "aluminum") {
      const b = rep(brushedTexture(), 2.5); mat.roughnessMap = b; mat.bumpMap = b; mat.bumpScale = 0.4;
    } else if (a.material === "rubber") {
      mat.bumpMap = rep(grainTexture(2), 0.8); mat.bumpScale = 1.2;
    } else if (a.material === "screen") {
      mat.map = screenTexture(); mat.color.set(0xffffff); mat.emissive.set(0x0b1422); mat.emissiveIntensity = 0.6;
    } else if (a.material === "fabric") {
      mat.bumpMap = rep(weaveTexture(), 0.6); mat.bumpScale = 1.5;
    } else if (a.material !== "glass") {
      mat.bumpMap = rep(grainTexture(0.6), 0.5); mat.bumpScale = 0.25; // fine moulded-plastic texture
    }
    if (c.type === "wheel" || a.shape === "torus") { mat.bumpMap = tiled(knurlTexture(), 1, 1); mat.bumpScale = 2.5; }
    return false;
  }

  // Parts the AI left plain get believable internals: chips on boards, caps on batteries.
  addAutoDetails(details) {
    const per = {}; for (const d of details) per[d.parentId] = (per[d.parentId] || 0) + 1;
    const metal = new THREE.MeshPhysicalMaterial({ color: 0xc9ccd2, metalness: 0.9, roughness: 0.25 });
    for (const p of this.parts) {
      if (p.conformed || (per[p.id] || 0) >= 4) continue;
      const [x, y, z] = p.size, r = (() => { let h = hashStr(p.id); return () => ((h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0) / 4294967296); })();
      const add = (geom, mat, px, py, pz, ry = 0) => {
        const m = new THREE.Mesh(geom, mat); m.position.set(px, py, pz); m.rotation.y = ry; m.castShadow = true;
        m.userData.partId = p.id; p.group.add(m); p.pickables.push(m); if (!p.extras.includes(mat)) p.extras.push(mat);
      };
      const board = p.isBoard && y < 0.4 * Math.min(x, z);
      if (board) {
        const top = y / 2, chip = new THREE.MeshPhysicalMaterial({ color: 0x16181c, roughness: 0.45, clearcoat: 0.3 });
        const cw = Math.min(x, z) * 0.3, ch = Math.max(0.03, Math.min(cw * 0.18, 0.12));
        add(new RoundedBoxGeometry(cw, ch, cw, 2, ch * 0.3), chip, x * 0.12, top + ch / 2, -z * 0.08);
        for (let i = 0; i < 8; i++) { // gull-wing pins
          const off = -cw / 2 + cw * (i + 0.5) / 8;
          add(new THREE.BoxGeometry(cw * 0.04, ch * 0.3, cw * 0.18), metal, x * 0.12 + off, top + ch * 0.15, -z * 0.08 + cw / 2 + cw * 0.06);
          add(new THREE.BoxGeometry(cw * 0.04, ch * 0.3, cw * 0.18), metal, x * 0.12 + off, top + ch * 0.15, -z * 0.08 - cw / 2 - cw * 0.06);
        }
        const smd = [new THREE.MeshPhysicalMaterial({ color: 0x2a2a2a, roughness: 0.5 }), new THREE.MeshPhysicalMaterial({ color: 0xb48a52, roughness: 0.4 })];
        for (let i = 0; i < 9; i++) {
          const w = Math.min(x, z) * (0.04 + r() * 0.05);
          add(new RoundedBoxGeometry(w, ch * 0.5, w * 0.55, 1, w * 0.1), smd[i % 2], (r() - 0.5) * x * 0.8, top + ch * 0.25, (r() - 0.5) * z * 0.8, r() * Math.PI);
        }
        const cr = Math.min(x, z) * 0.05; // crystal / electrolytic cap
        add(new THREE.CylinderGeometry(cr, cr, cr * 2.2, 24), metal, -x * 0.28, top + cr * 1.1, z * 0.22);
      }
      if (p.type === "power_source" && (p.shape === "cylinder" || p.shape === "capsule")) {
        const rad = Math.min(x, z) / 2;
        add(new THREE.CylinderGeometry(rad * 0.32, rad * 0.32, y * 0.05, 24), metal, 0, y / 2 + y * 0.025, 0); // + terminal
        add(new THREE.CylinderGeometry(rad * 1.005, rad * 1.005, y * 0.06, 40), metal, 0, y / 2 - y * 0.03, 0);
        add(new THREE.CylinderGeometry(rad * 1.005, rad * 1.005, y * 0.04, 40), metal, 0, -y / 2 + y * 0.02, 0);
      }
    }
  }

  // Thin flat parts (labels, switches, badges, panels) are wrapped onto the surface they sit on, like a sticker:
  // every vertex of a fine grid is ray-cast onto the host part, so a label hugs a round bottle and a switch
  // sits on a curved casing instead of floating as a flat card.
  wrapStickers() {
    for (const p of this.parts) { p.group.position.copy(p.base); p.group.updateMatrixWorld(true); }
    const solids = this.parts.filter((q) => !q.sheetCandidate);
    const ray = new THREE.Raycaster();
    for (const p of this.parts) {
      if (!p.sheetCandidate) continue;
      const q = p.group.quaternion, t = p.thinAxis, axes = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
      const n = axes[t].clone().applyQuaternion(q).normalize();
      const [ia, ib] = [0, 1, 2].filter((i) => i !== t), U = axes[ia].clone().applyQuaternion(q), V = axes[ib].clone().applyQuaternion(q);
      const c = p.group.position.clone(), w = p.size[ia], h = p.size[ib], th = p.size[t], reach = Math.max(w, h) * 1.2 + th * 4;
      // which side is the host on? the closer surface hit along -n or +n
      let best = null;
      for (const sgn of [1, -1]) {
        ray.set(c.clone().addScaledVector(n, sgn * reach), n.clone().multiplyScalar(-sgn)); ray.far = reach * 2;
        const hit = ray.intersectObjects(solids.map((s) => s.mesh), false).find((x) => x.object !== p.mesh);
        if (hit) { const d = Math.abs(hit.point.clone().sub(c).dot(n)); if (!best || d < best.d) best = { d, out: n.clone().multiplyScalar(sgn), host: hit.object }; }
      }
      if (!best || best.d > Math.max(w, h)) continue; // nothing close enough underneath: leave it as modelled
      const N = 18, g = new THREE.PlaneGeometry(1, 1, N, N), P = g.attributes.position;
      let ok = 0;
      for (let i = 0; i < P.count; i++) {
        const u = P.getX(i) * w, v = P.getY(i) * h;
        const world = c.clone().addScaledVector(U, u).addScaledVector(V, v);
        ray.set(world.clone().addScaledVector(best.out, reach), best.out.clone().negate()); ray.far = reach * 2.2;
        const hit = ray.intersectObject(best.host, false)[0];
        const pt = hit ? (ok++, hit.point.clone().addScaledVector(best.out, Math.max(0.006, th * 0.5))) : world;
        pt.sub(c); P.setXYZ(i, pt.x, pt.y, pt.z);
      }
      if (ok < P.count * 0.6) continue; // mostly off the host: keep the original shape
      g.computeVertexNormals();
      p.mesh.geometry.dispose(); p.mesh.geometry = g; p.mat.side = THREE.DoubleSide;
      p.edges.geometry.dispose(); p.edges.geometry = new THREE.EdgesGeometry(g, 40);
      p.group.quaternion.identity(); p.baseQuat = new THREE.Quaternion(); p.conformed = true; p.sheet = true;
      g.computeBoundingBox(); p.localCenter = g.boundingBox.getCenter(new THREE.Vector3());
      p.label.position.set(p.localCenter.x, g.boundingBox.max.y + 0.12, p.localCenter.z);
      p.group.updateMatrixWorld(true);
    }
  }

  // Lower/side housing that follows the dome: an oval wall from y0 to y1 (full footprint below the dome's
  // base, the dome's own curve above it) with a closed bottom. Built in world space, returned part-local.
  bandGeometry(d, { y0, y1 }, pos, seg = 96, rings = 18) {
    const r = (y) => (y <= d.baseY ? 1 : Math.sqrt(Math.max(0, 1 - ((y - d.baseY) / d.h) ** 2)));
    const vs = [], idx = [];
    for (let j = 0; j <= rings; j++) {
      const y = y0 + (y1 - y0) * (j / rings), f = r(y) * 1.004;
      for (let i = 0; i <= seg; i++) { const t = (i / seg) * Math.PI * 2; vs.push(d.cx + d.ax * f * Math.cos(t) - pos[0], y - pos[1], d.cz + d.az * f * Math.sin(t) - pos[2]); }
    }
    for (let j = 0; j < rings; j++) for (let i = 0; i < seg; i++) {
      const a = j * (seg + 1) + i, b = a + seg + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
    const c0 = vs.length / 3; vs.push(d.cx - pos[0], y0 - pos[1], d.cz - pos[2]); // bottom cap
    for (let i = 0; i < seg; i++) idx.push(c0, i + 1, i);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(vs, 3)); g.setIndex(idx);
    const uv = [];
    for (let j = 0; j <= rings; j++) for (let i = 0; i <= seg; i++) uv.push((i / seg) * 4, j / rings);
    uv.push(0.5, 0.5); g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    g.computeVertexNormals(); return g;
  }

  // Dome trimmed so it starts at fraction f of its height (sits exactly on a band below it).
  cutDome([x, y, z], f) {
    const theta = Math.acos(Math.max(0, Math.min(0.92, f)));
    const g = new THREE.SphereGeometry(0.5, 64, 32, 0, Math.PI * 2, 0, theta);
    g.scale(x, y * 2, z); g.translate(0, -y / 2, 0); g.computeVertexNormals(); return g;
  }

  // Small surface features (screws, vents, ports, LEDs, labels...). Each is snapped onto its parent's
  // surface with a ray from the parent's centre, oriented to the surface, and moves with the parent.
  addDetails(details, k, ctr) {
    const byId = Object.fromEntries(this.parts.map((p) => [p.id, p]));
    for (const p of this.parts) { p.group.position.copy(p.base); p.group.updateMatrixWorld(true); }
    const ray = new THREE.Raycaster(), Y = new THREE.Vector3(0, 1, 0);
    for (const d of details) {
      const p = byId[d.parentId]; if (!p) continue;
      const size = d.size.map((v) => Math.max(0.008, v * k));
      // flat details are built thin along y and then laid on the surface: move their thinnest side to y
      if (["box", "rounded_box", "plate", "cross", "slots"].includes(d.shape)) {
        const t = size.indexOf(Math.min(...size));
        if (t !== 1) [size[1], size[t]] = [size[t], size[1]];
      }
      const obj = this.detailObject(d, size);
      const want = new THREE.Vector3(...d.position.map((v) => v * k)).sub(ctr);
      const centre = new THREE.Box3().setFromObject(p.mesh).getCenter(new THREE.Vector3());
      const out = want.clone().sub(centre);
      let placed = false;
      if (out.lengthSq() > 1e-6) {
        out.normalize();
        ray.set(centre.clone().addScaledVector(out, 50), out.clone().negate());
        const hit = ray.intersectObject(p.mesh, false)[0];
        if (hit && hit.face) {
          const n = hit.face.normal.clone().transformDirection(p.mesh.matrixWorld);
          if (n.dot(out) < 0) n.negate();
          // slide along the surface towards the requested spot, then sit just proud of it
          obj.position.copy(hit.point).addScaledVector(n, size[1] * 0.45);
          obj.quaternion.setFromUnitVectors(Y, n).multiply(new THREE.Quaternion().setFromAxisAngle(Y, THREE.MathUtils.degToRad(d.rotation[1] || 0)));
          placed = true;
        }
      }
      if (!placed) { obj.position.copy(want); obj.rotation.set(...d.rotation.map((r) => THREE.MathUtils.degToRad(r))); }
      this.root.add(obj); p.group.attach(obj); // keep world pose, then follow the parent
      obj.traverse((o) => { o.userData.partId = p.id; if (o.isMesh) { p.pickables.push(o); if (o.material) p.extras.push(o.material); } });
    }
  }

  detailObject(d, size) {
    const mp = MATERIALS[d.material] || MATERIALS.plastic;
    const mat = new THREE.MeshPhysicalMaterial({ color: new THREE.Color(d.color), ...mp });
    const g = new THREE.Group();
    const add = (geom, x = 0, z = 0) => { const m = new THREE.Mesh(geom, mat); m.position.set(x, 0, z); m.castShadow = true; g.add(m); };
    const [x, y, z] = size;
    if (d.shape === "cross") {
      add(new RoundedBoxGeometry(x, y, z * 0.34, 2, Math.min(y, z * 0.34) * 0.3));
      add(new RoundedBoxGeometry(x * 0.34, y, z, 2, Math.min(y, x * 0.34) * 0.3));
    } else if (d.shape === "slots") {
      const n = Math.max(1, Math.min(24, d.count || 1)), pitch = x / n, w = pitch * 0.5;
      mat.color.multiplyScalar(0.55);
      for (let i = 0; i < n; i++) add(new RoundedBoxGeometry(w, y, z, 2, Math.min(w, y) * 0.45), -x / 2 + pitch * (i + 0.5));
    } else {
      add(geometryFor(d.shape, size));
    }
    return g;
  }

  // Print each visible part's photo cut-out onto the faces that look towards that photo's camera.
  async addDecals(views) {
    const AXES = { top: [0, 1, 0], bottom: [0, -1, 0], back: [0, 0, -1], left: [-1, 0, 0], right: [1, 0, 0] };
    const byId = Object.fromEntries(this.parts.map((p) => [p.id, p]));
    const load = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
    for (const v of views || []) {
      const axisW = new THREE.Vector3(...(AXES[v.view] || [0, 0, 1]));
      for (const l of v.layers || []) {
        const p = byId[l.componentId];
        if (!p || p.decal || !l.cutout) continue;
        if (p.sheet && !p.printable) continue; // switches/panels keep a clean solid colour
        if (p.sheet) { // label-like stickers print the photo of the part directly (plane UVs map onto the cut-out)
          let im; try { im = await load(l.cutout); } catch { continue; }
          if (!this.parts.includes(p)) return;
          const tex = new THREE.Texture(im); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8; tex.needsUpdate = true;
          p.mat.map = tex; p.mat.alphaTest = 0.35; p.mat.color.set(0xffffff); p.mat.bumpMap = null; p.mat.needsUpdate = true; p.decal = true; this.poke(); continue;
        }
        // photos only print well on flat faces: curved/conformed shells get their sampled colour instead
        if (p.conformed || !["box", "rounded_box", "plate"].includes(p.shape)) continue;
        let img; try { img = await load(l.cutout); } catch { continue; }
        if (!this.parts.includes(p)) return; // a newer build replaced this one
        const geom = this.decalGeometry(p, axisW, v.view, img.width / Math.max(1, img.height));
        if (!geom) continue;
        const tex = new THREE.Texture(img); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8; tex.needsUpdate = true;
        const mat = new THREE.MeshPhysicalMaterial({ map: tex, transparent: true, alphaTest: 0.3, roughness: p.mat.roughness,
          metalness: p.mat.metalness, clearcoat: p.mat.clearcoat, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
          side: THREE.DoubleSide, envMapIntensity: p.mat.envMapIntensity });
        const m = new THREE.Mesh(geom, mat); m.userData.partId = p.id; m.renderOrder = 1;
        p.mesh.add(m); p.decal = m; p.extras.push(mat); p.pickables.push(m); this.poke();
      }
    }
  }

  decalGeometry(p, axisW, view, imgAspect = 1) {
    // work in the mesh's local frame
    const inv = new THREE.Quaternion().copy(p.group.quaternion).invert();
    const axis = axisW.clone().applyQuaternion(inv).normalize();
    // image axes for that camera: u = image right, v = image up
    const ref = Math.abs(axisW.y) > 0.5 ? (axisW.y > 0 ? [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, -1)] : [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1)])
      : [new THREE.Vector3(0, 1, 0).cross(axisW).negate().normalize(), new THREE.Vector3(0, 1, 0)];
    const U = ref[0].applyQuaternion(inv), V = ref[1].applyQuaternion(inv);
    const src = p.mesh.geometry.index ? p.mesh.geometry.toNonIndexed() : p.mesh.geometry.clone();
    const P = src.attributes.position, N = src.attributes.normal;
    const keep = [], a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
    for (let i = 0; i < P.count; i += 3) {
      a.fromBufferAttribute(P, i); b.fromBufferAttribute(P, i + 1); c.fromBufferAttribute(P, i + 2);
      n.subVectors(c, b).cross(new THREE.Vector3().subVectors(a, b)).normalize();
      if (N) { n.fromBufferAttribute(N, i).add(new THREE.Vector3().fromBufferAttribute(N, i + 1)).add(new THREE.Vector3().fromBufferAttribute(N, i + 2)).normalize(); }
      if (n.dot(axis) > 0.25) keep.push(i);
    }
    if (!keep.length) return null;
    const pos = new Float32Array(keep.length * 9), nor = new Float32Array(keep.length * 9), uv = new Float32Array(keep.length * 6);
    let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
    for (const i of keep) for (let j = 0; j < 3; j++) {
      a.fromBufferAttribute(P, i + j); const u = a.dot(U), w = a.dot(V);
      uMin = Math.min(uMin, u); uMax = Math.max(uMax, u); vMin = Math.min(vMin, w); vMax = Math.max(vMax, w);
    }
    // the face the photo lands on must have roughly the cut-out's proportions, or the print looks smeared
    const faceAspect = (uMax - uMin) / Math.max(1e-6, vMax - vMin), mis = faceAspect / imgAspect;
    if (mis > 1.8 || mis < 1 / 1.8) return null;
    keep.forEach((i, t) => {
      for (let j = 0; j < 3; j++) {
        a.fromBufferAttribute(P, i + j);
        pos.set([a.x, a.y, a.z], (t * 3 + j) * 3);
        if (N) { n.fromBufferAttribute(N, i + j); nor.set([n.x, n.y, n.z], (t * 3 + j) * 3); }
        uv.set([(a.dot(U) - uMin) / Math.max(1e-6, uMax - uMin), (a.dot(V) - vMin) / Math.max(1e-6, vMax - vMin)], (t * 3 + j) * 2);
      }
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    if (N) g.setAttribute("normal", new THREE.BufferAttribute(nor, 3)); else g.computeVertexNormals();
    return g;
  }

  // Hand-moved parts belong to the explode level they were moved at: sliding back to "assembled"
  // glides them home, exploding again brings them back where you left them.
  pullScale(p) { return p.dragT > 1e-4 ? Math.min(1, this.explode / p.dragT) : 1; }

  applyPose() {
    this.poke();
    const t = this.explode, reach = TARGET_SIZE * 0.8, I = new THREE.Quaternion();
    for (const p of this.parts) {
      if (p.moved && p.dragT < 0.02 && t > p.dragT) p.dragT = t; // moved while assembled: tie it to this explode
      const s = this.pullScale(p);
      p.group.position.copy(p.base).addScaledVector(p.dir, t * p.dist * reach).addScaledVector(p.offset, s).add(p.fx.offset);
      p.group.quaternion.copy(p.fx.quat).multiply(I.clone().slerp(p.userQuat, s)).multiply(p.baseQuat);
      p.group.scale.setScalar(p.fx.scale * (p.fit || 1));
    }
    this.poseVersion = (this.poseVersion || 0) + 1;
  }

  setExplode(t) {
    this.explode = t;
    this.applyPose();
    // floor sits just under the lowest part
    let minY = Infinity;
    for (const p of this.parts) { if (!p.group.visible) continue; p.group.updateMatrixWorld(true); minY = Math.min(minY, new THREE.Box3().setFromObject(p.mesh).min.y); }
    this.floor.position.y = (isFinite(minY) ? minY : -3) - 0.02;
    this.grid.position.y = this.floor.position.y - 0.005;
    this.lights.children[0].target.position.set(0, this.floor.position.y, 0);
    for (const p of this.parts) p.label.visible = t > 0.25 || p.highlight;
  }

  frame(t = 0.75) { // elevated three-quarter view that fits the parts when exploded to t
    const reach = TARGET_SIZE * 0.8, box = new THREE.Box3(), v = new THREE.Vector3();
    for (const p of this.parts) {
      if (!p.mesh.geometry.boundingSphere) p.mesh.geometry.computeBoundingSphere();
      const r = p.mesh.geometry.boundingSphere.radius;
      v.copy(p.base).addScaledVector(p.dir, t * p.dist * reach);
      box.expandByPoint(v.clone().addScalar(r)); box.expandByPoint(v.clone().addScalar(-r));
    }
    if (box.isEmpty()) box.set(new THREE.Vector3(-3, -3, -3), new THREE.Vector3(3, 3, 3));
    const ctr = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
    const fit = Math.max(size.x, size.y, size.z);
    ctr.y -= fit * 0.08; // the control bar covers the bottom of the stage, so sit the model a bit higher
    const vfov = THREE.MathUtils.degToRad(this.camera.fov);
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * this.camera.aspect);
    const d = (fit / 2) / Math.tan(Math.min(vfov, hfov) / 2) * 1.25 + fit * 0.15; // fits short and narrow windows
    // look across the main explode axis so the gaps between parts are visible
    const axis = [0, 0, 0];
    for (const p of this.parts) { axis[0] += Math.abs(p.dir.x) * p.dist; axis[1] += Math.abs(p.dir.y) * p.dist; axis[2] += Math.abs(p.dir.z) * p.dist; }
    const main = axis.indexOf(Math.max(...axis));
    const [az, el] = main === 2 ? [0.68, 0.3] : main === 0 ? [0.3, 0.35] : [0.75, 0.3];
    this.camera.position.set(ctr.x + d * Math.sin(az) * Math.cos(el), ctr.y + d * Math.sin(el), ctr.z + d * Math.cos(az) * Math.cos(el));
    this.controls.target.copy(ctr); this.controls.update();
    this.fog.near = d * 1.6; this.fog.far = d * 4.5; // fog only fades the far floor, never the model
  }

  // ---------------------------------------------------------------- hands-on: move / turn / focus parts
  beginDrag(id, raycaster, kind, x, y) {
    const p = this.parts.find((q) => q.id === id); if (!p) return null;
    const hit = raycaster.intersectObjects(p.pickables, false)[0]; if (!hit) return null;
    const normal = this.camera.getWorldDirection(new THREE.Vector3());
    const s = this.pullScale(p); // start from what is on screen, then tie the pose to the current explode level
    p.offset.multiplyScalar(s); p.userQuat.copy(new THREE.Quaternion().slerp(p.userQuat, s)); p.dragT = this.explode;
    return { p, kind, x, y, start: hit.point.clone(), plane: new THREE.Plane().setFromNormalAndCoplanarPoint(normal, hit.point),
      offset0: p.offset.clone(), quat0: p.userQuat.clone() };
  }

  dragTo(d, raycaster, x, y) {
    if (d.kind === "rotate") { // turn the part around the camera's up/right axes
      const up = this.camera.up.clone().applyQuaternion(this.camera.quaternion).normalize();
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion).normalize();
      const q = new THREE.Quaternion().setFromAxisAngle(up, (x - d.x) * 0.01)
        .multiply(new THREE.Quaternion().setFromAxisAngle(right, (y - d.y) * 0.01));
      d.p.userQuat.copy(q).multiply(d.quat0);
    } else {
      const pt = raycaster.ray.intersectPlane(d.plane, new THREE.Vector3());
      if (pt) d.p.offset.copy(d.offset0).add(pt.sub(d.start));
    }
    d.p.moved = d.p.offset.lengthSq() > 1e-6 || d.p.userQuat.angleTo(new THREE.Quaternion()) > 1e-3;
    this.setExplode(this.explode);
  }

  anyMoved() { return this.parts.some((p) => p.moved); }

  // Pointing at a part, its callout or its row in the list lights up all three.
  setHover(id, source = "") {
    if (this.hoverId === id) return;
    this.hoverId = id;
    this._leaders?.classList.toggle("focus", !!id);
    if (this.lastPaint) this.paint(this.lastPaint); else this.poke();
    this.onHover?.(id, source);
  }

  // "Bring forward" / "Send back": slide the part towards or away from the viewer, animated.
  nudge(id, dir, ms = 260) {
    const p = this.parts.find((q) => q.id === id); if (!p) return false;
    const s = this.pullScale(p); p.offset.multiplyScalar(s); p.userQuat.copy(new THREE.Quaternion().slerp(p.userQuat, s)); p.dragT = this.explode;
    const toCam = this.camera.position.clone().sub(this.centerOf(p)).normalize();
    const step = Math.max(0.35, TARGET_SIZE * 0.09) * dir, from = p.offset.clone(), to = from.clone().addScaledVector(toCam, step), t0 = performance.now();
    const tick = (now) => {
      const k = Math.min(1, (now - t0) / ms); p.offset.lerpVectors(from, to, easeOut(k));
      p.moved = true; this.setExplode(this.explode);
      if (k < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return true;
  }

  resetParts(ms = 500) { // glide every part back into place
    const from = this.parts.map((p) => ({ p, o: p.offset.clone(), q: p.userQuat.clone() })), t0 = performance.now(), I = new THREE.Quaternion();
    const tick = (now) => {
      const k = Math.min(1, (now - t0) / ms), e = 1 - Math.pow(1 - k, 3);
      for (const f of from) { f.p.offset.copy(f.o).multiplyScalar(1 - e); f.p.userQuat.copy(f.q).slerp(I, e); if (k === 1) { f.p.moved = false; f.p.dragT = 0; } }
      this.setExplode(this.explode);
      if (k < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  focus(id, ms = 600) { // fly the camera to one part
    const p = this.parts.find((q) => q.id === id); if (!p) return;
    const box = new THREE.Box3(); for (const o of p.pickables) box.expandByObject(o);
    const ctr = box.getCenter(new THREE.Vector3()), r = Math.max(0.4, box.getSize(new THREE.Vector3()).length() / 2);
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    const vfov = THREE.MathUtils.degToRad(this.camera.fov);
    const toPos = ctr.clone().addScaledVector(dir, (r / Math.sin(vfov / 2)) * 1.25);
    const fromPos = this.camera.position.clone(), fromT = this.controls.target.clone(), t0 = performance.now();
    const tick = (now) => {
      const k = Math.min(1, (now - t0) / ms), e = 1 - Math.pow(1 - k, 3);
      this.camera.position.lerpVectors(fromPos, toPos, e); this.controls.target.lerpVectors(fromT, ctr, e); this.controls.update();
      if (k < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  pick(raycaster) {
    const hits = raycaster.intersectObjects(this.parts.filter((p) => p.group.visible).flatMap((p) => p.pickables), false);
    return hits.length ? hits[0].object.userData.partId : null;
  }

  paint(args) {
    this.lastPaint = args;
    if (this.intro) return; // the materialise intro owns the materials; it re-applies this when done
    const { selected, isolate, related } = args;
    const affected = this.whatif ? new Set() : args.affected, removed = this.whatif ? null : args.removed;
    const xr = this.xray;
    for (const p of this.parts) {
      if (!this.whatif) p.group.visible = p.id !== removed;
      const dim = (isolate && selected && p.id !== selected && !related.has(p.id)) || (xr && p.id !== selected);
      const hov = p.id === this.hoverId && p.id !== selected;
      const glow = p.id === selected ? 0x2a6df4 : affected.has(p.id) ? 0xff5040 : hov ? 0x1b8fd0 : 0x000000;
      p.mat.emissive.setHex(glow); p.mat.emissiveIntensity = glow ? (hov ? 0.4 : 0.55) : 0;
      p.label.element.classList.toggle("hov", p.id === this.hoverId);
      const baseOpacity = p.mat.userData.baseOpacity ??= p.mat.opacity;
      const dimOp = xr ? 0.16 : 0.1;
      p.mat.transparent = dim || baseOpacity < 1; p.mat.opacity = dim ? dimOp : baseOpacity; p.mat.depthWrite = !dim;
      p.edges.material.color.copy(xr ? new THREE.Color(0x7fdcff) : p.edgeColor);
      p.edges.material.opacity = xr ? (p.id === selected ? 0.9 : 0.45) : dim ? 0.05 : p.baseEdgeOpacity;
      for (const m of p.extras) { m.transparent = true; m.opacity = dim ? dimOp * 0.8 : 1; m.depthWrite = !dim; m.needsUpdate = true; }
      p.highlight = p.id === selected || affected.has(p.id);
      p.label.element.classList.toggle("sel", p.id === selected);
      p.label.element.classList.toggle("hit", affected.has(p.id));
      p.mat.needsUpdate = true;
    }
    for (const w of this.wires || []) { // wires of the selected part stand out
      const on = !selected || w.r.from === selected || w.r.to === selected;
      w.mat.opacity = (w.structural ? 0.45 : 0.8) * (on ? 1 : 0.18);
      for (const sp of w.sprites) sp.material.opacity = on ? 1 : 0.15;
    }
    this.setExplode(this.explode);
  }

  // draws the frame through the bloom composer; returns false when the 3D model view is not active
  renderScene() {
    if (!this.root.visible) return false;
    const now = performance.now();
    this.update(now);
    const c = this.renderer.domElement, w = c.clientWidth, h = c.clientHeight, key = w + "x" + h;
    if (key !== this._size && w && h) { this._size = key; this.composer.setPixelRatio(this.renderer.getPixelRatio()); this.composer.setSize(w, h); }
    if (this.lowQuality) this.renderer.render(this.scene, this.camera); else this.composer.render();
    this.watchSpeed(now);
    return true;
  }

  // Something is moving: keep drawing. When nothing changes the view stops redrawing, so an idle page costs nothing.
  poke() { this._active = performance.now(); }
  busy(now = performance.now()) {
    return !!(this.intro || this.whatif || this.sweep || this.ringT0 || this.xray || this.sparks?.length
      || (this.bloomT0 && now - this.bloomT0 < 1500) || now - (this._active || 0) < 700);
  }

  // Slow computer (integrated graphics): drop the glow pass, soft shadows and extra pixels so the page stays responsive.
  watchSpeed(now) {
    if (this.lowQuality) return;
    const dt = now - (this._lastFrame || now); this._lastFrame = now;
    if (dt <= 0 || dt > 1000) return; // first frame or the tab was in the background
    this._slow = (this._slow || 0) * 0.9 + (dt > 45 ? 1 : 0) * 0.1;
    if ((this._frames = (this._frames || 0) + 1) > 30 && this._slow > 0.6) this.setLowQuality();
  }
  setLowQuality() {
    this.lowQuality = true;
    this.renderer.setPixelRatio(1);
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    const keyL = this.lights.children[0]; if (keyL.shadow) { keyL.shadow.mapSize.set(1024, 1024); keyL.shadow.map?.dispose(); keyL.shadow.map = null; }
    console.info("3D view: lighter rendering for this computer");
  }

  render() {
    if (!this.root.visible) return;
    const r = this.renderer.domElement.getBoundingClientRect();
    this.labels.setSize(r.width, r.height);
    this.labels.render(this.scene, this.camera);
    // CSS2D labels ignore parent visibility: hide labels of parts that are hidden (removed, intro)
    for (const p of this.parts) p.label.element.style.visibility = p.group.visible && p.fx.scale > 0.3 ? "" : "hidden";
    this.layoutCallouts(r.width, r.height);
  }

  // Exploded-diagram callouts: labels sit in two clean columns at the left/right edges of the view,
  // ordered by the height of their part, and a leader line runs from each label to its part.
  // Labels never overlap each other or the part they name.
  layoutCallouts(w, h) {
    const NS = "http://www.w3.org/2000/svg";
    if (!this._leaders) {
      this._leaders = document.createElementNS(NS, "svg");
      this._leaders.setAttribute("class", "leaders3d");
      this.labels.domElement.prepend(this._leaders);
      this._leaderEls = new Map();
    }
    const svg = this._leaders;
    if (this._svgSize !== w + "x" + h) {
      this._svgSize = w + "x" + h;
      svg.setAttribute("width", w); svg.setAttribute("height", h); svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
      this._frameN = 0; // re-measure the overlays after a resize
    }
    // keep the columns clear of the overlays on the stage (view tabs at the top, controls panel at the bottom);
    // measured every 30 frames, not every frame, to keep rendering cheap
    if (!this._clear || (this._frameN = (this._frameN || 0) + 1) % 30 === 1) {
      const stageBox = this.stage.getBoundingClientRect();
      const tabs = this.stage.querySelector(".tabs")?.getBoundingClientRect();
      const ctrl = this.stage.querySelector(".controls")?.getBoundingClientRect();
      this._clear = {
        top: Math.max(16, tabs && tabs.height ? tabs.bottom - stageBox.top + 10 : 60),
        bottom: Math.max(16, ctrl && ctrl.height ? stageBox.bottom - ctrl.top + 10 : 76),
      };
    }
    const TOP = this._clear.top, BOTTOM = this._clear.bottom, SIDE = 16, GAP = 6, ELBOW = 18;
    const v = new THREE.Vector3(), items = [], live = new Set();
    for (const p of this.parts) {
      const e = p.label.element;
      if (!p.label.visible || !p.group.visible || p.fx.scale <= 0.3 || e.style.display === "none") continue;
      v.copy(this.centerOf(p)).project(this.camera);
      if (v.z > 1) { e.style.visibility = "hidden"; continue; } // behind the camera
      if (!p._lw) { p._lw = e.offsetWidth; p._lh = e.offsetHeight; } // label size is measured once
      items.push({ p, e, ax: (v.x + 1) / 2 * w, ay: (1 - v.y) / 2 * h, lw: p._lw, lh: p._lh });
    }
    if (items.length) {
      // split around the model's on-screen centre, then balance so neither column is overloaded
      const cx = items.reduce((sum, i) => sum + i.ax, 0) / items.length;
      const left = items.filter((i) => i.ax < cx), right = items.filter((i) => i.ax >= cx);
      const move = (from, to, pick) => { from.sort(pick); to.push(from.shift()); };
      while (left.length - right.length > 1) move(left, right, (a, b) => b.ax - a.ax);
      while (right.length - left.length > 1) move(right, left, (a, b) => a.ax - b.ax);
      // columns hug the model (a short gap from its outermost anchor) instead of the screen edges, so leader lines stay short
      const GUTTER = 56, minAx = Math.min(...items.map((i) => i.ax)), maxAx = Math.max(...items.map((i) => i.ax));
      const maxLwL = Math.max(0, ...left.map((i) => i.lw)), maxLwR = Math.max(0, ...right.map((i) => i.lw));
      const colRightL = Math.max(SIDE + maxLwL, minAx - GUTTER), colLeftR = Math.min(w - SIDE - maxLwR, maxAx + GUTTER);
      for (const [col, side] of [[left, "L"], [right, "R"]]) {
        const row = (i) => Math.round(i.ay / 14); // same row: the lower label goes to the part farther away, so lines never cross
        col.sort((a, b) => row(a) - row(b) || (side === "L" ? a.ax - b.ax : b.ax - a.ax));
        let y = TOP; // top-down: as close to the part's height as possible, no overlap
        for (const i of col) { i.y = Math.max(i.ay - i.lh / 2, y); y = i.y + i.lh + GAP; }
        let limit = h - BOTTOM; // bottom-up: pull back inside the free area if the column overflows
        for (let k = col.length - 1; k >= 0; k--) { col[k].y = Math.max(TOP, Math.min(col[k].y, limit - col[k].lh)); limit = col[k].y - GAP; }
        for (const i of col) {
          i.x = side === "L" ? colRightL - i.lw : colLeftR;
          i.e.style.transform = `translate(${Math.round(i.x)}px, ${Math.round(i.y)}px)`;
          const sx = side === "L" ? i.x + i.lw : i.x, sy = i.y + i.lh / 2, ex = sx + (side === "L" ? ELBOW : -ELBOW);
          let g = this._leaderEls.get(i.p.id);
          if (!g) {
            g = document.createElementNS(NS, "g");
            g.append(document.createElementNS(NS, "path"), document.createElementNS(NS, "circle"));
            g.lastChild.setAttribute("r", "3");
            svg.append(g); this._leaderEls.set(i.p.id, g);
          }
          const cls = "leader" + (i.p.inferred ? " inf" : "") + (i.e.classList.contains("sel") ? " sel" : "") + (i.e.classList.contains("hit") ? " hit" : "")
            + (i.p.id === this.hoverId ? " hov" : "");
          if (g.getAttribute("class") !== cls) g.setAttribute("class", cls); // unchanged class keeps the draw-in animation from restarting
          g.firstChild.setAttribute("d", `M${sx.toFixed(1)},${sy.toFixed(1)} L${ex.toFixed(1)},${sy.toFixed(1)} L${i.ax.toFixed(1)},${i.ay.toFixed(1)}`);
          g.lastChild.setAttribute("cx", i.ax.toFixed(1)); g.lastChild.setAttribute("cy", i.ay.toFixed(1));
          g.style.display = ""; live.add(i.p.id);
        }
      }
    }
    for (const [id, g] of this._leaderEls) if (!live.has(id)) g.style.display = "none";
  }

  // ---------------------------------------------------------------- wiring x-ray: the relationship graph, in 3D
  centerOf(p) { return p.group.localToWorld(p.localCenter.clone()); }

  buildWires(relationships) {
    if (this.wireGroup) { this.wireGroup.traverse((o) => o.geometry?.dispose()); this.root.remove(this.wireGroup); }
    this.wireGroup = new THREE.Group(); this.wireGroup.visible = !!this.xray; this.root.add(this.wireGroup);
    const byId = Object.fromEntries(this.parts.map((p) => [p.id, p]));
    const glow = glowSprite();
    this.wires = relationships.filter((r) => byId[r.from] && byId[r.to]).map((r, i) => {
      const structural = !(r.type in FLOW_SPEED);
      const base = new THREE.Color(WIRE[r.type] ?? 0x6b7a90);
      const mat = new THREE.MeshBasicMaterial({ color: base.clone().multiplyScalar(structural ? 1.1 : 2.4), transparent: true,
        opacity: structural ? 0.45 : 0.8, toneMapped: false, depthWrite: false, blending: THREE.AdditiveBlending });
      const mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat); mesh.renderOrder = 5;
      this.wireGroup.add(mesh);
      const sprites = [];
      for (let k = 0; k < (structural ? 0 : 3); k++) {
        const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color: base.clone().multiplyScalar(3), blending: THREE.AdditiveBlending,
          depthWrite: false, toneMapped: false, transparent: true }));
        sp.scale.setScalar(0.2); sp.renderOrder = 6; this.wireGroup.add(sp); sprites.push(sp);
      }
      return { r, a: byId[r.from], b: byId[r.to], mesh, mat, base, sprites, structural, side: (hashStr(r.id) % 5 - 2) * 0.12,
        speed: FLOW_SPEED[r.type] || 0.3, phase: (hashStr(r.id) % 100) / 100, version: -1, curve: null };
    });
  }

  wireCurve(a, b, side = 0) {
    const pa = this.centerOf(a), pb = this.centerOf(b), mid = pa.clone().lerp(pb, 0.5);
    const len = pa.distanceTo(pb), perp = new THREE.Vector3().subVectors(pb, pa).cross(new THREE.Vector3(0, 1, 0));
    if (perp.lengthSq() < 1e-6) perp.set(1, 0, 0);
    mid.y += len * 0.28 + 0.2; mid.addScaledVector(perp.normalize(), side * len);
    return new THREE.QuadraticBezierCurve3(pa, mid, pb);
  }

  setXray(on) { this.xray = on; if (this.wireGroup) this.wireGroup.visible = on; if (this.lastPaint) this.paint(this.lastPaint); }

  updateWires(now) {
    if (!this.xray || !this.wires) return;
    for (const w of this.wires) {
      const vis = w.a.group.visible && w.b.group.visible;
      w.mesh.visible = vis; w.sprites.forEach((sp) => (sp.visible = vis));
      if (!vis) continue;
      if (w.version !== this.poseVersion) {
        w.curve = this.wireCurve(w.a, w.b, w.side); w.version = this.poseVersion;
        w.mesh.geometry.dispose(); w.mesh.geometry = new THREE.TubeGeometry(w.curve, 36, w.structural ? 0.016 : 0.026, 6, false);
      }
      w.sprites.forEach((sp, k) => sp.position.copy(w.curve.getPoint((now / 1000 * w.speed + w.phase + k / w.sprites.length) % 1)));
    }
  }

  // ---------------------------------------------------------------- what-if: a failure cascade you can watch
  static PULSE = 480;
  whatIfDelay(hops) { return 900 + (hops - 1) * 700; }

  playWhatIf(res) {
    this.stopWhatIf(true);
    const byId = Object.fromEntries(this.parts.map((p) => [p.id, p]));
    const removed = byId[res.removedComponentId]; if (!removed) return;
    const floorY = this.floor.position.y, glow = glowSprite();
    const items = res.affected.map((a) => {
      const p = byId[a.componentId]; if (!p) return null;
      const from = byId[a.path[a.path.length - 2]] || removed;
      const bottom = new THREE.Box3().setFromObject(p.mesh).min.y;
      const sev = a.severity || "fails", col = sev === "loose" ? 0xffa020 : 0xff2a1a;
      const pulse = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color: new THREE.Color(col).multiplyScalar(4), blending: THREE.AdditiveBlending,
        depthTest: false, depthWrite: false, toneMapped: false, transparent: true }));
      pulse.scale.setScalar(0.45); pulse.visible = false; pulse.renderOrder = 9; this.root.add(pulse);
      const ax = new THREE.Vector3(Math.random() - 0.5, 0, Math.random() - 0.5).normalize();
      return { p, from, sev, col, at: this.whatIfDelay(a.hops || 1), pulse, orig: p.mat.color.clone(), origEm: p.mat.emissive.clone(),
        drop: Math.max(0.05, Math.min(6, bottom - floorY)), tiltAxis: ax, tilt: 0.35 + Math.random() * 0.45, viaId: (a.viaRelationshipIds || []).slice(-1)[0] };
    }).filter(Boolean);
    const axis = new THREE.Vector3(Math.random(), 1, Math.random()).normalize();
    this.whatif = { t0: performance.now(), removed, axis, items, origEm: removed.mat.emissive.clone() };
    for (const it of items) { // the wires along the failure path turn red
      const w = (this.wires || []).find((x) => x.r.id === it.viaId);
      if (w) it.wire = w;
    }
    if (this.lastPaint) this.paint(this.lastPaint);
  }

  stopWhatIf(instant = false) {
    const W = this.whatif; if (!W) return;
    if (!instant) { if (!W.restoreT0) W.restoreT0 = performance.now(); return; }
    for (const it of W.items) {
      this.root.remove(it.pulse); it.p.mat.color.copy(it.orig); it.p.mat.emissive.copy(it.origEm);
      it.p.fx.offset.set(0, 0, 0); it.p.fx.quat.identity(); it.p.fx.scale = 1;
      if (it.wire) it.wire.mat.color.copy(it.wire.base).multiplyScalar(it.wire.structural ? 1.1 : 2.4);
    }
    const r = W.removed; r.fx.offset.set(0, 0, 0); r.fx.quat.identity(); r.fx.scale = 1; r.group.visible = true; r.mat.emissive.copy(W.origEm);
    this.whatif = null; this.root.position.set(0, 0, 0);
    this.applyPose(); if (this.lastPaint) this.paint(this.lastPaint);
  }

  updateWhatIf(now) {
    const W = this.whatif; if (!W) return;
    const r = W.restoreT0 ? 1 - clamp01((now - W.restoreT0) / 750) : 1;
    // removed part: flash, then fly out spinning and vanish
    const rp = W.removed, k = Math.min(easeInOut(clamp01((now - W.t0) / 1000)), r);
    rp.fx.offset.copy(rp.dir).multiplyScalar(k * k * TARGET_SIZE * 1.5).add(new THREE.Vector3(0, k * 2.5, 0));
    rp.fx.quat.setFromAxisAngle(W.axis, k * Math.PI * 3); rp.fx.scale = Math.max(0.02, 1 - 0.95 * k);
    rp.group.visible = k < 0.97;
    rp.mat.emissive.setHex(0xff3322); rp.mat.emissiveIntensity = 2.2 * (1 - k) * (r < 1 ? 0 : 1);
    const sh = now - W.t0 < 380 && !W.restoreT0 ? 0.06 * (1 - (now - W.t0) / 380) : 0; // impact shake
    this.root.position.set((Math.random() - 0.5) * sh, (Math.random() - 0.5) * sh, (Math.random() - 0.5) * sh);
    for (const it of W.items) {
      const local = now - W.t0 - it.at, P = AssemblyView.PULSE;
      if (local > -P && local < 0 && !W.restoreT0) { // energy pulse travels down the dependency link
        it.pulse.visible = true;
        it.pulse.position.copy(this.wireCurve(it.from, it.p, it.wire ? it.wire.side : 0).getPoint(easeInOut((local + P) / P)));
      } else it.pulse.visible = false;
      if (local < 0) continue;
      if (it.wire) it.wire.mat.color.setHex(it.col).multiplyScalar(1 + 2 * r);
      const flash = Math.exp(-local / 260);
      if (!it.sparked && !W.restoreT0) { this.spark(this.centerOf(it.p), it.col); it.sparked = true; }
      if (it.sev === "fails") { // dies: flash, dark, smouldering red glow, shudder
        it.p.mat.emissive.setHex(0xff2a1a);
        it.p.mat.emissiveIntensity = (1.8 * flash + 0.3 * (0.55 + 0.45 * Math.sin(now / 170))) * r;
        it.p.mat.color.copy(it.orig).lerp(DARK, clamp01(local / 700) * 0.75 * r);
        const d = Math.exp(-local / 380) * r;
        it.p.fx.offset.set(Math.sin(local * 0.09) * 0.08 * d, 0, Math.cos(local * 0.13) * 0.06 * d);
      } else { // comes loose: drops to the floor and tips over
        const kd = bounce(clamp01(local / 1100)) * r;
        it.p.fx.offset.set(0, -it.drop * kd, 0); it.p.fx.quat.setFromAxisAngle(it.tiltAxis, it.tilt * kd);
        it.p.mat.emissive.setHex(0xffa020); it.p.mat.emissiveIntensity = (1.3 * flash + 0.12) * r;
      }
    }
    this.applyPose();
    if (W.restoreT0 && r === 0) this.stopWhatIf(true);
  }

  spark(at, color) { // burst of glowing particles
    const glow = glowSprite();
    for (let i = 0; i < 18; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color: new THREE.Color(color).multiplyScalar(3.5), blending: THREE.AdditiveBlending,
        depthWrite: false, toneMapped: false, transparent: true }));
      s.position.copy(at); s.scale.setScalar(0.12 + Math.random() * 0.1); this.root.add(s);
      const v = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.9 + 0.2, Math.random() - 0.5).normalize().multiplyScalar(2 + Math.random() * 3);
      this.sparks.push({ s, v, t0: performance.now() });
    }
  }

  updateSparks(now, dt) {
    this.sparks = this.sparks.filter((sp) => {
      const age = now - sp.t0;
      if (age > 900) { this.root.remove(sp.s); sp.s.material.dispose(); return false; }
      sp.v.y -= 7 * dt; sp.s.position.addScaledVector(sp.v, dt); sp.s.material.opacity = 1 - age / 900;
      return true;
    });
  }

  // ---------------------------------------------------------------- materialise intro: hologram -> solid -> assembled
  materialize(ms = 2600, onDone = null) {
    const now = performance.now(), n = this.parts.length, step = Math.min(120, 1300 / Math.max(1, n));
    this.intro = { t0: now, ms, onDone, total: ms + step * n, items: this.parts.map((p, i) => ({
      p, delay: i * step, axis: new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize(),
      ang: (Math.random() - 0.5) * 4, from: p.dir.clone().multiplyScalar(TARGET_SIZE * (0.9 + Math.random() * 0.6))
        .add(new THREE.Vector3((Math.random() - 0.5) * 3, Math.random() * 2.5, (Math.random() - 0.5) * 3)),
      // parts that live inside the body stay hidden until the shell is solid: no board or battery showing
      // through a half-built hologram or flying in from outside the object
      inside: this.isInside(p) })) };
    for (const p of this.parts) {
      p.mat.transparent = true; p.mat.opacity = 0; p.mat.depthWrite = false; p.mat.needsUpdate = true;
      for (const m of p.extras) { m.transparent = true; m.opacity = 0; m.needsUpdate = true; }
      p.edges.material.color.setHex(0x6fe3ff).multiplyScalar(3); p.edges.material.toneMapped = false; p.edges.material.opacity = 1;
      p.edges.material.needsUpdate = true; p.group.visible = false;
    }
    if (!this.scanPlane) {
      this.scanPlane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: new THREE.Color(0x36d6ff).multiplyScalar(1.6),
        transparent: true, opacity: 0.18, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
      this.scanPlane.rotation.x = -Math.PI / 2; this.root.add(this.scanPlane);
      this.ring = new THREE.Mesh(new THREE.RingGeometry(0.92, 1, 128), new THREE.MeshBasicMaterial({ color: new THREE.Color(0x6fe3ff).multiplyScalar(3),
        transparent: true, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
      this.ring.rotation.x = -Math.PI / 2; this.ring.visible = false; this.root.add(this.ring);
    }
    const sz = Math.max(this.size.x, this.size.z) * 1.6 + 1; this.scanPlane.scale.set(sz, sz, 1); this.scanPlane.visible = true;
  }

  updateIntro(now) {
    const I = this.intro; if (!I) return;
    for (const it of I.items) {
      const local = (now - I.t0 - it.delay) / (I.ms * 0.6), k = clamp01(local), e = easeOut(k);
      const p = it.p;
      if (it.inside) { p.group.visible = false; p.fx.offset.set(0, 0, 0); p.fx.quat.identity(); continue; }
      p.group.visible = local > 0;
      p.fx.offset.copy(it.from).multiplyScalar(1 - e); p.fx.quat.setFromAxisAngle(it.axis, it.ang * (1 - e));
      const solid = clamp01((k - 0.45) / 0.55);
      p.mat.opacity = solid * (p.mat.userData.baseOpacity ?? 1); for (const m of p.extras) m.opacity = solid;
      p.edges.material.opacity = 1 - 0.55 * solid;
    }
    const g = clamp01((now - I.t0) / I.total), top = this.size.y / 2 + 0.3, bot = this.floor.position.y;
    this.scanPlane.position.y = bot + (top - bot) * easeInOut(g); this.scanPlane.material.opacity = 0.22 * Math.sin(Math.PI * g);
    this.applyPose();
    if (now - I.t0 >= I.total + 150) {
      this.intro = null; this.scanPlane.visible = false;
      for (const p of this.parts) { p.edges.material.toneMapped = true; p.edges.material.color.copy(p.edgeColor); p.mat.depthWrite = true; p.fx.offset.set(0, 0, 0); p.fx.quat.identity(); p.group.visible = true; }
      this.ring.visible = true; this.ring.position.y = this.floor.position.y + 0.01; this.ringT0 = now; this.bloomT0 = now;
      if (this.lastPaint) this.paint(this.lastPaint); else this.applyPose();
      I.onDone?.();
    }
  }

  // camera swoops in from far and low behind the object to the framed view
  cameraSweep(ms = 3200) {
    const to = this.camera.position.clone(), tgt = this.controls.target.clone();
    const sTo = new THREE.Spherical().setFromVector3(to.clone().sub(tgt));
    const sFrom = new THREE.Spherical(sTo.radius * 2.1, Math.min(Math.PI / 2 - 0.05, sTo.phi + 0.35), sTo.theta - 2.2);
    this.sweep = { t0: performance.now(), ms, sFrom, sTo, tgt };
    this.camera.position.setFromSpherical(sFrom).add(tgt);
  }

  updateSweep(now) {
    const S = this.sweep; if (!S) return;
    const k = easeInOut(clamp01((now - S.t0) / S.ms));
    const sp = new THREE.Spherical(S.sFrom.radius + (S.sTo.radius - S.sFrom.radius) * k, S.sFrom.phi + (S.sTo.phi - S.sFrom.phi) * k,
      S.sFrom.theta + (S.sTo.theta - S.sFrom.theta) * k);
    this.camera.position.setFromSpherical(sp).add(S.tgt); this.camera.lookAt(S.tgt);
    if (k >= 1) { this.sweep = null; this.controls.update(); }
  }

  update(now) {
    const dt = Math.min(0.05, (now - (this._last || now)) / 1000); this._last = now;
    this.updateSweep(now); this.updateIntro(now); this.updateWhatIf(now); this.updateSparks(now, dt); this.updateWires(now);
    if (this.ringT0) { // shockwave ring when the object locks together
      const k = clamp01((now - this.ringT0) / 1100);
      this.ring.scale.setScalar(0.5 + easeOut(k) * Math.max(this.size.x, this.size.z) * 2.2); this.ring.material.opacity = 1 - k;
      if (k >= 1) { this.ring.visible = false; this.ringT0 = 0; }
    }
    this.bloom.strength = 0.18 + (this.bloomT0 ? 0.85 * Math.exp(-(now - this.bloomT0) / 380) : 0);
  }
}
