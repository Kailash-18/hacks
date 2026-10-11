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
  let run = 0, ov = null, pl = null, t0 = 0, tExploded = 0, ticker = null, curParts = [];
  let exploded = Promise.resolve(), markExploded = () => {};  // finish waits until the exploded view has been shown
  function overlay() {
    const stage = q("#stage");
    stage.classList.add("fx-on");
    ov?.remove();
    ov = document.createElement("div");
    ov.className = "fx";
    ov.innerHTML = `<div class="fx-cap"><span class="fx-step"></span><span class="fx-title"></span><span class="fx-sub"></span></div>
      <pre class="fx-code" aria-hidden="true"></pre><button class="fx-skip" type="button">Skip</button>`;
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
    curParts = list;
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

  // the real generated code types out next to the exploded layers; a layer lights up when its text is written
  const SPAN = (t) => escH(t).replace(/(&lt;\/?[a-zA-Z][^&]*?&gt;)/g, '<i>$1</i>');
  async function stream(my, code) {
    const box = q(".fx-code", ov);
    if (!box || !code) return;
    const body = code.search(/<body/i), src = (body > 0 ? code.slice(body) : code).replace(/\n\s*\n/g, "\n");
    const text = src.split("\n").slice(0, 120).join("\n");
    clearInterval(ticker);
    pl?.classList.add("shift");
    box.classList.add("on");
    const t1 = performance.now(), dur = 3200;
    let shown = 0, lines = 0;
    await new Promise((ok) => {
      const tick = (now) => {
        if (my !== run || !ov) return ok();
        const n = Math.min(text.length, Math.round(text.length * Math.min(1, (now - t1) / dur)));
        if (n !== shown) {
          shown = n;
          const part = text.slice(0, n), all = part.split("\n");
          box.innerHTML = SPAN(all.slice(-26).join("\n")) + '<b class="fx-caret"></b>';
          if (all.length !== lines) {  // a new line: light the part whose text it writes
            lines = all.length;
            const said = (all[all.length - 2] || "").replace(/<[^>]*>/g, " ").trim().toLowerCase();
            if (said.length > 2) {
              const hit = curParts.find((p) => { const l = p.label.toLowerCase(); return l.length > 2 && (said.includes(l) || l.includes(said)); });
              if (hit) {
                pl?.querySelectorAll(".fx-part.hot").forEach((e) => e.classList.remove("hot"));
                pl?.querySelector(`.fx-part[data-id="${CSS.escape(hit.id)}"]`)?.classList.add("hot");
                q(".fx-sub", ov).textContent = `writing <${pascal(hit.label)} />`;
              }
            }
          }
        }
        if (n < text.length) requestAnimationFrame(tick); else ok();
      };
      requestAnimationFrame(tick);
    });
  }

  async function finish(my, skip = false, code = "") {
    if (!ov) return;
    if (!skip) {
      const ready = window.genesisPrep?.().catch(() => null);  // particles sampled while the code streams
      await Promise.race([exploded, sleep(8000)]);
      if (my !== run || !ov) return;
      await sleep(Math.max(0, 1200 - (Date.now() - (tExploded || Date.now()))));  // the exploded view is worth a look
      if (my !== run || !ov) return;
      await stream(my, code);
      if (my !== run || !ov) return;
      clearInterval(ticker);
      q(".fx-code", ov)?.classList.remove("on");
      pl?.classList.remove("shift");
      caption("DONE", "Rebuilt", "here is the code next to the original");
      pl?.querySelectorAll(".fx-part.hot").forEach((e) => e.classList.remove("hot"));
      if (window.genesis && await ready) {
        // the scan is done: the light takes over on this exact frame, under the fading teardown
        const played = window.genesis();
        ov.classList.add("fast", "out");
        await sleep(260);
        if (my === run) clear();
        if (await played) window.polishSweep?.([[0, 0], [1, 50]], 1300); else sweep();
        return;
      }
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
  function done(code) { if (!reduce && ov) finish(run, false, code); }
  function abort() { run++; clear(); }

  // the compare slider sweeps from "all original" to the middle, revealing the rebuild
  function sweep() {
    if (window.polishSweep) return window.polishSweep();
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


  // ---------- X-ray: hover the rebuilt page, the original part and the element's code light up (and back) ----------
  // A small script inside the sandboxed preview reports the hovered element (text, tag, html); it is matched to the
  // analysis by visible text, so the link is real, not drawn. Hovering the original asks the preview to light its element.
  const XRAY_JS = `<script>(()=>{let on=false,last=null;const st=document.createElement("style");
st.textContent=".__xr{outline:2px solid #5ef2ff!important;outline-offset:2px!important;box-shadow:0 0 0 4px rgba(94,242,255,.22),0 0 26px rgba(94,242,255,.55)!important}";
document.head.appendChild(st);const T=e=>((e.innerText||e.value||e.placeholder||e.getAttribute("aria-label")||"")+"").trim().replace(/\\s+/g," ");
const pick=e=>{while(e&&e!==document.body&&e!==document.documentElement){const t=T(e);if(t&&t.length<=140)return e;e=e.parentElement}return null};
const mark=e=>{if(last)last.classList.remove("__xr");last=e;if(e)e.classList.add("__xr")};
addEventListener("message",v=>{const d=v.data||{};if("xray" in d){on=d.xray;if(!on)mark(null)}
if(d.find){const w=d.find.toLowerCase();let b=null,bl=1e9;for(const e of document.body.querySelectorAll("*")){const t=T(e).toLowerCase();
if(!t||t.length>220)continue;if(t===w||(w.length>2&&t.includes(w))){if(t.length<bl){bl=t.length;b=e}}}
const h=b?b.outerHTML.replace(/\\s+/g," ").slice(0,360):"";mark(b);if(b)parent.postMessage({xrayCode:{tag:b.tagName.toLowerCase(),html:h}},"*")}});
document.addEventListener("mouseover",v=>{if(!on)return;const e=pick(v.target);if(!e||e===last)return;const h=e.outerHTML.replace(/\\s+/g," ").slice(0,360);mark(e);
parent.postMessage({xrayHit:{text:T(e).slice(0,140),tag:e.tagName.toLowerCase(),html:h}},"*")},true);
document.documentElement.addEventListener("mouseleave",()=>{if(on){mark(null);parent.postMessage({xrayHit:null},"*")}});})();<\/script>`;
  if (typeof previewDoc === "function") {
    const base = previewDoc;
    window.previewDoc = (v) => {
      const doc = base(v);
      if (!["html", "react"].includes(S.target)) return doc;
      return /<\/body>/i.test(doc) ? doc.replace(/<\/body>(?![\s\S]*<\/body>)/i, XRAY_JS + "</body>") : doc + XRAY_JS;
    };
  }
  const words = (t) => (String(t).toLowerCase().match(/[a-z0-9]+/g) || []);
  function sim(a, b) {
    a = words(a).join(" "); b = words(b).join(" ");
    if (!a || !b) return 0;
    if (a === b) return 1;
    if (a.includes(b) || b.includes(a)) return 0.35 + 0.6 * Math.min(a.length, b.length) / Math.max(a.length, b.length);
    const A = new Set(a.split(" ")), B = new Set(b.split(" "));
    return [...A].filter((x) => B.has(x)).length / new Set([...A, ...B]).size;
  }
  function matchPart(text) {
    let best = null, bs = 0.45;
    for (const c of S.analysis?.components || []) {
      if (!c.bbox) continue;
      const sc = sim(text, c.label) - c.bbox.width * c.bbox.height * 0.05;  // ties go to the smaller part
      if (sc > bs) { bs = sc; best = c; }
    }
    return best;
  }
  let xrayOn = false;
  function xrBox() {
    const img = q("#sideImg"), fig = img?.parentElement;
    if (!fig) return null;
    fig.style.position = "relative";
    let b = q(".xr-box", fig);
    if (!b) { b = document.createElement("div"); b.className = "xr-box"; fig.appendChild(b); }
    return b;
  }
  function glow(c) {
    const b = xrBox(), img = q("#sideImg");
    if (!b) return;
    if (!c) { b.hidden = true; return; }
    const r = c.bbox;
    b.hidden = false;
    Object.assign(b.style, { left: `${img.offsetLeft + r.x * img.offsetWidth}px`, top: `${img.offsetTop + r.y * img.offsetHeight}px`,
      width: `${r.width * img.offsetWidth}px`, height: `${r.height * img.offsetHeight}px` });
    b.dataset.label = `${c.type} · ${c.label.slice(0, 40)}`;
  }
  function tip(hit, c) {
    let t = q("#xrTip");
    if (!t) { t = document.createElement("div"); t.id = "xrTip"; t.className = "xr-tip"; q("#side").appendChild(t); }
    if (!hit) { t.hidden = true; return; }
    t.hidden = false;
    t.innerHTML = `<div class="xr-head"><b>${escH(c ? c.label.slice(0, 50) : hit.text.slice(0, 50))}</b><span>${escH(c ? c.type : "not matched")} · &lt;${escH(hit.tag)}&gt;</span></div>
      <code>${escH(hit.html)}${hit.html.length >= 360 ? "…" : ""}</code>`;
  }
  function setXray(on) {
    xrayOn = on;
    q("#xrayBtn")?.classList.toggle("on", on);
    if (on && S.view !== "side") setView("side");
    q("#sideFrame")?.contentWindow?.postMessage({ xray: on }, "*");
    q("#side")?.classList.toggle("xray", on);
    if (!on) { glow(null); tip(null); }
  }
  let lastPart = null;
  addEventListener("message", (e) => {
    if (e.source !== q("#sideFrame")?.contentWindow || !xrayOn) return;
    if (e.data?.xrayCode && lastPart) { tip({ text: lastPart.label, ...e.data.xrayCode }, lastPart); return; }  // reverse: its code
    if (!("xrayHit" in (e.data || {}))) return;
    const hit = e.data.xrayHit, c = hit ? matchPart(hit.text) : null;
    glow(c); tip(hit, c);
  });
  q("#sideFrame")?.addEventListener("load", () => { if (xrayOn) setTimeout(() => q("#sideFrame").contentWindow.postMessage({ xray: true }, "*"), 60); });
  function partAt(ev) {
    const img = q("#sideImg"), r = img.getBoundingClientRect(), x = (ev.clientX - r.left) / r.width, y = (ev.clientY - r.top) / r.height;
    let best = null;
    for (const c of S.analysis?.components || []) {
      const b = c.bbox;
      if (b && x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height && (!best || b.width * b.height < best.bbox.width * best.bbox.height)) best = c;
    }
    return best;
  }
  let lastFind = null;
  q("#sideImg")?.addEventListener("mousemove", (ev) => {
    if (!xrayOn) return;
    const c = partAt(ev);
    if (c?.id === lastFind) return;
    lastFind = c?.id; lastPart = c;
    glow(c);
    q("#sideFrame").contentWindow.postMessage({ find: c ? c.label : "" }, "*");
    tip(c ? { text: c.label, tag: "…", html: "hover the rebuilt page to see this element's code" } : null, c);
  });
  // the X-ray button sits with the view switch
  const vs = q("#viewSeg");
  if (vs) {
    vs.insertAdjacentHTML("afterend", `<button id="xrayBtn" class="xray-btn" type="button" title="Hover the rebuilt page: the matching part of the original and its code light up">X-ray</button>`);
    q("#xrayBtn").onclick = () => setXray(!xrayOn);
    vs.addEventListener("click", (e) => { if (e.target.dataset?.v && e.target.dataset.v !== "side" && xrayOn) setXray(false); });
  }


  // ---------- demo mode (/digital?demo): plays the whole story with captions, for the 3-minute video ----------
  const waitFor = async (ok, ms = 90000) => { const t = Date.now(); while (!ok() && Date.now() - t < ms) await sleep(150); return ok(); };
  function cap(n, total, text) {
    let c = q("#demoCap");
    if (!c) { c = document.createElement("div"); c.id = "demoCap"; c.className = "demo-cap"; document.body.appendChild(c); }
    c.innerHTML = n ? `<span>${n} / ${total}</span>${escH(text)}` : escH(text);
    c.classList.remove("in"); void c.offsetWidth; c.classList.add("in");
  }
  function slide(from, to, ms) {
    return new Promise((ok) => { const t1 = performance.now();
      const st = (now) => { const t = Math.min(1, (now - t1) / ms), e = t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        setWipe(from + (to - from) * e); t < 1 ? requestAnimationFrame(st) : ok(); };
      requestAnimationFrame(st); });
  }
  async function typeInto(el, text) { el.focus(); el.value = ""; for (const ch of text) { el.value += ch; await sleep(38); } }
  async function demo() {
    const N = 10;
    const say = (n, text) => (window.tour ? window.tour.cap(n, text) : cap(n, N, text));  // full-site tour shares captions
    if (window.tour) await window.tour.bridgeOut();
    document.body.classList.add("demo");
    await waitFor(() => document.querySelectorAll(".ex").length > 1, 15000);
    say(1, "Paste a screenshot of any website or app");
    await sleep(3200);
    const ex = [...document.querySelectorAll(".ex")].find((b) => /log in/i.test(b.textContent)) || document.querySelectorAll(".ex")[0];
    ex.click();
    say(2, "It reads the screen, finds every part and tears it down into layers");
    await waitFor(() => S.versions.html.length && !q(".fx"));
    await sleep(700);
    scrollTo({ top: q(".tabs").getBoundingClientRect().top + scrollY - 70, behavior: "smooth" });
    say(3, "The rebuilt page runs live next to the original. Drag to compare");
    await sleep(600); await slide(50, 88, 1400); await slide(88, 12, 2000); await slide(12, 50, 1200);
    await sleep(600);
    say(4, "X-ray: every part of the rebuild is linked to the original and to its code");
    setXray(true);
    await sleep(900);
    const tour = (S.analysis?.components || []).filter((c) => c.bbox && /button|input|heading|link|text/.test(c.type) && c.label.length > 2)
      .sort((a, b) => b.bbox.width * b.bbox.height - a.bbox.width * a.bbox.height).slice(0, 4);
    for (const c of tour) {
      lastPart = c; glow(c);
      tip({ text: c.label, tag: "…", html: "finding its element in the rebuilt page…" }, c);  // replaced by the real code when found
      q("#sideFrame").contentWindow.postMessage({ find: c.label }, "*");
      await sleep(1700);
    }
    setXray(false); setView("wipe");
    say(5, "Inspect: the full component tree, every part boxed on the original");
    setTab("structure");
    await sleep(4600);
    setTab("code");
    say(6, "Ask for changes in plain English");
    scrollTo({ top: 0, behavior: "smooth" });
    await typeInto(q("#change"), "Switch the whole page to a dark theme");
    await sleep(400);
    const before = S.versions.html.length;
    q("#changeForm").requestSubmit();
    await waitFor(() => S.versions.html.length > before);
    await sleep(500); await slide(100, 50, 1300); await sleep(2200);
    say(7, "One click turns it into a mobile app: React Native, or Flutter");
    S.cur.html = 0;  // convert the first version (its React Native result is saved with the example)
    q('#targetSeg button[data-t="react-native"]').click();
    await waitFor(() => S.versions["react-native"].length);
    await sleep(4200);
    say(8, "A step-by-step plan to build it for real: stack, steps, effort");
    setTab("guide"); scrollTo({ top: 0 });
    await sleep(1200);
    const g = q("#guide"); const end = g.getBoundingClientRect().top + scrollY + g.offsetHeight - innerHeight;
    for (let y = scrollY; y < end; y += 6) { scrollTo(0, y); await sleep(16); }
    await sleep(800);
    say(9, "It even infers the backend: data models and API endpoints behind the screen");
    scrollTo({ top: 0 }); setTab("backend");
    await sleep(5200);
    say(10, "Plus an accessibility audit: contrast, labels, sizes, with one-click fixes");
    scrollTo({ top: 0 }); setTab("a11y");
    await sleep(2600);
    const ax = q("#tab-a11y"); const end2 = ax.getBoundingClientRect().top + scrollY + ax.offsetHeight - innerHeight;
    for (let y = scrollY; y < end2; y += 5) { scrollTo(0, y); await sleep(16); }
    await sleep(1600);
    if (window.tour) { await sleep(800); await window.tour.outro(); }
    else cap(0, 0, "Visual Reverse Engineering · screenshot in, working system out");
  }
  if (/[?&](demo|tour)\b/.test(location.search)) setTimeout(() => demo().catch((e) => cap(0, 0, `Demo stopped: ${e.message}`)), 400);

  window.fx = { scan, analysed, done, abort, setXray, matchPart, glow };
  if (document.readyState === "loading") addEventListener("DOMContentLoaded", hero); else hero();
})();
