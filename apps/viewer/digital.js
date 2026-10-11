// Digital Lab explorer: screenshots -> component tree, overlays, what-if, workflow graph, diff, reconstruction, chat.
// Every view reads the same SystemAnalysis shape the Physical Lab uses (components + relationships + status).

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pct = (v) => `${(v * 100).toFixed(3)}%`;
const STATUS_LABEL = { observed: "seen", inferred: "inferred", estimated: "from geometry", unknown: "unknown" };

const S = {
  screens: [],      // {key, name, url, blob, w, h, analysis, sample, busy, error}
  cur: -1, tab: "explore", sel: null, impact: null,
  workflow: null, flowSel: null,
  diff: null, diffPair: null, diffSel: null,
  builds: {},       // analysisId -> reconstruct result
  codeTab: "preview",
  chats: {},        // analysisId -> [{q, a}]
  refs: [],
  repos: {},        // screen analysisId -> repo mapping result
};

// ---------- api ----------
async function api(path, opts = {}) {
  let res;
  try { res = await fetch(path, opts); } catch { throw new Error("Cannot reach the API server. Is it running?"); }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.message || `Request failed (${res.status}).`);
  return body;
}
const postJSON = (path, data) => api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });

function toast(msg) {
  const el = $("#error");
  el.textContent = msg; el.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (el.hidden = true), 7000);
}

// ---------- screens ----------
const cur = () => S.screens[S.cur];
const ready = () => S.screens.filter((s) => s.analysis);

function imgSize(url) {
  return new Promise((ok) => { const i = new Image(); i.onload = () => ok([i.naturalWidth, i.naturalHeight]); i.onerror = () => ok([1, 1]); i.src = url; });
}

async function addScreen({ name, blob, analysis = null, sample = false }) {
  const url = URL.createObjectURL(blob);
  const [w, h] = await imgSize(url);
  const s = { key: Math.random().toString(36).slice(2), name, url, blob, w, h, analysis, sample, busy: !analysis };
  S.screens.push(s);
  renderScreens();
  return s;
}

async function analyzeScreen(s) {
  const showScan = !ready().length || S.cur === S.screens.indexOf(s);
  if (showScan) startScan(s.url);
  try {
    const fd = new FormData(); fd.append("image", s.blob, s.name);
    s.analysis = await api("/api/digital/analyze", { method: "POST", body: fd });
  } catch (e) {
    s.error = e.message; toast(`${s.name}: ${e.message}`);
  } finally {
    s.busy = false;
    if (showScan) stopScan();
    renderScreens();
  }
}

$("#file").addEventListener("change", (ev) => {
  const files = [...ev.target.files]; ev.target.value = "";
  addFiles(files);
});

// Ctrl+V a screenshot anywhere on the page (text pastes into inputs still work normally)
document.addEventListener("paste", (ev) => {
  const imgs = [...(ev.clipboardData?.items || [])].filter((it) => it.kind === "file" && it.type.startsWith("image/")).map((it) => it.getAsFile()).filter(Boolean);
  if (!imgs.length) return;
  ev.preventDefault();
  const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, "");
  addFiles(imgs.map((f, i) => new File([f], `pasted-${stamp}${imgs.length > 1 ? "-" + (i + 1) : ""}.${(f.type.split("/")[1] || "png").replace("jpeg", "jpg")}`, { type: f.type })));
  toast(imgs.length > 1 ? `Pasted ${imgs.length} screenshots` : "Pasted screenshot");
});

// drag screenshots from the desktop onto the page
document.addEventListener("dragover", (ev) => { if ([...ev.dataTransfer.types].includes("Files")) ev.preventDefault(); });
document.addEventListener("drop", (ev) => {
  const files = [...(ev.dataTransfer?.files || [])].filter((f) => f.type.startsWith("image/"));
  if (!files.length) return;
  ev.preventDefault();
  addFiles(files);
});

async function addFiles(files) {
  if (!files.length) return;
  const added = [];
  for (const f of files) added.push(await addScreen({ name: f.name, blob: f }));
  if (S.cur < 0 || !cur()?.analysis) selectScreen(S.screens.indexOf(added[0]));
  for (const s of added) {
    await analyzeScreen(s);
    if (s === cur() || !cur()?.analysis) selectScreen(S.screens.indexOf(s));
  }
  autoPair();
}

async function loadSamples() {
  try {
    const all = await api("/api/digital/samples");
    if (!all.length) return toast("No saved samples on this server.");
    // A demo app (screens saved as one set) loads first and in order; a second click adds the rest.
    const loaded = (it) => S.screens.some((s) => s.analysis?.analysisId === it.analysisId);
    const setName = all.find((it) => it.set && !loaded(it))?.set;
    const list = setName ? all.filter((it) => it.set === setName).sort((a, b) => (a.order ?? 99) - (b.order ?? 99)) : all;
    let first = null;
    for (const item of list) {
      if (S.screens.some((s) => s.analysis?.analysisId === item.analysisId)) continue;
      const [analysis, blob] = await Promise.all([api(`/api/digital/samples/${item.id}`), fetch(item.imageUrl).then((r) => r.blob())]);
      const s = await addScreen({ name: item.title, blob, analysis, sample: true });
      first = first || s;
    }
    if (first) selectScreen(S.screens.indexOf(first));
    autoPair();
  } catch (e) { toast(e.message); }
}
$("#loadSamples").onclick = loadSamples;
$("#loadSamples2").onclick = loadSamples;

// saved samples keep the title they were saved with ("Dashboard (v2 redesign)"); uploads use the model's title
const screenName = (s) => (s.sample ? s.name : s.analysis?.title || s.name);

function renderScreens() {
  $("#screenCount").textContent = S.screens.length ? `${ready().length}/${S.screens.length}` : "";
  $("#screenList").innerHTML = S.screens.map((s, i) => `
    <li class="${i === S.cur ? "on" : ""}" data-i="${i}" title="${esc(s.name)}">
      <img src="${s.url}" alt="" />
      ${s.sample ? '<span class="sbadge">SAMPLE</span>' : ""}
      ${s.busy ? '<div class="sbusy">reading…</div>' : ""}
      <div class="sname">${esc(screenName(s))}</div>
      <div class="smeta">${s.analysis ? `${s.analysis.components.length} components` : s.error ? "failed — click to retry" : "analysing"}</div>
    </li>`).join("");
  $$("#screenList li").forEach((li) => (li.onclick = () => {
    const s = S.screens[+li.dataset.i];
    if (s.error && !s.busy) { s.error = null; s.busy = true; renderScreens(); analyzeScreen(s).then(() => selectScreen(+li.dataset.i)); return; }
    selectScreen(+li.dataset.i);
  }));
  $("#empty").hidden = S.screens.length > 0;
  fillPairSelects();
}

function selectScreen(i) {
  if (i < 0 || i >= S.screens.length) return;
  S.cur = i; S.sel = null; S.impact = null; S.refs = [];
  const r = S.screens[i].analysis && S.repos[S.screens[i].analysis.analysisId];
  $("#repoToggle").textContent = r ? `Source: ${r.repo}` : "Link source code";
  renderScreens();
  if (S.tab === "workflow" || S.tab === "compare") { renderAll(); return; }
  renderAll();
}

// ---------- scan overlay ----------
const STEPS = ["Upload screenshot", "Vision model reads the interface", "Validate boxes and hierarchy", "Build the system graph"];
function startScan(url) {
  $("#scanImg").src = url; $("#loading").hidden = false;
  const t0 = performance.now();
  $("#steps").innerHTML = STEPS.map((s) => `<li>${s}</li>`).join("");
  const tick = () => {
    const sec = (performance.now() - t0) / 1000;
    $("#scanTime").textContent = `${sec.toFixed(1)} s`;
    const at = sec < 0.6 ? 0 : sec < 25 ? 1 : 2;
    $$("#steps li").forEach((li, k) => (li.className = k < at ? "done" : k === at ? "active" : ""));
  };
  tick(); clearInterval(startScan.t); startScan.t = setInterval(tick, 100);
}
function stopScan() { clearInterval(startScan.t); $("#loading").hidden = true; }

// ---------- tabs ----------
$$(".dtab").forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));
function setTab(t) {
  S.tab = t;
  $$(".dtab").forEach((b) => b.classList.toggle("on", b.dataset.tab === t));
  renderAll();
}

function contextAnalysis() {
  if (S.tab === "workflow") return S.workflow;
  if (S.tab === "compare") return S.diff ? S.diff.chat : null;
  const a = cur()?.analysis || null;
  if (S.tab === "explore" && a && S.repos[a.analysisId]?.chat) return S.repos[a.analysisId].chat;
  return a;
}

function renderAll() {
  const has = S.screens.length > 0;
  for (const v of ["explore", "workflow", "compare", "rebuild"]) $(`#view-${v}`).hidden = !has || S.tab !== v;
  const a = cur()?.analysis;
  $("#panel").hidden = !has;
  if (!has) return;
  if (S.tab === "explore") renderExplore();
  if (S.tab === "workflow") renderWorkflow();
  if (S.tab === "compare") renderCompare();
  if (S.tab === "rebuild") renderRebuild();
  renderPanelHead();
  renderChat();
  renderEngineLine(contextAnalysis() || a);
}

function renderEngineLine(a) {
  if (!a || !a.components) { $("#engineLine").textContent = ""; return; }
  const by = (k) => a.components.filter((c) => c.status === k).length;
  $("#engineLine").textContent = `SystemAnalysis · ${a.components.length} components · ${a.relationships.length} relationships · ${by("observed")} seen / ${by("inferred")} inferred / ${by("estimated")} geometry`;
}

function renderPanelHead() {
  const s = cur(), a = contextAnalysis();
  const badge = $("#modeBadge");
  if (S.tab === "workflow") { badge.textContent = "Workflow hypotheses"; badge.className = "eyebrow"; }
  else if (S.tab === "compare") { badge.textContent = "Visual difference"; badge.className = "eyebrow"; }
  else { badge.textContent = s?.sample ? "Sample · saved real result" : "Live analysis"; badge.className = "eyebrow" + (s?.sample ? " sample" : ""); }
  $("#title").textContent = S.tab === "compare" && S.diffPair && a ? `Changes: ${screenName(S.diffPair[0])} → ${screenName(S.diffPair[1])}`
    : a?.title || (S.tab === "workflow" ? "Workflow" : S.tab === "compare" ? "Compare versions" : s?.name || "");
  $("#summary").textContent = a?.summary || (s?.busy ? "Reading the interface…" : "");
  const lims = a?.limitations || [];
  $("#limits").innerHTML = lims.map((l) => `<li>${esc(l)}</li>`).join("");
  $("#providerLine").textContent = a?.provider ? `Provider: ${a.provider.name} / ${a.provider.model}` : "";
}

// ---------- explore ----------
$("#showBoxes").onchange = () => $("#boxes").classList.toggle("quiet", !$("#showBoxes").checked);
$("#showLabels").onchange = () => { layoutCallouts(); paintSelection(); };

// ---------- exploded-diagram callouts: component names in two side columns, a leader line to each box ----------
function layoutCallouts() {
  const wrap = $("#exploreWrap"), host = $("#callouts"), img = $("#shotImg");
  const a = cur()?.analysis, on = $("#showLabels").checked && !!a;
  wrap.classList.toggle("callout-mode", on);
  if (!on) { host.innerHTML = ""; return; }
  const W = img.clientWidth, H = img.clientHeight;
  if (!W || !H) { host.innerHTML = ""; return; }
  const GAP_X = 16, GAP_Y = 4, ELBOW = 10;
  const items = a.components.filter((c) => c.bbox).map((c) => {
    const b = c.bbox, x = b.x * W, y = b.y * H, w = b.width * W, h = b.height * H;
    return { c, x, y, w, h, cx: x + w / 2, cy: y + h / 2 };
  });
  host.innerHTML = `<svg class="leaders" width="${W}" height="${H}"></svg>` + items.map((i) =>
    `<div class="co" data-id="${esc(i.c.id)}" data-status="${i.c.status}" title="${esc(i.c.label)} (${esc(i.c.type)})">${esc(i.c.label)}</div>`).join("");
  const els = $$(".co", host);
  items.forEach((i, k) => { i.el = els[k]; i.lw = i.el.offsetWidth; i.lh = i.el.offsetHeight; });
  // split by which half of the screenshot the box is in, then balance the two columns
  let left = items.filter((i) => i.cx < W / 2), right = items.filter((i) => i.cx >= W / 2);
  const move = (from, to, pick) => { from.sort(pick); to.push(from.shift()); };
  while (left.length - right.length > 1) move(left, right, (p, q) => q.cx - p.cx);
  while (right.length - left.length > 1) move(right, left, (p, q) => p.cx - q.cx);
  let svg = "";
  for (const [col, side] of [[left, "L"], [right, "R"]]) {
    // same row (within ~14px): order so leader lines do not cross — the label lower down goes to the box farther from its column
    const row = (i) => Math.round(i.cy / 14);
    col.sort((p, q) => row(p) - row(q) || (side === "L" ? p.cx - q.cx : q.cx - p.cx));
    let y = 0; // top-down: as close to the box's height as possible, never overlapping
    for (const i of col) { i.ly = Math.max(i.cy - i.lh / 2, y); y = i.ly + i.lh + GAP_Y; }
    if (y - GAP_Y <= H) { // fits: bottom-up pass keeps the column inside the screenshot's height
      let limit = H;
      for (let k = col.length - 1; k >= 0; k--) { col[k].ly = Math.max(0, Math.min(col[k].ly, limit - col[k].lh)); limit = col[k].ly - GAP_Y; }
    }
    for (const i of col) {
      i.lx = side === "L" ? -GAP_X - i.lw : W + GAP_X;
      i.el.style.left = `${i.lx}px`; i.el.style.top = `${i.ly}px`;
      const sx = side === "L" ? i.lx + i.lw : i.lx, sy = i.ly + i.lh / 2;
      const ex = side === "L" ? sx + ELBOW : sx - ELBOW;
      const tx = side === "L" ? i.x : i.x + i.w, ty = Math.min(Math.max(sy, i.y + 2), i.y + i.h - 2); // nearest point on the box's outer edge
      svg += `<g data-id="${esc(i.c.id)}" data-status="${i.c.status}"><path d="M${sx.toFixed(1)},${sy.toFixed(1)} L${ex.toFixed(1)},${sy.toFixed(1)} L${tx.toFixed(1)},${ty.toFixed(1)}"/><circle cx="${tx.toFixed(1)}" cy="${ty.toFixed(1)}" r="2.6"/></g>`;
    }
  }
  $("svg.leaders", host).innerHTML = svg;
  els.forEach((el) => {
    el.onclick = (e) => { e.stopPropagation(); select(el.dataset.id); };
    el.onmouseenter = () => $$(`[data-id="${CSS.escape(el.dataset.id)}"]`, $("#shot")).forEach((x) => x.classList.add("hov"));
    el.onmouseleave = () => $$(".hov", $("#shot")).forEach((x) => x.classList.remove("hov"));
  });
}
let calloutSize = "";
new ResizeObserver(() => { // re-layout only when the screenshot's size really changed (avoids resize feedback loops)
  const img = $("#shotImg"), key = `${img.clientWidth}x${img.clientHeight}`;
  if (S.tab === "explore" && key !== calloutSize) { calloutSize = key; layoutCallouts(); paintSelection(); }
}).observe($("#shotImg"));

function boxesHTML(components, cls = () => "") {
  const withBox = components.filter((c) => c.bbox).sort((p, q) => q.bbox.width * q.bbox.height - p.bbox.width * p.bbox.height);
  return withBox.map((c) => `<div class="bx ${cls(c)}" data-id="${esc(c.id)}" data-status="${c.status}"
      style="left:${pct(c.bbox.x)};top:${pct(c.bbox.y)};width:${pct(c.bbox.width)};height:${pct(c.bbox.height)}"
      title="${esc(c.label)} (${esc(c.type)})"><span class="bl">${esc(c.label.slice(0, 40))}</span></div>`).join("");
}

function renderExplore() {
  const s = cur();
  if (!s) return;
  $("#shotImg").src = s.url;
  const a = s.analysis;
  const boxes = $("#boxes");
  boxes.innerHTML = a ? boxesHTML(a.components) : "";
  boxes.classList.toggle("quiet", !$("#showBoxes").checked);
  $$(".bx", boxes).forEach((b) => (b.onclick = (e) => { e.stopPropagation(); select(b.dataset.id); }));
  $("#shot").onclick = () => select(null);
  $("#shotImg").onload = () => { layoutCallouts(); paintSelection(); };
  layoutCallouts();
  renderSide();
  paintSelection();
}

function select(id) {
  S.sel = id; S.impact = null;
  if (S.tab !== "explore") setTab("explore");
  renderSide(); paintSelection();
  if (id) $(`.tn[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest" });
}

function paintSelection() {
  const removed = new Set(S.impact ? [S.impact.removedComponentId, ...S.impact.affected.filter((x) => x.severity === "fails").map((x) => x.componentId)] : []);
  const hit = new Set(S.impact ? S.impact.affected.filter((x) => x.severity !== "fails").map((x) => x.componentId) : []);
  const refs = new Set(S.refs);
  $$("#boxes .bx, #side .tn").forEach((el) => {
    const id = el.dataset.id;
    el.classList.toggle("sel", id === S.sel && !S.impact);
    el.classList.toggle("gone", el.classList.contains("bx") && removed.has(id));
    el.classList.toggle("hit", hit.has(id) || (el.classList.contains("tn") && removed.has(id)));
    el.classList.toggle("ref", refs.has(id));
  });
  $$("#callouts [data-id]").forEach((el) => { // callouts and their leader lines follow their box
    const id = el.dataset.id;
    el.classList.toggle("sel", id === S.sel && !S.impact);
    el.classList.toggle("gone", removed.has(id));
    el.classList.toggle("hit", hit.has(id));
    el.classList.toggle("ref", refs.has(id));
  });
}

let MAPPED = new Set();
function treeHTML(nodes, depth = 0) {
  return `<ul class="${depth ? "" : "tree"}">${nodes.map((n) => `
    <li class="${depth >= 2 && n.children.length ? "closed" : ""}">
      <div class="tn" data-id="${esc(n.id)}"><span class="tw">${n.children.length ? "▾" : ""}</span>
        <i class="st ${n.status}"></i><span class="tl">${esc(n.label)}</span>${MAPPED.has(n.id) ? '<span class="has-src" title="Found in source">{ }</span>' : ""}<span class="tt">${esc(n.type)}</span></div>
      ${n.children.length ? treeHTML(n.children, depth + 1) : ""}</li>`).join("")}</ul>`;
}

function buildTree(a) {  // same algorithm as the API's build_tree (contains edges, reading order)
  const by = new Map(a.components.map((c) => [c.id, c]));
  const parent = new Map();
  for (const r of a.relationships) if (r.type === "contains" && !parent.has(r.to)) parent.set(r.to, r.from);
  const kids = new Map();
  for (const c of a.components) {
    const p = by.has(parent.get(c.id)) ? parent.get(c.id) : null;
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p).push(c);
  }
  const order = (c) => (c.bbox ? [Math.round(c.bbox.y * 100) / 100, c.bbox.x] : [2, 0]);
  const sort = (l) => [...l].sort((p, q) => order(p)[0] - order(q)[0] || order(p)[1] - order(q)[1]);
  const node = (c, seen) => ({ id: c.id, label: c.label, type: c.type, status: c.status,
    children: seen.has(c.id) ? [] : sort(kids.get(c.id) || []).map((k) => node(k, new Set([...seen, c.id]))) });
  return sort(kids.get(null) || []).map((c) => node(c, new Set()));
}

function renderSide() {
  const side = $("#side");
  const a = cur()?.analysis;
  if (S.tab === "workflow") return renderFlowSide();
  if (S.tab === "compare") return renderDiffSide();
  if (S.tab === "rebuild") return renderBuildSide();
  if (!a) { side.innerHTML = ""; return; }
  const c = a.components.find((x) => x.id === S.sel);
  MAPPED = new Set((S.repos[a.analysisId]?.mappings || []).map((m) => m.componentId));
  side.innerHTML = `
    ${c ? detailHTML(a, c) : ""}
    ${repoBlockHTML(a)}
    <div class="block">
      <div class="block-head"><h3>Component tree</h3><span class="legend">${a.components.length} items</span></div>
      ${treeHTML(buildTree(a))}
    </div>`;
  $$(".tn", side).forEach((el) => {
    el.onclick = (e) => {
      if (e.target.classList.contains("tw") && el.parentElement.querySelector("ul")) { el.parentElement.classList.toggle("closed"); return; }
      select(el.dataset.id);
    };
    el.onmouseenter = () => $(`#boxes .bx[data-id="${CSS.escape(el.dataset.id)}"]`)?.classList.add("ref");
    el.onmouseleave = () => paintSelection();
  });
  $$("[data-go]", side).forEach((el) => (el.onclick = () => select(el.dataset.go)));
  const wi = $("#whatif", side);
  if (wi) wi.onclick = runWhatIf;
  $("#closeDetail", side)?.addEventListener("click", () => select(null));
}

function detailHTML(a, c) {
  const by = new Map(a.components.map((x) => [x.id, x]));
  const rels = a.relationships.filter((r) => r.from === c.id || r.to === c.id);
  const relLine = (r) => {
    const out = r.from === c.id, other = by.get(out ? r.to : r.from);
    const verb = r.type === "contains" ? (out ? "contains" : "inside") : r.type.replaceAll("_", " ");
    return `<li><span class="${r.status !== "observed" ? "dashed" : ""}">${esc(verb)}</span> <a href="#" data-go="${esc(other.id)}">${esc(other.label)}</a> <span class="tiny muted">${STATUS_LABEL[r.status]}</span></li>`;
  };
  const im = S.impact;
  return `<div class="block" id="detail">
    <div class="block-head"><h3>${esc(c.label)}</h3><span class="chip ${c.status}">${STATUS_LABEL[c.status]}</span></div>
    <div class="kv"><span>Type</span><b>${esc(c.type)}</b></div>
    ${c.bbox ? `<div class="kv"><span>Region</span><b class="tiny">${Math.round(c.bbox.x * 100)}%, ${Math.round(c.bbox.y * 100)}% · ${Math.round(c.bbox.width * 100)}×${Math.round(c.bbox.height * 100)}%</b></div>` : ""}
    <ul class="evidence">${c.evidence.map((e) => `<li>${esc(e)}</li>`).join("")}</ul>
    ${rels.length ? `<h4>Connections</h4><ul class="rels">${rels.slice(0, 14).map(relLine).join("")}</ul>` : ""}
    ${srcHTML(a, c)}
    <div class="row"><button id="whatif" class="btn small danger">What if I remove it?</button><button id="closeDetail" class="btn small">Close</button></div>
    ${im ? impactHTML(im, by) : ""}
  </div>`;
}

function srcHTML(a, c) {
  const r = S.repos[a.analysisId];
  if (!r) return "";
  const m = r.mappings.find((x) => x.componentId === c.id);
  if (!m) return `<h4>Source</h4><p class="tiny muted">Not found in ${esc(r.repo)} (text may come from data or translations).</p>`;
  return `<h4>Source · ${esc(r.repo)}</h4><ul class="src-list">${m.matches.map((h) => `<li class="${h.status}"><code>${esc(h.path)}${h.line ? ":" + h.line : ""}</code>
    <span class="tiny muted"> ${h.status === "observed" ? "text match" : "name match"}</span>${h.snippet ? `<pre>${esc(h.snippet)}</pre>` : ""}</li>`).join("")}</ul>`;
}

function repoBlockHTML(a) {
  const r = S.repos[a.analysisId];
  if (!r) return "";
  const st = r.structure;
  return `<div class="block"><div class="block-head"><h3>Source code</h3><span class="legend">${r.fileCount} files</span></div>
    <div class="fw">${r.frameworks.map((f) => `<span>${esc(f)}</span>`).join("")}</div>
    <p class="tiny">${esc(r.summary)}</p>
    ${st.pages.length ? `<h4>Pages / routes</h4><ul class="tiny">${st.pages.slice(0, 8).map((p) => `<li><code>${esc(p)}</code></li>`).join("")}</ul>` : ""}
    ${st.componentFiles.length ? `<h4>Most-imported components</h4><ul class="tiny">${st.componentFiles.slice(0, 8).map((p) => `<li><code>${esc(p)}</code></li>`).join("")}</ul>` : ""}
    <p class="tiny muted">Chat now also sees the files: try “Which file renders the main button?”</p></div>`;
}

function impactHTML(im, by) {
  return `<div class="dl-impact"><span class="vd ${im.verdict}">Screen ${im.verdict}</span> · health ${im.health}%
    <div class="meter"><i style="width:${im.health}%"></i></div>
    <div>${esc(im.summary)}</div>
    ${im.affected.length ? `<ul>${im.affected.slice(0, 12).map((x) => `<li><a href="#" data-go="${esc(x.componentId)}">${esc(x.label)}</a> ${esc(x.impact)}${x.uncertain ? " <small>(hypothesis)</small>" : ""}</li>`).join("")}</ul>` : ""}
    <p class="tiny muted">${esc(im.method)}</p></div>`;
}

async function runWhatIf() {
  const a = cur()?.analysis;
  if (!a || !S.sel) return;
  try {
    S.impact = await postJSON("/api/digital/whatif", { analysisId: a.analysisId, componentId: S.sel });
    renderSide(); paintSelection();
  } catch (e) { toast(e.message); }
}

// ---------- workflow ----------
$("#mapFlow").onclick = async () => {
  // a newer version of a screen is the same screen, not a separate step in the journey
  const all = ready(), ids = new Set(all.map((s) => s.analysis.sample?.id).filter(Boolean));
  const rs = all.filter((s) => !(s.analysis.sample?.compareWith && ids.has(s.analysis.sample.compareWith)));
  if (rs.length < 2) return toast("Add at least two analysed screens first.");
  const btn = $("#mapFlow"); btn.disabled = true; btn.textContent = "Mapping…";
  try {
    S.workflow = await postJSON("/api/digital/workflow", { analysisIds: rs.map((s) => s.analysis.analysisId), useModel: $("#flowModel").checked });
    S.flowSel = null;
    renderAll();
  } catch (e) { toast(e.message); }
  finally { btn.disabled = false; btn.textContent = "Map workflow"; }
};

function screenFor(analysisId) { return S.screens.find((s) => s.analysis?.analysisId === analysisId); }

function renderWorkflow() {
  const svg = $("#flow"), wf = S.workflow;
  $("#flowEmpty").hidden = !!wf;
  if (!wf) { svg.innerHTML = ""; renderSide(); return; }
  const nodes = wf.components, edges = wf.relationships;
  const entry = nodes.find((n) => n.isEntry) || nodes[0];
  // layered layout: BFS depth from the entry screen; unreachable screens go in the last column
  const depth = new Map([[entry.id, 0]]), q = [entry.id];
  while (q.length) { const n = q.shift(); for (const e of edges) if (e.from === n && !depth.has(e.to)) { depth.set(e.to, depth.get(n) + 1); q.push(e.to); } }
  const maxD = Math.max(0, ...depth.values());
  nodes.forEach((n) => { if (!depth.has(n.id)) depth.set(n.id, maxD + 1); });
  const cols = new Map();
  nodes.forEach((n) => { const d = depth.get(n.id); if (!cols.has(d)) cols.set(d, []); cols.get(d).push(n); });
  const NW = 200, TH = 124, NH = TH + 44, GX = 120, GY = 56;
  const pos = new Map();
  const ncols = Math.max(...cols.keys()) + 1, tallest = Math.max(...[...cols.values()].map((c) => c.length));
  const W = ncols * NW + (ncols - 1) * GX + 80, H = tallest * NH + (tallest - 1) * GY + 120;
  for (const [d, list] of cols) list.forEach((n, i) => {
    const colH = list.length * NH + (list.length - 1) * GY;
    pos.set(n.id, { x: 40 + d * (NW + GX), y: (H - colH) / 2 + i * (NH + GY) });
  });
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.style.height = `${Math.max(420, H)}px`;
  const fit = (s) => { // displayed image rect inside the thumbnail (preserveAspectRatio meet)
    const k = Math.min((NW - 12) / s.w, (TH - 12) / s.h); const w = s.w * k, h = s.h * k;
    return { x: 6 + (NW - 12 - w) / 2, y: 6 + (TH - 12 - h) / 2, w, h };
  };
  const pair = new Set(edges.map((e) => `${e.from}>${e.to}`));
  const edgeSVG = edges.map((e) => {
    const p = pos.get(e.from), t = pos.get(e.to);
    const back = t.x <= p.x, bidir = pair.has(`${e.to}>${e.from}`);
    let x1 = p.x + NW, y1 = p.y + TH / 2 + (bidir ? -10 : 0), x2 = t.x, y2 = t.y + TH / 2 + (bidir ? -10 : 0), d;
    if (back) { x1 = p.x + NW / 2; y1 = p.y + NH; x2 = t.x + NW / 2; y2 = t.y + NH; const dip = Math.max(y1, y2) + 50; d = `M${x1},${y1} C${x1},${dip} ${x2},${dip} ${x2},${y2 + 4}`; }
    else if (bidir && e.from > e.to) { y1 += 20; y2 += 20; x1 = p.x + NW; x2 = t.x; d = `M${x1},${y1} C${(x1 + x2) / 2},${y1 + 30} ${(x1 + x2) / 2},${y2 + 30} ${x2 - 4},${y2}`; }
    else d = `M${x1},${y1} C${(x1 + x2) / 2},${y1} ${(x1 + x2) / 2},${y2} ${x2 - 4},${y2}`;
    const mx = back ? (x1 + x2) / 2 : (x1 + x2) / 2, my = back ? Math.max(y1, y2) + 40 : (y1 + y2) / 2 - 8 + (bidir && e.from > e.to ? 34 : 0);
    const label = e.trigger?.label || "?";
    return `<g class="edge ${e.source === "model" ? "model" : ""} ${S.flowSel === e.id ? "on" : ""}" data-id="${esc(e.id)}">
      <path d="${d}" marker-end="url(#arrow${e.source === "model" ? "M" : ""})"/><path d="${d}" stroke="transparent" stroke-width="14" style="stroke-dasharray:none"/>
      <text x="${mx}" y="${my}" text-anchor="middle">${esc(label.slice(0, 26))}</text></g>`;
  }).join("");
  const sel = edges.find((e) => e.id === S.flowSel);
  const nodeSVG = nodes.map((n) => {
    const p = pos.get(n.id), s = screenFor(n.analysisId);
    const r = s ? fit(s) : null;
    let trig = "";
    if (sel && sel.from === n.id && sel.trigger?.bbox && r) {
      const b = sel.trigger.bbox;
      trig = `<rect class="trig" x="${r.x + b.x * r.w - 2}" y="${r.y + b.y * r.h - 2}" width="${b.width * r.w + 4}" height="${b.height * r.h + 4}" rx="3"/>`;
    }
    return `<g class="node ${s === cur() ? "on" : ""}" data-aid="${esc(n.analysisId)}" transform="translate(${p.x},${p.y})">
      <rect class="frame" width="${NW}" height="${NH}" rx="10"/>
      ${s ? `<image href="${s.url}" x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" preserveAspectRatio="xMidYMid meet"/>` : ""}
      ${trig}
      <text x="10" y="${TH + 18}">${esc(n.label.slice(0, 28))}</text>
      <text class="sub" x="10" y="${TH + 34}">${n.componentCount ?? ""} components</text>
      ${n.isEntry ? `<text class="entry" x="${NW - 10}" y="${TH + 18}" text-anchor="end">ENTRY</text>` : ""}</g>`;
  }).join("");
  svg.innerHTML = `<defs>
      <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#4f8cff"/></marker>
      <marker id="arrowM" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#c084fc"/></marker>
    </defs>${edgeSVG}${nodeSVG}`;
  $$(".edge", svg).forEach((g) => (g.onclick = () => { S.flowSel = S.flowSel === g.dataset.id ? null : g.dataset.id; renderWorkflow(); }));
  $$(".node", svg).forEach((g) => (g.ondblclick = () => { const s = screenFor(g.dataset.aid); if (s) { S.cur = S.screens.indexOf(s); renderScreens(); setTab("explore"); } }));
  $$(".node", svg).forEach((g) => (g.onclick = () => { const s = screenFor(g.dataset.aid); if (s) { S.cur = S.screens.indexOf(s); renderScreens(); renderWorkflow(); } }));
  renderSide();
}

function renderFlowSide() {
  const side = $("#side"), wf = S.workflow;
  if (!wf) { side.innerHTML = `<div class="block"><p class="muted tiny">Maps how users probably move between the screens you uploaded, from the controls visible on each screen. Click a screen to select it; double-click to explore it.</p></div>`; return; }
  const name = new Map(wf.components.map((c) => [c.id, c.label]));
  side.innerHTML = `<div class="block"><div class="block-head"><h3>Transitions</h3><span class="legend"><i class="st estimated"></i>label match <i class="st" style="background:#c084fc"></i>AI hypothesis</span></div>
    ${wf.relationships.length ? `<ul class="transitions">${wf.relationships.map((e) => `<li data-id="${esc(e.id)}" class="${S.flowSel === e.id ? "on" : ""}">
      ${esc(name.get(e.from))} → ${esc(name.get(e.to))}${e.trigger ? ` <span class="tiny muted">via “${esc(e.trigger.label)}”</span>` : ""}
      <small>${esc(e.evidence.join(" · "))}</small></li>`).join("")}</ul>` : `<p class="muted tiny">No control on any screen clearly leads to another screen.</p>`}
  </div>`;
  $$(".transitions li", side).forEach((li) => (li.onclick = () => { S.flowSel = li.dataset.id; renderWorkflow(); }));
}

// ---------- compare ----------
function fillPairSelects() {
  const opts = S.screens.map((s, i) => s.analysis ? `<option value="${i}">${esc(screenName(s))}</option>` : "").join("");
  for (const id of ["#beforeSel", "#afterSel"]) { const el = $(id), v = el.value; el.innerHTML = opts; if (v && el.querySelector(`option[value="${v}"]`)) el.value = v; }
}
function autoPair() {
  const idx = S.screens.map((s, i) => (s.analysis ? i : -1)).filter((i) => i >= 0);
  // a saved newer version names its earlier version: pre-select that pair
  const after = idx.find((i) => S.screens[i].analysis.sample?.compareWith);
  const before = after === undefined ? -1 : idx.find((i) => S.screens[i].analysis.sample?.id === S.screens[after].analysis.sample.compareWith);
  if (before !== undefined && before >= 0 && !S.diff) { $("#beforeSel").value = before; $("#afterSel").value = after; return; }
  if (idx.length >= 2 && !S.diff) { $("#beforeSel").value = idx[idx.length - 2]; $("#afterSel").value = idx[idx.length - 1]; }
}

$("#runDiff").onclick = async () => {
  const b = S.screens[+$("#beforeSel").value], a = S.screens[+$("#afterSel").value];
  if (!b || !a) return toast("Pick two analysed screens.");
  if (b === a) return toast("Pick two different screens.");
  const btn = $("#runDiff"); btn.disabled = true; btn.textContent = "Comparing…";
  try {
    const fd = new FormData();
    fd.append("before", b.blob, b.name); fd.append("after", a.blob, a.name);
    fd.append("useModel", $("#diffModel").checked ? "1" : "0");
    const out = await api("/api/digital/diff", { method: "POST", body: fd });
    const chat = await api(`/api/analysis/${out.diff.diffId}`);
    S.diff = { ...out.diff, chat }; S.diffPair = [b, a]; S.diffSel = null;
    renderAll();
  } catch (e) { toast(e.message); }
  finally { btn.disabled = false; btn.textContent = "Compare"; }
};

function renderCompare() {
  const d = S.diff;
  $("#diffEmpty").hidden = !!d;
  $(".compare").hidden = !d;
  if (!d) { renderSide(); return; }
  const [b, a] = S.diffPair;
  const sides = [["#shotB", b, "beforeBbox", (c) => c.kind !== "added"], ["#shotA", a, "afterBbox", (c) => c.kind !== "removed"]];
  for (const [sel, scr, key, keep] of sides) {
    const el = $(sel);
    $("img", el).src = scr.url;
    $(".boxes", el).innerHTML = d.changes.filter((c) => keep(c) && c[key]).map((c) => {
      const bb = c[key];
      return `<div class="bx k-${c.kind} ${S.diffSel === c.id ? "sel" : ""}" data-id="${esc(c.id)}" style="left:${pct(bb.x)};top:${pct(bb.y)};width:${pct(bb.width)};height:${pct(bb.height)}" title="${esc(c.details.join(" · "))}"><span class="bl">${esc(c.kind.replace("_", " "))}</span></div>`;
    }).join("");
    $$(".bx", el).forEach((x) => (x.onclick = () => { S.diffSel = x.dataset.id; renderCompare(); }));
  }
  renderSide();
}

function renderDiffSide() {
  const side = $("#side"), d = S.diff;
  if (!d) { side.innerHTML = `<div class="block"><p class="muted tiny">Matches components between two versions by text, type and position, then lists what was added, removed, moved, resized or reworded. The optional AI check adds colour and typography changes.</p></div>`; return; }
  const order = { removed: 0, added: 1, text_changed: 2, type_changed: 3, resized: 4, moved: 5 };
  const list = [...d.changes].sort((p, q) => order[p.kind] - order[q.kind]);
  side.innerHTML = `<div class="block"><div class="block-head"><h3>Changes</h3></div>
      <div class="counts">${Object.entries(d.counts).filter(([, v]) => v).map(([k, v]) => `<span>${v} ${esc(k.replace("_", " "))}</span>`).join("")}</div></div>
    <div class="block"><ul class="changes">${list.map((c) => `<li class="k-${c.kind}" data-id="${esc(c.id)}"><b>${esc(c.kind.replace("_", " "))}</b> · ${esc(c.label)}<small>${esc(c.details.join(" · "))}</small></li>`).join("") || '<li class="muted">No structural changes.</li>'}</ul></div>
    ${d.styleChanges.length ? `<div class="block"><div class="block-head"><h3>Style changes</h3><span class="legend">AI · inferred</span></div><ul class="changes">${d.styleChanges.map((s) => `<li class="k-restyled"><b>${esc(s.kind)}</b> · ${esc(s.description)}</li>`).join("")}</ul></div>` : ""}`;
  $$(".changes li[data-id]", side).forEach((li) => (li.onclick = () => { S.diffSel = li.dataset.id; renderCompare(); }));
}

// ---------- rebuild ----------
$$("#codeTabs button").forEach((b) => (b.onclick = () => { S.codeTab = b.dataset.k; renderRebuild(); }));
$("#runBuild").onclick = async () => {
  const s = cur();
  if (!s?.analysis) return toast("Select an analysed screen first.");
  const btn = $("#runBuild"); btn.disabled = true; btn.textContent = "Generating…";
  try {
    const fd = new FormData(); fd.append("image", s.blob, s.name);
    S.builds[s.analysis.analysisId] = await api("/api/digital/reconstruct", { method: "POST", body: fd });
    renderAll();
  } catch (e) { toast(e.message); }
  finally { btn.disabled = false; btn.textContent = "Generate draft"; }
};

function renderRebuild() {
  const s = cur(), r = s?.analysis && S.builds[s.analysis.analysisId];
  // no model call is involved, so the draft is generated as soon as the tab opens
  if (!r && s?.analysis && !(S.autoBuilt ||= {})[s.analysis.analysisId]) { S.autoBuilt[s.analysis.analysisId] = 1; $("#runBuild").click(); }
  $("#buildEmpty").hidden = !!r;
  $(".rebuild").hidden = !r;
  $$("#codeTabs button").forEach((b) => b.classList.toggle("on", b.dataset.k === S.codeTab));
  renderSide();
  if (!r) return;
  const k = S.codeTab;
  $(".side-by-side").hidden = k !== "preview";
  $("#code").hidden = !["html", "react", "css"].includes(k);
  $("#docs").hidden = k !== "docs";
  if (k === "preview") {
    $("#origImg").src = s.url;
    if ($("#preview").dataset.for !== s.analysis.analysisId) { $("#preview").srcdoc = r.prototype.html; $("#preview").dataset.for = s.analysis.analysisId; }
    requestAnimationFrame(() => fitPreview(s));
  }
  if (k === "html") $("#code").textContent = r.prototype.html;
  if (k === "react") $("#code").textContent = r.prototype.react;
  if (k === "css") $("#code").textContent = r.tokens ? r.tokens.css + "\n\n/* " + r.tokens.method + " */" : "/* No image, no measured tokens. */";
  if (k === "docs") $("#docs").innerHTML = md(r.docs);
}

// render the draft at the screenshot's real size, then scale it to the column (same scale as the original)
function fitPreview(s) {
  const wrap = $("#pvwrap"), f = $("#preview");
  if (!wrap || !s?.w || !wrap.clientWidth) return;
  const k = wrap.clientWidth / s.w;
  f.style.width = `${s.w}px`; f.style.height = `${s.h}px`; f.style.transform = `scale(${k})`;
  wrap.style.height = `${Math.round(s.h * k)}px`;
}
addEventListener("resize", () => { if (S.tab === "rebuild" && S.codeTab === "preview") fitPreview(cur()); });

$("#download").onclick = () => {
  const s = cur(), r = s?.analysis && S.builds[s.analysis.analysisId];
  if (!r) return toast("Generate a draft first.");
  const base = r.prototype.componentName || "screen";
  const [text, name, type] = {
    preview: [r.prototype.html, `${base}.html`, "text/html"], html: [r.prototype.html, `${base}.html`, "text/html"],
    react: [r.prototype.react, `${base}.jsx`, "text/javascript"], css: [r.tokens?.css || "", `${base}.tokens.css`, "text/css"],
    docs: [r.docs, `${base}.md`, "text/markdown"],
  }[S.codeTab];
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
};

function renderBuildSide() {
  const side = $("#side"), s = cur(), r = s?.analysis && S.builds[s.analysis.analysisId];
  if (!r) { side.innerHTML = `<div class="block"><p class="muted tiny">Turns the analysis into a starter prototype (HTML/CSS and React), measured design tokens and architecture docs. Code is a draft to start from, not a copy of the original app.</p></div>`; return; }
  const t = r.tokens;
  side.innerHTML = `${t ? `<div class="block"><div class="block-head"><h3>Design tokens</h3><span class="legend">measured</span></div>
      <div class="swatches">${Object.entries(t.colors).map(([k, v]) => `<div class="swatch"><i style="background:${esc(v)}"></i><div><b>${esc(k)}</b><code>${esc(v)}</code></div></div>`).join("")}</div>
      <div class="typescale">${Object.entries(t.typeScale).sort((p, q) => q[1] - p[1]).map(([k, v]) => `<span style="font-size:${Math.min(v, 34)}px">${esc(k)}<small>${v}px</small></span>`).join("")}</div>
      <p class="tiny muted">Spacing: ${t.spacing.map((v) => v + "px").join(", ")}</p></div>` : ""}
    <div class="block"><div class="block-head"><h3>Reusable components</h3></div>
      ${r.repeated.length ? r.repeated.map((g) => `<div class="repeat"><b>${esc(g.name)}</b> × ${g.count}</div>`).join("") : '<p class="tiny muted">No repeated patterns found.</p>'}</div>
    <div class="block"><ul class="tiny">${r.limitations.map((l) => `<li>${esc(l)}</li>`).join("")}</ul></div>`;
}

// tiny markdown renderer for the generated docs (input is escaped first)
function md(src) {
  const inline = (s) => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  const lines = src.split("\n"), out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^#{1,3} /.test(l)) { const n = l.match(/^#+/)[0].length; out.push(`<h${n}>${inline(l.slice(n + 1))}</h${n}>`); }
    else if (l.startsWith("> ")) out.push(`<blockquote>${inline(l.slice(2))}</blockquote>`);
    else if (l.startsWith("|")) {
      const rows = []; while (i < lines.length && lines[i].startsWith("|")) rows.push(lines[i++]); i--;
      const cells = (r) => r.slice(1, -1).split("|").map((c) => c.trim());
      out.push(`<table><tr>${cells(rows[0]).map((c) => `<th>${inline(c)}</th>`).join("")}</tr>${rows.slice(2).map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</table>`);
    } else if (/^\s*- /.test(l)) {
      const items = []; while (i < lines.length && /^\s*- /.test(lines[i])) items.push(lines[i++]); i--;
      out.push(`<ul>${items.map((it) => `<li style="margin-left:${it.match(/^\s*/)[0].length * 7}px">${inline(it.replace(/^\s*- /, ""))}</li>`).join("")}</ul>`);
    } else if (l.trim()) out.push(`<p>${inline(l)}</p>`);
  }
  return out.join("");
}

// ---------- chat (one engine: works on a screen, a workflow or a diff) ----------
const SUGGEST = {
  explore: ["How is this page structured?", "What does the selected component do?", "Which controls can a user interact with?"],
  workflow: ["What is the main user journey?", "How does a user reach the last screen?", "Which transitions are least certain?"],
  compare: ["What changed between these versions?", "Was anything removed?", "Which change matters most to users?"],
  rebuild: ["Which parts should become reusable components?", "What would I need to build this for real?"],
};

function renderChat() {
  const a = S.tab === "rebuild" ? cur()?.analysis : contextAnalysis();
  $("#chatScope").textContent = a?.analysisId?.startsWith("repo-") ? "this screen + its code" : { explore: "this screen", workflow: "the workflow", compare: "the changes", rebuild: "this screen" }[S.tab];
  const log = a ? S.chats[a.analysisId] || [] : [];
  const sugg = a?.analysisId?.startsWith("repo-") ? ["Which file renders the main call-to-action?", "How is the app organised?", "Which components are reused?"] : SUGGEST[S.tab];
  $("#chatLog").innerHTML = log.map((m) => `<div class="msg q">${esc(m.q)}</div>` + (m.pending ? `<div class="msg a muted">Thinking…</div>` :
    m.err ? `<div class="msg a err">${esc(m.err)}</div>` :
    `<div class="msg a">${esc(m.a.answer)}
      ${m.a.referencedComponentIds.length ? `<div class="cites">${m.a.referencedComponentIds.map((id) => `<button data-cite="${esc(id)}">${esc(labelOf(a, id))}</button>`).join("")}</div>` : ""}
      ${m.a.limitations.length ? `<div class="lim">${m.a.limitations.map(esc).join(" ")}</div>` : ""}</div>`)).join("");
  $("#chatLog").scrollTop = 1e6;
  $$("#chatLog [data-cite]").forEach((b) => (b.onclick = () => cite(a, b.dataset.cite)));
  $("#chatSuggest").innerHTML = a && !log.length ? sugg.map((q) => `<button>${esc(q)}</button>`).join("") : "";
  $$("#chatSuggest button").forEach((b) => (b.onclick = () => ask(b.textContent)));
  $("#chatInput").disabled = !a;
  $("#chatInput").placeholder = a ? (S.sel && S.tab === "explore" ? `Ask about “${labelOf(a, S.sel)}”…` : "Ask a question about it…") : "Analyse a screen first";
}
const labelOf = (a, id) => a.components.find((c) => c.id === id)?.label || id;

function cite(a, id) {
  if (S.tab === "explore" && id.startsWith("file:")) {  // a cited source file -> highlight the UI parts it renders
    S.refs = a.relationships.filter((r) => r.from === id && r.type === "implemented_in").map((r) => r.to);
    if (!S.refs.length) toast("That file does not render a visible component on this screen.");
    return paintSelection();
  }
  if (S.tab === "explore") return select(id);
  if (S.tab === "compare") { const ch = S.diff.changes.find((c) => c.chatId === id); if (ch) { S.diffSel = ch.id; renderCompare(); } return; }
  if (S.tab === "workflow") { const s = screenFor(a.components.find((c) => c.id === id)?.analysisId); if (s) { S.cur = S.screens.indexOf(s); renderScreens(); renderWorkflow(); } }
}

$("#chatForm").onsubmit = (e) => { e.preventDefault(); const q = $("#chatInput").value.trim(); if (q) { $("#chatInput").value = ""; ask(q); } };

async function ask(q) {
  const a = S.tab === "rebuild" ? cur()?.analysis : contextAnalysis();
  if (!a) return;
  const log = (S.chats[a.analysisId] ||= []);
  const m = { q, pending: true }; log.push(m); renderChat();
  try {
    const selected = S.tab === "explore" && S.sel ? [S.sel] : [];
    m.a = await postJSON(`/api/analysis/${a.analysisId}/chat`, { question: q, selectedComponentIds: selected });
    if (S.tab === "explore") { S.refs = m.a.referencedComponentIds; paintSelection(); }
  } catch (e) { m.err = e.message; }
  m.pending = false; renderChat();
}

// ---------- repository mapping ----------
$("#repoToggle").onclick = () => { $("#repoBar").hidden = !$("#repoBar").hidden; };
$("#repoZip").onchange = () => { const f = $("#repoZip").files[0]; if (f) { $("#repoNote").textContent = `Selected ${f.name}`; mapRepo(f); } };
$("#repoBar").onsubmit = (e) => { e.preventDefault(); const u = $("#repoUrl").value.trim(); if (u) mapRepo(null, u); else toast("Paste a public GitHub URL or upload a .zip."); };

async function mapRepo(file, url) {
  const a = cur()?.analysis;
  if (!a) return toast("Select an analysed screen first.");
  const btn = $("#repoGo"); btn.disabled = true; btn.textContent = "Mapping…";
  try {
    const fd = new FormData(); fd.append("analysisId", a.analysisId);
    if (file) fd.append("repo", file, file.name); else fd.append("repoUrl", url);
    const r = await api("/api/digital/repo", { method: "POST", body: fd });
    r.chat = await api(`/api/analysis/${r.analysisId}`);
    S.repos[a.analysisId] = r;
    $("#repoNote").textContent = r.summary;
    $("#repoToggle").textContent = `Source: ${r.repo}`;
    renderAll();
  } catch (e) { toast(e.message); }
  finally { btn.disabled = false; btn.textContent = "Map"; $("#repoZip").value = ""; }
}

// keyboard: Esc clears selection
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && S.tab === "explore") select(null); });

renderScreens();
renderAll();
