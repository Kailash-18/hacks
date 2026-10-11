// The signature moment of the Digital Lab. When the rebuilt page arrives, a beam of light passes over the
// screenshot; its pixels lift off, swirl into a bright core, burst, and land again as the live rebuilt page
// underneath. About 3.4 s, once per result. Shift+G replays it (for recording). Off with reduced motion.
(() => {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const CYAN = [94, 242, 255];
  const ease = { inC: (t) => t * t * t, outC: (t) => 1 - Math.pow(1 - t, 3), inOut: (t) => (t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
    outBack: (t) => { const c = 1.4; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); } };
  const cl = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  let busy = false;

  window.genesis = async function genesis() {
    const wipe = document.getElementById("wipe");
    if (reduce || busy || !wipe || wipe.hidden || !S?.shot?.url || isMobile?.()) return false;
    busy = true;
    try {
      const W = wipe.clientWidth, H = wipe.clientHeight; if (W < 80 || H < 60) return false;
      const img = await new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = S.shot.url; });
      // sample the screenshot into particles that tile it exactly
      const src = document.createElement("canvas"); src.width = W; src.height = H;
      const sg = src.getContext("2d", { willReadFrequently: true }); sg.drawImage(img, 0, 0, W, H);
      const px = sg.getImageData(0, 0, W, H).data;
      const step = Math.max(3, Math.ceil(Math.sqrt((W * H) / 12000)));
      const P = [];
      for (let y = 0; y < H; y += step) for (let x = 0; x < W; x += step) {
        const i = ((y + (step >> 1)) * W + Math.min(W - 1, x + (step >> 1))) * 4;
        P.push({ x, y, r: px[i], g: px[i + 1], b: px[i + 2], k: Math.random(), a: Math.random() * Math.PI * 2, o: 4 + Math.sqrt(Math.random()) * 58 });
      }
      const cx = W / 2, cy = H / 2, diag = Math.hypot(W, H);
      const cv = document.createElement("canvas"); cv.className = "genesis"; cv.width = W; cv.height = H;
      wipe.append(cv);
      const g = cv.getContext("2d"), layer = document.createElement("canvas"); layer.width = W; layer.height = H;
      const lg = layer.getContext("2d"), buf = lg.createImageData(W, H), d = buf.data;
      setWipe(0);  // the live rebuilt page waits underneath
      const T = { beam: 950, gather: 1900, burst: 2150, land: 3000, end: 3450 };
      const t0 = performance.now();
      await new Promise((done) => {
        const frame = (now) => {
          const t = now - t0;
          // backdrop: deep night until the landing, then it opens onto the rebuilt page
          const bgA = t < T.burst + 300 ? 1 : 1 - cl((t - T.burst - 300) / (T.end - T.burst - 500));
          g.globalCompositeOperation = "source-over"; g.clearRect(0, 0, W, H);
          g.fillStyle = `rgba(6,9,14,${bgA})`; g.fillRect(0, 0, W, H);
          const bx = W * ease.inOut(cl(t / T.beam)) * 1.04;
          if (t < T.beam + 40) {  // the part of the screenshot the light has not reached yet
            const sx = Math.max(0, Math.floor(bx)); if (sx < W) g.drawImage(src, sx, 0, W - sx, H, sx, 0, W - sx, H);
          }
          // particles, additive, written straight into one buffer
          d.fill(0);
          const fade = 1 - cl((t - (T.land - 250)) / (T.end - T.land + 150));
          for (const p of P) {
            const lift = (p.x / W) * T.beam * .96 + p.k * 60; if (t < lift) continue;
            let x, y, glow;
            const liftDur = 260, uX = p.x, uY = p.y - 10 - p.k * 26;
            if (t < lift + liftDur) { const e = ease.outC((t - lift) / liftDur); x = p.x + (Math.sin(p.a) * 6) * e; y = p.y + (uY - p.y) * e; glow = .12 + e * .25; }
            else if (t < T.burst) {
              const s = lift + liftDur, e = ease.inC(cl((t - s) / (T.gather - s)));
              const vx = uX - cx, vy = uY - cy, th = e * (2.4 + p.k * 1.2), rad = 1 - e;
              const ox = Math.cos(p.a + t / 180) * p.o * e, oy = Math.sin(p.a + t / 180) * p.o * e * .7;
              x = cx + (vx * Math.cos(th) - vy * Math.sin(th)) * rad + ox; y = cy + (vx * Math.sin(th) + vy * Math.cos(th)) * rad + oy;
              glow = .55 + e * .45;
            } else {
              const dist = Math.hypot(p.x - cx, p.y - cy) / diag, s = T.burst + dist * 380, e = ease.outBack(cl((t - s) / 560));
              const fx = cx + Math.cos(p.a + T.burst / 180) * p.o, fy = cy + Math.sin(p.a + T.burst / 180) * p.o * .7;
              x = fx + (p.x - fx) * e; y = fy + (p.y - fy) * e; glow = .7 * (1 - cl((t - s) / 420));
            }
            const a = fade * (t > T.burst ? .9 : t > T.beam ? .72 : .9), m = glow * .75;
            const r = (p.r * (1 - m) + CYAN[0] * m) * a, gg = (p.g * (1 - m) + CYAN[1] * m) * a, b = (p.b * (1 - m) + CYAN[2] * m) * a;
            const sz = t > T.land - 150 ? step : Math.max(2, step - 1);
            const x0 = x | 0, y0 = y | 0;
            for (let yy = y0; yy < y0 + sz; yy++) { if (yy < 0 || yy >= H) continue;
              for (let xx = x0; xx < x0 + sz; xx++) { if (xx < 0 || xx >= W) continue;
                const i = (yy * W + xx) << 2; d[i] = Math.min(255, d[i] + r); d[i + 1] = Math.min(255, d[i + 1] + gg); d[i + 2] = Math.min(255, d[i + 2] + b); d[i + 3] = 255; } }
          }
          lg.putImageData(buf, 0, 0);
          g.globalCompositeOperation = "lighter"; g.drawImage(layer, 0, 0);
          // the beam of light
          if (t < T.beam + 250) {
            const ba = 1 - cl((t - T.beam) / 250), grd = g.createLinearGradient(bx - 90, 0, bx + 24, 0);
            grd.addColorStop(0, "rgba(94,242,255,0)"); grd.addColorStop(.8, `rgba(94,242,255,${.35 * ba})`); grd.addColorStop(.97, `rgba(235,255,255,${.95 * ba})`); grd.addColorStop(1, "rgba(94,242,255,0)");
            g.fillStyle = grd; g.fillRect(bx - 90, 0, 114, H);
          }
          // the core: grows while the pixels gather, flashes at the burst
          if (t > T.beam * .6 && t < T.land) {
            const grow = cl((t - T.beam * .6) / (T.burst - T.beam * .6)), flash = t > T.burst ? 1 - cl((t - T.burst) / 420) : 0;
            const R = 20 + grow * 70 + flash * 140, ga = (t < T.burst ? grow * .9 : flash);
            const cg = g.createRadialGradient(cx, cy, 0, cx, cy, R);
            cg.addColorStop(0, `rgba(255,255,255,${ga})`); cg.addColorStop(.25, `rgba(160,250,255,${ga * .8})`); cg.addColorStop(1, "rgba(79,140,255,0)");
            g.fillStyle = cg; g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.fill();
          }
          // the shockwave
          if (t > T.burst && t < T.burst + 900) {
            const k = cl((t - T.burst) / 900), R = ease.outC(k) * diag * .62;
            g.lineWidth = 2 + (1 - k) * 10; g.strokeStyle = `rgba(150,245,255,${(1 - k) * .85})`;
            g.beginPath(); g.ellipse(cx, cy, R, R * .72, 0, 0, Math.PI * 2); g.stroke();
            g.lineWidth = 1; g.strokeStyle = `rgba(79,140,255,${(1 - k) * .5})`;
            g.beginPath(); g.ellipse(cx, cy, R * .82, R * .82 * .72, 0, 0, Math.PI * 2); g.stroke();
          }
          if (t < T.end) requestAnimationFrame(frame); else done();
        };
        requestAnimationFrame(frame);
      });
      cv.classList.add("out"); setTimeout(() => cv.remove(), 400);
      return true;
    } catch (e) { console.warn("genesis", e); document.querySelector("#wipe canvas.genesis")?.remove(); return false; }
    finally { busy = false; }
  };
  // Shift+G: play it again on the current result (for recording the demo)
  addEventListener("keydown", (e) => {
    if (e.shiftKey && (e.key === "G" || e.key === "g") && !/INPUT|TEXTAREA/.test(document.activeElement?.tagName || "") && !document.getElementById("work")?.hidden) {
      if (S.view !== "wipe") setView("wipe");
      setTimeout(() => window.genesis().then((ok) => ok && window.polishSweep?.([[0, 0], [1, 50]], 1300)), 60);
    }
  });
})();
