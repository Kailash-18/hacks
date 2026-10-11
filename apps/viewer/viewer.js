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
  A = analysis; isSample = sample; selected = removed = null; affected = new Set();
  for (const k in depthCache) delete depthCache[k];
  if (!A.scene) { showError("This analysis has no physical scene data."); return; }
  renderPanel();
  $("explode").value = 0;
  restoreWhatIf(true);
  $("xray").checked = false; asm.setXray(false);
  const has3D = A.scene.assembly && A.scene.assembly.parts.length;
  if (has3D) asm.build(A.scene.assembly, A.components, viewsOf(A), A.relationships);
  $("empty").hidden = true; $("controls").hidden = false; $("panel").hidden = false; steps(STEP_NAMES.length);
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
    e.value = from + (target - from) * ease; applyExplode(); paintSlider();
    if (k < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
$("explode").addEventListener("input", applyExplode);
// the slider track fills up to the grip
const paintSlider = () => { const e = $("explode"); e.style.setProperty("--fill", e.value * 100 + "%"); };
$("explode").addEventListener("input", paintSlider);
// callouts and the 3D model share the hover: the matching row in the parts list lights up too
asm.onPick = (id) => select(id);
canvas.addEventListener("pointerleave", () => { $("hover").hidden = true; if (mode === "3d") asm.setHover(null, "canvas"); });
asm.onHover = (id) => { for (const li of $("parts").children) li.classList.toggle("hov", li.dataset.id === id); };

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
  mb.textContent = isSample ? "Sample mode · saved real result" : "Live analysis";
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
    tb.onclick = () => showTeardowns(name || pr.searchQuery, tb); // brand + model searches best on iFixit
    pe.append(tb, Object.assign(el("div", "teardown"), { id: "teardown" }));
    pe.hidden = false;
  } else pe.hidden = true;
  renderParts(); renderGraph(); renderDetail(); resetChat();
}

function renderParts() {
  const ul = $("parts"); ul.innerHTML = "";
  for (const c of A.components) {
    const li = el("li", [c.id === selected && "sel", affected.has(c.id) && "affected", c.id === removed && "removed"].filter(Boolean).join(" "));
    li.append(el("i", `st ${c.status}`), el("span", "", c.label), el("span", "type", c.type));
    li.onclick = () => select(c.id);
    li.dataset.id = c.id;
    li.onmouseenter = () => { if (mode === "3d") asm.setHover(c.id, "list"); };
    li.onmouseleave = () => { if (mode === "3d") asm.setHover(null, "list"); };
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
  $("dFunction").hidden = !c.function; $("dFunction").textContent = c.function ? "Does: " + c.function : "";
  $("dIfRemoved").hidden = !c.ifRemoved; $("dIfRemoved").textContent = c.ifRemoved ? "Without it: " + c.ifRemoved : "";
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

async function select(id) {
  const inScene = mode === "3d" ? asm.parts.some((p) => p.id === id) : parts.some((p) => p.id === id);
  if (id && !inScene) { // part lives in another photo -> switch to it
    const vi = viewsOf(A).findIndex((v) => v.layers.some((l) => l.componentId === id));
    if (vi >= 0 && vi !== currentView) await showView(vi);
  }
  selected = id; renderParts(); renderDetail(); renderGraph(); paint(); renderChips();
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
    res.affected.forEach((a) => out.append(el("code", "", a.explanation + (a.uncertain ? "  (inferred link)" : ""))));
    out.append(el("div", "method", res.method)); out.hidden = false;
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
  box.append(el("div", "rk", isSample ? "SAMPLE · SCAN REPLAY" : "SCAN COMPLETE"), el("div", "rt", A.title ? A.title[0].toUpperCase() + A.title.slice(1) : "Object"));
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

const EDGE_COL = { powers: "#ffb020", feeds: "#ffb020", controls: "#36d6ff", connected_to: "#36d6ff", depends_on: "#9b8cff", drives: "#ff5fd2",
  transmits: "#ff5fd2", supports: "#8fa3bf", mounts: "#8fa3bf", contains: "#8fa3bf", attached_to: "#8fa3bf", covers: "#8fa3bf", adjacent_to: "#8fa3bf" };
// where each kind of part sits around the hub (degrees, 0 = right): power above, outputs right, inputs left, structure below
const ROLE_ANGLE = { power_source: -90, controller: -50, display: -15, interface: 15, mechanism: 35, actuator: 200, sensor: 160, wheel: 180,
  connector: -130, cable: -140, structure: 90, cover: 110, fastener: 70 };
const GW = 340; let GH = 300;
let graphLayout = { id: null, pos: {} };
const hashTxt = (t) => { let h = 7; for (const ch of t) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h; };
function layoutGraph() { // small deterministic force layout: linked parts cluster, everything stays readable
  const cs = A.components, n = cs.length, pos = {};
  GH = Math.round(290 + Math.max(0, n - 6) * 22); // taller canvas for bigger systems
  $("graph").setAttribute("viewBox", `0 0 ${GW} ${GH}`);
  // seed: the most connected part (usually the main board) in the middle, its neighbours on a ring grouped by role
  const deg = {}; for (const r of A.relationships) { deg[r.from] = (deg[r.from] || 0) + 1; deg[r.to] = (deg[r.to] || 0) + 1; }
  const hub = [...cs].sort((a, b) => (deg[b.id] || 0) - (deg[a.id] || 0) || (b.type === "controller") - (a.type === "controller"))[0];
  const nb = new Set(A.relationships.flatMap((r) => (r.from === hub.id ? [r.to] : r.to === hub.id ? [r.from] : [])));
  const ring = (list, R) => {
    const ang = (c) => (ROLE_ANGLE[c.type] ?? 45 + (hashTxt(c.id) % 90)) * Math.PI / 180;
    const sorted = [...list].sort((a, b) => ang(a) - ang(b));
    sorted.forEach((c, i) => { // keep the role direction but spread evenly so nodes never start on top of each other
      const a = 0.5 * ang(c) + 0.5 * (-Math.PI / 2 + (i / Math.max(1, sorted.length)) * Math.PI * 2);
      pos[c.id] = { x: GW / 2 + R * 1.15 * Math.cos(a), y: GH / 2 + R * Math.sin(a) };
    });
  };
  pos[hub.id] = { x: GW / 2, y: GH / 2 };
  ring(cs.filter((c) => nb.has(c.id)), Math.min(GW, GH) * 0.3);
  ring(cs.filter((c) => c.id !== hub.id && !nb.has(c.id)), Math.min(GW, GH) * 0.44);
  const edges = A.relationships.filter((r) => pos[r.from] && pos[r.to]);
  const k = Math.sqrt((GW * GH) / Math.max(1, n)) * 0.95;
  for (let it = 0; it < 260; it++) {
    const temp = 7 * (1 - it / 260) + 0.4, disp = {};
    for (const c of cs) disp[c.id] = { x: 0, y: 0 };
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const a = pos[cs[i].id], b = pos[cs[j].id]; let dx = a.x - b.x, dy = a.y - b.y; const d = Math.max(1, Math.hypot(dx, dy));
      const f = (k * k) / d * (1 + 0.08 * Math.min(deg[cs[i].id] || 0, deg[cs[j].id] || 0)); dx /= d; dy /= d; // hubs push each other apart
      disp[cs[i].id].x += dx * f; disp[cs[i].id].y += dy * f; disp[cs[j].id].x -= dx * f; disp[cs[j].id].y -= dy * f;
    }
    for (const e of edges) {
      const a = pos[e.from], b = pos[e.to]; let dx = a.x - b.x, dy = a.y - b.y; const d = Math.max(1, Math.hypot(dx, dy));
      const f = (d * d) / k; dx /= d; dy /= d;
      disp[e.from].x -= dx * f; disp[e.from].y -= dy * f; disp[e.to].x += dx * f; disp[e.to].y += dy * f;
    }
    for (const c of cs) {
      const p = pos[c.id], d = disp[c.id]; d.x += (GW / 2 - p.x) * 0.9; d.y += (GH / 2 - p.y) * 0.9;
      const m = Math.max(1, Math.hypot(d.x, d.y));
      p.x = Math.min(GW - 34, Math.max(34, p.x + (d.x / m) * Math.min(m, temp)));
      p.y = Math.min(GH - 22, Math.max(18, p.y + (d.y / m) * Math.min(m, temp)));
    }
  }
  // labels: try below / above / right / left of each node, skip ones that would overlap (hover shows them)
  const boxes = cs.map((c) => { const p = pos[c.id], r = 5 + (c.importance ?? 0.45) * 7; return { x0: p.x - r, y0: p.y - r, x1: p.x + r, y1: p.y + r }; });
  const hit = (b) => boxes.some((o) => b.x0 < o.x1 && b.x1 > o.x0 && b.y0 < o.y1 && b.y1 > o.y0);
  const labels = {};
  const order = [...cs].sort((a, b) => (b.importance ?? 0.45) - (a.importance ?? 0.45));
  for (const c of order) {
    const p = pos[c.id], r = 5 + (c.importance ?? 0.45) * 7, text = c.label.length > 16 ? c.label.slice(0, 15) + "…" : c.label;
    const w = text.length * 4.6 + 4, h = 10;
    const tries = [[p.x, p.y + r + 10, "middle"], [p.x, p.y - r - 4, "middle"], [p.x + r + 3, p.y + 3, "start"], [p.x - r - 3, p.y + 3, "end"]];
    for (const [x, y, anchor] of tries) {
      const x0 = anchor === "middle" ? x - w / 2 : anchor === "start" ? x : x - w;
      const b = { x0, y0: y - h + 2, x1: x0 + w, y1: y + 2 };
      if (b.x0 < 0 || b.x1 > GW || b.y0 < 0 || b.y1 > GH || hit(b)) continue;
      boxes.push(b); labels[c.id] = { x, y, anchor, text }; break;
    }
  }
  graphLayout = { id: A.analysisId + ":" + n + ":" + edges.length, pos, labels };
}

function renderGraph() {
  const svg = $("graph"); svg.innerHTML = "";
  const NS = "http://www.w3.org/2000/svg", cs = A.components;
  if (graphLayout.id !== A.analysisId + ":" + cs.length + ":" + A.relationships.length) layoutGraph();
  const pos = graphLayout.pos;
  $("graphStats").textContent = `${cs.length} parts · ${A.relationships.length} links`;
  const mk = (tag, attrs, parent = svg) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); parent.append(e); return e; };
  const defs = mk("defs", {});
  const colors = new Set([...Object.values(EDGE_COL), "#5b6472", "#ff4a3a"]);
  for (const c of colors) {
    const m = mk("marker", { id: "arr" + c.slice(1), viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 5, markerHeight: 5, orient: "auto-start-reverse" }, defs);
    mk("path", { d: "M0,0L10,5L0,10z", fill: c }, m);
  }
  const rad = (c) => 5 + (c.importance ?? 0.45) * 7;
  const hot = (r) => affected.has(r.to) && (r.from === removed || affected.has(r.from));
  const touch = (r) => selected && (r.from === selected || r.to === selected);
  const eg = mk("g", {});
  for (const r of A.relationships) {
    const a = pos[r.from], b = pos[r.to]; if (!a || !b) continue;
    const ca = compById(r.from), cb = compById(r.to);
    const dx = b.x - a.x, dy = b.y - a.y, d = Math.max(1, Math.hypot(dx, dy));
    const ra = rad(ca) + 2, rb = rad(cb) + 4;
    const x1 = a.x + (dx / d) * ra, y1 = a.y + (dy / d) * ra, x2 = b.x - (dx / d) * rb, y2 = b.y - (dy / d) * rb;
    const mx = (x1 + x2) / 2 - (dy / d) * d * 0.12, my = (y1 + y2) / 2 + (dx / d) * d * 0.12; // gentle curve
    const col = hot(r) ? "#ff4a3a" : EDGE_COL[r.type] || "#5b6472";
    const dim = selected && !touch(r) && !hot(r);
    const path = mk("path", { d: `M${x1},${y1} Q${mx},${my} ${x2},${y2}`, fill: "none", stroke: col, "stroke-width": hot(r) ? 2.2 : touch(r) ? 1.9 : 1.3,
      opacity: dim ? 0.18 : 0.9, "marker-end": `url(#arr${col.slice(1)})`, class: "gedge" + (hot(r) ? " hot" : "") }, eg);
    if (r.status !== "observed" && !hot(r)) path.setAttribute("stroke-dasharray", "4 3");
    mk("title", {}, path).textContent = `${ca.label} ${r.type.replace(/_/g, " ")} ${cb.label}${r.evidence[0] ? " — " + r.evidence[0] : ""}`;
  }
  const colorsN = { observed: "#3ccf8e", inferred: "#9b8cff", estimated: "#4f8cff", unknown: "#8b93a1" };
  for (const c of cs) {
    const p = pos[c.id]; if (!p) continue;
    const g = mk("g", { class: "node" + (affected.has(c.id) ? " hit" : "") + (c.id === removed ? " gone" : "") });
    g.onclick = () => select(c.id);
    const dim = selected && c.id !== selected && !A.relationships.some((r) => (r.from === selected && r.to === c.id) || (r.to === selected && r.from === c.id));
    g.setAttribute("opacity", dim ? 0.35 : 1);
    if (c.id === selected) mk("circle", { cx: p.x, cy: p.y, r: rad(c) + 5, fill: "none", stroke: "#4f8cff", "stroke-width": 2, class: "gsel" }, g);
    mk("circle", { cx: p.x, cy: p.y, r: rad(c), fill: c.id === removed ? "#2a2d33" : affected.has(c.id) ? "#ff4a3a" : colorsN[c.status],
      stroke: c.id === removed ? "#ff4a3a" : "rgba(0,0,0,.35)", "stroke-width": c.id === removed ? 2 : 1 }, g);
    if (c.id === removed) mk("path", { d: `M${p.x - 4},${p.y - 4}L${p.x + 4},${p.y + 4}M${p.x + 4},${p.y - 4}L${p.x - 4},${p.y + 4}`, stroke: "#ff4a3a", "stroke-width": 2 }, g);
    const L = graphLayout.labels[c.id];
    if (L || c.id === selected) { // overlapping labels stay hidden; hover or select a node to read it
      const l = L || { x: p.x, y: p.y + rad(c) + 10, anchor: "middle", text: c.label };
      const t = mk("text", { x: l.x, y: l.y, "text-anchor": l.anchor, class: "glabel" + (L ? "" : " gfloat") }, g);
      t.textContent = l.text;
    }
    mk("title", {}, g).textContent = `${c.label} (${c.type}, ${c.status})${c.function ? " — " + c.function : ""}`;
  }
}

// ---------------------------------------------------------------- chat: ask about the object and its parts
// Answers come from the server's grounded chat over this analysis (parts, links, functions); the photo is not resent.
let chatBusy = false;
function resetChat() {
  $("chatLog").innerHTML = "";
  chatMsg("bot", `Ask me anything about this ${A.title || "object"}: what a part does, how it is powered, or what breaks without it.`);
  renderChips();
}
function chatMsg(who, text, refs = []) {
  const m = el("div", "msg " + who);
  m.append(el("div", "bubble", text));
  if (refs.length) {
    const row = el("div", "refs");
    for (const id of refs) { const c = compById(id); if (!c) continue; const b = el("button", "ref", c.label); b.type = "button"; b.onclick = () => select(id); row.append(b); }
    m.append(row);
  }
  $("chatLog").append(m); $("chatLog").scrollTop = $("chatLog").scrollHeight;
  return m;
}
function renderChips() {
  if (!A) return;
  const c = selected && compById(selected), box = $("chatChips"); box.innerHTML = "";
  $("chatCtx").textContent = c ? `about: ${c.label}` : "";
  const qs = c ? [`What does the ${c.label} do?`, `What stops working without the ${c.label}?`, `What is the ${c.label} connected to?`]
    : ["How does it work?", "What powers it?", "Which part is the most important?"];
  for (const q of qs) { const b = el("button", "chip-q", q); b.type = "button"; b.onclick = () => ask(q); box.append(b); }
}
async function ask(q) {
  if (!A || chatBusy || !q.trim()) return;
  chatBusy = true; $("chatSend").disabled = true;
  chatMsg("me", q);
  const wait = chatMsg("bot pending", "Thinking…");
  try {
    const r = await fetch(API + `/api/analysis/${encodeURIComponent(A.analysisId)}/chat`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: q.slice(0, 1000), selectedComponentIds: selected ? [selected] : [] }) });
    const d = await r.json().catch(() => ({}));
    if (r.status === 404) throw new Error("The server was restarted and forgot this object. Load the sample or the photos again.");
    if (!r.ok) throw new Error(errText(d, r.status));
    wait.remove(); chatMsg("bot", d.answer, (d.referencedComponentIds || []).filter((id) => id !== selected).slice(0, 6));
  } catch (e) { wait.remove(); chatMsg("bot err", e.message || "Could not get an answer."); }
  finally { chatBusy = false; $("chatSend").disabled = false; }
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
async function showTeardowns(query, btn) {
  const box = $("teardown"); box.innerHTML = ""; btn.disabled = true; btn.textContent = "Searching iFixit…";
  try {
    const r = await fetch(API + "/api/physical/teardown?q=" + encodeURIComponent(query)); const d = await r.json();
    if (!r.ok) throw new Error(errText(d, r.status));
    const guides = d.guides.filter((g) => g.images.length);
    if (!guides.length) { box.append(el("div", "tiny muted", "No iFixit teardown found for this product.")); return; }
    const picked = new Set();
    for (const g of guides.slice(0, 2)) {
      const head = el("div", "tiny"); const link = el("a", "", g.title); link.href = g.url; link.target = "_blank"; link.rel = "noopener";
      head.append(link, document.createTextNode(` · by ${g.author}`)); box.append(head);
      const grid = el("div", "tgrid");
      for (const im of g.images.slice(0, 12)) {
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
    const add = el("button", "btn small primary", "Add to the model"); add.disabled = true;
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
    box.append(add, el("div", "tiny muted", isSample ? "Sample mode: upload your own photo to add teardown photos." : "Pick up to 3 photos that show the inside. " + d.license));
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
