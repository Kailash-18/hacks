// Procedural textures (canvas, no downloads): PCB, brushed metal, rubber grain, knurl, screen, weave.
// Deterministic (seeded) so the same object always looks the same.
import * as THREE from "three";

function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
const cache = new Map();

function canvasTex(key, size, draw, { color = true, repeat = true } = {}) {
  if (cache.has(key)) return cache.get(key);
  const c = document.createElement("canvas"); c.width = c.height = size;
  draw(c.getContext("2d"), size);
  const t = new THREE.CanvasTexture(c);
  if (color) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  cache.set(key, t); return t;
}

export function pcbTexture(base = "#2f6b3a", seed = 7) {
  return canvasTex("pcb" + base + seed, 1024, (g, N) => {
    const r = rng(seed), col = new THREE.Color(base);
    g.fillStyle = base; g.fillRect(0, 0, N, N);
    // subtle solder-mask mottling
    for (let i = 0; i < 1400; i++) { g.fillStyle = `rgba(0,0,0,${r() * 0.05})`; g.fillRect(r() * N, r() * N, 6 + r() * 30, 6 + r() * 30); }
    const trace = "#" + col.clone().offsetHSL(0, 0.05, 0.12).getHexString();
    g.strokeStyle = trace; g.lineCap = "round"; g.lineJoin = "round";
    for (let i = 0; i < 90; i++) { // orthogonal traces with 45-degree bends, like real routing
      g.lineWidth = 2 + r() * 5; g.beginPath();
      let x = r() * N, y = r() * N; g.moveTo(x, y);
      for (let k = 0; k < 3 + r() * 4; k++) {
        const d = 20 + r() * 160, dir = Math.floor(r() * 8) * Math.PI / 4;
        x += Math.cos(dir) * d; y += Math.sin(dir) * d; g.lineTo(x, y);
      }
      g.stroke();
      g.fillStyle = "#d9b45a"; g.beginPath(); g.arc(x, y, 4 + r() * 4, 0, Math.PI * 2); g.fill(); // via / pad
    }
    g.fillStyle = "#cfa64b"; // pad rows (gold)
    for (let i = 0; i < 14; i++) {
      const x = r() * N, y = r() * N, n = 4 + Math.floor(r() * 10), horiz = r() > 0.5;
      for (let k = 0; k < n; k++) g.fillRect(x + (horiz ? k * 12 : 0), y + (horiz ? 0 : k * 12), 7, 7);
    }
    g.strokeStyle = "rgba(240,240,235,.75)"; g.lineWidth = 2; g.fillStyle = "rgba(240,240,235,.75)"; // silkscreen
    g.font = "bold 18px monospace";
    for (let i = 0; i < 26; i++) {
      const x = r() * N, y = r() * N, w = 20 + r() * 60, h = 14 + r() * 40;
      g.strokeRect(x, y, w, h);
      g.fillText(["R", "C", "U", "D", "Q", "J", "SW", "LED"][Math.floor(r() * 8)] + Math.floor(r() * 40 + 1), x, y - 4);
    }
    for (let i = 0; i < 6; i++) { g.beginPath(); g.arc(r() * N, r() * N, 10, 0, Math.PI * 2); g.fillStyle = "#e8c768"; g.fill(); g.beginPath(); g.arc(r() * N, r() * N, 5, 0, Math.PI * 2); g.fillStyle = "#222"; g.fill(); }
  });
}

export function brushedTexture() { // roughness/bump: fine directional streaks
  return canvasTex("brushed", 512, (g, N) => {
    const r = rng(3); g.fillStyle = "#808080"; g.fillRect(0, 0, N, N);
    for (let i = 0; i < 2600; i++) { const v = Math.floor(90 + r() * 90); g.fillStyle = `rgba(${v},${v},${v},.35)`; g.fillRect(r() * N, r() * N, 40 + r() * 260, 1 + r() * 1.5); }
  }, { color: false });
}

export function grainTexture(strength = 1) { // plastic/rubber micro texture (bump)
  return canvasTex("grain" + strength, 512, (g, N) => {
    const r = rng(11), img = g.createImageData(N, N);
    for (let i = 0; i < N * N; i++) { const v = 128 + (r() - 0.5) * 120 * strength; img.data.set([v, v, v, 255], i * 4); }
    g.putImageData(img, 0, 0); g.filter = "blur(1px)"; g.drawImage(g.canvas, 0, 0);
  }, { color: false });
}

export function knurlTexture() { // ridges for wheels/knobs (bump)
  return canvasTex("knurl", 256, (g, N) => {
    for (let x = 0; x < N; x++) { const v = 128 + 110 * Math.sin((x / N) * Math.PI * 2 * 24); g.fillStyle = `rgb(${v},${v},${v})`; g.fillRect(x, 0, 1, N); }
  }, { color: false });
}

export function screenTexture() { // dark glass with a soft glare
  return canvasTex("screen", 512, (g, N) => {
    const gr = g.createLinearGradient(0, 0, N, N); gr.addColorStop(0, "#1b2433"); gr.addColorStop(0.5, "#0a0e15"); gr.addColorStop(1, "#05070b");
    g.fillStyle = gr; g.fillRect(0, 0, N, N);
    const gl = g.createLinearGradient(0, 0, N * 0.6, N * 0.35); gl.addColorStop(0, "rgba(255,255,255,.16)"); gl.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = gl; g.beginPath(); g.moveTo(0, 0); g.lineTo(N * 0.75, 0); g.lineTo(0, N * 0.55); g.fill();
  }, { repeat: false });
}

export function weaveTexture() {
  return canvasTex("weave", 256, (g, N) => {
    g.fillStyle = "#808080"; g.fillRect(0, 0, N, N);
    for (let y = 0; y < N; y += 8) for (let x = 0; x < N; x += 8) { const v = ((x + y) / 8) % 2 ? 170 : 90; g.fillStyle = `rgb(${v},${v},${v})`; g.fillRect(x, y, 7, 7); }
  }, { color: false });
}

export function glowSprite() { // soft round particle
  return canvasTex("glow", 64, (g, N) => {
    const gr = g.createRadialGradient(N / 2, N / 2, 0, N / 2, N / 2, N / 2);
    gr.addColorStop(0, "rgba(255,255,255,1)"); gr.addColorStop(0.25, "rgba(255,255,255,.75)"); gr.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = gr; g.fillRect(0, 0, N, N);
  }, { repeat: false });
}

// Per-part copy with a repeat that keeps texel size constant on big and small parts.
export function tiled(tex, sx, sy) {
  const t = tex.clone(); t.needsUpdate = true; t.repeat.set(Math.max(0.3, sx), Math.max(0.3, sy)); return t;
}
