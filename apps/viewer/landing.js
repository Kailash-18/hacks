// Physical Lab landing.
// Hero: the iPhone 17 teardown's own 3D model, rendered live (three.js), swept by a scan plane, then pulled apart.
// Shelf: every saved teardown drawn from its own 3D model as an isometric exploded drawing; click opens it.
import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
const $ = (id) => document.getElementById(id);
const root = $("empty");
const HERO = { "iphone-17": "iPhone 17" }; // the real photo scan shown in the hero
const SKIP = new Set(["game-boy"]);                                          // not shown on the landing
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
const cache = {};
const getSample = (id) => cache[id] || (cache[id] = fetch("/api/physical/samples/" + encodeURIComponent(id)).then((r) => r.json()));
const openSample = (id) => { const sel = $("samples"); if (!sel) return; sel.value = id; sel.dispatchEvent(new Event("change")); };

if (root && $("ldStage")) {
  fetch("/api/physical/samples").then((r) => r.json()).then((d) => {
    const list = d.samples.filter((s) => !SKIP.has(s.id));
    hero(list.filter((s) => HERO[s.id]).sort((a, b) => Object.keys(HERO).indexOf(a.id) - Object.keys(HERO).indexOf(b.id)));
    shelf(list);
  }).catch(() => { $("ldStage").hidden = true; });
}

// ------------------------------------------------------------------ hero: the iPhone's own 3D model, rendered live
// Built from the saved teardown's 3D model (the same parts, sizes, materials and colours the viewer uses),
// swept by a scan plane, then pulled apart layer by layer with callouts to each part.
const LAYERS = { // exploded-view order for the hero, front (+) to back (-); other parts follow their depth
  display_assembly: 2.2, front_camera_module: 0.6, metal_midframe: 0, side_buttons: 0, usb_c_port: 0, taptic_engine: 0,
  loudspeaker: 0, logic_board: -1.1, battery_pack: -1.1, mag_safe_coil: -2.1, rear_glass_panel: -3.1, apple_logo: -3.35,
  camera_island: -4.2, top_camera_lens: -5.1, bottom_camera_lens: -5.1, led_flash: -5.1 };
const SHOW = ["display_assembly", "metal_midframe", "logic_board", "battery_pack", "mag_safe_coil", "rear_glass_panel",
  "camera_island", "top_camera_lens", "led_flash", "taptic_engine", "side_buttons"];

async function hero(samples) {
  const stage = $("ldStage"), canvas = $("ldCanvas"), svg = $("ldLeaders"), labels = $("ldLabels");
  const range = $("ldExplode"), open = $("ldOpen"), caption = $("ldCaption");
  const s = samples[0];
  if (!s) { stage.hidden = true; return; }
  const d = await getSample(s.id), A = d.scene?.assembly;
  if (!A?.parts?.length) { stage.hidden = true; return; }
  const comp = Object.fromEntries(d.components.map((c) => [c.id, c]));

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(2, devicePixelRatio));
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.08;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
  const key = new THREE.DirectionalLight(0xffffff, 1.4); key.position.set(4, 6, 5); scene.add(key);
  const rim = new THREE.DirectionalLight(0x5ee6ff, 2.6); rim.position.set(-6, 2, -5); scene.add(rim);
  const warm = new THREE.DirectionalLight(0x9b8cff, 1.2); warm.position.set(5, -3, -2); scene.add(warm);
  const camera = new THREE.PerspectiveCamera(26, 1, 0.1, 200);

  const k = 3.2 / Math.max(...A.overallSize);          // the phone is 3.2 units tall
  const pivot = new THREE.Group(), model = new THREE.Group();
  pivot.add(model); scene.add(pivot);
  model.rotation.set(-0.16, -0.78, -0.06);              // three-quarter front view: the lit screen faces you, the layers fan out behind it
  const G = 0.66;                                       // gap between layers when pulled apart
  const parts = [];
  for (const p of A.parts) {
    const c = comp[p.componentId]; if (!c) continue;
    const mesh = new THREE.Mesh(geometryFor(p, k), materialFor(p, c));
    mesh.position.fromArray(p.position.map((v) => v * k));
    mesh.rotation.set(...p.rotation.map((v) => THREE.MathUtils.degToRad(v)));
    decorate(mesh, p, k, c);
    model.add(mesh);
    const layer = LAYERS[p.componentId] ?? Math.sign(p.position[2]) * 1.5;
    const lateral = new THREE.Vector3(p.explodeDir[0], p.explodeDir[1], 0).multiplyScalar(0.34 * (p.explodeDist || 1));
    parts.push({ p, c, mesh, base: mesh.position.clone(), off: new THREE.Vector3(0, 0, layer * G).add(lateral), layer,
      show: SHOW.includes(p.componentId) });
  }
  // peel order: the outermost layers leave first (lenses, then island, glass...), the display last
  const order = [...parts].sort((a, b) => Math.abs(b.layer) - Math.abs(a.layer));
  order.forEach((it, i) => (it.start = (i / order.length) * 0.55));

  // scan plane: sweeps down the assembled phone before it comes apart
  const scanMat = new THREE.MeshBasicMaterial({ color: 0x5ee6ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  const scan = new THREE.Mesh(new THREE.PlaneGeometry(A.overallSize[0] * k * 1.5, A.overallSize[2] * k * 9), scanMat);
  scan.rotation.x = Math.PI / 2; model.add(scan);

  // callouts
  const items = parts.filter((it) => it.show).map((it) => {
    const lb = el("div", "ld-lbl" + (it.c.status !== "observed" ? " inside" : ""), it.c.label);
    lb.setAttribute("aria-hidden", "true");
    labels.append(lb);
    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    g.setAttribute("class", it.c.status !== "observed" ? "inside" : "seen");
    g.append(document.createElementNS("http://www.w3.org/2000/svg", "path"), document.createElementNS("http://www.w3.org/2000/svg", "circle"));
    g.lastChild.setAttribute("r", "3"); svg.append(g);
    return Object.assign(it, { lb, g });
  });
  const seen = d.components.filter((c) => c.status === "observed").length;
  caption.replaceChildren(el("b", "", "iPhone 17"), `, a real saved scan: ${d.components.length} parts, ${seen} cut from the photo and ${d.components.length - seen} inside.`);

  let t = 0, anim = 0, phase = "idle", scanT = -1, W = 0, H = 0, live = true;
  const tilt = { x: 0, y: 0, tx: 0, ty: 0 };
  const clock = new THREE.Clock();
  const backOutE = (x) => backOut(Math.max(0, Math.min(1, x)));

  function resize() {
    const r = stage.getBoundingClientRect(); W = r.width; H = r.height;
    if (!W || !H) return;
    renderer.setSize(W, H, false); camera.aspect = W / H;
    // frame the pulled-apart phone (its widest pose), leaving room for the callout columns
    const box = new THREE.Box3();
    for (const it of parts) { const m = it.mesh; m.position.copy(it.base).add(it.off); }
    model.updateMatrixWorld(true); box.setFromObject(model);
    for (const it of parts) it.mesh.position.copy(it.base);
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const fit = Math.max(sphere.radius / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)),
      sphere.radius / (Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.aspect * 0.7));
    camera.position.set(0, 0.3, fit * 0.78); camera.lookAt(0, -0.18, 0); camera.updateProjectionMatrix();
    pivot.position.copy(sphere.center).multiplyScalar(-1);
  }

  function frame() {
    if (!live) return;
    const dt = Math.min(0.05, clock.getDelta()), time = clock.elapsedTime;
    if (scanT >= 0) {
      scanT += dt / 1.15;
      const y = (A.overallSize[1] * k) * (0.6 - scanT * 1.2);
      scan.position.set(0, y, 0); scanMat.opacity = scanT < 0.08 ? scanT * 4 : scanT > 0.9 ? Math.max(0, (1 - scanT) * 3) : 0.32;
      if (scanT >= 1) { scanT = -1; scanMat.opacity = 0; animateTo(1, 2400); }
    }
    tilt.x += (tilt.tx - tilt.x) * 0.06; tilt.y += (tilt.ty - tilt.y) * 0.06;
    pivot.rotation.set(tilt.y * 0.18, Math.sin(time * 0.35) * 0.12 + tilt.x * 0.3, 0);
    for (const it of parts) {
      const e = backOutE((t - it.start) / 0.45);
      const bob = t > 0.98 && !reduce ? Math.sin(time * 1.3 + it.layer * 1.7) * 0.025 : 0;
      it.mesh.position.copy(it.base).addScaledVector(it.off, e).add(new THREE.Vector3(0, 0, bob));
      it.e = e;
    }
    renderer.render(scene, camera);
    callouts();
    requestAnimationFrame(frame);
  }

  function callouts() {
    if (getComputedStyle(labels).display === "none") return;
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`); svg.setAttribute("width", W); svg.setAttribute("height", H);
    const v = new THREE.Vector3();
    const pts = items.map((it) => {
      it.mesh.updateWorldMatrix(true, false);
      v.setFromMatrixPosition(it.mesh.matrixWorld).project(camera);
      it.lw ||= it.lb.offsetWidth; it.lh ||= it.lb.offsetHeight;
      const o = Math.max(0, Math.min(1, (it.e - 0.6) * 3));
      it.lb.style.opacity = o; it.g.style.opacity = o;
      return { it, ax: (v.x + 1) / 2 * W, ay: (1 - v.y) / 2 * H };
    });
    const cx = pts.reduce((s2, p) => s2 + p.ax, 0) / pts.length;
    const left = pts.filter((p) => p.ax < cx), right = pts.filter((p) => p.ax >= cx);
    while (left.length - right.length > 1) { left.sort((a, b) => b.ax - a.ax); right.push(left.shift()); }
    while (right.length - left.length > 1) { right.sort((a, b) => a.ax - b.ax); left.push(right.shift()); }
    const minAx = Math.min(...pts.map((p) => p.ax)), maxAx = Math.max(...pts.map((p) => p.ax));
    const TOP = 16, BOTTOM = H - 96, GAP = 7;
    for (const [col, side] of [[left, "L"], [right, "R"]]) {
      const maxLw = Math.max(0, ...col.map((p) => p.it.lw));
      const xR = Math.max(8 + maxLw, minAx - 50), xL = Math.min(W - 8 - maxLw, maxAx + 50);
      col.sort((a, b) => a.ay - b.ay);
      let y = TOP;
      for (const p of col) { p.y = Math.max(p.ay - p.it.lh / 2, y); y = p.y + p.it.lh + GAP; }
      let lim = BOTTOM;
      for (let i = col.length - 1; i >= 0; i--) { col[i].y = Math.max(TOP, Math.min(col[i].y, lim - col[i].it.lh)); lim = col[i].y - GAP; }
      for (const p of col) {
        const x = side === "L" ? xR - p.it.lw : xL, sy = p.y + p.it.lh / 2, sx = side === "L" ? x + p.it.lw : x;
        const ex = sx + (side === "L" ? 16 : -16);
        p.it.lb.style.transform = `translate(${x.toFixed(1)}px, ${p.y.toFixed(1)}px)`;
        p.it.g.firstChild.setAttribute("d", `M${sx.toFixed(1)},${sy.toFixed(1)} H${ex.toFixed(1)} L${p.ax.toFixed(1)},${p.ay.toFixed(1)}`);
        p.it.g.lastChild.setAttribute("cx", p.ax.toFixed(1)); p.it.g.lastChild.setAttribute("cy", p.ay.toFixed(1));
      }
    }
  }

  function animateTo(target, ms) {
    cancelAnimationFrame(anim);
    const from = t, t0 = performance.now();
    const step = (now) => { const q = Math.min(1, (now - t0) / ms); t = from + (target - from) * q; range.value = Math.round(t * 100); if (q < 1) anim = requestAnimationFrame(step); };
    anim = requestAnimationFrame(step);
  }

  resize(); new ResizeObserver(resize).observe(stage);
  if (reduce) { t = 1; range.value = 100; } else setTimeout(() => (scanT = 0), 450);
  requestAnimationFrame(frame);
  // pause while the landing is hidden (a result is open) or the tab is in the background
  const wake = () => { const was = live; live = !root.hidden && !document.hidden; if (live && !was) { clock.getDelta(); resize(); requestAnimationFrame(frame); } };
  new MutationObserver(wake).observe(root, { attributes: true, attributeFilter: ["hidden"] });
  document.addEventListener("visibilitychange", wake);

  range.addEventListener("input", () => { cancelAnimationFrame(anim); scanT = -1; scanMat.opacity = 0; t = range.value / 100; });
  open.addEventListener("click", () => openSample(s.id));
  if (!reduce) {
    stage.addEventListener("pointermove", (e) => { const r = stage.getBoundingClientRect(); tilt.tx = ((e.clientX - r.left) / r.width - 0.5) * 2; tilt.ty = ((e.clientY - r.top) / r.height - 0.5) * 2; });
    stage.addEventListener("pointerleave", () => { tilt.tx = 0; tilt.ty = 0; });
  }
}

// ---- 3D building blocks for the hero
function geometryFor(p, k) {
  const [x, y, z] = p.size.map((v) => Math.max(0.004, v * k));
  const r = (p.cornerRadius || 0) * k;
  if (p.shape === "frame") return slab(x, y, z, r || Math.min(x, y) * 0.14, (p.wall || 1.6) * k);
  if (["plate", "rounded_box"].includes(p.shape) || (p.shape === "box" && r > 0)) return slab(x, y, z, r || Math.min(x, y, z) * 0.6 + Math.min(x, y) * 0.04);
  if (p.shape === "disc" || p.shape === "cylinder") return new THREE.CylinderGeometry(x / 2, x / 2, y, 56);
  if (p.shape === "torus") { const g = new THREE.TorusGeometry(Math.max(0.01, x / 2 - y / 2), Math.max(0.006, y / 2), 12, 72); g.rotateX(Math.PI / 2); return g; }
  return new RoundedBoxGeometry(x, y, z, 3, Math.min(x, y, z) * 0.3);
}
// a rounded slab (or a band, with a wall) extruded along its thinnest axis
function slab(x, y, z, r, wall) {
  const dims = [x, y, z], thin = dims.indexOf(Math.min(...dims));
  const [w, h, depth] = thin === 2 ? [x, y, z] : thin === 1 ? [x, z, y] : [z, y, x];
  const rr = Math.min(r, w / 2 - 1e-3, h / 2 - 1e-3);
  const rect = (W, H, R) => { const s = new THREE.Shape(), a = -W / 2, b = -H / 2;
    s.moveTo(a + R, b); s.lineTo(a + W - R, b); s.quadraticCurveTo(a + W, b, a + W, b + R); s.lineTo(a + W, b + H - R);
    s.quadraticCurveTo(a + W, b + H, a + W - R, b + H); s.lineTo(a + R, b + H); s.quadraticCurveTo(a, b + H, a, b + H - R);
    s.lineTo(a, b + R); s.quadraticCurveTo(a, b, a + R, b); return s; };
  const shape = rect(w, h, rr);
  if (wall) shape.holes.push(rect(w - 2 * wall, h - 2 * wall, Math.max(0.001, rr - wall)));
  const bev = Math.min(depth * 0.3, 0.02);
  const g = new THREE.ExtrudeGeometry(shape, { depth: Math.max(0.001, depth - 2 * bev), bevelEnabled: true, bevelSize: bev, bevelThickness: bev, bevelSegments: 3, curveSegments: 14 });
  g.translate(0, 0, -(depth - 2 * bev) / 2);
  if (thin === 1) g.rotateX(-Math.PI / 2); else if (thin === 0) g.rotateY(Math.PI / 2);
  g.computeVertexNormals();
  return g;
}
function materialFor(p, c) {
  const color = new THREE.Color(p.color || "#8a93a3");
  if (/display|screen/i.test(p.componentId + c.label) && p.material === "glass") {
    const front = new THREE.MeshPhysicalMaterial({ color: 0x000000, emissive: 0xffffff, emissiveMap: lockScreen(), emissiveIntensity: 0.95, roughness: 0.05, clearcoat: 1, clearcoatRoughness: 0.03 });
    const tex = front.emissiveMap; const [w, h] = [p.size[0], p.size[1]];
    tex.repeat.set(1 / (w * 3.2 / 147.6), 1 / (h * 3.2 / 147.6)); tex.offset.set(0.5, 0.5);
    return [front, new THREE.MeshPhysicalMaterial({ color: 0x0c0d10, roughness: 0.3, metalness: 0.4 })];
  }
  switch (p.material) {
    case "glass": return new THREE.MeshPhysicalMaterial({ color, roughness: 0.12, metalness: 0.05, clearcoat: 1, clearcoatRoughness: 0.04, iridescence: p.shape === "disc" ? 0.6 : 0 });
    case "aluminum": case "metal": return new THREE.MeshPhysicalMaterial({ color, roughness: 0.3, metalness: 0.9, clearcoat: 0.3 });
    case "pcb": return new THREE.MeshPhysicalMaterial({ color, roughness: 0.55, metalness: 0.15, clearcoat: 0.4 });
    default: return new THREE.MeshPhysicalMaterial({ color, roughness: 0.5, metalness: 0.1 });
  }
}
function decorate(mesh, p, k, c) {
  const dark = new THREE.MeshPhysicalMaterial({ color: 0x111418, roughness: 0.4, metalness: 0.3, clearcoat: 0.5 });
  const metal = new THREE.MeshPhysicalMaterial({ color: 0xc9ccd2, roughness: 0.22, metalness: 0.95 });
  if (p.material === "pcb") { // chips on the board
    const [x, y, z] = p.size.map((v) => v * k);
    [[0, 0.3, 0.42, 0.16], [0.05, -0.05, 0.34, 0.12], [-0.12, -0.32, 0.26, 0.1], [0.1, 0.12, 0.2, 0.07]].forEach(([u, v, s, q]) => {
      const chip = new THREE.Mesh(new RoundedBoxGeometry(x * s * 1.6, y * q, z * 0.6, 2, z * 0.1), dark);
      chip.position.set(u * x, v * y, -z * 0.6); mesh.add(chip);
    });
  }
  if (p.shape === "disc" && /lens/i.test(c.label)) { // lens: metal ring and a dark inner element
    const R = (p.size[0] * k) / 2, ring = new THREE.Mesh(new THREE.TorusGeometry(R * 0.96, R * 0.08, 12, 56), metal);
    ring.rotation.x = Math.PI / 2; ring.position.y = (p.size[1] * k) / 2; mesh.add(ring);
    const eye = new THREE.Mesh(new THREE.CircleGeometry(R * 0.45, 40), new THREE.MeshPhysicalMaterial({ color: 0x0a1630, roughness: 0.05, clearcoat: 1, iridescence: 1, iridescenceIOR: 1.8 }));
    eye.rotation.x = -Math.PI / 2; eye.position.y = (p.size[1] * k) / 2 + 0.002; mesh.add(eye);
  }
  if (/flash/i.test(c.label)) mesh.material = new THREE.MeshPhysicalMaterial({ color: 0xfff3c4, emissive: 0xffe9a8, emissiveIntensity: 0.6, roughness: 0.2 });
}
function lockScreen() { // a recognisable phone face: wallpaper, time and date
  const cv = document.createElement("canvas"); cv.width = 512; cv.height = 1024;
  const g = cv.getContext("2d");
  const bg = g.createLinearGradient(0, 0, 512, 1024);
  bg.addColorStop(0, "#0b1f5c"); bg.addColorStop(0.45, "#4b2bd6"); bg.addColorStop(0.75, "#c43fd6"); bg.addColorStop(1, "#ff8a5c");
  g.fillStyle = bg; g.fillRect(0, 0, 512, 1024);
  const glow = g.createRadialGradient(150, 720, 10, 150, 720, 420); glow.addColorStop(0, "rgba(94,230,255,.55)"); glow.addColorStop(1, "rgba(94,230,255,0)");
  g.fillStyle = glow; g.fillRect(0, 0, 512, 1024);
  g.fillStyle = "rgba(255,255,255,.92)"; g.textAlign = "center";
  g.font = "600 30px Inter, system-ui, sans-serif"; g.fillText("Monday 12 October", 256, 170);
  g.font = "700 150px Inter, system-ui, sans-serif"; g.fillText("9:41", 256, 320);
  g.fillStyle = "#000"; g.beginPath(); g.roundRect(196, 34, 120, 34, 17); g.fill();       // the island
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.flipY = true;
  return t;
}

// ------------------------------------------------------------------ shelf: every saved teardown, drawn from its own 3D model
async function shelf(samples) {
  const grid = $("ldShelf");
  if (!grid || !samples.length) return;
  const order = ["macbook-air", "gaming-pc", "iphone-17", "lenovo-mouse"];
  samples.sort((a, b) => (order.indexOf(a.id) + 1 || 99) - (order.indexOf(b.id) + 1 || 99));
  for (const s of samples) {
    const card = el("button", "ld-card"); card.type = "button";
    const art = el("span", "ld-art"); art.setAttribute("aria-hidden", "true");
    const kind = el("span", "ld-kind", "");
    card.append(art, el("span", "ld-card-title", s.title), el("span", "ld-card-meta", ""), kind);
    card.onclick = () => openSample(s.id);
    grid.append(card);
    getSample(s.id).then((d) => {
      const a = d.scene?.assembly;
      if (a?.parts?.length) art.append(iso(a));
      const inside = d.components.filter((c) => c.status !== "observed").length;
      card.querySelector(".ld-card-meta").textContent = `${d.components.length} parts, ${inside} inside`;
      const curated = d.provider?.name === "curated";
      kind.textContent = curated ? "Hand-built reference model" : "AI scan of a real photo";
      kind.classList.add(curated ? "ld-kind-ref" : "ld-kind-scan");
      card.setAttribute("aria-label", `Open the ${s.title} teardown: ${d.components.length} parts`);
    }).catch(() => card.remove());
  }
}

// isometric exploded drawing of an assembly: every part as a shaded block, offset along its explode direction.
// The card's --e (0..1) controls how far apart the parts are, so hovering pulls the drawing apart.
function iso(a) {
  const NS = "http://www.w3.org/2000/svg";
  const view = norm([1, 1, 1]), light = norm([0.35, 1, 0.55]);
  const P = ([x, y, z]) => [(x - z) / Math.SQRT2, -(-x + 2 * y - z) / Math.sqrt(6)];
  const D = 0.32 * Math.max(...a.overallSize);
  const parts = a.parts.map((p) => {
    const R = rot(p.rotation), [sx, sy, sz] = p.size.map((v) => v / 2);
    const corner = (i, j, k) => add(mul(R, [i * sx, j * sy, k * sz]), p.position);
    const faces = [];
    const ROUND = ["cylinder", "disc", "cone", "capsule", "torus", "sphere", "ellipsoid", "dome"];
    if (ROUND.includes(p.shape)) {
      const pts = [], N = 28;
      for (let i = 0; i < N; i++) {
        const th = (i / N) * 2 * Math.PI, c = Math.cos(th), s = Math.sin(th);
        if (["sphere", "ellipsoid", "dome"].includes(p.shape)) {
          for (let j = 0; j <= 6; j++) {
            const ph = p.shape === "dome" ? (j / 6) * (Math.PI / 2) : -Math.PI / 2 + (j / 6) * Math.PI;
            const y = p.shape === "dome" ? -sy + 2 * sy * Math.sin(ph) : sy * Math.sin(ph);
            pts.push(add(mul(R, [sx * c * Math.cos(ph), y, sz * s * Math.cos(ph)]), p.position));
          }
        } else {
          pts.push(add(mul(R, [sx * c, sy, sz * s]), p.position));
          pts.push(add(mul(R, p.shape === "cone" ? [0, -sy, 0] : [sx * c, -sy, sz * s]), p.position));
          if (p.shape === "cone") pts.push(add(mul(R, [sx * c, -sy, sz * s]), p.position));
        }
      }
      faces.push({ pts: hull(pts.map(P)), shade: 0.62 });
      if (["cylinder", "disc", "capsule", "torus"].includes(p.shape)) { // the end cap that faces us, lighter
        const n = mul(R, [0, 1, 0]), end = dot(n, view) >= 0 ? sy : -sy;
        const cap = []; for (let i = 0; i < N; i++) { const th = (i / N) * 2 * Math.PI; cap.push(P(add(mul(R, [sx * Math.cos(th), end, sz * Math.sin(th)]), p.position))); }
        faces.push({ pts: cap, shade: 0.5 + 0.5 * Math.max(0, Math.abs(dot(n, light))) });
      }
    } else for (const [ax, sgn] of [[0, 1], [0, -1], [1, 1], [1, -1], [2, 1], [2, -1]]) {
      const n = mul(R, ax === 0 ? [sgn, 0, 0] : ax === 1 ? [0, sgn, 0] : [0, 0, sgn]);
      if (dot(n, view) <= 0.01) continue;
      const quad = ax === 0 ? [[sgn, -1, -1], [sgn, 1, -1], [sgn, 1, 1], [sgn, -1, 1]]
        : ax === 1 ? [[-1, sgn, -1], [1, sgn, -1], [1, sgn, 1], [-1, sgn, 1]]
        : [[-1, -1, sgn], [1, -1, sgn], [1, 1, sgn], [-1, 1, sgn]];
      faces.push({ pts: quad.map(([i, j, k]) => P(corner(i, j, k))), shade: 0.5 + 0.5 * Math.max(0, dot(n, light)) });
    }
    const off = mul(1, p.explodeDir.map((v) => v * (p.explodeDist || 1) * D));
    return { p, faces, off: P(off), depth: dot(add(p.position, off.map((v) => v * 0.6)), view) };
  }).sort((u, v) => u.depth - v.depth);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const q of parts) for (const f of q.faces) for (const [x, y] of f.pts) for (const e of [0, 1]) {
    const X = x + q.off[0] * e, Y = y + q.off[1] * e;
    x0 = Math.min(x0, X); y0 = Math.min(y0, Y); x1 = Math.max(x1, X); y1 = Math.max(y1, Y);
  }
  const pad = Math.max(x1 - x0, y1 - y0) * 0.06;
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `${(x0 - pad).toFixed(1)} ${(y0 - pad).toFixed(1)} ${(x1 - x0 + 2 * pad).toFixed(1)} ${(y1 - y0 + 2 * pad).toFixed(1)}`);
  svg.setAttribute("class", "iso");
  const sw = (Math.max(x1 - x0, y1 - y0) / 260).toFixed(2);
  for (const q of parts) {
    const g = document.createElementNS(NS, "g");
    g.style.setProperty("--ex", q.off[0].toFixed(1) + "px"); g.style.setProperty("--ey", q.off[1].toFixed(1) + "px");
    for (const f of q.faces) {
      const poly = document.createElementNS(NS, "polygon");
      poly.setAttribute("points", f.pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" "));
      poly.setAttribute("fill", shade(q.p.color, f.shade)); poly.setAttribute("stroke-width", sw);
      g.append(poly);
    }
    svg.append(g);
  }
  return svg;
}

function hull(pts) { // convex hull (monotone chain) of 2D points
  const q = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]), cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], hi = [];
  for (const p of q) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  for (const p of q.reverse()) { while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], p) <= 0) hi.pop(); hi.push(p); }
  return lo.slice(0, -1).concat(hi.slice(0, -1));
}
function rot([a, b, c]) { // XYZ Euler in degrees -> matrix, same order as three.js
  [a, b, c] = [a, b, c].map((d) => (d * Math.PI) / 180);
  const [ca, sa, cb, sb, cc, sc] = [Math.cos(a), Math.sin(a), Math.cos(b), Math.sin(b), Math.cos(c), Math.sin(c)];
  return [[cb * cc, -cb * sc, sb], [ca * sc + sa * sb * cc, ca * cc - sa * sb * sc, -sa * cb], [sa * sc - ca * sb * cc, sa * cc + ca * sb * sc, ca * cb]];
}
function mul(M, v) { return typeof M === "number" ? v.map((x) => x * M) : M.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]); }
function add(a, b) { return a.map((x, i) => x + b[i]); }
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function norm(v) { const l = Math.hypot(...v); return v.map((x) => x / l); }
function shade(hex, k) {
  const n = parseInt((hex || "#8a93a3").slice(1), 16), c = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const lift = (x) => Math.round(Math.min(255, 18 + x * k * 1.05)); // a floor keeps black parts readable on the dark card
  return `rgb(${c.map(lift).join(",")})`;
}
function backOut(x) { const s = 1.4; return x <= 0 ? 0 : x >= 1 ? 1 : 1 + (s + 1) * Math.pow(x - 1, 3) + s * Math.pow(x - 1, 2); }
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function img(src) { const i = new Image(); i.src = src; i.alt = ""; i.draggable = false; return i; }
