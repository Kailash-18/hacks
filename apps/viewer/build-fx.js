// Digital Lab teardown effects. build.js calls fx.scan(url, w, h) -> fx.analysed(analysis) -> fx.done(), or fx.abort().
// Everything shown comes from the real analysis: part boxes, nesting depth (from "contains" relationships) and labels.
(() => {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const q = (s, r = document) => r.querySelector(s);
  const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
  const escH = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const pascal = (s) => (String(s).match(/[A-Za-z0-9]+/g) || ["Part"]).slice(0, 3).map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join("");

  // parts with their nesting depth; big containers first so small parts sit on top
  function parts(a, max = 34) {
    const parent = {};
    for (const r of a.relationships || []) if (r.type === "contains") parent[r.to] = r.from;
    const depth = (id, seen = 0) => (parent[id] && seen < 8 ? 1 + depth(parent[id], seen + 1) : 0);
    return (a.components || []).filter((c) => c.bbox && c.bbox.width > 0.01 && c.bbox.height > 0.008)
      .map((c) => ({ ...c, d: depth(c.id) + 1, area: c.bbox.width * c.bbox.height }))
      .sort((x, y) => x.d - y.d || y.area - x.area).slice(0, max);
  }

  // one plate: the screenshot plus a layer per part, each textured with its own pixels
  function plate(host, url, w, h, maxW, maxH) {
    const k = Math.min(maxW / w, maxH / h);
    const el = document.createElement("div");
    el.className = "fx-plate";
    el.style.width = `${Math.round(w * k)}px`; el.style.height = `${Math.round(h * k)}px`;
    el.innerHTML = `<img alt="" src="${escH(url)}"><div class="fx-beam"></div>`;
    host.appendChild(el);
    return el;
  }
  function addParts(el, url, list, labels = 4) {
    const tagged = new Set(list.filter((p) => p.d <= 2 && p.area > 0.015).sort((a, b) => b.area - a.area).slice(0, labels).map((p) => p.id));
    list.forEach((p, i) => {
      const b = p.bbox, div = document.createElement("div");
      div.className = "fx-part";
      div.dataset.id = p.id;
      div.dataset.name = pascal(p.label);
      div.style.cssText = `left:${b.x * 100}%;top:${b.y * 100}%;width:${b.width * 100}%;height:${b.height * 100}%;--d:${p.d};--i:${i};` +
        `background-image:url("${url}");background-size:${100 / b.width}% ${100 / b.height}%;` +
        `background-position:${b.width < 1 ? (b.x / (1 - b.width)) * 100 : 0}% ${b.height < 1 ? (b.y / (1 - b.height)) * 100 : 0}%`;
      if (tagged.has(p.id)) div.innerHTML = `<span class="fx-tag">${escH(pascal(p.label))}</span>`;
      el.appendChild(div);
    });
    return [...el.querySelectorAll(".fx-part")];
  }

  // ---------- teardown overlay on the code stage ----------
  let run = 0, ov = null, pl = null, t0 = 0, tExploded = 0, ticker = null;
  let exploded = Promise.resolve(), markExploded = () => {};  // finish waits until the exploded view has been shown
  function overlay() {
    const stage = q("#stage");
    stage.classList.add("fx-on");
    ov?.remove();
    ov = document.createElement("div");
    ov.className = "fx";
    ov.innerHTML = `<div class="fx-cap"><span class="fx-step"></span><span class="fx-title"></span><span class="fx-sub"></span></div>
      <button class="fx-skip" type="button">Skip</button>`;
    stage.appendChild(ov);
    q(".fx-skip", ov).onclick = () => finish(run, true);
    return ov;
  }
  function caption(step, title, sub = "") {
    if (!ov) return;
    q(".fx-step", ov).textContent = step; q(".fx-title", ov).textContent = title; q(".fx-sub", ov).textContent = sub;
  }
  function clear() {
    clearInterval(ticker); ticker = null;
    ov?.remove(); ov = null; pl = null;
    q("#stage")?.classList.remove("fx-on");
  }

  async function scan(url, w, h) {
    if (reduce) return;
    const my = ++run;
    t0 = Date.now(); tExploded = 0;
    exploded = new Promise((ok) => (markExploded = ok));
    const o = overlay();
    const r = o.getBoundingClientRect();  // forces layout: the stage is visible by now
    pl = plate(o, url, w, h, r.width * 0.7, r.height * 0.66);
    caption("STEP 1 OF 3", "Reading the screen", "scanning pixels, text and layout…");
  }

  async function analysed(a) {
    if (reduce || !ov) return;
    const my = run;
    for (let i = 0; i < 20 && !pl; i++) await sleep(25);
    if (!pl) return;
    const url = q("img", pl).src;
    await sleep(Math.max(0, 900 - (Date.now() - t0)));  // let the scan be seen
    if (my !== run || !pl) return;
    const list = parts(a);
    const els = addParts(pl, url, list);
    caption("STEP 2 OF 3", "Finding every part", `0 of ${a.components.length} parts`);
    const gap = Math.min(45, 1100 / Math.max(1, els.length));
    for (let i = 0; i < els.length; i++) {
      if (my !== run) return;
      els[i].classList.add("on");
      q(".fx-sub", ov).textContent = `${Math.round(((i + 1) / els.length) * a.components.length)} of ${a.components.length} parts · ${list[i].type}: ${list[i].label.slice(0, 40)}`;
      await sleep(gap);
    }
    await sleep(350);
    if (my !== run || !pl) return;
    pl.classList.add("iso");  // tear it down: tilt into 3D, layers lift by nesting depth
    tExploded = Date.now();
    markExploded();
    const names = [...new Set(list.map((p) => `<${pascal(p.label)} />`))];
    let n = 0;
    caption("STEP 3 OF 3", "Rebuilding it as code", "");
    ticker = setInterval(() => {
      if (!ov) return;
      q(".fx-sub", ov).textContent = `writing ${names[n % names.length]}`;
      pl?.querySelectorAll(".fx-part.hot").forEach((e) => e.classList.remove("hot"));
      pl?.querySelector(`.fx-part[data-id="${CSS.escape(list[n % list.length].id)}"]`)?.classList.add("hot");
      n++;
    }, 520);
  }

  async function finish(my, skip = false) {
    if (!ov) return;
    if (!skip) {
      await Promise.race([exploded, sleep(8000)]);
      if (my !== run || !ov) return;
      await sleep(Math.max(0, 1700 - (Date.now() - (tExploded || Date.now()))));  // the exploded view is worth a look
      if (my !== run || !ov) return;
      clearInterval(ticker);
      caption("DONE", "Rebuilt", "here is the code next to the original");
      pl?.querySelectorAll(".fx-part.hot").forEach((e) => e.classList.remove("hot"));
      pl?.classList.remove("iso");  // reassemble
      await sleep(1000);
      if (my !== run || !ov) return;
    }
    ov.classList.add("out");
    await sleep(skip ? 200 : 550);
    if (my !== run) return;
    clear();
    sweep();
  }
  function done() { if (!reduce && ov) finish(run); }
  function abort() { run++; clear(); }

  // the compare slider sweeps from "all original" to the middle, revealing the rebuild
  function sweep() {
    if (reduce || typeof setWipe !== "function" || q("#wipe")?.hidden) return;
    const w = q("#wipe"); w.classList.add("reveal");
    const start = performance.now(), from = 100, to = 50, dur = 1100;
    const step = (now) => {
      const t = Math.min(1, (now - start) / dur), e = 1 - Math.pow(1 - t, 3);
      setWipe(from + (to - from) * e);
      if (t < 1) requestAnimationFrame(step); else setTimeout(() => w.classList.remove("reveal"), 600);
    };
    requestAnimationFrame(step);
  }

  // ---------- start page: a live exploded stack of an example screen ----------
  async function hero() {
    const host = q("#heroStack");
    if (!host) return;
    try {
      const all = await (await fetch("/api/digital/samples")).json();
      const pick = all.find((s) => /dashboard/i.test(s.id) && !s.compareWith) || all[0];
      if (!pick) return;
      const a = await (await fetch(`/api/digital/samples/${encodeURIComponent(pick.id)}`)).json();
      const [w, h] = await new Promise((ok) => { const i = new Image(); i.onload = () => ok([i.naturalWidth, i.naturalHeight]); i.onerror = () => ok([1280, 800]); i.src = pick.imageUrl; });
      const r = host.getBoundingClientRect();
      const p = plate(host, pick.imageUrl, w, h, r.width * 0.78, r.height * 0.7);
      p.classList.add("idle", "ghost");
      addParts(p, pick.imageUrl, parts(a, 26), 3);
      host.insertAdjacentHTML("beforeend", `<div class="hero-cap">${a.components.length} parts found in this screen · its exploded structure</div>`);
      if (!reduce) host.parentElement.addEventListener("pointermove", (e) => {
        const b = host.getBoundingClientRect(), x = (e.clientX - b.left) / b.width - 0.5, y = (e.clientY - b.top) / b.height - 0.5;
        p.style.setProperty("--rz", `${-38 + x * 16}deg`); p.style.setProperty("--rx", `${56 - y * 12}deg`);
      });
    } catch { host.hidden = true; }
  }

  window.fx = { scan, analysed, done, abort };
  if (document.readyState === "loading") addEventListener("DOMContentLoaded", hero); else hero();
})();
