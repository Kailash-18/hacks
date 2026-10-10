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
    versions: { html: [], react: [] }, cur: { html: -1, react: -1 }, target: "html" });
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
function previewDoc(v) {
  if (S.target === "html") return v.code;
  // React preview: same Tailwind, React + Babel in the sandboxed frame
  let src = v.code.replace(/^\s*import[^;\n]*;?\s*$/gm, "");
  const m = src.match(/export\s+default\s+function\s+([A-Z]\w*)/) || src.match(/export\s+default\s+([A-Z]\w*)\s*;?/);
  const name = m ? m[1] : "Screen";
  src = src.replace(/export\s+default\s+function/, "function").replace(/^\s*export\s+default\s+[A-Z]\w*\s*;?\s*$/m, "").replace(/export\s+(?=(function|const))/g, "");
  src = src.replace(/<\/script/gi, "<\\/script");
  return `<!doctype html><html><head><meta charset="utf-8"><script src="https://cdn.tailwindcss.com"></script>
<script src="https://unpkg.com/react@18.3.1/umd/react.production.min.js"></script>
<script src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js"></script>
<script src="https://unpkg.com/@babel/standalone@7.24.7/babel.min.js"></script></head>
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
  for (const x of ["code", "guide", "structure"]) $(`#tab-${x}`).hidden = x !== t;
  if (t === "code") requestAnimationFrame(fit);
  if (t === "structure") requestAnimationFrame(placeBoxes);
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
