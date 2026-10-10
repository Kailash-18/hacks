// 360-degree exploded 3D model built from the AI's part geometry (simple solids, studio lighting).
// Geometry is an AI estimate from photos: clean and coherent, not a measured CAD model.
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";

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
    this.floor = new THREE.Mesh(new THREE.CircleGeometry(14, 64), new THREE.ShadowMaterial({ opacity: 0.32 }));
    this.floor.rotation.x = -Math.PI / 2; this.floor.receiveShadow = true; this.root.add(this.floor);
    // labels
    this.labels = new CSS2DRenderer(); this.labels.domElement.className = "labels3d"; stage.append(this.labels.domElement);
    this.stage = stage;
  }

  setActive(on) {
    this.root.visible = on; this.labels.domElement.hidden = !on;
    this.stage.classList.toggle("studio", on);
    this.scene.environment = on ? this.env : null;
    this.renderer.shadowMap.enabled = true; this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = on ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping;
    this.renderer.toneMappingExposure = 0.95;
    const c = this.controls;
    if (on) { c.minAzimuthAngle = -Infinity; c.maxAzimuthAngle = Infinity; c.minPolarAngle = 0.05; c.maxPolarAngle = Math.PI - 0.05; c.minDistance = 2; c.maxDistance = 60; }
  }

  build(assembly, components, views = []) {
    for (const p of this.parts) { this.root.remove(p.group); p.label.element.remove(); }
    this.parts = [];
    const comp = Object.fromEntries(components.map((c) => [c.id, c]));
    const [ox, oy, oz] = assembly.overallSize;
    this.scale = TARGET_SIZE / Math.max(ox, oy, oz, 1);
    const k = this.scale;
    // curved shells ("dome") that thin parts and base plates should conform to
    const domes = assembly.parts.filter((a) => a.shape === "dome").map((a) => ({
      cx: a.position[0] * k, cz: a.position[2] * k, ax: (a.size[0] * k) / 2, az: (a.size[2] * k) / 2,
      h: a.size[1] * k, baseY: a.position[1] * k - (a.size[1] * k) / 2 }));
    const domeTop = (d, x, z) => { const q = 1 - ((x - d.cx) / d.ax) ** 2 - ((z - d.cz) / d.az) ** 2; return q > 0 ? d.baseY + d.h * Math.sqrt(q) : null; };
    for (const a of assembly.parts) {
      const c = comp[a.componentId]; if (!c) continue;
      const inferred = c.status !== "observed";
      const size = a.size.map((v) => Math.max(0.02, v * k));
      const pos = a.position.map((v) => v * k);
      let geom = null, conformed = false;
      const thin = size[1] < 0.3 * Math.min(size[0], size[2]);
      const host = a.shape !== "dome" && domes.find((d) => domeTop(d, pos[0], pos[2]) !== null);
      if (host && thin && pos[1] > host.baseY + host.h * 0.3 && ["plate", "box", "rounded_box"].includes(a.shape)) {
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
      } else {
        const d = domes.find((d) => Math.abs((pos[1] + size[1] / 2) - d.baseY) < d.h * 0.35
          && size[0] > d.ax * 1.4 && size[2] > d.az * 1.4 && ["plate", "box", "rounded_box"].includes(a.shape));
        if (d) { // base plate under a curved shell: give it the shell's oval footprint
          geom = new THREE.CylinderGeometry(0.5, 0.5, 1, 64); geom.scale(d.ax * 2, size[1], d.az * 2);
          geom.translate(d.cx - pos[0], 0, d.cz - pos[2]); conformed = true;
        }
      }
      geom = geom || geometryFor(a.shape, size);
      const mp = MATERIALS[a.material] || MATERIALS.plastic;
      const mat = new THREE.MeshPhysicalMaterial({ color: new THREE.Color(a.color), envMapIntensity: 1.0, ...mp,
        side: a.shape === "dome" || conformed ? THREE.DoubleSide : THREE.FrontSide });
      const mesh = new THREE.Mesh(geom, mat); mesh.castShadow = true; mesh.receiveShadow = true;
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geom, 28),
        new THREE.LineBasicMaterial({ color: inferred ? 0xf2b84b : 0x0b0d12, transparent: true, opacity: inferred ? 0.85 : 0.28 }));
      const group = new THREE.Group(); group.add(mesh, edges);
      if (!conformed) group.rotation.set(...a.rotation.map((d) => THREE.MathUtils.degToRad(d)));
      group.traverse((o) => (o.userData.partId = a.componentId));
      const div = document.createElement("div"); div.className = "lbl" + (inferred ? " inferred" : "");
      div.textContent = (inferred ? "? " : "") + c.label;
      geom.computeBoundingBox();
      const label = new CSS2DObject(div); label.position.set(0, geom.boundingBox.max.y + 0.12, 0); label.center.set(0.5, 1);
      group.add(label);
      this.root.add(group);
      this.parts.push({ id: a.componentId, group, mesh, edges, mat, label, inferred, extras: [], pickables: [mesh], conformed,
        offset: new THREE.Vector3(), baseQuat: group.quaternion.clone(), userQuat: new THREE.Quaternion(),
        base: new THREE.Vector3(...a.position.map((v) => v * k)),
        dir: new THREE.Vector3(...a.explodeDir).normalize(), dist: a.explodeDist ?? 1, halfH: size[1] / 2 });
    }
    // centre the assembly on its bounding box
    const box = new THREE.Box3();
    for (const p of this.parts) { p.group.position.copy(p.base); p.group.updateMatrixWorld(true); box.expandByObject(p.mesh); }
    const ctr = box.getCenter(new THREE.Vector3());
    for (const p of this.parts) p.base.sub(ctr);
    this.size = box.getSize(new THREE.Vector3());
    this.addDetails(assembly.details || [], k, ctr);
    this.addDecals(views);
    this.setExplode(this.explode);
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
        let img; try { img = await load(l.cutout); } catch { continue; }
        if (!this.parts.includes(p)) return; // a newer build replaced this one
        const geom = this.decalGeometry(p, axisW, v.view);
        if (!geom) continue;
        const tex = new THREE.Texture(img); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8; tex.needsUpdate = true;
        const mat = new THREE.MeshPhysicalMaterial({ map: tex, transparent: true, alphaTest: 0.3, roughness: p.mat.roughness,
          metalness: p.mat.metalness, clearcoat: p.mat.clearcoat, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
          side: THREE.DoubleSide, envMapIntensity: p.mat.envMapIntensity });
        const m = new THREE.Mesh(geom, mat); m.userData.partId = p.id; m.renderOrder = 1;
        p.mesh.add(m); p.decal = m; p.extras.push(mat); p.pickables.push(m);
      }
    }
  }

  decalGeometry(p, axisW, view) {
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

  setExplode(t) {
    this.explode = t;
    const reach = TARGET_SIZE * 0.8;
    for (const p of this.parts) {
      p.group.position.copy(p.base).addScaledVector(p.dir, t * p.dist * reach).add(p.offset);
      p.group.quaternion.copy(p.userQuat).multiply(p.baseQuat);
    }
    // floor sits just under the lowest part
    let minY = Infinity;
    for (const p of this.parts) { if (!p.group.visible) continue; p.group.updateMatrixWorld(true); minY = Math.min(minY, new THREE.Box3().setFromObject(p.mesh).min.y); }
    this.floor.position.y = (isFinite(minY) ? minY : -3) - 0.02;
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
  }

  // ---------------------------------------------------------------- hands-on: move / turn / focus parts
  beginDrag(id, raycaster, kind, x, y) {
    const p = this.parts.find((q) => q.id === id); if (!p) return null;
    const hit = raycaster.intersectObjects(p.pickables, false)[0]; if (!hit) return null;
    const normal = this.camera.getWorldDirection(new THREE.Vector3());
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

  resetParts(ms = 500) { // glide every part back into place
    const from = this.parts.map((p) => ({ p, o: p.offset.clone(), q: p.userQuat.clone() })), t0 = performance.now(), I = new THREE.Quaternion();
    const tick = (now) => {
      const k = Math.min(1, (now - t0) / ms), e = 1 - Math.pow(1 - k, 3);
      for (const f of from) { f.p.offset.copy(f.o).multiplyScalar(1 - e); f.p.userQuat.copy(f.q).slerp(I, e); if (k === 1) f.p.moved = false; }
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

  paint({ selected, affected, removed, isolate, related }) {
    for (const p of this.parts) {
      p.group.visible = p.id !== removed;
      const dim = isolate && selected && p.id !== selected && !related.has(p.id);
      const glow = p.id === selected ? 0x2a6df4 : affected.has(p.id) ? 0xff5040 : 0x000000;
      p.mat.emissive.setHex(glow); p.mat.emissiveIntensity = glow ? 0.55 : 0;
      const baseOpacity = p.mat.userData.baseOpacity ??= p.mat.opacity;
      p.mat.transparent = dim || baseOpacity < 1; p.mat.opacity = dim ? 0.1 : baseOpacity; p.mat.depthWrite = !dim;
      p.edges.material.opacity = dim ? 0.05 : p.inferred ? 0.85 : 0.28;
      for (const m of p.extras) { m.transparent = true; m.opacity = dim ? 0.08 : 1; m.depthWrite = !dim; m.needsUpdate = true; }
      p.highlight = p.id === selected || affected.has(p.id);
      p.label.element.classList.toggle("sel", p.id === selected);
      p.label.element.classList.toggle("hit", affected.has(p.id));
      p.mat.needsUpdate = true;
    }
    this.setExplode(this.explode);
  }

  render() {
    if (!this.root.visible) return;
    const r = this.renderer.domElement.getBoundingClientRect();
    this.labels.setSize(r.width, r.height);
    this.labels.render(this.scene, this.camera);
    // declutter: keep the most important labels, hide ones that overlap them
    const cand = this.parts.filter((p) => p.label.visible && p.group.visible);
    cand.sort((a, b) => (b.highlight - a.highlight) || (a.inferred - b.inferred) || (b.halfH - a.halfH));
    const kept = [];
    for (const p of cand) {
      const e = p.label.element, b = e.getBoundingClientRect();
      const hit = kept.some((k) => b.left < k.right + 4 && b.right > k.left - 4 && b.top < k.bottom + 2 && b.bottom > k.top - 2);
      e.classList.toggle("collide", hit && !p.highlight);
      if (!hit || p.highlight) kept.push(b);
    }
  }
}
