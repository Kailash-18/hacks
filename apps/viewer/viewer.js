// Physical Lab viewer: layered 2.5D exploded diagram built from one photo.
// Depth relief: Depth Anything V2 (small) running in the browser via transformers.js,
// blended with a per-part "dome" from the cut-out silhouette. No GPU server needed.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { AssemblyView } from "./assembly3d.js";

const API = new URLSearchParams(location.search).get("api") || "";
const TRANSFORMERS_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.1.2";
const DEPTH_MODEL = "onnx-community/depth-anything-v2-small";
const WORLD_W = 10;          // image width in world units
const RELIEF = 1.1;          // depth relief strength
const THICKNESS = 0.22;      // solid edge thickness
const SLICES = 7;

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

// ---------------------------------------------------------------- three setup
const canvas = $("c");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene3 = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 200);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.minAzimuthAngle = -0.75; controls.maxAzimuthAngle = 0.75;          // keep the 2.5D illusion convincing
controls.minPolarAngle = Math.PI / 2 - 0.6; controls.maxPolarAngle = Math.PI / 2 + 0.6;
controls.minDistance = 4; controls.maxDistance = 40;
scene3.add(new THREE.HemisphereLight(0xffffff, 0x334055, 1.4));
const key = new THREE.DirectionalLight(0xffffff, 1.6); key.position.set(-4, 6, 10); scene3.add(key);
const rim = new THREE.DirectionalLight(0x88aaff, 0.6); rim.position.set(6, -2, -6); scene3.add(rim);
const root = new THREE.Group(); scene3.add(root);
const asm = new AssemblyView({ scene: scene3, renderer, camera, controls, stage: canvas.parentElement });
let mode = "layers"; // "3d" = AI-built 3D model, "layers" = photo cut-out layers
controls.autoRotateSpeed = 1.2;

function resize() {
  const r = canvas.getBoundingClientRect();
  renderer.setSize(r.width, r.height, false);
  camera.aspect = r.width / Math.max(1, r.height); camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(canvas);

// ---------------------------------------------------------------- state
let A = null;               // current SystemAnalysis
let parts = [];             // {id, comp, group, front, mats[], alpha, base, center, order, layer}
let ghosts = [];            // {id, comp, group, mat}
let plate = null;
let worldH = 1;
let selected = null, removed = null, affected = new Set();
let depthMap = null;        // {w,h,data Float32 0..1}
let isSample = false;

// ---------------------------------------------------------------- helpers
const loadImage = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
const compById = (id) => A.components.find((c) => c.id === id);
function showError(msg) { const t = $("error"); t.textContent = msg; t.hidden = false; clearTimeout(showError.t); showError.t = setTimeout(() => (t.hidden = true), 7000); }

const STEP_NAMES = ["Uploading photo", "AI finding parts & cutting them out", "Building 3D layers", "Estimating depth in your browser"];
function steps(active) {
  const ol = $("steps"); ol.innerHTML = "";
  STEP_NAMES.forEach((n, i) => ol.append(el("li", i < active ? "done" : i === active ? "active" : "", n)));
  $("loading").hidden = active >= STEP_NAMES.length;
}

function sampleImg(data, w, h, u, v) { // nearest sample of a 0..1 map
  const x = Math.min(w - 1, Math.max(0, Math.round(u * (w - 1))));
  const y = Math.min(h - 1, Math.max(0, Math.round(v * (h - 1))));
  return data[y * w + x];
}

function silhouetteDome(img) { // blurred alpha -> soft rounded relief 0..1 (64px grid)
  const N = 64, c = document.createElement("canvas"); c.width = c.height = N;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.filter = "blur(5px)"; ctx.drawImage(img, 0, 0, N, N);
  const d = ctx.getImageData(0, 0, N, N).data, out = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++) out[i] = Math.sqrt(d[i * 4 + 3] / 255);
  return { w: N, h: N, data: out };
}

function alphaOf(img) {
  const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
  const ctx = c.getContext("2d", { willReadFrequently: true }); ctx.drawImage(img, 0, 0);
  return { w: img.width, h: img.height, data: ctx.getImageData(0, 0, img.width, img.height).data };
}

function bboxToWorld(b) {
  return {
    w: b.width * WORLD_W, h: b.height * worldH,
    cx: (b.x + b.width / 2 - 0.5) * WORLD_W, cy: -(b.y + b.height / 2 - 0.5) * worldH,
  };
}

// Displace a plane by depth (global map) + dome (part silhouette).
function reliefGeometry(b, dome, domeWeight) {
  const wb = bboxToWorld(b);
  const sx = Math.max(8, Math.min(96, Math.round(wb.w * 14))), sy = Math.max(8, Math.min(96, Math.round(wb.h * 14)));
  const g = new THREE.PlaneGeometry(wb.w, wb.h, sx, sy);
  const pos = g.attributes.position, uv = g.attributes.uv;
  let mean = 0, n = 0; const ds = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const u = uv.getX(i), v = 1 - uv.getY(i);
    const d = depthMap ? sampleImg(depthMap.data, depthMap.w, depthMap.h, b.x + u * b.width, b.y + v * b.height) : 0.5;
    ds[i] = d; mean += d; n++;
  }
  mean /= n;
  for (let i = 0; i < pos.count; i++) {
    const u = uv.getX(i), v = 1 - uv.getY(i);
    const dm = dome ? sampleImg(dome.data, dome.w, dome.h, u, v) : 0;
    pos.setZ(i, RELIEF * ((ds[i] - mean) * 0.9 + dm * domeWeight));
  }
  g.computeVertexNormals();
  return { geom: g, meanDepth: mean, wb };
}

function makeSolid(geom, tex) {
  const group = new THREE.Group();
  const front = new THREE.MeshStandardMaterial({ map: tex, alphaTest: 0.5, roughness: 0.75, metalness: 0.05, side: THREE.DoubleSide });
  const frontMesh = new THREE.Mesh(geom, front);
  group.add(frontMesh);
  const mats = [front];
  for (let s = 1; s <= SLICES; s++) { // stacked darker slices read as a solid edge
    const m = new THREE.MeshStandardMaterial({ map: tex, alphaTest: 0.5, color: new THREE.Color().setScalar(0.42 - s * 0.025), roughness: 0.9 });
    const mesh = new THREE.Mesh(geom, m); mesh.position.z = -(THICKNESS * s) / SLICES; group.add(mesh); mats.push(m);
  }
  return { group, frontMesh, mats };
}

function textSprite(text, color = "#f2b84b") {
  const c = document.createElement("canvas"), ctx = c.getContext("2d"); const f = 28;
  ctx.font = `600 ${f}px Inter, sans-serif`; c.width = Math.ceil(ctx.measureText(text).width) + 24; c.height = f + 16;
  ctx.font = `600 ${f}px Inter, sans-serif`; ctx.fillStyle = "rgba(13,15,18,.85)"; ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = color; ctx.textBaseline = "middle"; ctx.fillText(text, 12, c.height / 2);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthTest: false }));
  s.scale.set(c.width / c.height * 0.38, 0.38, 1); s.renderOrder = 10; return s;
}

// ---------------------------------------------------------------- build scene
let currentView = 0;
const depthCache = {};
function viewsOf(a) {
  const S = a.scene;
  return S.views && S.views.length ? S.views
    : [{ index: 0, view: "photo", imageWidth: S.imageWidth, imageHeight: S.imageHeight, plate: S.plate, plateBbox: S.plateBbox, layers: S.layers }];
}
const VIEW_NAMES = { top: "Top", bottom: "Bottom", front: "Front", back: "Back", left: "Left side", right: "Right side", "three-quarter": "Angle", inside: "Inside", unknown: "Photo", photo: "Photo" };

async function build(analysis, { sample = false } = {}) {
  A = analysis; isSample = sample; selected = removed = null; affected = new Set();
  for (const k in depthCache) delete depthCache[k];
  if (!A.scene) { showError("This analysis has no physical scene data."); return; }
  renderPanel();
  $("explode").value = 0;
  if (A.scene.assembly && A.scene.assembly.parts.length) {
    asm.build(A.scene.assembly, A.components, viewsOf(A));
    show3D();
  } else await showView(0);
  $("empty").hidden = true; $("controls").hidden = false; $("panel").hidden = false; $("loading").hidden = true;
  introExplode();
}

function show3D() {
  mode = "3d";
  root.visible = false; asm.setActive(true);
  asm.setExplode(parseFloat($("explode").value));
  asm.frame(); renderTabs(); paint();
  $("depthBadge").textContent = "3D model: AI-estimated shapes (approximate)";
  $("handsHint").hidden = false; $("resetParts").hidden = !asm.anyMoved();
  $("forward").disabled = $("backward").disabled = true;
  $("loading").hidden = true;
}

function renderTabs() {
  const box = $("viewTabs"); box.innerHTML = "";
  const vs = viewsOf(A);
  if (A.scene.assembly && A.scene.assembly.parts.length) {
    const t = el("button", "tab tab3d" + (mode === "3d" ? " on" : ""), "3D model");
    t.title = "AI-built 3D model: rotate 360°, explode, click parts"; t.onclick = () => { if (mode !== "3d") show3D(); };
    box.append(t);
  }
  vs.forEach((v, i) => {
    const b = el("button", "tab" + (mode === "layers" && i === currentView ? " on" : ""), `Photo ${i + 1} · ${VIEW_NAMES[v.view] || "Photo"}`);
    b.title = v.filename || ""; b.onclick = () => { if (mode === "3d" || i !== currentView) showView(i, { fromTab: true }).then(paint); };
    box.append(b);
  });
  if (!isSample && vs.length < 4) {
    const add = el("label", "tab add", "+ Add photo"); add.htmlFor = "addFile";
    add.title = "Add another angle of the same object (bottom, side, opened...)"; box.append(add);
  }
  box.hidden = false;
}

async function showView(vi, { fromTab = false } = {}) {
  currentView = vi;
  mode = "layers"; asm.setActive(false); root.visible = true; controls.autoRotate = false; $("spin").checked = false;
  $("handsHint").hidden = true; $("resetParts").hidden = true;
  controls.minAzimuthAngle = -0.75; controls.maxAzimuthAngle = 0.75;          // 2.5D layers only look right from the front
  controls.minPolarAngle = Math.PI / 2 - 0.6; controls.maxPolarAngle = Math.PI / 2 + 0.6; controls.minDistance = 4; controls.maxDistance = 40;
  if (fromTab) { // only the in-browser steps run when switching photos
    const ol = $("steps"); ol.innerHTML = ""; ol.append(el("li", "active", `Preparing photo ${vi + 1}`));
    $("loading").hidden = false;
  }
  root.clear(); parts = []; ghosts = []; plate = null; depthMap = null;
  const S = { ...viewsOf(A)[vi], ghostComponentIds: A.scene.ghostComponentIds || [] };
  worldH = WORLD_W * S.imageHeight / S.imageWidth;

  if (!fromTab) steps(2);
  const layerImgs = await Promise.all(S.layers.map((l) => loadImage(l.cutout)));
  const plateImg = S.plate ? await loadImage(S.plate) : null;

  // Depth (browser). Composite the object from plate + layers so it also works for samples.
  if (!fromTab) steps(3);
  try {
    depthMap = depthCache[vi] || (depthCache[vi] = await estimateDepth(S, plateImg, layerImgs));
    $("depthBadge").textContent = "depth: Depth Anything V2 (in-browser)";
  } catch (e) {
    console.warn("Depth model unavailable, using silhouette relief only", e);
    $("depthBadge").textContent = "depth: silhouette only (model unavailable)";
  }
  if (!fromTab) steps(4);

  if (plateImg) {
    const tex = new THREE.Texture(plateImg); tex.colorSpace = THREE.SRGBColorSpace; tex.needsUpdate = true;
    const { geom } = reliefGeometry(S.plateBbox, null, 0);
    const solid = makeSolid(geom, tex);
    const wb = bboxToWorld(S.plateBbox);
    solid.group.position.set(wb.cx, wb.cy, 0);
    root.add(solid.group); plate = solid;
  }

  const maxRank = Math.max(1, ...S.layers.map((l) => l.depthRank));
  S.layers.forEach((l, i) => {
    const img = layerImgs[i];
    const tex = new THREE.Texture(img); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4; tex.needsUpdate = true;
    const { geom, meanDepth, wb } = reliefGeometry(l.bbox, silhouetteDome(img), 0.35);
    const solid = makeSolid(geom, tex);
    solid.group.traverse((o) => (o.userData.partId = l.componentId));
    root.add(solid.group);
    const frontness = 1 - l.depthRank / maxRank;
    parts.push({ id: l.componentId, comp: compById(l.componentId), ...solid, alpha: alphaOf(img), wb,
      score: 0.5 * frontness + 0.5 * (depthMap ? meanDepth : frontness) });
  });
  reorder();

  // Hidden (inferred) parts as ghost boxes behind the object.
  const ghostIds = S.ghostComponentIds || [];
  ghostIds.forEach((id, i) => {
    const comp = compById(id); if (!comp) return;
    const mat = new THREE.MeshStandardMaterial({ color: 0xf2b84b, transparent: true, opacity: 0.18, depthWrite: false });
    const box = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.9, 0.5), mat);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(box.geometry), new THREE.LineDashedMaterial({ color: 0xf2b84b, dashSize: 0.12, gapSize: 0.08 }));
    edges.computeLineDistances();
    const label = textSprite("? " + comp.label); label.position.y = 0.75;
    const g = new THREE.Group(); g.add(box, edges, label);
    g.traverse((o) => (o.userData.partId = id));
    // Column to the right of the object, so labels never overlap each other or the controls.
    const pb = S.plateBbox || { x: 0.25, y: 0.25, width: 0.5, height: 0.5 };
    const right = (pb.x + pb.width - 0.5) * WORLD_W, top = -(pb.y - 0.5) * worldH;
    const step = Math.min(1.4, (pb.height * worldH + 1) / Math.max(1, ghostIds.length - 1 || 1));
    g.userData.home = new THREE.Vector3(right + 2.9, top - 0.4 - i * step, 0);
    root.add(g); ghosts.push({ id, comp, group: g, mat, box });
  });

  frame();
  applyExplode();
  renderTabs();
  $("loading").hidden = true;
}

function reorder() { // back-to-front order -> explode layer index
  [...parts].sort((a, b) => a.score - b.score).forEach((p, i) => (p.layer = i + 1));
}

function objFrame() { // object centre + size in world units for the current photo
  const pb = A && A.scene && viewsOf(A)[currentView].plateBbox;
  if (!pb) return { cx: 0, cy: 0, size: Math.max(WORLD_W, worldH) * 0.6 };
  return { cx: (pb.x + pb.width / 2 - 0.5) * WORLD_W, cy: -(pb.y + pb.height / 2 - 0.5) * worldH,
           size: Math.max(pb.width * WORLD_W, pb.height * worldH) };
}

function frame() { // three-quarter view so the explode depth is visible
  if (mode === "3d") return asm.frame();
  const o = objFrame();
  const tx = o.cx - (ghosts.length ? o.size * 0.25 : 0), ty = o.cy - o.size * 0.12, tz = o.size * 0.35;
  const dist = o.size * 2.6 + (ghosts.length ? 2.5 : 0) + 2;
  const az = -0.55, el = 0.16;
  camera.position.set(tx + dist * Math.sin(az) * Math.cos(el), ty + dist * Math.sin(el), tz + dist * Math.cos(az) * Math.cos(el));
  controls.target.set(tx, ty, tz); controls.update();
}

function applyExplode() {
  const t = parseFloat($("explode").value);
  if (mode === "3d") return asm.setExplode(t);
  const n = parts.length, o = objFrame();
  const step = (o.size * 1.15) / Math.max(2, n);       // total explode depth ~ object size
  for (const p of parts) {
    const assembled = 0.03 + p.score * 0.25 + p.layer * 0.015;
    p.group.position.set(o.cx + (p.wb.cx - o.cx) * (1 + 0.35 * t), o.cy + (p.wb.cy - o.cy) * (1 + 0.35 * t),
                         assembled + t * p.layer * step);
    p.group.visible = p.id !== removed;
  }
  if (plate) plate.group.position.z = -t * o.size * 0.12;
  for (const g of ghosts) {
    g.group.visible = t > 0.12 && g.id !== removed;
    // keep the column just outside the exploded parts (they spread out by 35% at full explode)
    const halfW = (viewsOf(A)[currentView].plateBbox?.width || 0.5) * WORLD_W / 2;
    g.group.position.copy(g.group.userData.home).setZ(o.size * 0.3 * t);
    // left side: the 3/4 camera looks from the left, so exploded parts drift right on screen
    g.group.position.x = o.cx - halfW * (1 + 0.35 * t) - 1.8 - t * 0.6;
    g.group.scale.setScalar(Math.min(1, t * 1.6));
  }
}

function introExplode(target = 0.65, ms = 1600) { // animate apart once a result loads
  const e = $("explode"), from = parseFloat(e.value), t0 = performance.now();
  const tick = (now) => {
    const k = Math.min(1, (now - t0) / ms), ease = 1 - Math.pow(1 - k, 3);
    e.value = from + (target - from) * ease; applyExplode();
    if (k < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
$("explode").addEventListener("input", applyExplode);

// ---------------------------------------------------------------- depth (browser)
let depthPipe = null;
async function estimateDepth(S, plateImg, layerImgs) {
  const W = S.imageWidth, H = S.imageHeight;
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (plateImg) { const b = S.plateBbox; ctx.drawImage(plateImg, b.x * W, b.y * H, b.width * W, b.height * H); }
  const order = S.layers.map((l, i) => [l, layerImgs[i]]).sort((a, b) => b[0].depthRank - a[0].depthRank);
  for (const [l, img] of order) ctx.drawImage(img, l.bbox.x * W, l.bbox.y * H, l.bbox.width * W, l.bbox.height * H);
  const objAlpha = ctx.getImageData(0, 0, W, H).data;

  if (!depthPipe) {
    const { pipeline, env } = await import(TRANSFORMERS_URL);
    env.allowLocalModels = false;
    depthPipe = await pipeline("depth-estimation", DEPTH_MODEL, { device: navigator.gpu ? "webgpu" : "wasm", dtype: "fp32" })
      .catch(() => pipeline("depth-estimation", DEPTH_MODEL));
  }
  const out = await depthPipe(c.toDataURL("image/png"));
  const dimg = out.depth; // RawImage, 1 channel, larger = closer
  const dw = dimg.width, dh = dimg.height, src = dimg.data, ch = dimg.channels || 1;
  const data = new Float32Array(dw * dh);
  let lo = Infinity, hi = -Infinity;
  for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
    const v = src[(y * dw + x) * ch];
    const ox = Math.min(W - 1, Math.floor(x / dw * W)), oy = Math.min(H - 1, Math.floor(y / dh * H));
    data[y * dw + x] = v;
    if (objAlpha[(oy * W + ox) * 4 + 3] > 128) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  }
  const span = Math.max(1e-6, hi - lo);
  for (let i = 0; i < data.length; i++) data[i] = Math.min(1, Math.max(0, (data[i] - lo) / span));
  return { w: dw, h: dh, data };
}

// ---------------------------------------------------------------- picking
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
function pick(ev) {
  const r = canvas.getBoundingClientRect();
  ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  if (mode === "3d") return asm.pick(ray);
  for (const hit of ray.intersectObjects(root.children, true)) {
    if (!hit.object.visible || !hit.object.parent?.visible) continue;
    const id = hit.object.userData.partId; if (!id) continue;
    const p = parts.find((q) => q.id === id);
    if (p && hit.uv) { // ignore transparent pixels of the cut-out
      const a = p.alpha, x = Math.floor(hit.uv.x * (a.w - 1)), y = Math.floor((1 - hit.uv.y) * (a.h - 1));
      if (a.data[(y * a.w + x) * 4 + 3] < 128) continue;
    }
    return id;
  }
  return null;
}
// ---------------------------------------------------------------- hands-on parts (3D mode)
// drag = pull a part out, Shift+drag = turn it, double-click = focus on it, "Reset parts" = put everything back
let drag = null;
function rayFrom(ev) {
  const r = canvas.getBoundingClientRect();
  ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera); return ray;
}
canvas.parentElement.addEventListener("pointerdown", (e) => { // capture phase: runs before the orbit controls
  if (mode !== "3d" || e.button !== 0 || e.target !== canvas) return;
  const id = asm.pick(rayFrom(e)); if (!id) return;
  drag = asm.beginDrag(id, ray, e.shiftKey ? "rotate" : "move", e.clientX, e.clientY);
  if (!drag) return;
  controls.enabled = false; canvas.setPointerCapture(e.pointerId); canvas.style.cursor = "grabbing";
  if (controls.autoRotate) { controls.autoRotate = false; $("spin").checked = false; }
  if (selected !== id) select(id);
}, { capture: true });
window.addEventListener("pointermove", (e) => { if (drag) { asm.dragTo(drag, rayFrom(e), e.clientX, e.clientY); $("resetParts").hidden = false; } });
window.addEventListener("pointerup", () => { if (drag) { drag = null; controls.enabled = true; canvas.style.cursor = ""; } });
canvas.addEventListener("dblclick", (e) => {
  if (mode !== "3d") return;
  const id = asm.pick(rayFrom(e)); if (!id) return;
  $("isolate").checked = true; select(id).then(() => asm.focus(id));
});
$("resetParts").addEventListener("click", () => { asm.resetParts(); $("resetParts").hidden = true; });

let downAt = null;
canvas.addEventListener("pointerdown", (e) => (downAt = [e.clientX, e.clientY]));
canvas.addEventListener("pointerup", (e) => {
  if (!A || !downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5) return;
  select(pick(e));
});
canvas.addEventListener("pointermove", (e) => {
  if (!A) return;
  const id = pick(e), h = $("hover");
  if (id) { const r = canvas.getBoundingClientRect(); h.textContent = compById(id).label; h.style.left = e.clientX - r.left + "px"; h.style.top = e.clientY - r.top + "px"; h.hidden = false; canvas.style.cursor = "pointer"; }
  else { h.hidden = true; canvas.style.cursor = ""; }
});

// ---------------------------------------------------------------- highlight
function paint() {
  const iso = $("isolate").checked && selected;
  const related = new Set(selected ? A.relationships.filter((r) => r.from === selected || r.to === selected).flatMap((r) => [r.from, r.to]) : []);
  if (mode === "3d") return asm.paint({ selected, affected, removed, isolate: $("isolate").checked, related });
  for (const p of parts) {
    const dim = iso && p.id !== selected && !related.has(p.id);
    const glow = p.id === selected ? 0x2a6df4 : affected.has(p.id) ? 0xff5040 : 0x000000;
    p.mats.forEach((m, i) => {
      m.transparent = dim; m.opacity = dim ? 0.12 : 1; m.depthWrite = !dim;
      if (i === 0) { m.emissive.setHex(glow); m.emissiveIntensity = glow ? 0.45 : 0; }
      m.needsUpdate = true;
    });
  }
  if (plate) plate.mats.forEach((m) => { m.transparent = !!iso; m.opacity = iso ? 0.1 : 1; m.depthWrite = !iso; m.needsUpdate = true; });
  for (const g of ghosts) {
    g.mat.color.setHex(g.id === selected ? 0x4f8cff : affected.has(g.id) ? 0xff5040 : 0xf2b84b);
    g.mat.opacity = iso && g.id !== selected && !related.has(g.id) ? 0.05 : g.id === selected ? 0.45 : 0.18;
  }
}
$("isolate").addEventListener("change", paint);
$("resetView").addEventListener("click", () => { if (mode === "3d" && $("isolate").checked) { $("isolate").checked = false; paint(); } frame(); });

// ---------------------------------------------------------------- panel
function statusChip(s) { return el("span", `chip ${s}`, s); }

function renderPanel() {
  $("title").textContent = A.title ? A.title[0].toUpperCase() + A.title.slice(1) : "";
  $("summary").textContent = A.summary || "";
  const mb = $("modeBadge");
  mb.textContent = isSample ? "Sample mode · saved real result" : "Live analysis";
  mb.className = "eyebrow" + (isSample ? " sample" : "");
  $("limits").innerHTML = "";
  A.limitations.concat(A.scene?.notes || []).forEach((t) => $("limits").append(el("li", "", t)));
  const pr = A.scene?.product, pe = $("product");
  if (pr && (pr.searchQuery || pr.brand)) {
    pe.innerHTML = "";
    const name = (pr.model && pr.brand && pr.model.toLowerCase().startsWith(pr.brand.toLowerCase()) ? pr.model
      : [pr.brand, pr.model].filter(Boolean).join(" ")) || pr.category || A.title;
    pe.append(el("div", "", `Identified: ${name}` + (pr.model ? "" : " (exact model not readable)")));
    if (pr.identifiedFrom) pe.append(el("div", "tiny muted", "From: " + pr.identifiedFrom));
    if (!isSample) {
      const a = el("a", "btn small", "Find photos of this model ↗");
      a.href = "https://www.google.com/search?tbm=isch&q=" + encodeURIComponent(pr.searchQuery || name);
      a.target = "_blank"; a.rel = "noopener";
      pe.append(a, el("div", "tiny muted", "Save top / bottom / side shots, then use “+ Add photo”. Up to 4 photos."));
    }
    pe.hidden = false;
  } else pe.hidden = true;
  $("providerLine").textContent = `Vision: ${A.provider.name} · ${A.provider.model}. What-if = graph traversal, not physics.`;
  renderParts(); renderGraph(); renderDetail();
}

function renderParts() {
  const ul = $("parts"); ul.innerHTML = "";
  for (const c of A.components) {
    const li = el("li", [c.id === selected && "sel", affected.has(c.id) && "affected", c.id === removed && "removed"].filter(Boolean).join(" "));
    li.append(el("i", `st ${c.status}`), el("span", "", c.label), el("span", "type", c.type));
    li.onclick = () => select(c.id);
    ul.append(li);
  }
}

function renderDetail() {
  const d = $("detail");
  if (!selected) { d.hidden = true; return; }
  const c = compById(selected); d.hidden = false;
  $("dLabel").textContent = c.label;
  const st = $("dStatus"); st.className = `chip ${c.status}`; st.textContent = c.status === "observed" ? "seen in photo" : c.status;
  $("dType").textContent = c.type;
  $("dEvidence").innerHTML = ""; c.evidence.forEach((e) => $("dEvidence").append(el("li", "", e)));
  const rl = $("dRels"); rl.innerHTML = "";
  const rels = A.relationships.filter((r) => r.from === c.id || r.to === c.id);
  if (!rels.length) rl.append(el("li", "muted", "No relationships extracted."));
  for (const r of rels) {
    const other = compById(r.from === c.id ? r.to : r.from);
    const txt = r.from === c.id ? `${r.type.replace(/_/g, " ")} → ${other.label}` : `${other.label} ${r.type.replace(/_/g, " ")} this`;
    const li = el("li", r.status === "observed" ? "" : "dashed", txt + (r.status === "observed" ? "" : " (inferred)"));
    li.title = r.evidence.join(" · "); li.onclick = () => select(other.id); rl.append(li);
  }
  const isLayer = mode === "layers" && parts.some((p) => p.id === c.id);
  $("forward").disabled = $("backward").disabled = !isLayer;
  $("whatif").textContent = removed === c.id ? "Put it back" : "What if I remove it?";
}

async function select(id) {
  const inScene = mode === "3d" ? asm.parts.some((p) => p.id === id) : parts.some((p) => p.id === id);
  if (id && !inScene) { // part lives in another photo -> switch to it
    const vi = viewsOf(A).findIndex((v) => v.layers.some((l) => l.componentId === id));
    if (vi >= 0 && vi !== currentView) await showView(vi);
  }
  selected = id; renderParts(); renderDetail(); renderGraph(); paint();
}

function nudge(dir) {
  const p = parts.find((q) => q.id === selected); if (!p) return;
  const sorted = [...parts].sort((a, b) => a.score - b.score);
  const i = sorted.indexOf(p), j = i + dir;
  if (j < 0 || j >= sorted.length) return;
  [p.score, sorted[j].score] = [sorted[j].score, p.score];
  if (p.score === sorted[j].score) p.score += dir * 0.01;
  reorder(); applyExplode();
}
$("forward").onclick = () => nudge(1);
$("backward").onclick = () => nudge(-1);

$("whatif").onclick = async () => {
  const out = $("whatifOut");
  if (removed === selected) { removed = null; affected = new Set(); out.hidden = true; applyExplode(); renderParts(); renderDetail(); renderGraph(); paint(); return; }
  try {
    const r = await fetch(API + "/api/physical/whatif", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ analysisId: A.analysisId, removedComponentId: selected,
                             components: A.components, relationships: A.relationships }) });
    const res = await r.json();
    if (!r.ok) throw new Error(errText(res, r.status));
    removed = selected; affected = new Set(res.affected.map((a) => a.componentId));
    out.innerHTML = ""; out.append(el("div", "", res.summary));
    res.affected.forEach((a) => out.append(el("code", "", a.explanation + (a.uncertain ? "  (inferred link)" : ""))));
    out.append(el("div", "method", res.method)); out.hidden = false;
    applyExplode(); renderParts(); renderDetail(); renderGraph(); paint();
  } catch (e) { showError(e.message); }
};

function renderGraph() {
  const svg = $("graph"); svg.innerHTML = "";
  const NS = "http://www.w3.org/2000/svg", cs = A.components, n = cs.length;
  const pos = {}; const cx = 160, cy = 120, R = n > 1 ? 88 : 0;
  cs.forEach((c, i) => { const a = (i / n) * Math.PI * 2 - Math.PI / 2; pos[c.id] = [cx + R * Math.cos(a), cy + R * Math.sin(a)]; });
  const defs = document.createElementNS(NS, "defs");
  defs.innerHTML = `<marker id="arr" viewBox="0 0 10 10" refX="16" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0L10,5L0,10z" fill="#8b93a1"/></marker>`;
  svg.append(defs);
  for (const r of A.relationships) {
    const [x1, y1] = pos[r.from], [x2, y2] = pos[r.to];
    const ln = document.createElementNS(NS, "line");
    Object.entries({ x1, y1, x2, y2, stroke: (affected.has(r.to) && (r.from === removed || affected.has(r.from))) ? "#ff6b5b" : "#5b6472", "stroke-width": 1.3, "marker-end": "url(#arr)" })
      .forEach(([k, v]) => ln.setAttribute(k, v));
    if (r.status !== "observed") ln.setAttribute("stroke-dasharray", "4 3");
    const t = document.createElementNS(NS, "title"); t.textContent = `${r.type}: ${r.evidence.join(" · ")}`; ln.append(t);
    svg.append(ln);
  }
  const colors = { observed: "#3ccf8e", inferred: "#f2b84b", estimated: "#4f8cff", unknown: "#8b93a1" };
  for (const c of cs) {
    const g = document.createElementNS(NS, "g"); g.setAttribute("class", "node"); g.onclick = () => select(c.id);
    const [x, y] = pos[c.id];
    const circ = document.createElementNS(NS, "circle");
    Object.entries({ cx: x, cy: y, r: c.id === selected ? 9 : 7, fill: c.id === removed ? "#333" : affected.has(c.id) ? "#ff6b5b" : colors[c.status],
      stroke: c.id === selected ? "#fff" : "none", "stroke-width": 2 }).forEach(([k, v]) => circ.setAttribute(k, v));
    const tx = document.createElementNS(NS, "text");
    tx.setAttribute("x", x); tx.setAttribute("y", y + (y < cy ? -12 : 18)); tx.setAttribute("text-anchor", "middle");
    tx.textContent = c.label.length > 16 ? c.label.slice(0, 15) + "…" : c.label;
    g.append(circ, tx); svg.append(g);
  }
}

// ---------------------------------------------------------------- upload & samples
async function shrink(file, max = 1600) { // client-side downscale keeps uploads fast
  const img = await loadImage(URL.createObjectURL(file));
  const s = Math.min(1, max / Math.max(img.width, img.height));
  const c = document.createElement("canvas"); c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  return new Promise((res) => c.toBlob(res, "image/jpeg", 0.9));
}

function errText(data, status) { // API errors are {error: {code, message}}; older/FastAPI shapes still handled
  const d = data && (data.error || data.detail);
  if (typeof d === "string") return d;
  if (d && typeof d.message === "string") return d.message;
  if (Array.isArray(d)) return d.map((x) => x.msg || JSON.stringify(x)).join("; ");
  return `Request failed (${status})`;
}
let currentFiles = []; // shrunk blobs of the current object (re-sent on "Add photo"; server caches each photo)

async function analyze(files) {
  try {
    steps(0);
    const fd = new FormData();
    files.forEach((b, i) => fd.append("images", b, `photo${i + 1}.jpg`));
    STEP_NAMES[1] = files.length > 1 ? `AI finding parts in ${files.length} photos` : "AI finding parts & cutting them out";
    steps(1);
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 180000);
    let r;
    try { r = await fetch(API + "/api/physical/analyze", { method: "POST", body: fd, signal: ctl.signal }); }
    catch (err) { throw new Error(err.name === "AbortError" ? "The analysis took over 3 minutes and was stopped. Please try again." : "Can't reach the server. Is uvicorn running?"); }
    finally { clearTimeout(timer); }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(errText(data, r.status));
    currentFiles = files;
    await build(data, { sample: false });
  } catch (err) { $("loading").hidden = true; showError(err.message || "Something went wrong."); }
}

async function pickFiles(list) {
  const ok = [...list].filter((f) => /^image\/(jpeg|png|webp)$/.test(f.type));
  if (ok.length < list.length) showError("Some files were skipped: use JPEG, PNG or WebP photos.");
  return Promise.all(ok.map((f) => shrink(f)));
}

$("file").addEventListener("change", async (e) => {
  const list = [...e.target.files]; e.target.value = "";
  if (!list.length) return;
  const blobs = await pickFiles(list);
  if (!blobs.length) return;
  if (blobs.length > 4) showError("Using the first 4 photos.");
  analyze(blobs.slice(0, 4));
});

$("addFile").addEventListener("change", async (e) => {
  const list = [...e.target.files]; e.target.value = "";
  if (!list.length) return;
  const blobs = await pickFiles(list);
  const all = currentFiles.concat(blobs).slice(0, 4);
  if (all.length > currentFiles.length) analyze(all);
});

async function loadSamples() {
  try {
    const r = await fetch(API + "/api/physical/samples"); const d = await r.json();
    for (const s of d.samples) $("samples").append(new Option(s.title, s.id));
    if (!d.samples.length) $("samples").hidden = true;
  } catch { $("samples").hidden = true; }
}
$("samples").addEventListener("change", async (e) => {
  const id = e.target.value; e.target.value = ""; if (!id) return;
  try {
    steps(1);
    const r = await fetch(API + "/api/physical/samples/" + encodeURIComponent(id)); const d = await r.json();
    if (!r.ok) throw new Error(errText(d, r.status));
    await build(d, { sample: true });
  } catch (err) { $("loading").hidden = true; showError(err.message); }
});
loadSamples();

// ---------------------------------------------------------------- loop
$("spin").addEventListener("change", (e) => { controls.autoRotate = e.target.checked; });
controls.addEventListener("start", () => { if (controls.autoRotate) { controls.autoRotate = false; $("spin").checked = false; } });
renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene3, camera); asm.render(); });
window.__vre = { build, get state() { return { mode, parts: mode === "3d" ? asm.parts.length : parts.length, ghosts: ghosts.length, selected, removed, affected: [...affected] }; }, select };
