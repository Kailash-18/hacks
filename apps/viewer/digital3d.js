// Digital Lab: the screenshot as an exploded 3D stack. Every level of the component tree is lifted onto its own
// layer (page -> sections -> cards -> controls), printed with its own pixels from the screenshot.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const $ = (s) => document.querySelector(s);
const COLORS = { container: 0xf2a541, control: 0x36d6ff, text: 0xe8eef7, media: 0xff6ad5 };
const KIND = (t) => ["button", "link", "input", "textarea", "checkbox", "radio", "toggle", "dropdown", "select", "search", "tab",
  "menu_item", "pagination", "avatar", "icon"].includes(t) ? "control"
  : ["heading", "text", "paragraph", "badge", "label", "breadcrumb", "notification", "tooltip", "list_item"].includes(t) ? "text"
  : ["image", "video", "chart", "map", "logo"].includes(t) ? "media" : "container";
const GAP = 0.7, W = 10;
let R = null; // renderer state, created on first show

function init() {
  const canvas = $("#x3d");
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a1733);
  scene.fog = new THREE.Fog(0x0a1733, 26, 60);
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 200);
  const controls = new OrbitControls(camera, canvas); controls.enableDamping = true; controls.maxDistance = 60;
  scene.add(new THREE.AmbientLight(0xffffff, 0.9));
  const key = new THREE.DirectionalLight(0xffffff, 1.2); key.position.set(-6, 8, 14); scene.add(key);
  const grid = new THREE.GridHelper(60, 60, 0x2c4a85, 0x16294f); grid.rotation.x = Math.PI / 2; grid.position.z = -0.6; scene.add(grid);
  const group = new THREE.Group(); scene.add(group);
  R = { canvas, renderer, scene, camera, controls, group, layers: [], id: null, explode: 1, t0: 0, ray: new THREE.Raycaster(), ndc: new THREE.Vector2(), hover: null, sel: null };
  new ResizeObserver(size).observe(canvas);
  $("#x3dExplode").oninput = (e) => { R.explode = +e.target.value; R.t0 = 0; };
  $("#x3dReplay").onclick = () => intro();
  $("#x3dSpin").onchange = () => {};
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerleave", () => { $("#x3dTip").hidden = true; setHover(null); });
  let down = null;
  canvas.addEventListener("pointerdown", (e) => (down = [e.clientX, e.clientY]));
  canvas.addEventListener("pointerup", (e) => { if (down && Math.hypot(e.clientX - down[0], e.clientY - down[1]) < 5) pick(e, true); down = null; });
  renderer.setAnimationLoop(loop);
}

function size() {
  const r = R.canvas.getBoundingClientRect(); if (!r.width) return;
  const changed = Math.abs(R.camera.aspect - r.width / r.height) > 0.01;
  R.renderer.setSize(r.width, r.height, false); R.camera.aspect = r.width / r.height; R.camera.updateProjectionMatrix();
  if (changed && R.id) frameCamera();
}

function depths(tree) { // component id -> tree depth (1 = top-level sections)
  const out = {};
  const walk = (nodes, d) => nodes.forEach((n) => { out[n.id] = d; if (n.children?.length) walk(n.children, d + 1); });
  walk(tree || [], 1);
  return out;
}

function build(S) {
  const g = R.group; while (g.children.length) { const o = g.children.pop(); o.traverse?.((x) => { x.geometry?.dispose(); }); }
  R.layers = []; R.sel = null; R.hover = null;
  const a = S.analysis, H = W * S.shot.h / S.shot.w, depth = depths(S.tree);
  R.H = H;
  const tex = new THREE.TextureLoader().load(S.shot.url, (t) => { t.needsUpdate = true; });
  tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
  // the page itself: dimmed so the lifted layers read clearly
  const base = new THREE.Mesh(new THREE.PlaneGeometry(W, H), new THREE.MeshBasicMaterial({ map: tex, color: 0x6c7a92 }));
  g.add(base);
  const frame = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(W, H)), new THREE.LineBasicMaterial({ color: 0x5b8def }));
  g.add(frame);
  const maxD = Math.max(1, ...Object.values(depth));
  R.maxD = maxD;
  for (const c of a.components) {
    const b = c.bbox; if (!b || b.width * b.height > 0.97) continue;
    const d = depth[c.id] || 1, kind = KIND(c.type), col = COLORS[kind];
    const w = Math.max(0.02, b.width * W), h = Math.max(0.02, b.height * H), thick = 0.05;
    const t = tex.clone(); t.offset.set(b.x, 1 - b.y - b.height); t.repeat.set(b.width, b.height); t.needsUpdate = true;
    const side = new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 0.25, roughness: 0.6 });
    const front = new THREE.MeshStandardMaterial({ map: t, roughness: 0.75, emissive: 0x000000 });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, thick), [side, side, side, side, front, side]);
    const edge = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry), new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.9 }));
    const pinGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]);
    const pin = new THREE.Line(pinGeo, new THREE.LineDashedMaterial({ color: col, dashSize: 0.08, gapSize: 0.08, transparent: true, opacity: 0.45 }));
    const layer = new THREE.Group(); layer.add(mesh, edge); g.add(layer, pin);
    layer.position.set((b.x + b.width / 2 - 0.5) * W, -(b.y + b.height / 2 - 0.5) * H, 0);
    mesh.userData.id = c.id;
    R.layers.push({ id: c.id, c, d, kind, layer, mesh, edge, pin, front, side, col, area: b.width * b.height });
  }
  // depth legend
  const counts = {}; R.layers.forEach((l) => (counts[l.d] = (counts[l.d] || 0) + 1));
  $("#x3dDepths").innerHTML = Object.keys(counts).sort((x, y) => x - y).map((d) =>
    `<li><b>Layer ${d}</b> <span class="muted">${counts[d]} part${counts[d] > 1 ? "s" : ""}</span> <small>${d == 1 ? "sections" : d == 2 ? "blocks / cards" : "controls & text"}</small></li>`).join("");
  R.id = a.analysisId;
  frameCamera(); intro();
}

function frameCamera() { // fit the whole (tilted) stack in view, whatever the page's aspect ratio
  const H = R.H, depth = R.maxD * GAP, vfov = THREE.MathUtils.degToRad(R.camera.fov);
  const hfov = 2 * Math.atan(Math.tan(vfov / 2) * R.camera.aspect);
  const radius = Math.hypot(W, H, depth) / 2;
  const dist = radius / Math.sin(Math.min(vfov, hfov) / 2) * 0.82;
  const dir = new THREE.Vector3(0.42, -0.62, 1).normalize();
  R.controls.target.set(0, 0, depth * 0.45);
  R.camera.position.copy(R.controls.target).addScaledVector(dir, dist); R.controls.update();
}

function intro() { R.t0 = performance.now(); }

function loop(now) {
  if (!R || R.canvas.offsetParent === null) return; // tab hidden: skip work
  const t = R.t0 ? Math.min(1, (now - R.t0) / 1800) : 1;
  for (const L of R.layers) {
    const k = R.t0 ? Math.max(0, Math.min(1, (now - R.t0 - L.d * 140) / 1100)) : 1;
    const e = 1 - Math.pow(1 - k, 3);
    const z = L.d * GAP * R.explode * e + 0.03;
    L.layer.position.z = z;
    L.pin.position.set(L.layer.position.x, L.layer.position.y, z); L.pin.scale.z = Math.max(0.001, z); L.pin.computeLineDistances?.();
    const hl = L.id === R.sel ? 1 : L.id === R.hover ? 0.6 : 0;
    L.front.emissive.setHex(hl ? 0x1f4fd6 : 0x000000); L.front.emissiveIntensity = hl * 0.45;
    L.edge.material.color.setHex(hl ? 0xffffff : L.col);
    L.layer.visible = e > 0.01 || R.explode === 0;
  }
  if (t >= 1) R.t0 = 0;
  if ($("#x3dSpin").checked && !R.drag) R.group.rotation.y = Math.sin(now / 3200) * 0.28;
  R.controls.update(); R.renderer.render(R.scene, R.camera);
}

function hit(e) {
  const r = R.canvas.getBoundingClientRect();
  R.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  R.ray.setFromCamera(R.ndc, R.camera);
  const h = R.ray.intersectObjects(R.layers.map((l) => l.mesh), false)[0];
  return h ? R.layers.find((l) => l.mesh === h.object) : null;
}
function setHover(L) { R.hover = L?.id || null; R.canvas.style.cursor = L ? "pointer" : ""; }
function onMove(e) {
  const L = hit(e); setHover(L);
  const tip = $("#x3dTip");
  if (!L) { tip.hidden = true; return; }
  const r = R.canvas.getBoundingClientRect();
  tip.textContent = `${L.c.label} · ${L.c.type} · layer ${L.d}`;
  tip.style.left = `${e.clientX - r.left + 14}px`; tip.style.top = `${e.clientY - r.top + 14}px`; tip.hidden = false;
}
function pick(e) {
  const L = hit(e); R.sel = L?.id || null;
  const info = $("#x3dInfo");
  if (!L) { info.innerHTML = `<p class="muted">Click a layer.</p>`; return; }
  const kids = R.layers.filter((x) => x.d === L.d + 1 && inside(x.c.bbox, L.c.bbox)).length;
  const esc = window.DL?.esc || ((x) => x);
  info.innerHTML = `<h4>${esc(L.c.label)}</h4><p><span class="kind k-${L.kind}">${esc(L.c.type)}</span> · layer ${L.d}${kids ? ` · ${kids} part${kids > 1 ? "s" : ""} on it` : ""}</p>
    ${L.c.evidence?.[0] ? `<p class="muted small">${esc(L.c.evidence[0])}</p>` : ""}`;
  window.DL?.select?.(L.id);
}
const inside = (a, b) => a && b && a.x >= b.x - 0.005 && a.y >= b.y - 0.005 && a.x + a.width <= b.x + b.width + 0.005 && a.y + a.height <= b.y + b.height + 0.005;

window.DL3D = {
  async show() {
    const S = window.DL?.S;
    if (!S?.analysis || !S.shot) { $("#x3dInfo").innerHTML = `<p class="muted">Waiting for the screenshot to be read…</p>`; return; }
    if (!R) init();
    size();
    if (!S.tree) { setTimeout(() => window.DL3D.show(), 500); return; } // tree loads right after the analysis
    if (R.id !== S.analysis.analysisId) build(S); else intro();
  },
};
