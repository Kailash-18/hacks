// Digital Lab, simple flow: one screenshot -> rebuilt code (HTML or React), how to build it, structure.
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const S = {
  shot: null,          // {blob, url, w, h, name}
  analysis: null,
  versions: { html: [], react: [] },  // [{code, notes, source, change, label}]
  cur: { html: -1, react: -1 },
  target: "html", view: "wipe", tab: "code",
  guide: null, tree: null, sel: null, wipe: 50, run: 0,
};

const CHIPS = ["Make it mobile friendly", "Add a dark mode", "Add hover and focus states", "Use real icons (inline SVG)"];

// ---------- api ----------
async function api(path, opts = {}) {
  const r = await fetch(path, opts);
  let body = null;
  try { body = await r.json(); } catch { /* non-JSON error page */ }
  if (!r.ok) throw new Error(body?.error?.message || `Request failed (${r.status})`);
  return body;
}
function form(extra = {}) {
  const fd = new FormData();
  fd.append("image", S.shot.blob, S.shot.name);
  for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== null && v !== "") fd.append(k, v);
  return fd;
}
function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 3200);
}
function status(msg, err = false) { const s = $("#status"); s.textContent = msg || ""; s.classList.toggle("err", err); }
const imgSize = (url) => new Promise((ok) => { const i = new Image(); i.onload = () => ok([i.naturalWidth, i.naturalHeight]); i.onerror = () => ok([1280, 800]); i.src = url; });

// ---------- input: paste, drop, file, examples ----------
$("#file").addEventListener("change", (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) start(f, f.name); });
document.addEventListener("paste", (e) => {
  const item = [...(e.clipboardData?.items || [])].find((it) => it.kind === "file" && it.type.startsWith("image/"));
  if (!item) return;
  e.preventDefault();
  const f = item.getAsFile();
  start(f, `pasted-${new Date().toTimeString().slice(0, 8).replace(/:/g, "")}.${f.type.split("/")[1] === "jpeg" ? "jpg" : "png"}`);
});
document.addEventListener("dragover", (e) => { if ([...e.dataTransfer.types].includes("Files")) { e.preventDefault(); $("#drop").classList.add("over"); } });
document.addEventListener("dragleave", (e) => { if (!e.relatedTarget) $("#drop").classList.remove("over"); });
document.addEventListener("drop", (e) => {
  $("#drop").classList.remove("over");
  const f = [...(e.dataTransfer?.files || [])].find((x) => x.type.startsWith("image/"));
  if (!f) return;
  e.preventDefault(); start(f, f.name);
});
$("#drop").addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("#file").click(); } });
$("#newShot").onclick = () => { history.pushState(null, "", "/digital"); showStart(); };
addEventListener("popstate", () => { if (!location.hash) showStart(); });

async function loadExamples() {
  try {
    const all = await api("/api/digital/samples");
    const set = all.filter((s) => s.set).sort((a, b) => (a.order ?? 99) - (b.order ?? 99)).filter((s) => !s.compareWith);
    const list = (set.length ? set : all).slice(0, 4);
    $("#examples").innerHTML = list.map((s) => `<button class="ex" data-id="${esc(s.id)}"><img src="${esc(s.imageUrl)}" alt="" loading="lazy" /><span>${esc(s.title.replace(/^.*·\s*/, ""))}</span></button>`).join("");
    $$(".ex").forEach((b) => (b.onclick = async () => {
      const s = list.find((x) => x.id === b.dataset.id);
      const blob = await (await fetch(s.imageUrl)).blob();
      start(blob, `${s.id}.png`, s.title.replace(/^.*·\s*/, ""));
    }));
    if (!list.length) $(".examples").hidden = true;
  } catch { $(".examples").hidden = true; }
}

function showStart() {
  $("#start").hidden = false; $("#work").hidden = true;
  S.run++;  // late responses from the previous screenshot are ignored
}

// ---------- main flow ----------
async function start(blob, name, title = "") {
  const run = ++S.run;
  if (S.shot?.url) URL.revokeObjectURL(S.shot.url);
  const url = URL.createObjectURL(blob);
  const [w, h] = await imgSize(url);
  Object.assign(S, { shot: { blob, url, w, h, name }, analysis: null, guide: null, tree: null, sel: null,
    versions: { html: [], react: [] }, cur: { html: -1, react: -1 }, target: "html", backend: null, a11y: null, acc: {} });
  $("#acc").hidden = true; $("#heat").hidden = true; $("#accHeat").checked = false;
  for (const id of ["#beImg", "#axImg"]) $(id).src = url;
  $("#beSummary").textContent = "Inferring the data model and API from what the screen shows…"; $("#beEr").innerHTML = "";
  $("#beEndpoints").innerHTML = ""; $("#beBoxes").innerHTML = ""; $("#beNotes").innerHTML = ""; $("#beBadge").textContent = "";
  $("#axList").innerHTML = ""; $("#axMarks").innerHTML = ""; $("#axGrade").textContent = "–"; $("#axScoreTxt").textContent = "Checking…";
  $("#start").hidden = true; $("#work").hidden = false;
  if (location.hash !== "#result") history.pushState(null, "", "#result");
  for (const id of ["#thumb", "#origImg", "#sideImg", "#structImg"]) $(id).src = url;
  $("#title").textContent = title || "Reading the screenshot…";
  $("#summary").textContent = "";
  $("#guide").innerHTML = `<p class="muted">The build guide appears here once the screenshot is read.</p>`;
  $("#tree").innerHTML = ""; $("#boxes").innerHTML = ""; $("#answer").textContent = "";
  setTarget("html", false); setTab("code"); setView("wipe");
  wait("Reading the screenshot…");
  status("Finding every section, button and text on the screen.");
  renderVersions(); renderNotes();

  try {
    const fd = new FormData(); fd.append("image", blob, name);
    const a = await api("/api/digital/analyze", { method: "POST", body: fd });
    if (run !== S.run) return;
    S.analysis = a;
    $("#title").textContent = title || a.title;
    $("#summary").textContent = a.summary || "";
    renderStructure();
  } catch (e) {
    if (run !== S.run) return;
    wait(null); status(`Could not read the screenshot: ${e.message}`, true); return;
  }
  wait("Writing the code…");
  status("Writing the code and the build plan. This takes about 20–40 seconds.");
  const code = makeCode({ target: "html" }, "First version", run);
  const guide = api("/api/digital/guide", { method: "POST", body: form() })
    .then((g) => { if (run === S.run) { S.guide = g; renderGuide(); } })
    .catch((e) => { if (run === S.run) $("#guide").innerHTML = `<p class="fallback">Could not write the guide: ${esc(e.message)}</p>`; });
  await Promise.allSettled([code, guide]);
  if (run === S.run && !$("#status").classList.contains("err")) status("");
}

async function makeCode(params, label, run = S.run) {
  const t = params.target;
  wait(params.change ? "Applying the change…" : t === "react" ? "Converting to React…" : "Writing the code…");
  busy(true);
  try {
    const out = await api("/api/digital/code", { method: "POST", body: form(params) });
    if (run !== S.run) return;
    S.versions[t].push({ code: out.code, notes: out.notes || [], source: out.source, change: out.change, label,
      model: out.provider?.model, cached: out.cached });
    S.cur[t] = S.versions[t].length - 1;
    if (out.source !== "ai") status(out.notes?.[0] || "Showing the layout-only draft.", true);
    else status("");
    S.target = t; renderTarget(); renderVersions(); renderNotes(); renderCode();
  } catch (e) {
    if (run === S.run) status(`Could not write the code: ${e.message}`, true);
  } finally {
    if (run === S.run) { wait(null); busy(false); }
  }
}

const current = () => S.versions[S.target][S.cur[S.target]];
function busy(on) { for (const id of ["#apply", "#regen", "#copy", "#download", "#openTab"]) $(id).disabled = on; $$("#targetSeg button").forEach((b) => (b.disabled = on)); }
function wait(msg) { $("#stageWait").hidden = !msg; if (msg) $("#stageWaitText").textContent = msg; }

// ---------- code view ----------
// preview only: no scrollbar strip over the comparison (the downloaded code is untouched)
const NO_BAR = "<style>html{scrollbar-width:none}::-webkit-scrollbar{display:none}</style>";
function previewDoc(v) {
  if (S.target === "html") return /<\/head>/i.test(v.code) ? v.code.replace(/<\/head>/i, NO_BAR + "</head>") : NO_BAR + v.code;
  // React preview: same Tailwind, React + Babel in the sandboxed frame
  let src = v.code.replace(/^\s*import[^;\n]*;?\s*$/gm, "");
  const m = src.match(/export\s+default\s+function\s+([A-Z]\w*)/) || src.match(/export\s+default\s+([A-Z]\w*)\s*;?/);
  const name = m ? m[1] : "Screen";
  src = src.replace(/export\s+default\s+function/, "function").replace(/^\s*export\s+default\s+[A-Z]\w*\s*;?\s*$/m, "").replace(/export\s+(?=(function|const))/g, "");
  src = src.replace(/<\/script/gi, "<\\/script");
  return `<!doctype html><html><head><meta charset="utf-8"><script src="https://cdn.tailwindcss.com"></script>
<script src="https://unpkg.com/react@18.3.1/umd/react.production.min.js"></script>
<script src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js"></script>
<script src="https://unpkg.com/@babel/standalone@7.24.7/babel.min.js"></script>${NO_BAR}</head>
<body><div id="root"></div><script type="text/babel" data-presets="react">
const { useState, useEffect, useRef, useMemo, useCallback, Fragment } = React;
${src}
ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(${name}));
</script></body></html>`;
}

function renderCode() {
  const v = current();
  if (!v) return;
  const doc = previewDoc(v);
  for (const id of ["#frame", "#sideFrame"]) if ($(id).dataset.doc !== doc.length + ":" + S.target + S.cur[S.target]) { $(id).srcdoc = doc; $(id).dataset.doc = doc.length + ":" + S.target + S.cur[S.target]; }
  $("#codeText").textContent = v.code;
  fit();
  measureAccuracy(v, doc);
}

function fit() {
  const { w, h } = S.shot || {};
  if (!w) return;
  const wipe = $("#wipe"), width = $("#stage").clientWidth - 28;
  // fit the whole comparison on screen: limited by the column width and by the window height
  const tall = Math.max(360, innerHeight - Math.max($("#stage").getBoundingClientRect().top, 0) - 44);
  const k = Math.min(1, width / w, tall / h);
  wipe.style.width = `${Math.round(w * k)}px`; wipe.style.height = `${Math.round(h * k)}px`;
  sizeFrame($("#frame"), k);
  const sw = $("#sideFrameWrap"), ks = sw.clientWidth / w;
  sw.style.height = `${Math.round(h * ks)}px`;
  sizeFrame($("#sideFrame"), ks);
  setWipe(S.wipe);
}
function sizeFrame(f, k) { f.style.width = `${S.shot.w}px`; f.style.height = `${S.shot.h}px`; f.style.transform = `scale(${k})`; }
addEventListener("resize", () => { if (!$("#work").hidden) { fit(); placeBoxes(); } });

// wipe slider: original on the left of the line, rebuilt on the right
function setWipe(p) {
  S.wipe = Math.max(0, Math.min(100, p));
  $("#origLayer").style.clipPath = `inset(0 ${100 - S.wipe}% 0 0)`;
  $("#handle").style.left = `${S.wipe}%`;
  $("#handle").setAttribute("aria-valuenow", Math.round(S.wipe));
  $(".tag.left").hidden = S.wipe < 12; $(".tag.right").hidden = S.wipe > 88;  // label only what is visible
}
(() => {
  const wipe = $("#wipe");
  let drag = false;
  const move = (e) => { const r = wipe.getBoundingClientRect(); setWipe(((e.clientX - r.left) / r.width) * 100); };
  wipe.addEventListener("pointerdown", (e) => { drag = true; wipe.setPointerCapture(e.pointerId); move(e); });
  wipe.addEventListener("pointermove", (e) => drag && move(e));
  wipe.addEventListener("pointerup", () => (drag = false));
  $("#handle").addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") setWipe(S.wipe - 5);
    if (e.key === "ArrowRight") setWipe(S.wipe + 5);
  });
})();

function setView(v) {
  S.view = v;
  $$("#viewSeg button").forEach((b) => b.classList.toggle("on", b.dataset.v === v));
  $("#wipe").hidden = v !== "wipe"; $("#side").hidden = v !== "side"; $("#codeView").hidden = v !== "code";
  requestAnimationFrame(fit);
}
$$("#viewSeg button").forEach((b) => (b.onclick = () => setView(b.dataset.v)));

function setTarget(t, generate = true) {
  S.target = t; renderTarget();
  if (generate && t === "react" && !S.versions.react.length) {
    const base = S.versions.html[S.cur.html];
    makeCode({ target: "react", baseCode: base?.code, change: base ? "Convert this page to a React component; keep the look identical." : "" }, "First React version");
    return;
  }
  renderVersions(); renderNotes(); renderCode();
}
function renderTarget() { $$("#targetSeg button").forEach((b) => b.classList.toggle("on", b.dataset.t === S.target)); }
$$("#targetSeg button").forEach((b) => (b.onclick = () => { if (S.analysis) setTarget(b.dataset.t); }));

function renderVersions() {
  const vs = S.versions[S.target];
  $("#versions").innerHTML = vs.length ? vs.map((v, i) => `<li><button class="${i === S.cur[S.target] ? "on" : ""}" data-i="${i}">v${i + 1} · ${esc(v.label)}
      <small>${v.source === "ai" ? esc(v.model || "AI") : "layout-only draft"}${v.cached ? " · saved result" : ""}</small></button></li>`).join("")
    : `<li class="muted" style="font-size:14px">No version yet.</li>`;
  $$("#versions button").forEach((b) => (b.onclick = () => { S.cur[S.target] = +b.dataset.i; renderVersions(); renderNotes(); renderCode(); }));
}
function renderNotes() {
  const v = current();
  $("#notes").innerHTML = v?.notes?.length ? `<p><b>Notes</b></p><ul>${v.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : "";
}

$("#chips").innerHTML = CHIPS.map((c) => `<button type="button">${esc(c)}</button>`).join("");
$$("#chips button").forEach((b) => (b.onclick = () => { $("#change").value = b.textContent; $("#change").focus(); }));
$("#changeForm").onsubmit = (e) => {
  e.preventDefault();
  const change = $("#change").value.trim(), v = current();
  if (!change) return toast("Describe the change first, for example: make it mobile friendly.");
  if (!v) return toast("Wait for the first version.");
  makeCode({ target: S.target, change, baseCode: v.code }, change.length > 40 ? change.slice(0, 40) + "…" : change).then(() => ($("#change").value = ""));
};
$("#regen").onclick = () => { if (S.analysis) makeCode({ target: S.target, force: "1" }, "Written again"); };

const fileName = () => (S.analysis?.title || "screen").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "screen";
$("#copy").onclick = async () => {
  const v = current(); if (!v) return;
  try { await navigator.clipboard.writeText(v.code); toast("Code copied"); } catch { toast("Copy failed: select the code in the Code view instead."); }
};
$("#download").onclick = () => {
  const v = current(); if (!v) return;
  const [ext, type] = S.target === "html" ? ["html", "text/html"] : ["jsx", "text/javascript"];
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([v.code], { type })); a.download = `${fileName()}.${ext}`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast(`Downloaded ${fileName()}.${ext}`);
};
$("#openTab").onclick = () => {
  const v = current(); if (!v) return;
  const u = URL.createObjectURL(new Blob([previewDoc(v)], { type: "text/html" }));
  window.open(u, "_blank", "noopener");
};

// ---------- tabs ----------
function setTab(t) {
  S.tab = t;
  $$(".tabs button").forEach((b) => b.setAttribute("aria-selected", b.dataset.tab === t));
  for (const x of ["code", "guide", "structure", "explode", "backend", "a11y"]) $(`#tab-${x}`).hidden = x !== t;
  if (t === "code") requestAnimationFrame(fit);
  if (t === "structure") requestAnimationFrame(placeBoxes);
  if (t === "explode") window.DL3D?.show();
  if (t === "backend") loadBackend();
  if (t === "a11y") loadA11y();
}
$$(".tabs button").forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));

// ---------- guide ----------
function renderGuide() {
  const g = S.guide; if (!g) return;
  const c = g.tokens?.colors || {}, ts = g.tokens?.typeScale || {};
  $("#guide").innerHTML = `
    ${g.source !== "ai" ? `<p class="fallback">${esc(g.notes?.[0] || "AI unavailable.")} This is a basic outline from the detected structure.</p>` : ""}
    <h2>How to build ${esc(S.analysis?.title || "this screen")}</h2>
    <p>${esc(g.summary)}</p>
    ${g.effort?.estimate ? `<p class="effort">Difficulty <b>${esc(g.effort.level)}</b> · ${esc(g.effort.estimate)}</p>` : ""}
    ${g.stack?.length ? `<h3>Recommended stack</h3><div class="stack">${g.stack.map((s) => `<div><b>${esc(s.name)}</b><span>${esc(s.why)}</span></div>`).join("")}</div>` : ""}
    ${g.steps?.length ? `<h3>Steps</h3><ol class="steps">${g.steps.map((s) => `<li><b>${esc(s.title)}</b><p>${esc(s.detail)}</p></li>`).join("")}</ol>` : ""}
    ${g.components?.length ? `<h3>Components to build</h3><table class="comps">${g.components.map((x) => `<tr><td>${esc(x.name)}</td><td>${esc(x.purpose)}${x.props?.length ? `<br>${x.props.map((p) => `<code>${esc(p)}</code>`).join("")}` : ""}</td></tr>`).join("")}</table>` : ""}
    ${g.behaviour?.length ? `<h3>What the screenshot can't show</h3><p class="muted">You still need to build these. They are informed guesses from what is visible.</p><ul class="plain">${g.behaviour.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>` : ""}
    ${g.data?.length ? `<h3>Data it needs</h3><ul class="plain">${g.data.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>` : ""}
    ${Object.keys(c).length ? `<h3>Design tokens</h3><p class="muted">Measured from the screenshot's pixels.</p><div class="swatches">${Object.entries(c).map(([k, v]) => `<span class="sw"><i style="background:${esc(v)}"></i>${esc(k)} <code>${esc(v)}</code></span>`).join("")}</div>
      <p class="muted" style="margin-top:12px">Text sizes: ${Object.entries(ts).map(([k, v]) => `${esc(k)} ${esc(v)}px`).join(", ")}</p>` : ""}`;
}

// ---------- structure ----------
async function renderStructure() {
  const a = S.analysis; if (!a) return;
  $("#partCount").textContent = `(${a.components.length})`;
  $("#boxes").innerHTML = a.components.filter((c) => c.bbox).map((c) => `<div class="box" data-id="${esc(c.id)}" title="${esc(c.label)} (${esc(c.type)})"></div>`).join("");
  $$(".box").forEach((b) => (b.onclick = () => select(b.dataset.id)));
  placeBoxes();
  try { S.tree = (await api(`/api/digital/${encodeURIComponent(a.analysisId)}/tree`)).tree; }
  catch { S.tree = a.components.map((c) => ({ ...c, children: [] })); }
  const node = (n) => `<li><button data-id="${esc(n.id)}"><span>${esc(n.label)}</span><em>${esc(n.type)}</em></button>${n.children?.length ? `<ul>${n.children.map(node).join("")}</ul>` : ""}</li>`;
  $("#tree").innerHTML = S.tree.map(node).join("");
  $$("#tree button").forEach((b) => (b.onclick = () => select(b.dataset.id)));
}
function placeBoxes() {
  const a = S.analysis; if (!a) return;
  const map = Object.fromEntries(a.components.map((c) => [c.id, c.bbox]));
  $$(".box").forEach((el) => { const b = map[el.dataset.id]; Object.assign(el.style, { left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.width * 100}%`, height: `${b.height * 100}%` }); });
}
function select(id) {
  S.sel = S.sel === id ? null : id;
  $$(".box").forEach((b) => b.classList.toggle("on", b.dataset.id === S.sel));
  $$("#tree button").forEach((b) => b.classList.toggle("on", b.dataset.id === S.sel));
  $(`#tree button[data-id="${CSS.escape(S.sel || "")}"]`)?.scrollIntoView({ block: "nearest" });
}
$("#askForm").onsubmit = async (e) => {
  e.preventDefault();
  const q = $("#ask").value.trim(); if (!q || !S.analysis) return;
  $("#answer").textContent = "Thinking…";
  try {
    const r = await api(`/api/analysis/${encodeURIComponent(S.analysis.analysisId)}/chat`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: q, selectedComponentIds: S.sel ? [S.sel] : [] }) });
    $("#answer").textContent = r.answer;
    if (r.referencedComponentIds?.[0]) { S.sel = null; select(r.referencedComponentIds[0]); }
  } catch (err) { $("#answer").textContent = `Could not answer: ${err.message}`; }
};

loadExamples();


// ---------- shared with digital3d.js ----------
window.DL = { S, select: (id) => select(id), esc };

// ---------- accuracy: how closely the rebuilt page matches the screenshot ----------
// The rebuilt page is rendered in a hidden sandboxed frame, captured with html-to-image inside that frame,
// and compared with the screenshot on a small grid (colour + edges). It is an approximate visual score.
const H2I = "https://cdn.jsdelivr.net/npm/html-to-image@1.11.11/dist/html-to-image.js";
function captureDoc(doc, w, h) {
  return new Promise((resolve, reject) => {
    const token = Math.random().toString(36).slice(2);
    // capture inside the sandboxed frame itself (html-to-image renders the live DOM through an SVG, no nested frame)
    const inj = `<script src="${H2I}"><\/script><script>addEventListener("load",()=>setTimeout(async()=>{try{
      const bg=getComputedStyle(document.body).backgroundColor;
      const o={width:${w},height:${h},canvasWidth:${w},canvasHeight:${h},pixelRatio:1,cacheBust:false,
        backgroundColor:(bg&&bg!=="rgba(0, 0, 0, 0)")?bg:"#ffffff"};
      let url; try{url=await htmlToImage.toPng(document.documentElement,o)}catch(_){url=await htmlToImage.toPng(document.documentElement,{...o,skipFonts:true})}
      parent.postMessage({accShot:"${token}",data:url},"*")}catch(e){parent.postMessage({accShot:"${token}",error:String(e&&e.message||e)},"*")}},1500))<\/script>`;
    const f = document.createElement("iframe");
    f.setAttribute("sandbox", "allow-scripts"); f.setAttribute("aria-hidden", "true"); f.tabIndex = -1;
    Object.assign(f.style, { position: "fixed", left: "-20000px", top: "0", width: `${w}px`, height: `${h}px`, border: "0", visibility: "hidden" });
    const done = (fn, v) => { removeEventListener("message", onMsg); clearTimeout(timer); f.remove(); fn(v); };
    const onMsg = (e) => { if (e.data?.accShot === token) e.data.error ? done(reject, new Error(e.data.error)) : done(resolve, e.data.data); };
    const timer = setTimeout(() => done(reject, new Error("render timed out")), 25000);
    addEventListener("message", onMsg);
    f.srcdoc = /<\/body>/i.test(doc) ? doc.replace(/<\/body>/i, inj + "</body>") : doc + inj;
    document.body.append(f);
  });
}

function pixels(src, gw, gh) {
  return new Promise((ok, bad) => {
    const i = new Image();
    i.onload = () => { const c = document.createElement("canvas"); c.width = gw; c.height = gh;
      const g = c.getContext("2d", { willReadFrequently: true }); g.filter = "blur(1px)"; g.drawImage(i, 0, 0, gw, gh);
      ok(g.getImageData(0, 0, gw, gh).data); };
    i.onerror = bad; i.src = src;
  });
}

function edges(px, gw, gh) {
  const L = new Float32Array(gw * gh), E = new Float32Array(gw * gh);
  for (let i = 0; i < gw * gh; i++) L[i] = (0.3 * px[i * 4] + 0.59 * px[i * 4 + 1] + 0.11 * px[i * 4 + 2]) / 255;
  for (let y = 1; y < gh - 1; y++) for (let x = 1; x < gw - 1; x++) {
    const i = y * gw + x; E[i] = Math.min(1, Math.hypot(L[i + 1] - L[i - 1], L[i + gw] - L[i - gw]) * 2);
  }
  return E;
}

async function measureAccuracy(v, doc) {
  const key = `${S.target}:${S.cur[S.target]}`, run = S.run;
  if (!S.shot || S.acc[key] === "busy") return;
  if (typeof S.acc[key] === "object") return showAccuracy(S.acc[key]);
  S.acc[key] = "busy";
  $("#acc").hidden = false; $("#accPct").textContent = "…"; $("#accLbl").textContent = "measuring match"; setRing(0);
  try {
    const shot = await captureDoc(doc, S.shot.w, Math.min(S.shot.h, 6000));
    if (run !== S.run) return;
    const gw = 200, gh = Math.max(20, Math.round(gw * S.shot.h / S.shot.w));
    const [a, b] = await Promise.all([pixels(S.shot.url, gw, gh), pixels(shot, gw, gh)]);
    const ea = edges(a, gw, gh), eb = edges(b, gw, gh), miss = new Float32Array(gw * gh);
    let sum = 0;
    for (let i = 0; i < gw * gh; i++) {
      const dr = a[i * 4] - b[i * 4], dg = a[i * 4 + 1] - b[i * 4 + 1], db = a[i * 4 + 2] - b[i * 4 + 2];
      const col = Math.sqrt(0.3 * dr * dr + 0.59 * dg * dg + 0.11 * db * db) / 255;
      const d = 0.7 * Math.min(1, col / 0.3) + 0.3 * Math.min(1, Math.abs(ea[i] - eb[i]) / 0.5);
      miss[i] = d; sum += d;
    }
    const res = { score: Math.round(100 * (1 - sum / (gw * gh))), miss, gw, gh };
    S.acc[key] = res;
    if (run === S.run && `${S.target}:${S.cur[S.target]}` === key) showAccuracy(res);
  } catch (e) {
    S.acc[key] = null;
    if (run === S.run) { $("#accPct").textContent = "n/a"; $("#accLbl").textContent = "could not measure"; $("#acc").title = e.message; }
  }
}
function setRing(p) {
  const C = 2 * Math.PI * 15, bar = $("#accBar");
  bar.style.strokeDasharray = C; bar.style.strokeDashoffset = C * (1 - p / 100);
  bar.style.stroke = p >= 85 ? "var(--ok)" : p >= 70 ? "var(--amber)" : "#c2410c";
}
function showAccuracy(r) {
  $("#acc").hidden = false; $("#accLbl").textContent = "visual match";
  const t0 = performance.now(), tick = () => { const k = Math.min(1, (performance.now() - t0) / 700), p = Math.round(r.score * (1 - Math.pow(1 - k, 3)));
    $("#accPct").textContent = p + "%"; setRing(p); if (k < 1) requestAnimationFrame(tick); };
  tick();
  const c = $("#heat"); c.width = r.gw; c.height = r.gh;
  const g = c.getContext("2d"), img = g.createImageData(r.gw, r.gh);
  for (let i = 0; i < r.gw * r.gh; i++) { const d = r.miss[i]; const a = d < 0.18 ? 0 : Math.min(200, (d - 0.18) * 320); img.data.set([255, 40, 60, a], i * 4); }
  g.putImageData(img, 0, 0);
  c.hidden = !$("#accHeat").checked;
}
$("#accHeat").onchange = (e) => { $("#heat").hidden = !e.target.checked; if (e.target.checked) setWipe(100); };

// ---------- back end, reverse-engineered ----------
async function loadBackend(force = false) {
  if (!S.analysis || (S.backend && !force) || S.beBusy) return;
  S.beBusy = true; const run = S.run;
  try {
    const b = await api("/api/digital/backend", { method: "POST", body: form(force ? { force: "1" } : {}) });
    if (run !== S.run) return;
    S.backend = b; renderBackend();
  } catch (e) { if (run === S.run) $("#beSummary").textContent = `Could not infer the back end: ${e.message}`; }
  finally { S.beBusy = false; }
}
const METHOD_COL = { GET: "#1d7f4e", POST: "#1f4fd6", PUT: "#b45309", PATCH: "#7c3aed", DELETE: "#c2410c" };
function beHighlight(ids) {
  const set = new Set(ids || []);
  $$("#beBoxes .box").forEach((el) => el.classList.toggle("on", set.has(el.dataset.id)));
}
function renderBackend() {
  const b = S.backend, a = S.analysis;
  $("#beSummary").textContent = b.summary || "";
  $("#beBadge").textContent = b.source === "ai" ? `Inferred design (a hypothesis from what the screen shows) · ${b.provider?.model || "AI"}${b.cached ? " · saved result" : ""}`
    : `Outline only: ${b.notes?.[0] || "AI unavailable."}`;
  $("#beSql").disabled = $("#beOpenApi").disabled = !b.entities.length;
  // where it shows: every component an entity or endpoint mentions
  const used = new Set([...b.entities.flatMap((e) => e.components), ...b.endpoints.flatMap((p) => p.components)]);
  $("#beBoxes").innerHTML = a.components.filter((c) => c.bbox && used.has(c.id)).map((c) => {
    const x = c.bbox; return `<div class="box" data-id="${esc(c.id)}" title="${esc(c.label)}" style="left:${x.x * 100}%;top:${x.y * 100}%;width:${x.width * 100}%;height:${x.height * 100}%"></div>`; }).join("");
  renderEr(b);
  $("#beEndpoints").innerHTML = b.endpoints.map((p, i) => `
    <details class="ep" data-i="${i}">
      <summary><span class="m" style="background:${METHOD_COL[p.method]}">${p.method}</span><code>${esc(p.path)}</code><span class="purpose">${esc(p.purpose)}</span></summary>
      <div class="ep-body">
        ${p.components.length ? `<p class="small muted">Used by: ${p.components.map((id) => esc(a.components.find((c) => c.id === id)?.label || id)).join(", ")}</p>` : ""}
        ${p.method !== "GET" ? `<h4>Request</h4><pre>${esc(JSON.stringify(p.request, null, 2))}</pre>` : ""}
        <h4>Response</h4><pre>${esc(JSON.stringify(p.response, null, 2))}</pre>
      </div>
    </details>`).join("") || `<p class="muted">No endpoints inferred.</p>`;
  $$("#beEndpoints .ep").forEach((el) => {
    const p = b.endpoints[+el.dataset.i];
    el.onmouseenter = () => beHighlight(p.components); el.onmouseleave = () => beHighlight([]);
  });
  $("#beNotes").innerHTML = [b.auth && `<li><b>Auth:</b> ${esc(b.auth)}</li>`, ...(b.source === "ai" ? b.notes : []).map((n) => `<li>${esc(n)}</li>`)].filter(Boolean).length
    ? `<p><b>Assumptions</b></p><ul>${[b.auth && `<li><b>Auth:</b> ${esc(b.auth)}</li>`, ...(b.source === "ai" ? b.notes : []).map((n) => `<li>${esc(n)}</li>`)].filter(Boolean).join("")}</ul>` : "";
}
function renderEr(b) {
  const svg = $("#beEr"), ents = b.entities, cols = Math.min(3, Math.max(1, ents.length)), BW = 210, RH = 19, HH = 30, GX = 70, GY = 46;
  const boxes = ents.map((e, i) => ({ e, col: i % cols, row: Math.floor(i / cols), h: HH + e.fields.length * RH + 8 }));
  const rowH = []; boxes.forEach((x) => (rowH[x.row] = Math.max(rowH[x.row] || 0, x.h)));
  // links between boxes that are not neighbours arc over the top, so leave room above the boxes
  const skip = (r) => { const A = boxes.find((x) => x.e.name === r.from), B = boxes.find((x) => x.e.name === r.to);
    return A && B && A.row === B.row && Math.abs(A.col - B.col) > 1; };
  const TOP = b.relations.some(skip) ? 56 : 10;
  const rowY = rowH.map((_, r) => rowH.slice(0, r).reduce((s, v) => s + v + GY, 0) + TOP);
  boxes.forEach((x) => { x.x = 10 + x.col * (BW + GX); x.y = rowY[x.row]; });
  const W = 20 + cols * BW + (cols - 1) * GX, H = rowY.length ? rowY[rowY.length - 1] + rowH[rowH.length - 1] + 14 : 60;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`); svg.style.aspectRatio = `${W} / ${H}`;
  const by = Object.fromEntries(boxes.map((x) => [x.e.name, x]));
  const lines = b.relations.map((r) => {
    const A = by[r.from], B = by[r.to]; if (!A || !B) return "";
    if (skip(r)) { // arc over the boxes in between
      const x1 = A.x + BW / 2, x2 = B.x + BW / 2, y = A.y, k = { "one-to-many": ["1", "N"], "many-to-one": ["N", "1"], "one-to-one": ["1", "1"], "many-to-many": ["N", "N"] }[r.kind] || ["1", "N"];
      return `<path d="M${x1},${y} C${x1},${y - 48} ${x2},${y - 48} ${x2},${y}" class="er-l" fill="none"/>
        <text x="${x1 + 6}" y="${y - 8}" class="er-c">${k[0]}</text><text x="${x2 + 6}" y="${y - 8}" class="er-c">${k[1]}</text>
        ${r.label ? `<text x="${(x1 + x2) / 2}" y="${y - 40}" class="er-r" text-anchor="middle">${esc(r.label)}</text>` : ""}`;
    }
    const ax = A.x + BW / 2, ay = A.y + A.h / 2, bx = B.x + BW / 2, by2 = B.y + B.h / 2;
    const ex = (x, h, tx, ty) => { // point on the box edge towards (tx, ty)
      const dx = tx - x, dy = ty - (h.y + h.h / 2), sx = (BW / 2) / Math.abs(dx || 1e-6), sy = (h.h / 2) / Math.abs(dy || 1e-6), k = Math.min(sx, sy);
      return [x + dx * k, h.y + h.h / 2 + dy * k]; };
    const [x1, y1] = ex(ax, A, bx, by2), [x2, y2] = ex(bx, B, ax, ay);
    const [ca, cb] = { "one-to-many": ["1", "N"], "many-to-one": ["N", "1"], "one-to-one": ["1", "1"], "many-to-many": ["N", "N"] }[r.kind] || ["1", "N"];
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="er-l"/>
      <text x="${x1 + (x2 - x1) * 0.12}" y="${y1 + (y2 - y1) * 0.12 - 4}" class="er-c">${ca}</text>
      <text x="${x1 + (x2 - x1) * 0.88}" y="${y1 + (y2 - y1) * 0.88 - 4}" class="er-c">${cb}</text>
      ${r.label ? `<text x="${mx}" y="${my - 5}" class="er-r" text-anchor="middle">${esc(r.label)}</text>` : ""}`;
  }).join("");
  const ICON = { id: "#", string: "Aa", number: "12", boolean: "✓", date: "📅", enum: "≡", url: "🔗", email: "@", money: "$" };
  const cards = boxes.map((x) => `<g class="er-e" data-name="${esc(x.e.name)}" transform="translate(${x.x},${x.y})">
      <rect width="${BW}" height="${x.h}" rx="8" class="er-box"/><rect width="${BW}" height="${HH}" rx="8" class="er-head"/><rect y="${HH - 8}" width="${BW}" height="8" class="er-head"/>
      <text x="12" y="20" class="er-t">${esc(x.e.name)}</text>
      ${x.e.fields.map((f, j) => `<g transform="translate(0,${HH + 4 + j * RH})"><text x="12" y="13" class="er-f ${f.visible ? "" : "imp"}">${esc(f.name)}</text>
        <text x="${BW - 12}" y="13" text-anchor="end" class="er-ty">${esc(f.type)}</text>${f.visible ? `<circle cx="${BW - 70 + 0}" cy="9" r="0"/>` : ""}</g>`).join("")}
      <title>${esc(x.e.description)}${x.e.fields.filter((f) => f.example).length ? "\nExamples: " + x.e.fields.filter((f) => f.example).map((f) => `${f.name}=${f.example}`).join(", ") : ""}</title></g>`).join("");
  svg.innerHTML = lines + cards;
  $$("#beEr .er-e").forEach((g) => { const e = ents.find((x) => x.name === g.dataset.name);
    g.onmouseenter = () => beHighlight(e.components); g.onmouseleave = () => beHighlight([]); });
}
const SQL_T = { id: "TEXT PRIMARY KEY", string: "TEXT", number: "NUMERIC", boolean: "BOOLEAN", date: "TIMESTAMP", enum: "TEXT", url: "TEXT", email: "TEXT", money: "NUMERIC(12,2)" };
const snake = (s) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
function toSql(b) {
  const fk = {}; // child entity -> [parent]
  for (const r of b.relations) {
    if (r.kind === "one-to-many") (fk[r.to] ||= []).push(r.from);
    else if (r.kind === "many-to-one") (fk[r.from] ||= []).push(r.to);
  }
  const order = [], seen = new Set(); // referenced tables first, so the script runs top to bottom
  const visit = (e, path = new Set()) => { if (seen.has(e.name) || path.has(e.name)) return; path.add(e.name);
    for (const p of fk[e.name] || []) { const pe = b.entities.find((x) => x.name === p); if (pe) visit(pe, path); }
    seen.add(e.name); order.push(e); };
  b.entities.forEach((e) => visit(e));
  return `-- Inferred from a screenshot by Visual Reverse Engineering (a starting point, not the real schema)\n\n` + order.map((e) => {
    const cols = e.fields.map((f) => `  ${snake(f.name)} ${f.name.toLowerCase() === "id" ? SQL_T.id : SQL_T[f.type] || "TEXT"}`);
    for (const p of fk[e.name] || []) if (!e.fields.some((f) => snake(f.name) === snake(p) + "_id")) cols.push(`  ${snake(p)}_id TEXT REFERENCES ${snake(p)}s(id)`);
    return `CREATE TABLE ${snake(e.name)}s (\n${cols.join(",\n")}\n);`;
  }).join("\n\n") + "\n";
}
const OA_T = { id: ["string"], string: ["string"], number: ["number"], boolean: ["boolean"], date: ["string", "date-time"], enum: ["string"], url: ["string", "uri"], email: ["string", "email"], money: ["number"] };
function toOpenApi(b) {
  const paths = {};
  for (const p of b.endpoints) {
    const op = { summary: p.purpose, responses: { 200: { description: "OK", content: { "application/json": { example: p.response } } } } };
    if (p.method !== "GET" && Object.keys(p.request || {}).length) op.requestBody = { content: { "application/json": { example: p.request } } };
    const path = p.path.replace(/:(\w+)/g, "{$1}");
    const params = [...path.matchAll(/\{(\w+)\}/g)].map((m) => ({ name: m[1], in: "path", required: true, schema: { type: "string" } }));
    if (params.length) op.parameters = params;
    (paths[path] ||= {})[p.method.toLowerCase()] = op;
  }
  const schemas = Object.fromEntries(b.entities.map((e) => [e.name, { type: "object", description: e.description,
    properties: Object.fromEntries(e.fields.map((f) => { const [type, format] = OA_T[f.type] || ["string"]; return [f.name, { type, ...(format ? { format } : {}), ...(f.example ? { example: f.example } : {}) }]; })) }]));
  return JSON.stringify({ openapi: "3.0.3", info: { title: `${S.analysis?.title || "Screen"} API (inferred)`, version: "0.1.0",
    description: "Inferred from a screenshot by Visual Reverse Engineering. A starting point, not the real API." }, paths, components: { schemas } }, null, 2);
}
function save(text, name, type) {
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000); toast(`Downloaded ${name}`);
}
$("#beSql").onclick = () => S.backend && save(toSql(S.backend), `${fileName()}-schema.sql`, "text/plain");
$("#beOpenApi").onclick = () => S.backend && save(toOpenApi(S.backend), `${fileName()}-openapi.json`, "application/json");

// ---------- accessibility ----------
async function loadA11y() {
  if (!S.analysis || S.a11y || S.axBusy) return;
  S.axBusy = true; const run = S.run;
  try {
    const r = await api("/api/digital/a11y", { method: "POST", body: form() });
    if (run !== S.run) return;
    S.a11y = r; renderA11y();
  } catch (e) { if (run === S.run) $("#axScoreTxt").textContent = `Could not run the audit: ${e.message}`; }
  finally { S.axBusy = false; }
}
function renderA11y() {
  const r = S.a11y, by = Object.fromEntries(S.analysis.components.map((c) => [c.id, c]));
  const g = $("#axGrade"); g.textContent = r.grade; g.className = "ax-grade g" + r.grade;
  $("#axScoreTxt").textContent = `${r.score}/100 accessibility`;
  $("#axCounts").textContent = `${r.errors} must-fix · ${r.warnings} should-fix · ${r.checkedText} text areas measured`;
  $("#axMethod").textContent = r.method;
  const marked = r.issues.map((x, i) => ({ ...x, n: i + 1 }));
  $("#axMarks").innerHTML = marked.filter((x) => x.componentId && by[x.componentId]?.bbox).map((x) => { const b = by[x.componentId].bbox;
    return `<div class="axm ${x.severity}" data-n="${x.n}" style="left:${b.x * 100}%;top:${b.y * 100}%;width:${b.width * 100}%;height:${b.height * 100}%"><span>${x.n}</span></div>`; }).join("");
  $("#axList").innerHTML = marked.length ? marked.map((x) => `<li class="${x.severity}" data-n="${x.n}"><span class="n">${x.n}</span>
      <div><b>${esc(x.message)}</b><small>${esc(x.label)}</small>
      ${x.fg ? `<span class="pair"><i style="background:${x.bg}"><em style="color:${x.fg}">Aa</em></i>${esc(x.fg)} on ${esc(x.bg)}</span>` : ""}
      <p>${esc(x.detail)}</p></div></li>`).join("") : `<li class="none">No issues found by the automatic checks.</li>`;
  const hi = (n) => { $$(".axm").forEach((m) => m.classList.toggle("on", m.dataset.n === String(n))); $$("#axList li").forEach((m) => m.classList.toggle("on", m.dataset.n === String(n))); };
  $$("#axList li[data-n]").forEach((li) => (li.onmouseenter = () => hi(li.dataset.n)));
  $$(".axm").forEach((m) => (m.onmouseenter = () => { hi(m.dataset.n); $(`#axList li[data-n="${m.dataset.n}"]`)?.scrollIntoView({ block: "nearest" }); }));
  $("#axFix").disabled = !r.issues.length;
}
$("#axFix").onclick = async () => {
  const r = S.a11y, v = current();
  if (!r?.issues.length) return;
  if (!v) return toast("Wait for the first code version, then fix.");
  const change = "Fix these accessibility problems and keep the design otherwise identical: " +
    r.issues.slice(0, 20).map((x, i) => `${i + 1}) ${x.fix || x.message}`).join(" ") +
    " Also use semantic HTML (header/nav/main/footer, one h1), visible focus styles, and aria-labels on icon-only buttons.";
  setTab("code");
  await makeCode({ target: S.target, change, baseCode: v.code }, "Accessibility fixes");
};
