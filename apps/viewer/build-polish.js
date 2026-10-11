// Digital Lab visual layer: coloured code, compare with the previous version, parts drawn on in Inspect, a score
// gauge in Accessibility, a data model that draws itself, example cards that turn into their rebuild, header stats
// and devices dealt out. It wraps the lab's render functions, so the lab logic stays where it is.
(() => {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const q = (s, r = document) => r.querySelector(s), qa = (s, r = document) => [...r.querySelectorAll(s)];
  const replay = (el, cls) => { if (!el) return; el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); };
  const wrap = (name, after) => { const base = window[name]; if (typeof base !== "function") return;
    window[name] = function (...a) { const r = base.apply(this, a); try { after(...a); } catch (e) { console.warn("polish", name, e); } return r; }; };
  const LANG = { html: "xml", react: "javascript", "react-native": "javascript", flutter: "dart" };
  const EXT = { html: "html", react: "jsx", "react-native": "js", flutter: "dart" };

  // ---------- coloured code ----------
  function colourCode() {
    const v = current(), el = q("#codeText"), pre = q("#codeView"); if (!v || !el) return;
    const key = v.code.length + ":" + S.target + ":" + S.cur[S.target];
    if (el.dataset.k === key) return; el.dataset.k = key;
    const lines = v.code.split("\n").length;
    pre.dataset.head = `${(S.analysis?.title || "screen").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}.${EXT[S.target] || "txt"}  ·  ${lines.toLocaleString()} lines  ·  ${(v.code.length / 1024).toFixed(1)} KB`;
    if (!window.hljs) return;
    try { el.innerHTML = hljs.highlight(v.code, { language: LANG[S.target] || "xml", ignoreIllegals: true }).value; el.classList.add("hljs"); }
    catch { el.textContent = v.code; }
  }
  const GUIDE_LANG = { jsx: "javascript", js: "javascript", ts: "typescript", tsx: "typescript", html: "xml", css: "css", sql: "sql", bash: "bash", sh: "bash", py: "python", json: "json" };
  wrap("renderGuide", () => {
    if (!window.hljs) return;
    qa("#guide .g-code").forEach((pre) => { const c = q("code", pre), l = GUIDE_LANG[(q("span", pre)?.textContent || "").trim().toLowerCase()];
      try { c.innerHTML = l ? hljs.highlight(c.textContent, { language: l, ignoreIllegals: true }).value : hljs.highlightAuto(c.textContent).value; c.classList.add("hljs"); } catch {} });
  });

  // ---------- compare: the screenshot, or the version before this one ----------
  const seg = document.createElement("div");
  seg.className = "seg cmp-seg"; seg.id = "cmpSeg"; seg.hidden = true;
  seg.innerHTML = `<button data-c="shot" class="on" title="Compare with the original screenshot">vs screenshot</button><button data-c="prev" title="Compare with the version before this one: see exactly what your change did">vs previous version</button>`;
  q("#viewSeg")?.after(seg);
  S.cmp = "shot";
  qa("button", seg).forEach((b) => (b.onclick = () => { setCmp(b.dataset.c); if (b.dataset.c === "prev") sweep(); }));
  const prevOf = () => { const i = S.cur[S.target]; return i > 0 ? S.versions[S.target][i - 1] : null; };
  function setCmp(mode) {
    const prev = prevOf(), on = mode === "prev" && prev && !isMobile();
    S.cmp = on ? "prev" : "shot";
    qa("button", seg).forEach((b) => b.classList.toggle("on", b.dataset.c === S.cmp));
    let f = q("#prevFrame"); const layer = q("#origLayer"), img = q("#origImg");
    if (on) {
      if (!f) { f = document.createElement("iframe"); f.id = "prevFrame"; f.title = "Previous version"; f.setAttribute("sandbox", "allow-scripts"); layer.prepend(f); }
      const doc = previewDoc(prev); if (f.dataset.k !== doc.length + ":" + S.cur[S.target]) { f.srcdoc = doc; f.dataset.k = doc.length + ":" + S.cur[S.target]; }
      img.hidden = true; sizePrev();
      q(".tag.left").textContent = `v${S.cur[S.target]}`; q(".tag.right").textContent = `v${S.cur[S.target] + 1} · now`;
      q("#acc")?.classList.add("dim");
    } else {
      f?.remove(); img.hidden = false;
      q(".tag.left").textContent = "Original"; q(".tag.right").textContent = "Rebuilt";
      q("#acc")?.classList.remove("dim");
    }
  }
  function sizePrev() { const f = q("#prevFrame"), m = q("#frame"); if (f && m) { f.style.width = m.style.width; f.style.height = m.style.height; f.style.transform = m.style.transform; } }
  wrap("fit", sizePrev);
  function sweep(keys = [[0, 100], [.45, 6], [1, 50]], dur = 2100) {
    if (reduce || typeof setWipe !== "function" || q("#wipe").hidden) return;
    const w = q("#wipe"); w.classList.add("reveal");
    const t0 = performance.now();
    if (keys.length === 2) keys = [keys[0], [(keys[0][0] + keys[1][0]) / 2, (keys[0][1] + keys[1][1]) / 2], keys[1]];
    const ease = (t) => (t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
    const step = (now) => {
      const t = Math.min(1, (now - t0) / dur);
      const i = t < keys[1][0] ? 0 : 1, [ta, va] = keys[i], [tb, vb] = keys[i + 1];
      setWipe(va + (vb - va) * ease((t - ta) / (tb - ta)));
      if (t < 1) requestAnimationFrame(step); else setTimeout(() => w.classList.remove("reveal"), 500);
    };
    requestAnimationFrame(step);
  }
  window.polishSweep = sweep;
  let seen = {};
  wrap("renderCode", () => {
    colourCode();
    const v = current(), n = S.versions[S.target].length, grew = n > (seen[S.target] || 0);
    seen[S.target] = n;
    const canPrev = !!prevOf() && !isMobile() && !v?.app && !(v?.code || "").includes("data-screen=");
    seg.hidden = !canPrev;
    const changed = v?.change && !v.app && !/^(Whole site|Refine)/.test(v.change) && !Object.values(CONVERT).includes(v.change);
    if (canPrev && grew && changed && S.cur[S.target] === n - 1) {  // a change just landed: show what it did
      if (S.view !== "wipe") setView("wipe");
      setCmp("prev"); setTimeout(sweep, 350);
    } else setCmp(canPrev ? S.cmp : "shot");
    chips();
  });

  // ---------- header stats ----------
  const hc = document.createElement("div"); hc.className = "head-chips"; hc.id = "headChips";
  q(".head-text")?.append(hc);
  function chips() {
    const a = S.analysis; if (!a) { hc.innerHTML = ""; return; }
    const v = current(), pct = q("#accPct")?.textContent || "", screens = (v?.code || "").match(/data-screen="[^"$]+"/g)?.length || 1;
    const items = [[a.components.length, "parts found"], /^\d+%$/.test(pct) && !q("#acc").hidden && /^visual match/.test(q("#accLbl")?.textContent || "") ? [pct, "visual match"] : null,
      screens > 1 ? [screens, "screens wired"] : null, [S.versions[S.target].length, S.versions[S.target].length === 1 ? "version" : "versions"],
      [TARGET_NAME[S.target], "code"]].filter(Boolean);
    const html = items.map(([n, l]) => `<span class="hchip"><b>${n}</b>${l}</span>`).join("");
    if (hc.dataset.h !== html) { hc.dataset.h = html; hc.innerHTML = html; replay(hc, "in"); }
  }
  const pctEl = q("#accPct");
  if (pctEl) new MutationObserver(() => /^\d+%$/.test(pctEl.textContent) && chips()).observe(pctEl, { childList: true, characterData: true, subtree: true });

  // ---------- Inspect: parts are drawn on one after another, each labelled on hover ----------
  function drawBoxes(host) {
    const boxes = qa(".box", host); if (!boxes.length) return;
    boxes.forEach((b, i) => { b.style.setProperty("--i", Math.min(i, 30)); if (!b.dataset.label) b.dataset.label = (b.title || "").replace(/\s*\(.*\)$/, ""); });
    replay(host, "draw");
  }
  wrap("renderStructure", () => drawBoxes(q("#boxes")));
  wrap("setTab", (t) => {
    if (t === "structure") requestAnimationFrame(() => drawBoxes(q("#boxes")));
    if (t === "a11y" && S.a11y) requestAnimationFrame(a11yFx);
    if (t === "backend" && S.backend) requestAnimationFrame(erFx);
  });

  // ---------- Accessibility: a score gauge, findings pinned on in order ----------
  function a11yFx() {
    const r = S.a11y, g = q("#axGrade"); if (!r || !g) return;
    const C = 2 * Math.PI * 25, col = { A: "#3ccf8e", B: "#9be15d", C: "#f2b84b", D: "#ff7a45" }[r.grade] || "#ff6b5b";
    g.innerHTML = `<svg viewBox="0 0 60 60" class="ax-ring"><circle cx="30" cy="30" r="25" class="trk"/><circle cx="30" cy="30" r="25" class="bar" style="stroke:${col};stroke-dasharray:${C};stroke-dashoffset:${C}"/></svg><b>${r.grade}</b>`;
    g.classList.add("gauge");
    requestAnimationFrame(() => requestAnimationFrame(() => { const bar = q(".bar", g); if (bar) bar.style.strokeDashoffset = C * (1 - r.score / 100); }));
    const t = q("#axScoreTxt"); if (t && !reduce) { const t0 = performance.now(); const tick = (now) => { const k = Math.min(1, (now - t0) / 900);
      t.textContent = `${Math.round(r.score * (1 - Math.pow(1 - k, 3)))}/100 accessibility`; if (k < 1) requestAnimationFrame(tick); }; requestAnimationFrame(tick); }
    qa("#axMarks .axm").forEach((m, i) => m.style.setProperty("--i", i)); replay(q("#axMarks"), "pin");
    qa("#axList li").forEach((m, i) => m.style.setProperty("--i", i)); replay(q("#axList"), "pin");
  }
  wrap("renderA11y", a11yFx);

  // ---------- Backend: the data model draws itself ----------
  function erFx() {
    const svg = q("#beEr"); if (!svg) return;
    if (!q("#erGrad", svg)) svg.insertAdjacentHTML("afterbegin", `<defs><linearGradient id="erGrad" x1="0" x2="1"><stop offset="0" stop-color="#2f6bff"/><stop offset="1" stop-color="#18b5d8"/></linearGradient></defs>`);
    qa(".er-e", svg).forEach((g, i) => g.style.setProperty("--i", i));
    qa(".er-l", svg).forEach((l) => { const n = l.getTotalLength?.() || 300; l.style.setProperty("--len", n); });
    replay(svg, "draw");
  }
  wrap("renderEr", erFx);

  // ---------- Devices: dealt out from one stack ----------
  const dev = q("#devices");
  if (dev) new MutationObserver(() => { if (!dev.hidden) replay(dev, "deal"); }).observe(dev, { attributes: true, attributeFilter: ["hidden"] });

  // ---------- example cards: hover turns the screenshot into its rebuild ----------
  const codeCache = {};
  async function exampleCode(s) {
    if (!s?.analysisId) return null;
    return (codeCache[s.analysisId] ||= (async () => { const f = new FormData(); f.append("analysisId", s.analysisId); f.append("target", "html");
      const r = await fetch("/api/digital/code", { method: "POST", body: f }); if (!r.ok) return null; const j = await r.json(); return j.source === "ai" ? j.code : null; })());
  }
  let samples = null;
  async function wireExamples() {
    const cards = qa("#examples .ex"); if (!cards.length) return;
    samples ||= await fetch("/api/digital/samples").then((r) => r.json()).catch(() => []);
    cards.forEach((card) => {
      if (card.dataset.fx) return; card.dataset.fx = 1;
      const s = samples.find((x) => x.id === card.dataset.id); if (!s) return;
      const img = q("img", card); const box = document.createElement("div"); box.className = "ex-live"; img.after(box);
      const tag = document.createElement("em"); tag.className = "ex-tag"; tag.textContent = "Screenshot"; card.append(tag);
      card.addEventListener("mouseenter", async () => {
        card.classList.add("hot");
        if (!box.firstChild) {
          const code = await exampleCode(s); if (!code || box.firstChild) return;
          const f = document.createElement("iframe"); f.setAttribute("sandbox", "allow-scripts"); f.tabIndex = -1; f.setAttribute("aria-hidden", "true");
          f.srcdoc = code.replace(/<\/head>/i, "<style>html{scrollbar-width:none}::-webkit-scrollbar{display:none}</style></head>");
          const W = img.naturalWidth || 1280, H = img.naturalHeight || 800, k = box.clientWidth / W;
          Object.assign(f.style, { width: `${W}px`, height: `${H}px`, transform: `scale(${k})` });
          f.onload = () => setTimeout(() => box.classList.add("ready"), 250);
          box.append(f);
        }
        tag.textContent = box.classList.contains("ready") ? "Rebuilt code" : "Rebuilding…";
        const t = setInterval(() => { if (box.classList.contains("ready")) { tag.textContent = card.classList.contains("hot") ? "Rebuilt code" : "Screenshot"; clearInterval(t); } }, 150);
      });
      card.addEventListener("mouseleave", () => { card.classList.remove("hot"); tag.textContent = "Screenshot"; });
    });
  }
  const ex = q("#examples");
  if (ex) { new MutationObserver(wireExamples).observe(ex, { childList: true }); wireExamples(); }
  // warm the saved code of the examples while the page is idle, so the first hover is instant
  setTimeout(async () => { samples ||= await fetch("/api/digital/samples").then((r) => r.json()).catch(() => []);
    for (const s of samples.slice(0, 4)) await exampleCode(s).catch(() => null); }, 1500);
})();
