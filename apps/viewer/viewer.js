// Physical Lab viewer: layered 2.5D exploded diagram built from one photo.
// Depth relief: Depth Anything V2 (small) running in the browser via transformers.js,
// blended with a per-part "dome" from the cut-out silhouette. No GPU server needed.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { AssemblyView } from "./assembly3d.js";
import { alternativesFor, lookFor } from "./alternatives.js";

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
let scanTimer = null;
function steps(active, through = active, names = STEP_NAMES) { // steps active..through run at once (one server request)
  const ol = $("steps"); ol.innerHTML = "";
  names.forEach((n, i) => ol.append(el("li", i < active ? "done" : i <= through ? "active" : "", n)));
  const done = active >= names.length;
  $("loading").hidden = done;
  if (done) { clearInterval(scanTimer); scanTimer = null; }
}
function startScan(file) { // photo with a sweeping laser while the AI works
  const img = $("scanImg");
  if (file) { if (img.dataset.url) URL.revokeObjectURL(img.dataset.url); img.dataset.url = img.src = URL.createObjectURL(file); }
  $("scanPhoto").hidden = !file;
  const dots = $("scanDots"); dots.innerHTML = "";
  for (let i = 0; i < 26; i++) { const d = el("i"); d.style.left = 8 + Math.random() * 84 + "%"; d.style.top = 8 + Math.random() * 84 + "%"; d.style.animationDelay = Math.random() * 3 + "s"; dots.append(d); }
  const t0 = performance.now(); clearInterval(scanTimer);
  scanTimer = setInterval(() => ($("scanTime").textContent = ((performance.now() - t0) / 1000).toFixed(1) + " s"), 100);
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

function textSprite(text, color = "#c9c0ff") {
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
  A = analysis; isSample = sample; selected = removed = null; affected = new Set(); swaps.clear();
  for (const k in depthCache) delete depthCache[k];
  if (!A.scene) { showError("This analysis has no physical scene data."); return; }
  renderPanel();
  $("explode").value = 0;
  restoreWhatIf(true);
  $("xray").checked = false; asm.setXray(false);
  const has3D = A.scene.assembly && A.scene.assembly.parts.length;
  if (has3D) asm.build(A.scene.assembly, A.components, viewsOf(A), A.relationships);
  $("empty").hidden = true; $("controls").hidden = false; $("panel").hidden = false; steps(STEP_NAMES.length);
  setPanelTab(panelTab); requestAnimationFrame(moveInk);
  if (has3D) show3D({ intro: true });
  else { await showView(0); introExplode(); }
}

function show3D({ intro = false } = {}) {
  mode = "3d";
  root.visible = false; asm.setActive(true);
  asm.setExplode(parseFloat($("explode").value));
  asm.frame(); renderTabs(); paint();
  if (intro) { // hologram materialises, locks together with a shockwave, then flies apart
    controls.enabled = false; controls.autoRotate = false; $("spin").checked = false;
    asm.cameraSweep(3000);
    asm.materialize(2300, () => {
      controls.enabled = true; showReveal(); introExplode(0.65, 1700);
      setTimeout(() => { if (!drag && mode === "3d") { controls.autoRotate = true; $("spin").checked = true; } }, 2000);
    });
  }
  $("depthBadge").textContent = "3D model: AI-estimated shapes (approximate)";
  $("handsHint").hidden = false; $("resetParts").hidden = !asm.anyMoved();
  $("loading").hidden = true;
}

function renderTabs() {
  const box = $("viewTabs"); box.innerHTML = "";
  const vs = viewsOf(A);
  const has3D = !!(A.scene.assembly && A.scene.assembly.parts.length);
  if (!has3D) vs.forEach((v, i) => { // photo views are only a fallback when no 3D model could be built
    const b = el("button", "tab" + (mode === "layers" && i === currentView ? " on" : ""), `Photo ${i + 1} · ${VIEW_NAMES[v.view] || "Photo"}`);
    b.title = v.filename || ""; b.onclick = () => { if (mode === "3d" || i !== currentView) showView(i, { fromTab: true }).then(paint); };
    box.append(b);
  });
  if (!isSample && vs.length < 4) {
    const add = el("label", "tab add", "+ Add photo"); add.htmlFor = "addFile";
    add.title = "Add another angle of the same object (bottom, side, opened...)"; box.append(add);
  }
  box.hidden = !box.children.length;
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
    const mat = new THREE.MeshStandardMaterial({ color: 0x9b8cff, transparent: true, opacity: 0.18, depthWrite: false });
    const box = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.9, 0.5), mat);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(box.geometry), new THREE.LineDashedMaterial({ color: 0x9b8cff, dashSize: 0.12, gapSize: 0.08 }));
    edges.computeLineDistances();
    const label = textSprite(comp.label + " · inferred"); label.position.y = 0.75;
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
  if (mode === "3d") return asm.frame(Math.max(0.3, parseFloat($("explode").value) || 0));
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
    e.value = from + (target - from) * ease; applyExplode(); paintSlider();
    if (k < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
$("explode").addEventListener("input", applyExplode);
// the slider track fills up to the grip
const paintSlider = () => { const e = $("explode"); e.style.setProperty("--fill", e.value * 100 + "%"); };
$("explode").addEventListener("input", paintSlider);
// orientation: the whole object lies flat (explodes up/down) or stands up (explodes left/right)
$("layoutSeg").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-l]"); if (!b || mode !== "3d" || b.classList.contains("on")) return;
  document.querySelectorAll("#layoutSeg button").forEach((x) => x.classList.toggle("on", x === b));
  controls.autoRotate = false; $("spin").checked = false;
  asm.setOrientation(b.dataset.l);
});
asm.onExplode = (t) => { $("explode").value = t; paintSlider(); };

// callouts and the 3D model share the hover: the matching row in the parts list lights up too
asm.onPick = (id) => select(id);
canvas.addEventListener("pointerleave", () => { $("hover").hidden = true; if (mode === "3d") asm.setHover(null, "canvas"); });
asm.onHover = (id, source) => {
  for (const li of $("parts").children) li.classList.toggle("hov", !!id && li.dataset.id === id);
  if (id && source !== "list") $("parts").querySelector(`li[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
};

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
  if (id) {
    const r = canvas.getBoundingClientRect(), c = compById(id);
    h.textContent = c.label; h.append(el("em", "", c.type.replace(/_/g, " ")));
    h.style.left = e.clientX - r.left + "px"; h.style.top = e.clientY - r.top + "px"; h.hidden = false; canvas.style.cursor = "pointer";
  } else { h.hidden = true; canvas.style.cursor = ""; }
  if (mode === "3d" && !drag) asm.setHover(id, "canvas");
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
    g.mat.color.setHex(g.id === selected ? 0x4f8cff : affected.has(g.id) ? 0xff5040 : 0x9b8cff);
    g.mat.opacity = iso && g.id !== selected && !related.has(g.id) ? 0.05 : g.id === selected ? 0.45 : 0.18;
  }
}
$("isolate").addEventListener("change", paint);
$("xray").addEventListener("change", (e) => { if (mode !== "3d") { e.target.checked = false; return; } asm.setXray(e.target.checked); });
$("resetView").addEventListener("click", () => { if (mode === "3d" && $("isolate").checked) { $("isolate").checked = false; paint(); } frame(); });

// ---------------------------------------------------------------- panel
function statusChip(s) { return el("span", `chip ${s}`, s); }

function renderPanel() {
  $("title").textContent = A.title ? A.title[0].toUpperCase() + A.title.slice(1) : "";
  $("summary").textContent = A.summary || "";
  const mb = $("modeBadge");
  const curated = A.provider?.name === "curated";
  mb.textContent = curated ? "Sample · curated reference model" : isSample ? "Sample mode · saved real result" : "Live analysis";
  mb.className = "eyebrow" + (isSample ? " sample" : "");
  const pr = A.scene?.product, pe = $("product");
  if (pr && (pr.searchQuery || pr.brand)) {
    pe.innerHTML = "";
    const name = (pr.model && pr.brand && pr.model.toLowerCase().startsWith(pr.brand.toLowerCase()) ? pr.model
      : [pr.brand, pr.model].filter(Boolean).join(" ")) || pr.category || A.title;
    const conf = pr.confidence == null ? null : Math.round(pr.confidence * 100);
    const head = el("div", "id-head");
    head.append(el("strong", "", name));
    if (conf != null) head.append(el("span", `conf ${conf >= 75 ? "hi" : conf >= 45 ? "mid" : "lo"}`, `${conf}% sure`));
    pe.append(el("div", "eyebrow", pr.userHint ? "Model you confirmed" : pr.webChecked ? "Identified · checked on the web" : pr.confidence != null ? "AI match · not web-verified" : "Identified from logo/text"), head);
    if (!pr.model) pe.append(el("div", "tiny muted", "Exact model not found."));
    if (pr.identifiedFrom) pe.append(el("div", "tiny muted", "Why: " + pr.identifiedFrom));
    if (pr.visibleText) pe.append(el("div", "tiny muted", "Text read: “" + pr.visibleText + "”"));
    if (pr.dimensionsMm) pe.append(el("div", "tiny muted", `Real size used for 3D: ${pr.dimensionsMm.map((v) => Math.round(v)).join(" × ")} mm`));
    if (pr.sources?.length) {
      const sw = el("div", "tiny muted src", "Sources: ");
      pr.sources.slice(0, 3).forEach((src, i) => {
        let host = ""; try { host = new URL(src.url).hostname.replace(/^www\./, ""); } catch { /* ignore */ }
        const a = el("a", "", src.title || host || `link ${i + 1}`); a.href = src.url; a.target = "_blank"; a.rel = "noopener";
        sw.append(a, i < Math.min(3, pr.sources.length) - 1 ? ", " : "");
      });
      pe.append(sw);
    }
    if (!isSample && currentFiles?.length) {
      const fix = el("div", "id-fix");
      if (pr.candidates?.length) {
        fix.append(el("div", "tiny muted", "Not it? Maybe:"));
        const row = el("div", "cands");
        pr.candidates.forEach((c) => {
          const label = c.brand && !c.model.toLowerCase().startsWith(c.brand.toLowerCase()) ? `${c.brand} ${c.model}` : c.model;
          const b = el("button", "btn small", label + (c.confidence ? ` · ${Math.round(c.confidence * 100)}%` : ""));
          b.onclick = () => analyze(currentFiles, { hint: label });
          row.append(b);
        });
        fix.append(row);
      }
      const form = el("form", "id-input");
      const inp = Object.assign(el("input"), { placeholder: "Type the exact model, e.g. Logitech M185", value: pr.userHint || "" });
      const go = el("button", "btn small primary", "Rebuild 3D");
      form.append(inp, go);
      form.onsubmit = (e) => { e.preventDefault(); const v = inp.value.trim(); if (v) analyze(currentFiles, { hint: v }); };
      fix.append(form);
      if ((conf ?? 0) < 60 && !pr.userHint) fix.append(el("div", "tiny tip", "Tip: flip the object and add a photo of the label underneath (“+ Add photo”); model numbers are usually printed there."));
      pe.append(fix);
    }
    if (!isSample) {
      const a = el("a", "btn small", "Find photos of this model ↗");
      a.href = "https://www.google.com/search?tbm=isch&q=" + encodeURIComponent(pr.searchQuery || name);
      a.target = "_blank"; a.rel = "noopener";
      pe.append(a, el("div", "tiny muted", "Save top / bottom / side shots, then use “+ Add photo”. Up to 4 photos."));
    }
    const tb = el("button", "btn small", "Find teardown photos (iFixit)");
    // search the exact model when known, otherwise brand + kind of object; only guides about the same kind of object count
    const brandWords = new Set((pr.brand || "").toLowerCase().split(/\s+/).filter(Boolean));
    const kind = (pr.category || A.title || "").split(/\s+/).filter((w) => !brandWords.has(w.toLowerCase())).join(" ");
    tb.onclick = () => showTeardowns(pr.model ? name : [pr.brand, kind].filter(Boolean).join(" ") || pr.searchQuery || name, tb, kind || A.title);
    pe.append(tb, Object.assign(el("div", "teardown"), { id: "teardown" }));
    pe.hidden = false;
  } else pe.hidden = true;
  partsQuery = ""; $("partsSearch").value = "";
  $("parts").classList.add("intro"); clearTimeout(renderPanel.t); renderPanel.t = setTimeout(() => $("parts").classList.remove("intro"), 900);
  renderStats(); renderParts(); renderGraph(); renderDetail(); resetChat();
  const panel = $("panel"); panel.classList.remove("boot"); void panel.offsetWidth; panel.classList.add("boot"); // boot-up sequence once per result
}

// part type -> family colour (same families as the system graph and the X-ray wires)
const FAMILY = { power_source: "power", controller: "control", sensor: "control", display: "control", interface: "control", connector: "control",
  cable: "control", actuator: "motion", wheel: "motion", mechanism: "motion", structure: "structure", cover: "structure", fastener: "structure" };
let partsFilter = "all", partsQuery = "";
function cutoutOf(id) { // the part's own photo cut-out, when it was seen
  for (const v of viewsOf(A)) { const l = (v.layers || []).find((x) => x.componentId === id); if (l?.cutout) return l.cutout; }
  return null;
}
const isVerified = (c) => (c.evidence || []).some((e) => e.startsWith("Confirmed for "));
function renderParts() {
  const ul = $("parts"); ul.innerHTML = "";
  const seen = A.components.filter((c) => c.status === "observed"), inside = A.components.filter((c) => c.status !== "observed");
  $("partsCount").textContent = A.components.length;
  const q = partsQuery.trim().toLowerCase();
  const match = (c) => !q || c.label.toLowerCase().includes(q) || c.type.replace(/_/g, " ").includes(q);
  const groups = [["observed", "Seen in the photo", seen], ["inferred", "Inside, inferred", inside]]
    .filter(([k]) => partsFilter === "all" || partsFilter === k);
  let shown = 0;
  for (const [, title, list] of groups) {
    const items = list.filter(match); if (!items.length) continue;
    const gh = el("li", "group"); gh.append(el("span", "", title), el("span", "gcount", String(items.length))); ul.append(gh);
    for (const c of items) {
      shown++;
      const li = el("li", ["part", c.id === selected && "sel", affected.has(c.id) && "affected", c.id === removed && "removed"].filter(Boolean).join(" "));
      li.dataset.id = c.id; li.tabIndex = 0;
      const fam = FAMILY[c.type] || "other";
      li.classList.add(fam); li.style.animationDelay = Math.min(shown, 12) * 25 + "ms";
      const th = el("span", "thumb" + (c.status === "observed" ? "" : " ghost"));
      const src = cutoutOf(c.id);
      if (src) { const im = el("img"); im.src = src; im.alt = ""; im.loading = "lazy"; th.append(im); }
      const txt = el("span", "pname"); txt.append(el("b", "", c.label), el("small", "", c.type.replace(/_/g, " ")));
      li.append(th, txt);
      if (c.id === removed) li.append(el("span", "tag gone", "removed"));
      else if (swaps.has(c.id)) li.append(el("span", "tag sw", "swapped"));
      else if (isVerified(c)) li.append(Object.assign(el("span", "tag ok", "✓ verified"), { title: c.evidence[0] }));
      else if (affected.has(c.id)) li.append(el("span", "tag hit", "affected"));
      else li.append(el("span", "chev", "›"));
      li.onclick = () => select(c.id);
      li.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(c.id); } };
      li.onmouseenter = () => { if (mode === "3d") asm.setHover(c.id, "list"); };
      li.onmouseleave = () => { if (mode === "3d") asm.setHover(null, "list"); };
      ul.append(li);
    }
  }
  if (!shown) ul.append(el("li", "none", q ? `No part matches “${partsQuery}”.` : "No parts in this group."));
}
$("partsFilter").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b || !A) return;
  partsFilter = b.dataset.f; document.querySelectorAll("#partsFilter button").forEach((x) => x.classList.toggle("on", x === b)); renderParts();
});
$("partsSearch").addEventListener("input", (e) => { partsQuery = e.target.value; if (A) renderParts(); });

function renderStats() { // one quiet line of counts under the title; the numbers count up once
  const seen = A.components.filter((c) => c.status === "observed").length, links = A.relationships.length;
  const box = $("stats"); box.innerHTML = "";
  for (const [n, l, cls] of [[seen, "seen", "observed"], [A.components.length - seen, "inside", "inferred"], [links, "links", "lnk"]]) {
    const s = el("span", "stat " + cls), b = el("b", "", "0"); s.append(b, el("span", "", l)); box.append(s);
    const t0 = performance.now(), up = (now) => { const k = Math.min(1, (now - t0) / 700); b.textContent = Math.round(n * (1 - Math.pow(1 - k, 3))); if (k < 1) requestAnimationFrame(up); };
    requestAnimationFrame(up);
  }
}

function renderDetail() {
  const d = $("detail");
  if (!selected) { d.hidden = true; return; }
  const c = compById(selected); d.hidden = false;
  $("dLabel").textContent = c.label;
  const st = $("dStatus"); st.className = `chip ${c.status}${isVerified(c) ? " verified" : ""}`;
  st.textContent = c.status === "observed" ? "seen in photo" : isVerified(c) ? "verified inside" : c.status;
  $("dType").textContent = c.type.replace(/_/g, " "); $("dThumb").replaceChildren(thumbOf(c, "thumb lg")); d.className = "detail " + (FAMILY[c.type] || "other");
  $("dFunction").hidden = !c.function; $("dFunction").textContent = c.function ? "Does: " + c.function : "";
  $("dIfRemoved").hidden = !c.ifRemoved; $("dIfRemoved").textContent = c.ifRemoved ? "Without it: " + c.ifRemoved : "";
  renderAlts(c);
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
  const movable = mode === "3d" ? asm.parts.some((p) => p.id === c.id) : parts.some((p) => p.id === c.id);
  $("forward").disabled = $("backward").disabled = !movable;
  $("forward").title = mode === "3d" ? "Move this part towards you" : "Draw this layer in front of the others";
  $("backward").title = mode === "3d" ? "Move this part away from you" : "Draw this layer behind the others";
  $("whatif").textContent = removed === c.id ? "Put it back" : "What if I remove it?";
}

// "Could be replaced with": three swaps, each with one advantage and one drawback, built once per selected part
function renderAlts(c) {
  const box = $("dAlts");
  if (box.dataset.id === c.id) { syncAlts(c); return; }
  box.dataset.id = c.id; box.innerHTML = "";
  const alts = alternativesFor(c); box.hidden = !alts.length; if (!alts.length) return;
  const head = el("div", "alts-head"); head.append(el("span", "", "Could be replaced with"), el("span", "alts-note", mode === "3d" ? "tap to try in 3D" : "rules of thumb"));
  const list = el("div", "alts-list");
  alts.forEach((a, i) => {
    const card = el("button", "alt"); card.type = "button"; card.style.setProperty("--i", i); card.dataset.name = a.name;
    const pro = el("div", "pro"), con = el("div", "con");
    pro.append(el("i", "", "+"), el("span", "", a.pro)); con.append(el("i", "", "−"), el("span", "", a.con));
    const top = el("div", "alt-top"); top.append(el("i", "alt-sw"), el("b", "", a.name), el("span", "alt-state", "in 3D"));
    top.querySelector(".alt-sw").style.background = lookFor(a.name).color;
    card.append(top, pro, con);
    card.onclick = () => trySwap(c.id, a.name);
    list.append(card);
  });
  const reset = el("button", "alt-reset", "↺ Back to the original"); reset.type = "button"; reset.onclick = () => trySwap(c.id, null);
  box.append(head, list, reset);
  syncAlts(c);
}
// which replacement (if any) is on the model right now
const swaps = new Map();
function syncAlts(c) {
  const on = swaps.get(c.id) || null, box = $("dAlts");
  box.querySelectorAll(".alt").forEach((b) => b.classList.toggle("on", b.dataset.name === on));
  box.querySelector(".alt-reset")?.toggleAttribute("hidden", !on);
}
function trySwap(id, name) {
  if (mode !== "3d") return;
  if (!name || swaps.get(id) === name) { swaps.delete(id); asm.restorePart(id); }
  else { swaps.set(id, name); asm.swapPart(id, lookFor(name), name); }
  const c = compById(id); syncAlts(c); renderParts();
}

async function select(id) {
  const inScene = mode === "3d" ? asm.parts.some((p) => p.id === id) : parts.some((p) => p.id === id);
  if (id && !inScene && mode !== "3d") { // part lives in another photo -> switch to it
    const vi = viewsOf(A).findIndex((v) => v.layers.some((l) => l.componentId === id));
    if (vi >= 0 && vi !== currentView) await showView(vi);
  }
  selected = id; renderParts(); renderDetail(); renderGraph(); paint(); renderChips();
  if (id && panelTab === "overview") setPanelTab("parts");
  if (id && panelTab === "parts") $("detail").scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function nudge(dir) {
  if (mode === "3d") { if (selected && asm.nudge(selected, dir)) $("resetParts").hidden = false; return; }
  const p = parts.find((q) => q.id === selected); if (!p) return;
  const sorted = [...parts].sort((a, b) => a.score - b.score);
  const i = sorted.indexOf(p), j = i + dir;
  if (j < 0 || j >= sorted.length) return;
  [p.score, sorted[j].score] = [sorted[j].score, p.score];
  if (p.score === sorted[j].score) p.score += dir * 0.01;
  reorder(); applyExplode();
}
$("forward").onclick = () => nudge(1);
addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || !A) return;
  if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || "")) { document.activeElement.blur(); return; } // first Esc leaves the text box
  if (removed) restoreWhatIf(); else if (selected) select(null);
});
$("backward").onclick = () => nudge(-1);

let lastWhatIf = null, whatIfTimers = [];
function restoreWhatIf(instant = false) {
  whatIfTimers.forEach(clearTimeout); whatIfTimers = [];
  const was = removed; removed = null; affected = new Set(); lastWhatIf = null;
  asm.stopWhatIf(instant); $("impact").hidden = true; $("whatifOut").hidden = true;
  if (A && was) { applyExplode(); renderParts(); renderDetail(); renderGraph(); paint(); }
}

$("whatif").onclick = async () => {
  if (removed === selected) return restoreWhatIf();
  if (removed) restoreWhatIf(true);
  const out = $("whatifOut");
  try {
    const r = await fetch(API + "/api/physical/whatif", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ analysisId: A.analysisId, removedComponentId: selected,
                             components: A.components, relationships: A.relationships }) });
    const res = await r.json();
    if (!r.ok) throw new Error(errText(res, r.status));
    removed = selected; affected = new Set(); lastWhatIf = res;
    const delay = (h) => (mode === "3d" ? asm.whatIfDelay(h) : 350 * h);
    if (mode === "3d") { asm.playWhatIf(res); flashStage(); }
    showImpact(res, delay);
    for (const a of res.affected) whatIfTimers.push(setTimeout(() => {
      if (lastWhatIf !== res) return;
      affected.add(a.componentId); renderParts(); renderGraph(); if (mode !== "3d") paint();
    }, delay(a.hops)));
    out.innerHTML = ""; out.append(el("div", "", res.summary));
    if (res.affected.length) {
      const names = res.affected.map((a) => a.label);
      out.append(el("div", "wi-parts", "Affected: " + names.slice(0, 6).join(", ") + (names.length > 6 ? ` and ${names.length - 6} more` : "")));
    }
    out.append(el("div", "method", "Graph-based estimate from the part links, not a physics simulation.")); out.hidden = false;
    applyExplode(); renderParts(); renderDetail(); renderGraph(); paint();
  } catch (e) { showError(e.message); }
};

function flashStage() { const f = $("flash"); f.classList.remove("on"); void f.offsetWidth; f.classList.add("on"); }

const VERDICT = { dead: ["DEVICE DEAD", "It stops working without this part."], degraded: ["DEGRADED", "Parts of it stop working or come loose."],
  works: ["STILL WORKS", "Nothing important depends on this part."] };
function showImpact(res, delay) {
  const box = $("impact"); box.innerHTML = ""; box.className = "impact"; box.hidden = false;
  const comp = compById(res.removedComponentId);
  const R = 34, C = 2 * Math.PI * R;
  const head = el("div", "ih"); head.append(el("span", "", "SYSTEM IMPACT"), el("span", "imethod", "graph what-if · not physics"));
  const ring = el("div", "iring");
  ring.innerHTML = `<svg viewBox="0 0 80 80"><circle cx="40" cy="40" r="${R}" class="trk"/><circle cx="40" cy="40" r="${R}" class="bar" stroke-dasharray="${C}" stroke-dashoffset="0"/></svg><div class="ipct"><b>100</b><span>% working</span></div>`;
  const verdict = el("div", "iv", "TRACING FAILURES…");
  const top = el("div", "itop"); const tv = el("div", "itv"); tv.append(verdict, el("div", "irem", `Removed: ${comp.label}`));
  if (res.consequence) tv.append(el("div", "icons", res.consequence));
  top.append(ring, tv);
  const list = el("ol", "il");
  const btn = el("button", "btn small", "↺ Put it back"); btn.onclick = () => restoreWhatIf();
  box.append(head, top, list, btn);
  const end = Math.max(600, ...res.affected.map((a) => delay(a.hops))) + 500, t0 = performance.now();
  const bar = ring.querySelector(".bar"), num = ring.querySelector("b");
  const tick = () => { // health drains in step with the cascade
    if (lastWhatIf !== res) return;
    const k = Math.min(1, (performance.now() - t0) / end), h = Math.round(100 - (100 - res.health) * (1 - Math.pow(1 - k, 2)));
    num.textContent = h; bar.style.strokeDashoffset = C * (1 - h / 100);
    bar.style.stroke = h > 66 ? "var(--ok)" : h > 33 ? "var(--warn)" : "var(--danger)";
    if (k < 1) requestAnimationFrame(tick);
    else { const [v, sub] = VERDICT[res.verdict] || VERDICT.degraded; verdict.textContent = v; box.classList.add("v-" + res.verdict, "stamped"); verdict.title = sub; }
  };
  requestAnimationFrame(tick);
  if (!res.affected.length) list.append(el("li", "none", "No other part depends on it."));
  for (const a of res.affected) whatIfTimers.push(setTimeout(() => {
    if (lastWhatIf !== res) return;
    const li = el("li", a.severity || "fails");
    li.append(el("b", "", a.label), el("span", "", " " + (a.impact || "is affected")));
    if (a.why) li.append(el("small", "", a.why + (a.uncertain ? " (inferred)" : "")));
    li.onclick = () => select(a.componentId);
    list.append(li);
  }, delay(a.hops)));
}

// ---------------------------------------------------------------- reveal banner
function showReveal() {
  const box = $("reveal"), pr = A.scene.product;
  const hiddenN = (A.scene.ghostComponentIds || []).length, seen = A.components.length - hiddenN;
  const name = pr && (pr.model ? [pr.brand && !pr.model.toLowerCase().startsWith(pr.brand.toLowerCase()) ? pr.brand : "", pr.model].join(" ").trim() : pr.brand);
  box.innerHTML = "";
  box.append(el("div", "rk", A.provider?.name === "curated" ? "SAMPLE · REFERENCE MODEL" : isSample ? "SAMPLE · SCAN REPLAY" : "SCAN COMPLETE"), el("div", "rt", A.title ? A.title[0].toUpperCase() + A.title.slice(1) : "Object"));
  if (name) box.append(el("div", "rs", name + (pr.confidence != null ? ` · ${Math.round(pr.confidence * 100)}% match` : "")));
  const stats = el("div", "rc");
  [[seen, "parts seen"], [hiddenN, "inside (inferred)"], [A.relationships.length, "links"], [(A.scene.assembly?.details || []).length, "details"]].forEach(([n, l]) => {
    const c = el("div", "rstat"); const b = el("b", "", "0"); c.append(b, el("span", "", l)); stats.append(c);
    const t0 = performance.now(); const up = () => { const k = Math.min(1, (performance.now() - t0) / 900); b.textContent = Math.round(n * k); if (k < 1) requestAnimationFrame(up); }; up();
  });
  box.append(stats);
  box.hidden = false; box.classList.remove("out"); void box.offsetWidth; box.classList.add("in");
  clearTimeout(showReveal.t); showReveal.t = setTimeout(() => { box.classList.add("out"); setTimeout(() => (box.hidden = true), 700); }, 5200);
}
$("reveal").addEventListener("click", () => { $("reveal").classList.add("out"); setTimeout(() => ($("reveal").hidden = true), 700); });

// ---------------------------------------------------------------- connections (focus view)
// One part at a time, in plain words: where its power and orders come from, what it runs, and what holds it.
// Clicking any neighbour moves the focus there, so you walk the system instead of reading a hairball.
const REL_IN = { powers: "Gets power from", feeds: "Gets power from", controls: "Controlled by", connected_to: "Gets signals from",
  depends_on: "Needed by", drives: "Driven by", transmits: "Driven by" };
const REL_OUT = { powers: "Powers", feeds: "Powers", controls: "Controls", connected_to: "Sends signals to",
  depends_on: "Needs", drives: "Drives", transmits: "Drives" };
const REL_ORDER = ["Gets power from", "Controlled by", "Gets signals from", "Needs", "Driven by", "Powers", "Controls", "Sends signals to", "Drives", "Needed by"];
const REL_KIND = { "Gets power from": "power", Powers: "power", "Driven by": "motion", Drives: "motion" }; // the rest carry signals
const UPSTREAM = new Set(["Gets power from", "Controlled by", "Gets signals from", "Needs", "Driven by"]);
const HOLD = new Set(["supports", "mounts", "contains", "attached_to", "covers", "adjacent_to"]);
function degrees() { const d = {}; for (const r of A.relationships) { d[r.from] = (d[r.from] || 0) + 1; d[r.to] = (d[r.to] || 0) + 1; } return d; }
function hubId() { // the most connected part is the natural place to start
  const deg = degrees(); return [...A.components].sort((a, b) => (deg[b.id] || 0) - (deg[a.id] || 0))[0]?.id;
}
function thumbOf(c, cls = "thumb") { // photo cut-out when the part was seen, a soft family-coloured ghost when inferred
  const th = el("span", cls + (c.status === "observed" ? "" : " ghost")), src = cutoutOf(c.id);
  if (src) { const im = el("img"); im.src = src; im.alt = ""; im.loading = "lazy"; th.append(im); }
  return th;
}
const nameList = (ids) => { const n = ids.map((id) => compById(id).label); return n.length <= 2 ? n.join(" and ") : `${n.slice(0, 2).join(", ")} and ${n.length - 2} more`; };
function relGroups(fid) {
  const groups = new Map(), holds = [];
  for (const r of A.relationships) {
    let label = null, other = null;
    if (r.to === fid && REL_IN[r.type]) [label, other] = [REL_IN[r.type], r.from];
    else if (r.from === fid && REL_OUT[r.type]) [label, other] = [REL_OUT[r.type], r.to];
    else if ((r.from === fid || r.to === fid) && HOLD.has(r.type)) { const o = r.from === fid ? r.to : r.from; if (compById(o) && !holds.some(([, x]) => x === o)) holds.push([r, o]); continue; }
    if (!label || !compById(other) || other === fid) continue;
    if (!groups.has(label)) groups.set(label, []);
    const g = groups.get(label); if (!g.some(([, x]) => x === other)) g.push([r, other]);
  }
  const wired = new Set([...groups.values()].flat().map(([, id]) => id));
  return { holds: holds.filter(([, id]) => !wired.has(id)), groups: REL_ORDER.filter((l) => groups.has(l)).map((l) => [l, groups.get(l)]) };
}
function renderGraph() { renderLinks(); renderOverview(); }
let linkTrail = [];
function renderLinks() {
  const box = $("links"); if (!box || !A) return;
  const fid = selected && compById(selected) ? selected : hubId(); const f = compById(fid);
  box.innerHTML = ""; if (!f) return;
  if (linkTrail[linkTrail.length - 1] !== fid) { linkTrail = linkTrail.filter((id) => id !== fid && compById(id)); linkTrail.push(fid); linkTrail = linkTrail.slice(-5); }
  const { groups, holds } = relGroups(fid);
  const nIn = groups.filter(([l]) => UPSTREAM.has(l)).reduce((s, [, g]) => s + g.length, 0), nOut = groups.reduce((s, [, g]) => s + g.length, 0) - nIn;

  // where you have been: a short trail to step back along
  if (linkTrail.length > 1) {
    const tr = el("div", "lk-trail");
    linkTrail.forEach((id, i) => {
      if (i) tr.append(el("span", "lk-sep", "›"));
      const b = el("button", "lk-crumb" + (id === fid ? " on" : ""), compById(id).label); b.type = "button";
      if (id !== fid) b.onclick = () => select(id);
      tr.append(b);
    });
    box.append(tr);
  }

  // the focused part, with one sentence that says what it is plugged into
  const fam = FAMILY[f.type] || "other";
  const fc = el("div", "lk-focus " + fam);
  const ft = el("div", "lk-ftop"); ft.append(thumbOf(f, "thumb lg"));
  const fn = el("div", "lk-fname"); fn.append(el("span", "lk-ftype", f.type.replace(/_/g, " ") + (f.status !== "observed" ? " · inferred" : "")), el("strong", "", f.label));
  ft.append(fn); fc.append(ft);
  const sentence = groups.slice(0, 2).map(([l, g]) => `${l} ${nameList(g.map(([, id]) => id))}`).join(". ");
  fc.append(el("p", "lk-say", sentence ? sentence + "." : holds.length ? `A structural part, held with ${nameList(holds.map(([, id]) => id))}.` : "Nothing is wired to it directly."));
  const meta = el("div", "lk-meta");
  meta.append(el("span", "m-in", `${nIn} in`), el("span", "m-out", `${nOut} out`), el("span", "", `${holds.length} held`));
  fc.append(meta);
  const acts = el("div", "lk-acts");
  const go = (tab) => async () => { if (selected !== fid) await select(fid); setPanelTab(tab); };
  const b1 = el("button", "btn small ghost", "Part details"); b1.type = "button"; b1.onclick = go("parts");
  const b2 = el("button", "btn small ghost", "Ask about it"); b2.type = "button"; b2.onclick = go("ask");
  acts.append(b1, b2); fc.append(acts);
  if (!selected) fc.append(el("div", "lk-hint", "Showing the most connected part. Pick any part to follow its connections."));
  fc.onmouseenter = () => { if (mode === "3d") asm.setHover(fid, "links"); };
  fc.onmouseleave = () => { if (mode === "3d") asm.setHover(null, "links"); };
  box.append(fc);

  // one tidy section per kind of link
  let k = 0;
  for (const [label, items] of groups) {
    const sec = el("section", `lk-sec ${REL_KIND[label] || "control"} ${UPSTREAM.has(label) ? "in" : "out"}`);
    const cap = el("div", "lk-cap"); cap.append(el("i", "lk-glyph"), el("span", "", label), el("span", "lk-n", String(items.length)));
    sec.append(cap);
    for (const [r, id] of items) {
      const c = compById(id), row = el("button", ["lk-row", FAMILY[c.type] || "other", r.status !== "observed" && "inf", affected.has(id) && "hit", id === removed && "gone"].filter(Boolean).join(" "));
      row.type = "button"; row.style.animationDelay = Math.min(k++, 14) * 30 + "ms";
      const nm = el("span", "pname"); nm.append(el("b", "", c.label), el("small", "", c.type.replace(/_/g, " ")));
      row.append(thumbOf(c), nm, r.status !== "observed" ? el("span", "lk-tag", "inferred") : el("span", "chev", "›"));
      row.title = (r.evidence || []).join(" · ");
      row.onclick = () => select(id);
      row.onmouseenter = () => { if (mode === "3d") asm.setHover(id, "links"); };
      row.onmouseleave = () => { if (mode === "3d") asm.setHover(null, "links"); };
      sec.append(row);
    }
    box.append(sec);
  }
  if (!groups.length && !holds.length) box.append(el("div", "lk-empty", "No links were found for this part."));
  if (holds.length) {
    const hg = el("section", "lk-sec hold"); const cap = el("div", "lk-cap"); cap.append(el("i", "lk-glyph"), el("span", "", "Held with"), el("span", "lk-n", String(holds.length)));
    const row = el("div", "lk-chips");
    for (const [r, id] of holds) {
      const c = compById(id), b = el("button", "lk-chip" + (r.status !== "observed" ? " inf" : "")); b.type = "button";
      b.append(thumbOf(c, "thumb xs"), el("span", "", c.label)); b.onclick = () => select(id);
      b.onmouseenter = () => { if (mode === "3d") asm.setHover(id, "links"); }; b.onmouseleave = () => { if (mode === "3d") asm.setHover(null, "links"); };
      row.append(b);
    }
    hg.append(cap, row); box.append(hg);
  }
}

// ---------------------------------------------------------------- overview: how it works, at a glance
function powerPath() { // power source -> the part it feeds (usually the board) -> what that part runs
  const outs = (id, types) => A.relationships.filter((r) => r.from === id && types.includes(r.type)).map((r) => r.to).filter((x) => compById(x));
  const srcs = A.components.filter((c) => c.type === "power_source" && outs(c.id, ["powers", "feeds"]).length);
  const src = srcs[0] || A.components.find((c) => outs(c.id, ["powers", "feeds"]).length); if (!src) return null;
  const fed = outs(src.id, ["powers", "feeds"]);
  const brain = fed.map(compById).find((c) => c.type === "controller") || compById(fed[0]);
  const work = [...new Set(outs(brain.id, ["controls", "drives", "powers", "feeds", "connected_to", "transmits"]))].filter((x) => x !== src.id && x !== brain.id);
  return { src, brain, work };
}
function renderOverview() {
  const box = $("flow"); if (!box || !A) return; box.innerHTML = "";
  const p = powerPath();
  if (p) {
    const sec = el("section", "ov-sec"); sec.append(el("div", "ov-cap", "How it works"));
    const chain = el("div", "ov-chain");
    const step = (kind, title, c, extra) => {
      const s = el("button", "ov-step " + kind); s.type = "button";
      const t = el("span", "pname"); t.append(el("small", "", title), el("b", "", c.label)); s.append(thumbOf(c), t);
      if (extra) s.append(el("span", "ov-more", extra));
      s.onclick = () => select(c.id);
      s.onmouseenter = () => { if (mode === "3d") asm.setHover(c.id, "links"); }; s.onmouseleave = () => { if (mode === "3d") asm.setHover(null, "links"); };
      return s;
    };
    chain.append(step("power", "Power comes from", p.src));
    if (p.brain.id !== p.src.id) chain.append(el("span", "ov-link power"), step("control", "It feeds", p.brain));
    if (p.work.length) {
      chain.append(el("span", "ov-link control"));
      const w = el("div", "ov-work"); w.append(el("small", "", "Which runs"));
      const row = el("div", "lk-chips");
      p.work.slice(0, 6).forEach((id) => { const c = compById(id), b = el("button", "lk-chip"); b.type = "button"; b.append(thumbOf(c, "thumb xs"), el("span", "", c.label)); b.onclick = () => select(id); row.append(b); });
      if (p.work.length > 6) row.append(el("span", "ov-more", `+${p.work.length - 6}`));
      w.append(row); chain.append(w);
    }
    sec.append(chain); box.append(sec);
  }
  const deg = degrees(), key = [...A.components].filter((c) => deg[c.id]).sort((a, b) => (deg[b.id] || 0) - (deg[a.id] || 0)).slice(0, 4);
  if (key.length) {
    const sec = el("section", "ov-sec"); sec.append(el("div", "ov-cap", "Key parts"));
    const grid = el("div", "ov-grid");
    key.forEach((c, i) => {
      const t = el("button", "ov-tile " + (FAMILY[c.type] || "other")); t.type = "button"; t.style.animationDelay = i * 60 + "ms";
      const nm = el("span", "pname"); nm.append(el("b", "", c.label), el("small", "", `${deg[c.id]} links · ${c.status === "observed" ? "seen" : "inside"}`));
      t.append(thumbOf(c), nm); t.onclick = () => select(c.id);
      t.onmouseenter = () => { if (mode === "3d") asm.setHover(c.id, "links"); }; t.onmouseleave = () => { if (mode === "3d") asm.setHover(null, "links"); };
      grid.append(t);
    });
    sec.append(grid); box.append(sec);
  }
}

// ---------------------------------------------------------------- panel tabs
let panelTab = "parts";
function setPanelTab(t) {
  panelTab = t;
  document.querySelectorAll("#ptabs button").forEach((b) => { const on = b.dataset.tab === t; b.classList.toggle("on", on); b.setAttribute("aria-selected", on); });
  document.querySelectorAll(".pview").forEach((v) => { const on = v.dataset.view === t; v.hidden = !on; v.classList.toggle("on", on); });
  moveInk();
  if (t === "links") renderLinks();
}
function moveInk() { // the underline slides to the active tab
  const b = document.querySelector("#ptabs button.on"), ink = $("ptabInk"); if (!b || !ink) return;
  ink.style.width = b.offsetWidth + "px"; ink.style.transform = `translateX(${b.offsetLeft}px)`;
}
$("ptabs").addEventListener("click", (e) => { const b = e.target.closest("button[data-tab]"); if (b) setPanelTab(b.dataset.tab); });
addEventListener("resize", moveInk);

// ---------------------------------------------------------------- chat: ask about the object and its parts
// Answers come from the server's grounded chat over this analysis (parts, links, functions); the photo is not resent.
let chatBusy = false;
function resetChat() {
  $("chatLog").innerHTML = "";
  const hi = el("div", "chat-hello");
  hi.append(el("div", "ch-mark"), el("b", "", `Ask about this ${A.title || "object"}`),
    el("span", "", "What a part does, how it is powered, or what breaks without it. Answers come only from this analysis."));
  $("chatLog").append(hi);
  renderChips();
}
function chatMsg(who, text, refs = []) {
  $("chatLog").querySelector(".chat-hello")?.classList.add("gone");
  const m = el("div", "msg " + who);
  const bub = el("div", "bubble");
  if (who.includes("pending")) { bub.append(el("i"), el("i"), el("i")); bub.setAttribute("aria-label", "Thinking"); }
  else bub.textContent = text;
  m.append(bub);
  if (refs.length) {
    const row = el("div", "refs");
    for (const id of refs) {
      const c = compById(id); if (!c) continue;
      const b = el("button", "ref"); b.type = "button"; b.append(thumbOf(c, "thumb xs"), el("span", "", c.label)); b.onclick = () => select(id);
      b.onmouseenter = () => { if (mode === "3d") asm.setHover(id, "links"); }; b.onmouseleave = () => { if (mode === "3d") asm.setHover(null, "links"); };
      row.append(b);
    }
    m.append(row);
  }
  $("chatLog").append(m); $("chatLog").scrollTo({ top: $("chatLog").scrollHeight, behavior: "smooth" });
  return m;
}
function renderChips() {
  if (!A) return;
  const c = selected && compById(selected), box = $("chatChips"), ctx = $("chatCtx"); box.innerHTML = ""; ctx.innerHTML = "";
  if (c) {
    const pill = el("div", "ctx-pill " + (FAMILY[c.type] || "other"));
    const x = el("button", "ctx-x", "×"); x.type = "button"; x.title = "Ask about the whole object"; x.onclick = () => select(null);
    pill.append(thumbOf(c, "thumb xs"), el("span", "", "Asking about "), el("b", "", c.label), x);
    ctx.append(pill);
  }
  const qs = c ? [`What does the ${c.label} do?`, `What stops working without the ${c.label}?`, `What is the ${c.label} connected to?`]
    : ["How does it work?", "What powers it?", "Which part is the most important?"];
  for (const q of qs) { const b = el("button", "chip-q"); b.type = "button"; b.append(el("span", "", q), el("i", "", "↗")); b.onclick = () => ask(q); box.append(b); }
}
async function ask(q) {
  if (!A || chatBusy || !q.trim()) return;
  chatBusy = true; $("chatSend").disabled = true; $("chatBlock").classList.add("busy");
  chatMsg("me", q);
  const wait = chatMsg("bot pending", "");
  try {
    const r = await fetch(API + `/api/analysis/${encodeURIComponent(A.analysisId)}/chat`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: q.slice(0, 1000), selectedComponentIds: selected ? [selected] : [] }) });
    const d = await r.json().catch(() => ({}));
    if (r.status === 404) throw new Error("The server was restarted and forgot this object. Load the sample or the photos again.");
    if (!r.ok) throw new Error(errText(d, r.status));
    wait.remove(); chatMsg("bot", d.answer, (d.referencedComponentIds || []).filter((id) => id !== selected).slice(0, 6));
  } catch (e) { wait.remove(); chatMsg("bot err", e.message || "Could not get an answer."); }
  finally { chatBusy = false; $("chatSend").disabled = false; $("chatBlock").classList.remove("busy"); }
}
$("chatForm").addEventListener("submit", (e) => { e.preventDefault(); const q = $("chatInput").value.trim(); if (q) { $("chatInput").value = ""; ask(q); } });

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
// ---------------------------------------------------------------- iFixit teardown photos (CC BY-NC-SA, credited)
async function showTeardowns(query, btn, topic = "") {
  const box = $("teardown"); box.innerHTML = ""; btn.disabled = true; btn.textContent = "Searching iFixit…";
  try {
    const r = await fetch(API + "/api/physical/teardown?q=" + encodeURIComponent(query) + "&topic=" + encodeURIComponent(topic)); const d = await r.json();
    if (!r.ok) throw new Error(errText(d, r.status));
    const guides = d.guides.filter((g) => g.images.length);
    if (!guides.length) { box.append(el("div", "td-empty", `No teardown of a ${topic || "matching product"} on iFixit yet. Upload a photo of the inside instead.`)); return; }
    const picked = new Set();
    for (const g of guides.slice(0, 1)) { // the best match only: a wall of photos from other products helps no one
      const head = el("div", "td-head"); const link = el("a", "", g.title); link.href = g.url; link.target = "_blank"; link.rel = "noopener";
      head.append(link, el("span", "", `by ${g.author} · CC BY-NC-SA`)); box.append(head);
      const grid = el("div", "tgrid");
      for (const im of g.images.slice(0, 8)) {
        const t = el("img"); t.src = im.thumb; t.alt = im.caption || `Step ${im.step}`; t.title = `Step ${im.step}: ${im.caption}`; t.loading = "lazy";
        t.onclick = () => {
          if (picked.has(im.url)) { picked.delete(im.url); t.classList.remove("on"); }
          else if (picked.size < 3) { picked.add(im.url); t.classList.add("on"); }
          add.disabled = !picked.size || isSample; add.textContent = `Add ${picked.size || ""} to the model`.replace("  ", " ");
        };
        grid.append(t);
      }
      box.append(grid);
    }
    const add = el("button", "btn small primary", "Add to the model"); add.disabled = true; add.hidden = isSample;
    add.onclick = async () => {
      add.disabled = true; add.textContent = "Downloading…";
      const blobs = [];
      let n = 0;
      for (const u of picked) {
        add.textContent = `Downloading ${++n} of ${picked.size}…`;
        const r = await fetch(API + "/api/physical/teardown/image?u=" + encodeURIComponent(u));
        if (r.ok) blobs.push(await shrink(new File([await r.blob()], "teardown.jpg", { type: "image/jpeg" })));
      }
      add.textContent = `Add ${picked.size} to the model`; add.disabled = false;
      const all = currentFiles.concat(blobs).slice(0, 4);
      if (blobs.length) analyze(all, { added: blobs });
    };
    box.append(add, el("div", "td-note", isSample ? "Reference photos only in sample mode. Upload your own photos to add these to the model."
      : "Pick up to 3 photos that show the inside, then add them to the model."));
  } catch (err) { box.append(el("div", "tiny muted", "iFixit search failed: " + err.message)); }
  finally { btn.disabled = false; btn.textContent = "Find teardown photos (iFixit)"; }
}

let currentFiles = []; // shrunk blobs of the current object (re-sent on "Add photo"; server caches each photo)

async function analyze(files, { added = null, hint = "" } = {}) {
  try {
    const LIVE = ["Uploading photo", files.length > 1 ? `AI finding parts in ${files.length} photos` : "AI finding parts & tracing outlines",
      "Identifying the exact model", "Designing 3D parts, internals & wiring", "Building the scene"];
    steps(0, 0, LIVE); startScan(files[0]);
    const fd = new FormData();
    files.forEach((b, i) => fd.append("images", b, `photo${i + 1}.jpg`));
    if (hint) fd.append("model_hint", hint);
    steps(1, 3, LIVE);
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 300000);
    let r;
    try { r = await fetch(API + "/api/physical/analyze", { method: "POST", body: fd, signal: ctl.signal }); }
    catch (err) { throw new Error(err.name === "AbortError" ? "The analysis took over 5 minutes and was stopped. Please try again." : "Can't reach the server. Is uvicorn running?"); }
    finally { clearTimeout(timer); }
    const data = await r.json().catch(() => ({}));
    if (!r.ok && added && data.error && data.error.code === "different_object") {
      // the added photo is another product: analyse it on its own instead of merging two objects
      showError("That photo shows a different object, so it gets its own analysis.");
      return analyze(added);
    }
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
  if (all.length > currentFiles.length) analyze(all, { added: blobs.slice(0, 4) });
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
    steps(1); startScan(null);
    const r = await fetch(API + "/api/physical/samples/" + encodeURIComponent(id)); const d = await r.json();
    if (!r.ok) throw new Error(errText(d, r.status));
    await build(d, { sample: true });
  } catch (err) { $("loading").hidden = true; showError(err.message); }
});
loadSamples();

// ---------------------------------------------------------------- loop
$("spin").addEventListener("change", (e) => { controls.autoRotate = e.target.checked; });
controls.addEventListener("start", () => { if (controls.autoRotate) { controls.autoRotate = false; $("spin").checked = false; } });
// The 3D model view redraws only while something moves (orbiting, animations, dragging, hovering);
// a still page does no work, which keeps slower laptops responsive.
for (const ev of ["pointermove", "pointerdown", "pointerup", "wheel", "keydown", "input", "change", "click", "resize"]) addEventListener(ev, () => asm.poke(), { passive: true });
controls.addEventListener("change", () => asm.poke());
renderer.setAnimationLoop(() => {
  controls.update();
  if (mode === "3d" && asm.root.visible && !controls.autoRotate && !drag && !asm.busy()) return;
  if (!asm.renderScene()) renderer.render(scene3, camera);
  asm.render();
});
window.__vre = { build, asm, get state() { return { mode, parts: mode === "3d" ? asm.parts.length : parts.length, ghosts: ghosts.length, selected, removed, affected: [...affected] }; }, select };
