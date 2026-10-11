// Digital Lab, simple flow: one screenshot -> rebuilt code (HTML or React), how to build it, structure.
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const S = {
  shot: null,          // {blob, url, w, h, name}
  analysis: null,
  versions: { html: [], react: [], "react-native": [], flutter: [] },  // [{code, notes, source, change, label}]
  cur: { html: -1, react: -1, "react-native": -1, flutter: -1 },
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
    S.sets = {}; for (const s of set) (S.sets[s.set] ||= []).push(s);  // the screens of each saved app, in order
    $("#examples").innerHTML = list.map((s) => `<button class="ex" data-id="${esc(s.id)}"><img src="${esc(s.imageUrl)}" alt="" loading="lazy" /><span>${esc(s.title.replace(/^.*·\s*/, ""))}</span></button>`).join("");
    $$(".ex").forEach((b) => (b.onclick = async () => {
      const s = list.find((x) => x.id === b.dataset.id);
      const blob = await (await fetch(s.imageUrl)).blob();
      start(blob, `${s.id}.png`, s.title.replace(/^.*·\s*/, ""), s.set, s.id);
    }));
    if (!list.length) $(".examples").hidden = true;
  } catch { $(".examples").hidden = true; }
}

function showStart() {
  $("#start").hidden = false; $("#work").hidden = true;
  S.run++;  // late responses from the previous screenshot are ignored
  window.fx?.abort();
}

// ---------- main flow ----------
async function start(blob, name, title = "", set = null, sampleId = null) {
  const run = ++S.run;
  if (S.shot?.url) URL.revokeObjectURL(S.shot.url);
  const url = URL.createObjectURL(blob);
  const [w, h] = await imgSize(url);
  // the other screens of a saved app come along, so "Build the whole app" works straight away
  const extra = (set && S.sets?.[set] || []).filter((x) => x.id !== sampleId)
    .map((x) => ({ name: `${x.id}.png`, url: x.imageUrl, title: x.title.replace(/^.*·\s*/, ""), blob: null }));
  Object.assign(S, { extra, shot: { blob, url, w, h, name }, analysis: null, guide: null, tree: null, sel: null,
    versions: { html: [], react: [], "react-native": [], flutter: [] }, cur: { html: -1, react: -1, "react-native": -1, flutter: -1 }, target: "html", backend: null, a11y: null, acc: {} });
  $("#acc").hidden = true; showHeat(false); $("#accHeat").checked = false; $("#screenBar").hidden = true;
  renderScreens();
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
  window.fx?.scan(url, w, h);  // teardown animation (build-fx.js)
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
    window.fx?.analysed(a);
  } catch (e) {
    if (run !== S.run) return;
    window.fx?.abort();
    wait(null); status(`Could not read the screenshot: ${e.message}`, true); return;
  }
  wait("Writing the code…");
  status("Writing the code and the build plan. This takes about 20–40 seconds.");
  const code = makeCode({ target: "html" }, "First version", run);
  code.then(() => { if (run === S.run) window.fx?.done(S.versions.html.at(-1)?.code); });
  const guide = api("/api/digital/guide", { method: "POST", body: form() })
    .then((g) => { if (run === S.run) { S.guide = g; renderGuide(); } })
    .catch((e) => { if (run === S.run) $("#guide").innerHTML = `<p class="fallback">Could not write the guide: ${esc(e.message)}</p>`; });
  await Promise.allSettled([code, guide]);
  if (run === S.run && !$("#status").classList.contains("err")) status("");
}

async function makeCode(params, label, run = S.run) {
  const t = params.target;
  wait(params.change && !CONVERT[t]?.startsWith(params.change.slice(0, 20)) ? "Applying the change…" : t === "html" ? "Writing the code…" : `Converting to ${TARGET_NAME[t]}…`);
  busy(true);
  try {
    const out = await api("/api/digital/code", { method: "POST", body: form(params) });
    if (run !== S.run) return;
    if (out.source !== "ai" && params.baseCode && out.code === params.baseCode) { const m = out.notes?.[0] || "The change could not be applied."; status(m, true); toast(m); return; }
    S.versions[t].push({ code: out.code, notes: out.notes || [], source: out.source, change: out.change, label,
      model: out.provider?.model, cached: out.cached });
    S.cur[t] = S.versions[t].length - 1;
    if (out.source !== "ai") status(out.notes?.[0] || "Showing the layout-only draft.", true);
    else status("");
    S.target = t; renderTarget(); renderVersions(); renderNotes(); renderCode();
    if (params.baseCode && params.change && out.source === "ai" && !Object.values(CONVERT).includes(params.change)) toast(`Applied: v${S.versions[t].length} is ready`);
  } catch (e) {
    if (run === S.run) { status(`Could not write the code: ${e.message}`, true); toast(`Could not write the code: ${e.message}`); }
  } finally {
    if (run === S.run) { wait(null); busy(false); }
  }
}

const current = () => S.versions[S.target][S.cur[S.target]];
function busy(on) { for (const id of ["#apply", "#regen", "#copy", "#download", "#openTab", "#stackblitz"]) $(id).disabled = on; $$("#targetSeg button").forEach((b) => (b.disabled = on)); }
// waiting message with a running seconds counter, so a slow model call never looks frozen
function wait(msg) {
  clearInterval(wait.t);
  $("#stageWait").hidden = !msg;
  if (!msg) return;
  const t0 = Date.now(), el = $("#stageWaitText");
  const tick = () => {
    const s = Math.round((Date.now() - t0) / 1000);
    el.textContent = s < 3 ? msg : `${msg} ${s} s` + (s > 45 ? " · the AI is busy, still trying" : "");
  };
  tick(); wait.t = setInterval(tick, 1000);
}

// ---------- code view ----------
// preview only: no scrollbar strip over the comparison (the downloaded code is untouched)
const NO_BAR = "<style>html{scrollbar-width:none}::-webkit-scrollbar{display:none}</style>";
// mobile targets: the code is a phone app, so it is previewed in a phone-sized frame next to the screenshot
const MOBILE = new Set(["react-native", "flutter"]);
const TARGET_NAME = { html: "HTML", react: "React", "react-native": "React Native", flutter: "Flutter" };
const CONVERT = {  // the React text is part of the saved example results' cache keys: keep it unchanged
  react: "Convert this page to a React component; keep the look identical.",
  "react-native": "Convert this screen to a React Native (Expo) app screen; keep the look and all text identical.",
  flutter: "Convert this screen to a Flutter app screen; keep the look and all text identical.",
};
const isMobile = () => MOBILE.has(S.target);
const frameSize = () => (isMobile() && S.shot.w > S.shot.h ? { w: 390, h: 844 } : { w: S.shot.w, h: S.shot.h });

function nativeDoc(code) {
  // React Native runs in the browser through react-native-web, loaded as ES modules from esm.sh
  const RN = "https://esm.sh/react-native-web@0.19.12?deps=react@18.3.1,react-dom@18.3.1";
  const R = "https://esm.sh/react@18.3.1";
  let src = code.replace(/^\s*import[^;\n]*from\s*['\"](?!react['\"]|react-native['\"])[^'\"]+['\"];?\s*$/gm, "")  // other libraries are not available
    .replace(/from\s*['\"]react-native['\"]/g, `from "${RN}"`).replace(/from\s*['\"]react['\"]/g, `from "${R}"`);
  if (!/import\s+React\b/.test(src)) src = `import React from "${R}";\n` + src;
  const m = src.match(/export\s+default\s+function\s+([A-Z]\w*)/) || src.match(/export\s+default\s+([A-Z]\w*)\s*;?/);
  const name = m ? m[1] : "App";
  src = src.replace(/export\s+default\s+function/, "function").replace(/^\s*export\s+default\s+[A-Z]\w*\s*;?\s*$/m, "").replace(/<\/script/gi, "<\\/script");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body,#root{height:100%;margin:0}#root{display:flex;flex-direction:column}</style>${NO_BAR}
<script src="https://unpkg.com/@babel/standalone@7.24.7/babel.min.js"></script></head>
<body><div id="root"></div><script type="text/babel" data-type="module" data-presets="react">
import { createRoot } from "https://esm.sh/react-dom@18.3.1/client?deps=react@18.3.1";
${src}
createRoot(document.getElementById("root")).render(React.createElement(${name}));
</script></body></html>`;
}
const FLUTTER_DOC = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
font:16px system-ui,sans-serif;background:#0b1220;color:#cbd5e1;text-align:center;padding:32px;box-sizing:border-box}b{color:#fff;font-size:20px}</style></head>
<body><div><b>Flutter runs outside the browser preview</b><p>Press <b>Run in DartPad</b>: the code is copied, DartPad opens, paste it and press Run.<br>Or put it in <code>lib/main.dart</code> of a Flutter project.</p></div></body></html>`;

// whole-app pages: tell the viewer which screens exist and which one shows, and switch screens on request
const SCREEN_JS = `<script>(()=>{const all=()=>[...document.querySelectorAll("[data-screen]")].filter(s=>!s.parentElement.closest("[data-screen]"));
const send=()=>{const a=all();parent.postMessage({appScreens:a.map(s=>s.dataset.screen),active:a.findIndex(s=>s.classList.contains("active"))},"*")};
addEventListener("message",e=>{const n=e.data&&e.data.goScreen;if(n==null)return;const a=all();if(!a.some(s=>s.dataset.screen===n))return;
a.forEach(s=>s.classList.toggle("active",s.dataset.screen===n));scrollTo(0,0)});
new MutationObserver(send).observe(document.body,{subtree:true,attributes:true,attributeFilter:["class"]});addEventListener("load",send);send()})();<\/script>`;
function previewDoc(v) {
  if (S.target === "react-native") return nativeDoc(v.code);
  if (S.target === "flutter") return FLUTTER_DOC;
  if (S.target === "html") {
    const doc = /<\/head>/i.test(v.code) ? v.code.replace(/<\/head>/i, NO_BAR + "</head>") : NO_BAR + v.code;
    if (!/data-screen=/.test(v.code)) return doc;
    return /<\/body>/i.test(doc) ? doc.replace(/<\/body>(?![\s\S]*<\/body>)/i, SCREEN_JS + "</body>") : doc + SCREEN_JS;
  }
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

// the same rebuilt page at three real widths, to show it is responsive (phone, tablet, laptop)
function renderDevices() {
  const v = current();
  if (!v || S.view !== "devices") return;
  const doc = previewDoc(v), box = $("#devices"), H = Math.max(320, Math.min(560, innerHeight - box.getBoundingClientRect().top - 60));
  const figs = $$("#devices .dev"), totalW = box.clientWidth - 24 * (figs.length - 1) - 24 - figs.length * 24;  // gaps, padding, frames
  const ks = figs.map((f) => H / +f.dataset.h), sumW = figs.reduce((a, f, i) => a + +f.dataset.w * ks[i], 0), fit = Math.min(1, totalW / sumW);
  figs.forEach((f, i) => {
    const w = +f.dataset.w, h = +f.dataset.h, k = ks[i] * fit, wrap = f.querySelector(".devwrap"), fr = f.querySelector("iframe");
    wrap.style.width = `${Math.round(w * k)}px`; wrap.style.height = `${Math.round(h * k)}px`;
    Object.assign(fr.style, { width: `${w}px`, height: `${h}px`, transform: `scale(${k})` });
    const key = doc.length + ":" + S.target + S.cur[S.target];
    if (fr.dataset.doc !== key) { fr.srcdoc = doc; fr.dataset.doc = key; }
  });
}
addEventListener("resize", () => S.view === "devices" && renderDevices());

function renderCode() {
  const v = current();
  if (!v) return;
  renderDevices();
  if (!(S.target === "html" && /data-screen=/.test(v.code))) {  // not a whole app: no screen bar, the first screenshot
    $("#screenBar").hidden = true; S.appScreens = null; S.appActive = 0; $("#acc").classList.remove("off");
    if (S.shot?.url) for (const id of ["#origImg", "#sideImg"]) if ($(id).getAttribute("src") !== S.shot.url) $(id).src = S.shot.url;
  }
  const doc = previewDoc(v);
  for (const id of ["#frame", "#sideFrame"]) if ($(id).dataset.doc !== doc.length + ":" + S.target + S.cur[S.target]) {
    $(id).srcdoc = doc; $(id).dataset.doc = doc.length + ":" + S.target + S.cur[S.target];
    $(id).dataset.hiddenLoad = String(!$(id).offsetParent);  // loaded while its panel was hidden
  }
  $("#codeText").textContent = v.code;
  fit();
  if (isMobile()) { $("#acc").hidden = true; return; }  // pixel match only makes sense for the same-size web page
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
  const sw = $("#sideFrameWrap"), f = frameSize();
  sw.classList.toggle("phone", isMobile());
  // side by side: original and rebuilt get the same height (a portrait screenshot no longer fills the column)
  const sideH = Math.max(tall, 600) - 30;
  $("#sideImg").style.maxHeight = S.shot.h > S.shot.w || isMobile() ? `${sideH}px` : "";
  // phone frame: as wide as fits, but never taller than that height
  sw.style.width = isMobile() ? `${Math.round(Math.min(330, sw.parentElement.clientWidth, sideH * f.w / f.h))}px` : "";
  const ks = sw.clientWidth / f.w;
  sw.style.height = `${Math.round(f.h * ks)}px`;
  sizeFrame($("#sideFrame"), ks, f);
  setWipe(S.wipe);
}
function sizeFrame(f, k, size = S.shot) { f.style.width = `${size.w}px`; f.style.height = `${size.h}px`; f.style.transform = `scale(${k})`; }
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
  if (v === "wipe" && S.shot && isMobile()) { toast("A phone app is compared side by side with the screenshot"); v = "side"; }
  S.view = v;
  $$("#viewSeg button").forEach((b) => b.classList.toggle("on", b.dataset.v === v));
  $("#wipe").hidden = v !== "wipe"; $("#side").hidden = v !== "side"; $("#codeView").hidden = v !== "code"; $("#devices").hidden = v !== "devices";
  if (v === "devices") requestAnimationFrame(renderDevices);
  // a React Native app measures the screen once at start: one loaded while hidden saw a 0 x 0 screen, so reload it
  const shown = { wipe: "#frame", side: "#sideFrame" }[v];
  if (shown && $(shown).dataset.hiddenLoad === "true" && current()) { delete $(shown).dataset.doc; requestAnimationFrame(renderCode); }
  requestAnimationFrame(fit);
}
$$("#viewSeg button").forEach((b) => (b.onclick = () => setView(b.dataset.v)));

function setTarget(t, generate = true) {
  S.target = t; renderTarget();
  // a mobile app is compared side by side with the screenshot (a wipe needs the same size and layout)
  if (isMobile() && (S.view === "wipe" || S.view === "devices")) { S.prevView = S.view; setView("side"); }
  if (!isMobile() && S.prevView === "wipe") { S.prevView = null; if (S.view === "side") setView("wipe"); }
  $("#openTab").textContent = t === "flutter" ? "Run in DartPad" : "Open";
  $("#stackblitz").hidden = !["html", "react"].includes(t);
  if (generate && t !== "html" && !S.versions[t].length) {
    const base = S.versions.html[S.cur.html];
    makeCode({ target: t, baseCode: base?.code, change: base ? CONVERT[t] : "" }, `First ${TARGET_NAME[t]} version`);
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
// ---------- whole app: every screen of the app in one working page, its navigation wired ----------
function renderScreens() {
  const all = [{ url: S.shot?.url, title: "This screen" }, ...(S.extra || [])];
  $("#screens").innerHTML = all.map((x, i) => `<figure class="scr"><img src="${esc(x.url || "")}" alt="" /><figcaption>${i + 1}. ${esc(x.title || "Screen")}</figcaption>
    ${i ? `<button type="button" class="scr-x" data-i="${i - 1}" aria-label="Remove screen ${i + 1}">×</button>` : ""}</figure>`).join("")
    + (all.length < 6 ? `<button type="button" class="scr-add" id="scrAdd" title="Add a screenshot of another page"><span>+</span>Add screen</button>` : "");
  $("#scrAdd")?.addEventListener("click", () => $("#addFile").click());
  $$("#screens .scr-x").forEach((b) => (b.onclick = () => { const [r] = S.extra.splice(+b.dataset.i, 1); if (r?.own) URL.revokeObjectURL(r.url); renderScreens(); }));
  const n = all.length;
  $("#wholeBtn").disabled = n < 2;
  $("#wholeBtn").innerHTML = n < 2 ? "Build the whole app" : `Build the whole app <small>${n} screens</small>`;
  $("#wholeBtn").title = n < 2 ? "Add at least one more screen first" : "";
  $("#screenCount").textContent = `${n} / 6`;
}
function addScreens(files) {
  for (const f of [...files].filter((f) => f.type.startsWith("image/")).slice(0, 6 - 1 - S.extra.length))
    S.extra.push({ blob: f, name: f.name || "screen.png", url: URL.createObjectURL(f), title: (f.name || "Screen").replace(/\.\w+$/, "").slice(0, 24), own: true });
  renderScreens();
}
$("#addScreen").onclick = () => $("#addFile").click();
$("#toPrompt").onclick = () => setTab("prompt");
$("#addFile").addEventListener("change", (e) => { addScreens(e.target.files); e.target.value = ""; });
$("#screens").addEventListener("dragover", (e) => { e.preventDefault(); e.stopPropagation(); $("#screens").classList.add("over"); });
$("#screens").addEventListener("dragleave", () => $("#screens").classList.remove("over"));
$("#screens").addEventListener("drop", (e) => { e.preventDefault(); e.stopPropagation(); $("#screens").classList.remove("over"); addScreens(e.dataTransfer.files); });
$("#wholeBtn").onclick = async () => {
  if (!S.analysis || !S.extra.length) return;
  const run = S.run, n = S.extra.length + 1;
  wait(`Building the whole app from ${n} screens…`); busy(true); $("#wholeBtn").disabled = true;
  status(`Reading all ${n} screenshots together and wiring the navigation between them. This takes about a minute.`);
  try {
    const fd = new FormData(); fd.append("image", S.shot.blob, S.shot.name);
    for (const x of S.extra) fd.append("image", x.blob || (x.blob = await (await fetch(x.url)).blob()), x.name);
    const out = await api("/api/digital/app", { method: "POST", body: fd });
    if (run !== S.run) return;
    if (out.fallback || !/data-screen=/.test(out.code || "")) {  // never pass one screen off as the whole app
      const m = out.notes?.[0] || "The whole app could not be built. Try again.";
      status(m, true); toast(m); return;
    }
    S.versions.html.push({ code: out.code, notes: out.notes || [], source: out.source, change: out.change, label: `Whole app · ${n} screens`,
      model: out.provider?.model, cached: out.cached, app: true });
    S.cur.html = S.versions.html.length - 1;
    S.target = "html"; renderTarget(); renderVersions(); renderNotes(); renderCode(); setView("side");
    status(`Whole app built: ${n} screens in one page. Use the screen buttons above the preview, or click the app's own menus and buttons. Open or Download gives you the full working app.`);
    toast("Whole app ready: try its menus and buttons");
  } catch (e) {
    if (run === S.run) status(`Could not build the whole app: ${e.message}`, true);
  } finally {
    if (run === S.run) { wait(null); busy(false); renderScreens(); }
  }
};
$("#regen").onclick = () => { if (S.analysis) makeCode({ target: S.target, force: "1" }, "Written again"); };

const fileName = () => (S.analysis?.title || "screen").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "screen";
$("#copy").onclick = async () => {
  const v = current(); if (!v) return;
  try { await navigator.clipboard.writeText(v.code); toast("Code copied"); } catch { toast("Copy failed: select the code in the Code view instead."); }
};
$("#download").onclick = () => {
  const v = current(); if (!v) return;
  const [name, type] = { html: [`${fileName()}.html`, "text/html"], react: [`${fileName()}.jsx`, "text/javascript"],
    "react-native": ["App.js", "text/javascript"], flutter: ["main.dart", "text/plain"] }[S.target];
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([v.code], { type })); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast(`Downloaded ${name}`);
};
// a real, editable project in StackBlitz (free, runs in the browser): plain HTML, or a Vite + React app
function stackblitzFiles(v) {
  const title = S.analysis?.title || "Rebuilt screen";
  if (S.target === "html") return { template: "html", files: { "index.html": v.code } };
  let app = v.code.replace(/^\s*import\s[^;\n]*from\s*["']react["'];?\s*$/gm, "");
  app = `import React, { useState, useEffect, useRef, useMemo, useCallback, Fragment } from "react";\n${app}`;
  if (!/export\s+default/.test(app)) { const m = app.match(/function\s+([A-Z]\w*)/); if (m) app += `\nexport default ${m[1]};\n`; }
  return { template: "node", files: {
    "package.json": JSON.stringify({ name: "rebuilt-screen", private: true, type: "module", scripts: { dev: "vite", build: "vite build" },
      dependencies: { react: "^18.3.1", "react-dom": "^18.3.1" }, devDependencies: { vite: "^5.4.10", "@vitejs/plugin-react": "^4.3.3" } }, null, 2),
    "vite.config.js": 'import { defineConfig } from "vite";\nimport react from "@vitejs/plugin-react";\nexport default defineConfig({ plugins: [react()] });\n',
    "index.html": `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8" />\n<meta name="viewport" content="width=device-width, initial-scale=1" />\n<title>${esc(title)}</title>\n<script src="https://cdn.tailwindcss.com"></script>\n</head>\n<body>\n<div id="root"></div>\n<script type="module" src="/src/main.jsx"></script>\n</body>\n</html>\n`,
    "src/main.jsx": 'import React from "react";\nimport { createRoot } from "react-dom/client";\nimport App from "./App.jsx";\ncreateRoot(document.getElementById("root")).render(<App />);\n',
    "src/App.jsx": app } };
}
$("#stackblitz").onclick = () => {
  const v = current(); if (!v || !["html", "react"].includes(S.target)) return;
  const { template, files } = stackblitzFiles(v);
  const f = document.createElement("form");
  f.method = "POST"; f.action = `https://stackblitz.com/run?file=${encodeURIComponent(S.target === "html" ? "index.html" : "src/App.jsx")}`; f.target = "_blank";
  const add = (k, val) => { const i = document.createElement("input"); i.type = "hidden"; i.name = k; i.value = val; f.append(i); };
  add("project[title]", `${S.analysis?.title || "Rebuilt screen"} (rebuilt from a screenshot)`);
  add("project[description]", "Rebuilt from a screenshot by Visual Reverse Engineering");
  add("project[template]", template);
  for (const [k, val] of Object.entries(files)) add(`project[files][${k}]`, val);
  document.body.append(f); f.submit(); f.remove();
  toast("Opening a live project in StackBlitz");
};
$("#openTab").onclick = async () => {
  const v = current(); if (!v) return;
  if (S.target === "flutter") {  // DartPad runs Flutter: copy the code, open it, the user pastes and presses Run
    try { await navigator.clipboard.writeText(v.code); toast("Code copied: paste it into DartPad and press Run"); } catch { toast("Copy the code from the Code view, then paste it into DartPad"); }
    window.open("https://dartpad.dev/?sample=flutter", "_blank", "noopener");
    return;
  }
  const u = URL.createObjectURL(new Blob([previewDoc(v)], { type: "text/html" }));
  window.open(u, "_blank", "noopener");
};

// ---------- tabs ----------
function setTab(t) {
  S.tab = t;
  $$(".tabs button").forEach((b) => b.setAttribute("aria-selected", b.dataset.tab === t));
  for (const x of ["code", "guide", "prompt", "structure", "backend", "a11y"]) $(`#tab-${x}`).hidden = x !== t;
  if (t === "code") requestAnimationFrame(fit);
  if (t === "structure") requestAnimationFrame(placeBoxes);
  if (t === "guide" && S.guide) replayGuide();
  if (t === "backend") loadBackend();
  if (t === "prompt") loadPrompt();
  if (t === "a11y") loadA11y();
}
$$(".tabs button").forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));

// ---------- guide ----------
function renderGuide() {
  const g = S.guide; if (!g) return;
  const c = g.tokens?.colors || {}, ts = g.tokens?.typeScale || {}, be = g.backend || {};
  const lvl = { easy: 1, medium: 2, hard: 3 }[g.effort?.level] || 2;
  const mono = (n) => (String(n).match(/[A-Za-z0-9]+/g) || ["?"]).slice(0, 2).map((w) => w[0].toUpperCase()).join("");
  const icon = { lock: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
    db: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/></svg>' };
  $("#guide").innerHTML = `
    ${g.source !== "ai" ? `<p class="fallback">${esc(g.notes?.[0] || "AI unavailable.")} This is a basic outline from the detected structure.</p>` : ""}
    <header class="g-hero">
      <div class="g-shot"><div class="g-shot-in"><img src="${esc(S.shot?.url || "")}" alt="" /></div></div>
      <div class="g-intro">
        <h2>How to build ${esc(S.analysis?.title || "this screen")}</h2>
        <p>${esc(g.summary)}</p>
        <div class="g-stats">
          <div class="g-stat"><span>Difficulty</span><b>${esc(g.effort?.level || "medium")}</b><i class="g-meter">${[1, 2, 3].map((n) => `<em class="${n <= lvl ? "on" : ""}"></em>`).join("")}</i></div>
          ${g.effort?.estimate ? `<div class="g-stat"><span>Time</span><b>${esc(g.effort.estimate.replace(/ for one developer/i, ""))}</b><small>one developer</small></div>` : ""}
          <div class="g-stat"><span>Plan</span><b>${g.steps?.length || 0} steps</b><small>${g.components?.length || 0} components</small></div>
        </div>
      </div>
    </header>
    ${g.stack?.length ? `<section class="g-sec"><h3>Recommended stack</h3><div class="g-stack">${g.stack.map((s, i) => `<div class="g-card" style="--i:${i}"><span class="g-mono">${esc(mono(s.name))}</span><div><b>${esc(s.name)}</b>${s.role ? `<em class="g-role">${esc(s.role)}</em>` : ""}<p>${esc(s.why)}</p></div></div>`).join("")}</div></section>` : ""}
    ${g.steps?.length ? `<section class="g-sec"><h3>Build plan</h3><ol class="g-steps">${g.steps.map((s, i) => `<li style="--i:${i}"><span class="g-num">${i + 1}</span><div class="g-step"><b>${esc(s.title)}</b><p>${esc(s.detail)}</p>${s.code ? `<pre class="g-code"><span>${esc(s.lang || "code")}</span><code>${esc(s.code)}</code></pre>` : ""}${s.check ? `<p class="g-check"><i>✓</i>${esc(s.check)}</p>` : ""}</div></li>`).join("")}</ol></section>` : ""}
    ${g.fileTree ? `<section class="g-sec"><h3>Project structure</h3><pre class="g-tree">${esc(g.fileTree)}</pre></section>` : ""}
    ${g.components?.length ? `<section class="g-sec"><h3>Components to build <small>hover one to find it on the screen</small></h3><div class="g-comp-wrap"><div class="g-mini"><img src="${esc(S.shot?.url || "")}" alt="" /></div><div class="g-comps">${g.components.map((x, i) => `<div class="g-card g-comp" style="--i:${i}" data-name="${esc(x.name)}"><code class="g-tag">&lt;${esc(x.name)} /&gt;</code><p>${esc(x.purpose)}</p>${x.props?.length ? `<div class="g-props">${x.props.map((p) => `<span>${esc(p)}</span>`).join("")}</div>` : ""}${x.state?.length ? `<div class="g-props g-state">${x.state.map((p) => `<span>${esc(p)}</span>`).join("")}</div>` : ""}</div>`).join("")}</div></div></section>` : ""}
    ${g.behaviour?.length || g.data?.length ? `<section class="g-sec g-two">
      ${g.behaviour?.length ? `<div><h3>What the screenshot can't show</h3><p class="muted g-note">You still need to build these. They are informed guesses from what is visible.</p><ul class="g-list">${g.behaviour.map((b) => `<li><i>${icon.lock}</i>${esc(b)}</li>`).join("")}</ul></div>` : ""}
      ${g.data?.length ? `<div><h3>Data it needs</h3><p class="muted g-note">What the back end has to provide.</p><ul class="g-list">${g.data.map((b) => `<li><i>${icon.db}</i>${esc(b)}</li>`).join("")}</ul></div>` : ""}
    </section>` : ""}
    ${be.endpoints?.length || be.tables?.length ? `<section class="g-sec"><h3>Back end <small>${esc(be.summary || "what the server has to do")}</small></h3>
      <div class="g-be">
        <div>${be.database ? `<p class="g-kv"><b>Database</b>${esc(be.database)}</p>` : ""}${be.auth ? `<p class="g-kv"><b>Auth</b>${esc(be.auth)}</p>` : ""}
          ${be.tables?.length ? `<div class="g-tables">${be.tables.map((t) => `<div class="g-table"><code>${esc(t.name)}</code><ul>${t.columns.split(/,\s*/).map((col) => `<li>${esc(col)}</li>`).join("")}</ul></div>`).join("")}</div>` : ""}</div>
        <div>${be.endpoints?.length ? `<ul class="g-eps">${be.endpoints.map((e) => `<li><span class="g-m g-${esc(e.method.toLowerCase())}">${esc(e.method)}</span><code>${esc(e.path)}</code><p>${esc(e.purpose)}${e.usedBy ? ` <small>· ${esc(e.usedBy)}</small>` : ""}</p></li>`).join("")}</ul>` : ""}
          ${be.rules?.length ? `<h4>Rules to enforce</h4><ul class="g-list">${be.rules.map((r) => `<li><i>${icon.lock}</i>${esc(r)}</li>`).join("")}</ul>` : ""}</div>
      </div>
      <p class="muted g-note">Open the Backend tab for the full data model, SQL and OpenAPI file.</p></section>` : ""}
    ${g.pitfalls?.length || g.testing?.length || g.deploy?.length ? `<section class="g-sec g-three">
      ${g.pitfalls?.length ? `<div><h3>Watch out for</h3><ul class="g-bul warn">${g.pitfalls.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>` : ""}
      ${g.testing?.length ? `<div><h3>Tests to write</h3><ul class="g-bul test">${g.testing.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>` : ""}
      ${g.deploy?.length ? `<div><h3>Put it online (free)</h3><ul class="g-bul ship">${g.deploy.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>` : ""}
    </section>` : ""}
    <section class="g-sec g-cta"><div><b>Rather let your own AI agent build it?</b><p>Get a complete prompt with all of this for Claude Code, Cursor, Copilot or Lovable.</p></div><button class="btn primary" type="button" id="gToPrompt">Prompt for your agent</button></section>
    ${Object.keys(c).length ? `<section class="g-sec"><h3>Design tokens <small>measured from the screenshot's pixels</small></h3>
      <div class="g-swatches">${Object.entries(c).map(([k, v]) => `<div class="g-sw"><i style="background:${esc(v)}"></i><b>${esc(k)}</b><code>${esc(v)}</code></div>`).join("")}</div>
      ${Object.keys(ts).length ? `<div class="g-type">${Object.entries(ts).map(([k, v]) => `<div><span style="font-size:${Math.min(56, +v || 14)}px">Aa</span><b>${esc(k)}</b><code>${esc(v)}px</code></div>`).join("")}</div>` : ""}
    </section>` : ""}`;
  // hover a component card: its parts light up on the screenshot. Matched by visible text first, then by type
  // ("StatCard" -> every card, "ProjectTable" -> the table), since component names rarely appear on screen.
  const TYPE_WORDS = { card: ["card", "tile", "stat", "metric"], table: ["table", "grid", "list"], sidebar: ["sidebar", "drawer"],
    navbar: ["nav", "navbar", "topbar", "header"], header: ["header"], form: ["form", "login", "signup"], button: ["button", "cta"],
    input: ["input", "field", "search"], image: ["image", "chart", "illustration", "hero"], footer: ["footer"], tabs: ["tabs", "tab"] };
  function partsFor(name) {
    const words = name.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
    const byText = window.fx?.matchPart?.(words);
    if (byText) return [byText];
    const comps = (S.analysis?.components || []).filter((c) => c.bbox);
    for (const [type, keys] of Object.entries(TYPE_WORDS)) {
      if (!keys.some((k) => words.split(" ").includes(k))) continue;
      const hits = comps.filter((c) => c.type === type || keys.some((k) => c.label.toLowerCase().includes(k)));
      if (hits.length) return hits.slice(0, 8);
    }
    return [];
  }
  $$("#guide .g-comp").forEach((card) => {
    card.onmouseenter = () => {
      const mini = $("#guide .g-mini");
      if (!mini) return;
      mini.querySelectorAll(".g-hl").forEach((e) => e.remove());
      for (const part of partsFor(card.dataset.name)) {
        const b = part.bbox, hl = document.createElement("div");
        hl.className = "g-hl";
        Object.assign(hl.style, { left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.width * 100}%`, height: `${b.height * 100}%` });
        mini.appendChild(hl);
        requestAnimationFrame(() => hl.classList.add("on"));
      }
    };
    card.onmouseleave = () => $$("#guide .g-mini .g-hl").forEach((e) => e.classList.remove("on"));
  });
  $("#gToPrompt").onclick = () => setTab("prompt");
  replayGuide();
}
// one orchestrated entrance each time the plan is shown
function replayGuide() { const el = $("#guide"); el.classList.remove("reveal"); void el.offsetWidth; el.classList.add("reveal"); }

// ---------- whole app: jump between its screens; the original follows when the screenshots are known ----------
addEventListener("message", (e) => {
  const d = e.data;
  if (!d || !Array.isArray(d.appScreens) || e.source !== $("#sideFrame").contentWindow && e.source !== $("#frame").contentWindow) return;
  const v = current(); if (!v || S.target !== "html" || !d.appScreens.length) { $("#screenBar").hidden = true; return; }
  S.appScreens = d.appScreens; S.appActive = Math.max(0, d.active);
  $("#screenBar").hidden = false;
  $("#screenChips").innerHTML = d.appScreens.map((n, i) => `<button type="button" data-i="${i}" class="${i === S.appActive ? "on" : ""}">${i + 1}. ${esc(n.replace(/[-_]+/g, " "))}</button>`).join("");
  $$("#screenChips button").forEach((b) => (b.onclick = () => goScreen(+b.dataset.i)));
  syncOriginal();
});
function goScreen(i) {
  const n = S.appScreens?.[i]; if (n == null) return;
  for (const f of [$("#frame"), $("#sideFrame"), ...$$("#devices iframe")]) f.contentWindow?.postMessage({ goScreen: n }, "*");
}
function syncOriginal() {
  // the n-th screen of the app is the n-th screenshot added, when there are as many
  const shots = [{ url: S.shot?.url }, ...(S.extra || [])], i = S.appActive || 0;
  const url = shots.length === S.appScreens?.length ? shots[i]?.url : i === 0 ? S.shot?.url : null;
  for (const id of ["#origImg", "#sideImg"]) if (url && $(id).getAttribute("src") !== url) $(id).src = url;
  if (!url) $("#sideImg").src = S.shot?.url || "";
  $("#acc").classList.toggle("off", i !== 0);  // the match is measured against the first screen
}

// ---------- prompt for the developer's own coding agent (no model call: built from what was measured) ----------
const AP = { agent: "claude-code", stack: "react" };
try { Object.assign(AP, JSON.parse(localStorage.getItem("ap-opts") || "{}")); } catch {}
async function loadPrompt() {
  if (!S.analysis) return;
  const run = S.run, extras = $("#apScreens").checked ? (S.extra || []).map((x) => x.title || "Screen").join("\n") : "";
  $("#apMeta").textContent = "Writing…";
  try {
    const p = await api("/api/digital/prompt", { method: "POST", body: form({ agent: AP.agent, stack: AP.stack,
      backend: $("#apBackend").checked ? "1" : "0", extra: $("#apExtra").value, screens: extras }) });
    if (run !== S.run) return;
    S.prompt = p;
    const chips = (el, list, key) => {
      el.innerHTML = list.map((x) => `<button type="button" data-id="${esc(x.id)}" class="${x.id === AP[key] ? "on" : ""}">${esc(x.name)}</button>`).join("");
      el.querySelectorAll("button").forEach((b) => (b.onclick = () => { AP[key] = b.dataset.id; try { localStorage.setItem("ap-opts", JSON.stringify(AP)); } catch {} loadPrompt(); }));
    };
    chips($("#apAgent"), p.agents, "agent");
    chips($("#apStack"), p.stacks.map((x) => ({ ...x, name: x.name.split(/ \+ |,| with /)[0].replace(/ \(.*/, "") })), "stack");
    const changed = $("#apText").value && $("#apText").value !== p.prompt;
    $("#apText").value = p.prompt; $("#apText").scrollTop = 0;
    if (changed) { const o = $(".ap-out"); o.classList.remove("swap"); void o.offsetWidth; o.classList.add("swap"); }
    $("#apHow").textContent = p.agent.how;
    const words = p.prompt.split(/\s+/).length;
    $("#apMeta").textContent = `${words.toLocaleString()} words · ${p.agent.name} · ${p.stack.name}` + (p.usesGuide ? " · uses the build plan" : "") + (p.usesBackend ? " · uses the back end" : "");
  } catch (e) { if (run === S.run) $("#apMeta").textContent = `Could not write the prompt: ${e.message}`; }
}
for (const id of ["#apBackend", "#apScreens"]) $(id).onchange = loadPrompt;
$("#apExtra").onchange = loadPrompt;
$("#apCopy").onclick = async () => { try { await navigator.clipboard.writeText($("#apText").value); toast("Prompt copied: paste it into your agent with the screenshot"); } catch { $("#apText").select(); toast("Press Ctrl+C to copy"); } };
const saveAs = (blob, name) => { const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); };
const slug = () => (S.analysis?.title || "screen").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "screen";
$("#apMd").onclick = () => saveAs(new Blob([$("#apText").value], { type: "text/markdown" }), `${slug()}-prompt.md`);
$("#apShot").onclick = async () => { if (!S.shot?.url) return; const b = await (await fetch(S.shot.url)).blob(); saveAs(b, `${slug()}.${(b.type.split("/")[1] || "png").replace("jpeg", "jpg")}`); };

// ---------- structure ----------
async function renderStructure() {
  const a = S.analysis; if (!a) return;
  $("#partCount").textContent = `(${a.components.length})`;
  $("#boxes").innerHTML = a.components.filter((c) => c.bbox).map((c) => `<div class="box" data-id="${esc(c.id)}" title="${esc(c.label)} (${esc(c.type)})"></div>`).join("");
  $$(".box").forEach((b) => { b.onclick = () => select(b.dataset.id); b.onmouseenter = () => hoverBox(b.dataset.id); b.onmouseleave = () => ($("#insHover").hidden = true); });
  placeBoxes();
  pixelData().catch(() => {}); // warm up the pixel buffer used by Inspect
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
  renderInspect();
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
window.DL = { S, select: (id) => select(id), esc };  // used by the console/dev harness

// ---------- accuracy: how closely the rebuilt page matches the screenshot ----------
// The rebuilt page is rendered in a hidden sandboxed frame, captured with html-to-image inside that frame,
// and compared with the screenshot on a small grid (colour + edges). It is an approximate visual score.
const H2I = "https://cdn.jsdelivr.net/npm/html-to-image@1.11.11/dist/html-to-image.js";
function captureDoc(doc, w, h) {
  return new Promise((resolve, reject) => {
    const token = Math.random().toString(36).slice(2);
    // capture inside the sandboxed frame itself (html-to-image renders the live DOM through an SVG, no nested frame)
    // web fonts: an SVG snapshot cannot use the page's fonts, and html-to-image cannot read Google's cross-origin
    // CSS, so the Latin font files are fetched and inlined here; without this the text is measured in a fallback font
    const inj = `<script src="${H2I}"><\/script><script>
    async function __fontCSS(){let out="";const hrefs=new Set();
      for(const l of document.querySelectorAll('link[href*="fonts.googleapis.com"]'))hrefs.add(l.href);
      for(const st of document.querySelectorAll("style"))for(const m of st.textContent.matchAll(/https:\\/\\/fonts\\.googleapis\\.com\\/[^"')\\s]+/g))hrefs.add(m[0]);
      const data=(b)=>new Promise(ok=>{const r=new FileReader();r.onload=()=>ok(r.result);r.readAsDataURL(b)});
      for(const href of hrefs){try{const css=await(await fetch(href)).text();
        for(let b of css.split(/(?=\\/\\*)/)){if(/^\\/\\*/.test(b)&&!/^\\/\\*\\s*latin\\s*\\*\\//.test(b))continue;
          for(const m of [...b.matchAll(/url\\((https:[^)]+)\\)/g)]){try{b=b.replace(m[1],await data(await(await fetch(m[1])).blob()))}catch(_){}}
          out+=b}}catch(_){}}
      return out}
    addEventListener("load",()=>setTimeout(async()=>{try{
      try{await document.fonts.ready}catch(_){}
      const fontEmbedCSS=await __fontCSS();
      const bg=getComputedStyle(document.body).backgroundColor;
      const o={width:${w},height:${h},canvasWidth:${w},canvasHeight:${h},pixelRatio:1,cacheBust:false,
        backgroundColor:(bg&&bg!=="rgba(0, 0, 0, 0)")?bg:"#ffffff",...(fontEmbedCSS?{fontEmbedCSS}:{})};
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
  const v = current(), changed = v?.change && !v.app && !/^(Whole site|Refine)/.test(v.change) && !Object.values(CONVERT).includes(v.change);
  $("#acc").hidden = false; $("#accLbl").textContent = changed ? "match · lower is expected after your change" : "visual match";
  const t0 = performance.now(), tick = () => { const k = Math.min(1, (performance.now() - t0) / 700), p = Math.round(r.score * (1 - Math.pow(1 - k, 3)));
    $("#accPct").textContent = p + "%"; setRing(p); if (k < 1) requestAnimationFrame(tick); };
  tick();
  const c = $("#heat"); c.width = r.gw; c.height = r.gh;
  const g = c.getContext("2d"), img = g.createImageData(r.gw, r.gh);
  for (let i = 0; i < r.gw * r.gh; i++) { const d = r.miss[i]; const a = d < 0.18 ? 0 : Math.min(200, (d - 0.18) * 320); img.data.set([255, 40, 60, a], i * 4); }
  g.putImageData(img, 0, 0);
  for (const id of ["#sideHeat", "#sideHeat2"]) { const o = $(id); o.width = r.gw; o.height = r.gh; o.getContext("2d").putImageData(img, 0, 0); }
  showHeat($("#accHeat").checked);
}
// ---------- refine: show the AI how its code renders, let it fix the differences, measure again ----------
const TARGET_MATCH = 95, MAX_ROUNDS = 5;
// the screenshot with its differences painted red, so the model sees exactly where it is off
async function diffImage(r) {
  const img = await new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = S.shot.url; });
  const c = document.createElement("canvas"); c.width = S.shot.w; c.height = Math.min(S.shot.h, 6000);
  const g = c.getContext("2d"); g.drawImage(img, 0, 0);
  const h = document.createElement("canvas"); h.width = r.gw; h.height = r.gh;
  const hg = h.getContext("2d"), d = hg.createImageData(r.gw, r.gh);
  for (let i = 0; i < r.gw * r.gh; i++) { const v = r.miss[i]; d.data.set([255, 0, 40, v < 0.15 ? 0 : Math.min(190, (v - 0.15) * 300)], i * 4); }
  hg.putImageData(d, 0, 0); g.imageSmoothingEnabled = true; g.drawImage(h, 0, 0, c.width, c.height);
  return new Promise((ok) => c.toBlob(ok, "image/png"));
}
async function measured(v) {
  const key = `${S.target}:${S.cur[S.target]}`;
  for (let i = 0; i < 200 && (S.acc[key] === "busy" || S.acc[key] === undefined); i++) {
    if (S.acc[key] === undefined) measureAccuracy(v, previewDoc(v));
    await new Promise((ok) => setTimeout(ok, 150));
  }
  return S.acc[key];
}
function worstRegions(r) {  // a 4 x 3 grid of the difference map, worst cells first, in words the model can use
  const out = [];
  for (let gy = 0; gy < 3; gy++) for (let gx = 0; gx < 4; gx++) {
    let s = 0, n = 0;
    for (let y = Math.floor(gy * r.gh / 3); y < Math.floor((gy + 1) * r.gh / 3); y++)
      for (let x = Math.floor(gx * r.gw / 4); x < Math.floor((gx + 1) * r.gw / 4); x++) { s += r.miss[y * r.gw + x]; n++; }
    out.push({ gx, gy, d: s / Math.max(1, n) });
  }
  return out.sort((a, b) => b.d - a.d).slice(0, 4).filter((c) => c.d > 0.08)
    .map((c) => `x ${c.gx * 25}-${c.gx * 25 + 25}%, y ${Math.round(c.gy * 33.3)}-${Math.round(c.gy * 33.3 + 33.3)}% (${Math.round(c.d * 100)}% off)`).join("; ");
}
// where the main colours of the screenshot come out a different shade in the render (exact hex, so it can be fixed)
const hexOf = (c) => "#" + c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");
async function colorPairs(render) {
  const gw = 320, gh = Math.max(20, Math.round(gw * S.shot.h / S.shot.w));
  const [a, b] = await Promise.all([pixels(S.shot.url, gw, gh), pixels(render, gw, gh)]);
  const groups = new Map(), n = gw * gh;
  for (let i = 0; i < n; i++) {
    const k = ((a[i * 4] >> 3) << 10) | ((a[i * 4 + 1] >> 3) << 5) | (a[i * 4 + 2] >> 3);
    const g = groups.get(k) || [0, 0, 0, 0, 0, 0, 0]; g[0]++;
    for (let c = 0; c < 3; c++) { g[1 + c] += a[i * 4 + c]; g[4 + c] += b[i * 4 + c]; }
    groups.set(k, g);
  }
  return [...groups.values()].sort((x, y) => y[0] - x[0]).slice(0, 8).filter((g) => g[0] > n * 0.01).map((g) => {
    const t = [g[1], g[2], g[3]].map((v) => v / g[0]), r = [g[4], g[5], g[6]].map((v) => v / g[0]);
    return { t, r, share: g[0] / n, off: Math.hypot(t[0] - r[0], t[1] - r[1], t[2] - r[2]) };
  }).filter((c) => c.off > 6);
}
const colorText = (pairs) => pairs.map((c) => `${hexOf(c.t)} in the target is ${hexOf(c.r)} in your render (${Math.round(c.share * 100)}% of the page)`).join("; ");
// measured colour correction: a hex colour in the code that renders as the wrong shade is set to the sampled one
function colorSnap(code, pairs) {
  const rgb = (h) => h.length === 4 ? [1, 2, 3].map((i) => parseInt(h[i] + h[i], 16)) : [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  let n = 0;
  const out = code.replace(/#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g, (h) => {
    const c = rgb(h);
    const p = pairs.find((q) => q.share > 0.02 && Math.hypot(c[0] - q.r[0], c[1] - q.r[1], c[2] - q.r[2]) < 10);
    if (!p) return h;
    n++; return hexOf(p.t);
  });
  return { code: out, n };
}
// close-ups of the worst regions, target on the left and the render on the right, so small details are visible
async function closeUps(r, renderUrl) {
  const load = (src) => new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = src; });
  const [ti, ri] = await Promise.all([load(S.shot.url), load(renderUrl)]);
  const cells = [];
  for (let gy = 0; gy < 3; gy++) for (let gx = 0; gx < 4; gx++) {
    let s = 0, n = 0;
    for (let y = Math.floor(gy * r.gh / 3); y < Math.floor((gy + 1) * r.gh / 3); y++)
      for (let x = Math.floor(gx * r.gw / 4); x < Math.floor((gx + 1) * r.gw / 4); x++) { s += r.miss[y * r.gw + x]; n++; }
    cells.push({ gx, gy, d: s / Math.max(1, n) });
  }
  const W = S.shot.w, H = Math.min(S.shot.h, 6000), out = [];
  for (const c of cells.sort((a, b) => b.d - a.d).slice(0, 3)) {
    const x0 = Math.max(0, (c.gx / 4) * W - W * 0.04), y0 = Math.max(0, (c.gy / 3) * H - H * 0.05);
    const w = Math.min(W - x0, W / 4 + W * 0.08), h = Math.min(H - y0, H / 3 + H * 0.1);
    const k = Math.min(2, 640 / w), cv = document.createElement("canvas"); cv.width = Math.round(w * k) * 2 + 12; cv.height = Math.round(h * k);
    const g = cv.getContext("2d"); g.fillStyle = "#ff0040"; g.fillRect(0, 0, cv.width, cv.height);
    g.drawImage(ti, x0, y0, w, h, 0, 0, w * k, h * k); g.drawImage(ri, x0, y0, w, h, w * k + 12, 0, w * k, h * k);
    out.push({ blob: await new Promise((ok) => cv.toBlob(ok, "image/png")),
      where: `x ${Math.round(x0 / W * 100)}-${Math.round((x0 + w) / W * 100)}%, y ${Math.round(y0 / H * 100)}-${Math.round((y0 + h) / H * 100)}%` });
  }
  return out;
}
// measured text fitting: each visible text of the screenshot is found in the rendered page, its text width compared
// with the width it has in the screenshot, and its font size scaled to match (only tags whose class is unique in the code)
function fitText(code) {
  const comps = (S.analysis?.components || []).filter((c) => c.bbox && c.label && c.label.length >= 6 && /heading|text|button|link|label|badge|title|paragraph/i.test(c.type))
    .map((c) => ({ t: (c.label.includes(":") ? c.label.split(":").slice(1).join(":") : c.label).replace(/\s+/g, " ").trim().slice(0, 80), w: c.bbox.width * S.shot.w }))
    .filter((c) => c.t.length >= 6);  // labels like "Main heading: Build something..." carry the visible text after the colon
  if (!comps.length) return Promise.resolve({ code, n: 0 });
  const token = Math.random().toString(36).slice(2);
  const inj = `<script>addEventListener("load",()=>setTimeout(async()=>{try{await document.fonts.ready}catch(_){}
    const C=${JSON.stringify(comps)},out=[],norm=s=>(s||"").replace(/\\s+/g," ").trim().toLowerCase();
    for(const c of C){let best=null;const t=norm(c.t);
      for(const e of document.body.querySelectorAll("*")){const x=norm(e.innerText);if(!x||x.length>t.length*1.3+4)continue;
        if(x===t||x.startsWith(t.slice(0,24))){if(!best||e.contains(best)===false&&best.contains(e))best=e;else if(!best)best=e}}
      if(!best)continue;const r=document.createRange();r.selectNodeContents(best);const w=r.getBoundingClientRect().width;
      if(w<20)continue;out.push({cls:best.getAttribute("class")||"",tag:best.tagName.toLowerCase(),k:c.w/w,fs:parseFloat(getComputedStyle(best).fontSize)})}
    parent.postMessage({fit:"${token}",out},"*")},1200))<\/script>`;
  return new Promise((resolve) => {
    const f = document.createElement("iframe");
    f.setAttribute("sandbox", "allow-scripts"); f.setAttribute("aria-hidden", "true");
    Object.assign(f.style, { position: "fixed", left: "-20000px", top: "0", width: `${S.shot.w}px`, height: `${S.shot.h}px`, border: "0" });
    const done = (v) => { removeEventListener("message", on); clearTimeout(tm); f.remove(); resolve(v); };
    const on = (e) => {
      if (e.data?.fit !== token) return;
      let out = code, n = 0;
      for (const m of e.data.out) {
        if (!m.cls || m.k < 0.7 || m.k > 1.45 || Math.abs(m.k - 1) < 0.04) continue;
        const attr = `class="${m.cls}"`, at = out.indexOf(attr);
        if (at < 0 || out.indexOf(attr, at + 1) >= 0) continue;  // the class string must point at one tag only
        const fs = Math.round(m.fs * m.k * 10) / 10;
        const t0 = out.lastIndexOf("<", at), t1 = out.indexOf(">", at), tag = out.slice(t0, t1);
        const tag2 = /\sstyle="/.test(tag) ? tag.replace(/\sstyle="/, ` style="font-size:${fs}px;`) : tag.replace(attr, `style="font-size:${fs}px" ${attr}`);
        out = out.slice(0, t0) + tag2 + out.slice(t1); n++;
      }
      done({ code: out, n });
    };
    const tm = setTimeout(() => done({ code, n: 0 }), 15000);
    addEventListener("message", on);
    f.srcdoc = /<\/body>/i.test(code) ? code.replace(/<\/body>(?![\s\S]*<\/body>)/i, inj + "</body>") : code + inj;
    document.body.append(f);
  });
}
// font finder: the headline's text is drawn in candidate Google Fonts and compared, ink against ink, with the
// headline in the screenshot; the closest face is passed to the model (it tends to default to Inter)
const FONT_CANDIDATES = ["Inter", "Archivo", "Space Grotesk", "Manrope", "DM Sans", "Plus Jakarta Sans", "Poppins", "Montserrat", "Sora",
  "Outfit", "Figtree", "Geist", "Bricolage Grotesque", "Instrument Sans", "Work Sans", "IBM Plex Sans", "Rubik", "Lexend", "Onest",
  "Syne", "Unbounded", "Archivo Narrow", "Barlow", "Roboto", "Open Sans", "Lato", "Nunito Sans", "Raleway", "Oswald", "Playfair Display",
  "Fraunces", "Instrument Serif", "Libre Franklin", "Public Sans", "Urbanist", "Red Hat Display", "Epilogue", "Hanken Grotesk"];
const WIDTH_AXIS = { Archivo: "wdth,wght@62..125,100..900", "Bricolage Grotesque": "opsz,wdth,wght@12..96,75..100,200..800" };
const STRETCH = { normal: 100, "semi-condensed": 87.5, condensed: 75, "extra-condensed": 62.5 };
let fontCache = null;
async function findFont() {
  if (fontCache?.id === S.analysis?.analysisId) return fontCache.text;
  const h = (S.analysis?.components || []).filter((c) => c.type === "heading" && c.bbox && c.label && !c.label.includes(":") && c.label.length >= 8)
    .sort((a, b) => b.bbox.width * b.bbox.height - a.bbox.width * a.bbox.height)[0];
  if (!h) return "";
  if (!document.getElementById("fontFinder")) {
    const l = document.createElement("link"); l.id = "fontFinder"; l.rel = "stylesheet";
    l.href = "https://fonts.googleapis.com/css2?" + FONT_CANDIDATES.map((f) => `family=${f.replace(/ /g, "+")}:${WIDTH_AXIS[f] || "wght@500;700;800"}`).join("&") + "&display=block";
    document.head.append(l); await new Promise((ok) => { l.onload = ok; l.onerror = ok; setTimeout(ok, 8000); });
  }
  // the headline's lines in the screenshot: ink bands, each with its ink width, height and density
  const pad = 6, X = Math.max(0, Math.round(h.bbox.x * S.shot.w) - pad), Y = Math.max(0, Math.round(h.bbox.y * S.shot.h) - pad);
  const W = Math.min(S.shot.w - X, Math.round(h.bbox.width * S.shot.w) + 2 * pad), H = Math.min(S.shot.h - Y, Math.round(h.bbox.height * S.shot.h) + 2 * pad);
  const img = await new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = S.shot.url; });
  const tc = document.createElement("canvas"); tc.width = W; tc.height = H;
  const tg = tc.getContext("2d", { willReadFrequently: true }); tg.drawImage(img, X, Y, W, H, 0, 0, W, H);
  const td = tg.getImageData(0, 0, W, H).data, lum = (d, i) => 0.3 * d[i] + 0.59 * d[i + 1] + 0.11 * d[i + 2];
  const bg = lum(td, 0), ink = (x, y) => Math.abs(lum(td, (y * W + x) * 4) - bg) > 70;
  const rows = []; for (let y = 0; y < H; y++) { let n = 0; for (let x = 0; x < W; x++) n += ink(x, y); rows.push(n); }
  const bands = []; let y0 = -1;
  const rmax = Math.max(...rows), cut = Math.max(1, rmax * 0.1);  // a descender touching the next line is not a line
  for (let y = 0; y <= H; y++) { const on = y < H && rows[y] > cut; if (on && y0 < 0) y0 = y; if (!on && y0 >= 0) { if (y - y0 > 6) bands.push([y0, y]); y0 = -1; } }
  for (let i = 0; i < bands.length; i++) {  // grow each band to its full ink (ascenders, descenders), not past the neighbours
    const lo = i ? Math.ceil((bands[i - 1][1] + bands[i][0]) / 2) : 0, hi = i < bands.length - 1 ? Math.floor((bands[i][1] + bands[i + 1][0]) / 2) : H;
    while (bands[i][0] > lo && rows[bands[i][0] - 1] > 0) bands[i][0]--;
    while (bands[i][1] < hi && rows[bands[i][1]] > 0) bands[i][1]++;
  }
  const lines = bands.map(([a, b]) => { let x0 = W, x1 = 0, n = 0;
    for (let y = a; y < b; y++) for (let x = 0; x < W; x++) if (ink(x, y)) { n++; if (x < x0) x0 = x; if (x > x1) x1 = x; }
    return { w: x1 - x0 + 1, h: b - a, dens: n / Math.max(1, (x1 - x0 + 1) * (b - a)) }; }).filter((l) => l.w > 20);
  const words = h.label.replace(/\s+/g, " ").trim().split(" "), N = lines.length;
  window.__fontFinder = { lines, words };
  if (!N || N > 4 || words.length < N || words.length > 16) return "";
  const splits = [];  // every way to break the words into N lines
  (function rec(i, acc) { if (acc.length === N - 1) { splits.push([...acc, words.length]); return; } for (let j = i + 1; j < words.length; j++) rec(j, [...acc, j]); })(0, []);
  const c = document.createElement("canvas"); c.width = 900; c.height = 260; const g = c.getContext("2d", { willReadFrequently: true });
  const box = (t) => { const m = g.measureText(t); return { w: m.actualBoundingBoxLeft + m.actualBoundingBoxRight, h: m.actualBoundingBoxAscent + m.actualBoundingBoxDescent, asc: m.actualBoundingBoxAscent, left: m.actualBoundingBoxLeft }; };
  let best = null;
  for (const fam of FONT_CANDIDATES) for (const wt of [500, 700, 800]) for (const st of WIDTH_AXIS[fam] ? Object.keys(STRETCH) : ["normal"]) {
    const f100 = `${st} ${wt} 100px "${fam}"`;
    try { await document.fonts.load(f100); } catch { continue; }
    if (!document.fonts.check(f100)) continue;
    for (const ls of [0, -0.01, -0.02, -0.03]) {
      g.font = f100; g.letterSpacing = `${ls * 100}px`;
      let pick = null;
      for (const sp of splits) {  // shape match: each line's width / ink height against the screenshot's
        let err = 0, st = 0, sizes = [];
        sp.forEach((end, li) => { const t = words.slice(li ? sp[li - 1] : 0, end).join(" "), m = box(t);
          err += Math.abs(Math.log((m.w / m.h) / (lines[li].w / lines[li].h))); sizes.push(lines[li].h / m.h * 100); });
        const mean = sizes.reduce((a, b) => a + b) / N; for (const z of sizes) st += Math.abs(z - mean) / mean;  // one size for all lines
        err = err / N + st / N;
        if (!pick || err < pick.err) pick = { err, sp, size: mean };
      }
      // stroke weight: ink density of the first line drawn at the matched size
      const t0 = words.slice(0, pick.sp[0]).join(" "); g.font = `${st} ${wt} ${pick.size}px "${fam}"`;
      const m = box(t0); g.fillStyle = "#000"; g.fillRect(0, 0, c.width, c.height); g.fillStyle = "#fff";
      g.fillText(t0, m.left + 2, m.asc + 2);
      const bw = Math.min(c.width, Math.ceil(m.w) + 4), bh = Math.min(c.height, Math.ceil(m.h) + 4), dd = g.getImageData(0, 0, bw, bh).data;
      let n = 0; for (let i = 0; i < bw * bh; i++) n += dd[i * 4] > 128; const dens = n / Math.max(1, (m.w) * (m.h));
      const score = pick.err + 1.5 * Math.abs(dens - lines[0].dens);
      (window.__fontScores ||= []).push([fam, wt, st, ls, +score.toFixed(3)]);
      if (!best || score < best.score) best = { fam, wt, st, ls, s: Math.round(pick.size), score, lines: pick.sp.length };
    }
  }
  g.letterSpacing = "0px";
  window.__fontFinder = { lines, best };  // for debugging in the console
  const text = best && best.score < 0.35 ? `the main headline measures closest to "${best.fam}" weight ${best.wt}${best.st !== "normal" ? `, font-stretch ${STRETCH[best.st]}% (load the font with its wdth axis)` : ""}, about ${best.s}px, letter-spacing ${best.ls}em, ${best.lines} lines (shape error ${best.score.toFixed(2)})` : "";
  fontCache = { id: S.analysis?.analysisId, text };
  return text;
}
async function refineLoop() {
  if (S.target !== "html" || !current()) return;
  const run = S.run, btn = $("#refineBtn");
  btn.disabled = true; busy(true);
  let best = { i: S.cur.html, score: (await measured(current()))?.score ?? 0 }, snaps = 0, fits = 0, fails = 0;
  try {
    for (let round = 1; round <= MAX_ROUNDS && best.score < TARGET_MATCH; round++) {
      if (run !== S.run) return;
      S.cur.html = best.i; renderVersions(); renderCode();
      const v = current(), res = await measured(v);
      if (!res) throw new Error("the match could not be measured");
      wait(`Refining, round ${round}: ${res.score}% match, comparing the render with the screenshot…`);
      status(`Round ${round}: the AI sees its own render next to the screenshot and fixes what differs.`);
      const shotUrl = await captureDoc(previewDoc(v), S.shot.w, Math.min(S.shot.h, 6000));
      if (fits++ < 2) {  // instant, measured fix: text sizes to the widths they have in the screenshot
        const ft = await fitText(v.code);
        if (ft.n) {
          S.versions.html.push({ ...v, code: ft.code, label: `Text sizes matched (${ft.n})`, cached: false });
          S.cur.html = S.versions.html.length - 1; renderVersions(); renderCode();
          const now = (await measured(current()))?.score ?? 0;
          if (now > best.score) { best = { i: S.cur.html, score: now }; if (now >= TARGET_MATCH) break; round--; continue; }
        }
      }
      const pairs = await colorPairs(shotUrl);
      const snap = colorSnap(v.code, pairs);
      if (snap.n && snaps++ < 3) {  // instant, measured fix first: wrong shades -> the sampled colours
        S.versions.html.push({ ...v, code: snap.code, label: `Colours matched (${snap.n})`, cached: false });
        S.cur.html = S.versions.html.length - 1; renderVersions(); renderCode();
        const now = (await measured(current()))?.score ?? 0;
        if (now > best.score) { best = { i: S.cur.html, score: now }; if (now >= TARGET_MATCH) break; round--; continue; }
      }
      const png = await (await fetch(shotUrl)).blob(), colors = colorText(pairs), ups = await closeUps(res, shotUrl);
      const fontMatch = await findFont().catch(() => "");
      const fd = form({ render: new File([png], "render.png", { type: "image/png" }),
        diff: new File([await diffImage(res)], "diff.png", { type: "image/png" }),
        baseCode: v.code, score: String(res.score), regions: worstRegions(res), colors, fontMatch, force: "1",
        closeupWhere: ups.map((u) => u.where).join(" | ") });
      ups.forEach((u, i) => fd.append("closeup", new File([u.blob], `closeup${i}.png`, { type: "image/png" })));
      const out = await api("/api/digital/refine", { method: "POST", body: fd });
      if (run !== S.run) return;
      if (out.source !== "ai") { status(out.notes?.[0] || "Refine unavailable.", true); if (++fails >= 2) break; continue; }  // one bad round is retried
      S.versions.html.push({ code: out.code, notes: out.notes || [], source: out.source, change: out.change, label: `Refined · round ${round}`,
        model: out.provider?.model, cached: out.cached });
      S.cur.html = S.versions.html.length - 1; renderVersions(); renderNotes(); renderCode();
      const now = (await measured(current()))?.score ?? 0;
      if (now > best.score) best = { i: S.cur.html, score: now };
    }
    if (run !== S.run) return;
    S.cur.html = best.i; renderVersions(); renderNotes(); renderCode();  // keep the best-matching version
    status(best.score >= TARGET_MATCH ? `Refined to ${best.score}% match.` : `Best so far: ${best.score}% match. Run it again to keep refining.`);
  } catch (e) {
    if (run === S.run) status(`Could not refine: ${e.message}`, true);
  } finally {
    if (run === S.run) { wait(null); busy(false); btn.disabled = false; }
  }
}
const showHeat = (on) => { for (const id of ["#heat", "#sideHeat", "#sideHeat2"]) $(id).hidden = !on; };
$("#accHeat").onchange = (e) => { showHeat(e.target.checked); if (e.target.checked && S.view === "wipe") setWipe(100); };

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


// ---------- Inspect: dev-mode measurements for any element of the screenshot ----------
// Everything here is measured from the screenshot's pixels in the browser (no AI call): the AI's box is
// first snapped to the real edges, then size, spacing, colours, font size, radius and border are read off.
let PIX = null;
function pixelData() {
  if (PIX && PIX.url === S.shot?.url) return Promise.resolve(PIX);
  return new Promise((ok, bad) => {
    const i = new Image();
    i.onload = () => { const c = document.createElement("canvas"); c.width = i.naturalWidth; c.height = i.naturalHeight;
      const g = c.getContext("2d", { willReadFrequently: true }); g.drawImage(i, 0, 0);
      PIX = { url: i.src, w: c.width, h: c.height, d: g.getImageData(0, 0, c.width, c.height).data }; ok(PIX); };
    i.onerror = bad; i.src = S.shot.url;
  });
}
const dprOf = (w, h) => (h > w * 1.5 && w >= 1000 ? 3 : w >= 2000 ? 2 : 1);
const at = (P, x, y) => { x = Math.max(0, Math.min(P.w - 1, x | 0)); y = Math.max(0, Math.min(P.h - 1, y | 0)); const i = (y * P.w + x) * 4; return [P.d[i], P.d[i + 1], P.d[i + 2]]; };
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const hex = (c) => "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");

function stripMean(P, x0, y0, x1, y1) { // mean colour of a thin strip
  let r = 0, g = 0, b = 0, n = 0;
  const sx = Math.max(1, ((x1 - x0) / 60) | 0), sy = Math.max(1, ((y1 - y0) / 60) | 0);
  for (let y = y0; y <= y1; y += sy) for (let x = x0; x <= x1; x += sx) { const c = at(P, x, y); r += c[0]; g += c[1]; b += c[2]; n++; }
  return [r / n, g / n, b / n];
}
function snapBox(P, b) { // move each side of the AI box onto the strongest nearby colour edge
  let x0 = b.x * P.w, y0 = b.y * P.h, x1 = (b.x + b.width) * P.w, y1 = (b.y + b.height) * P.h;
  const kx = Math.round((x1 - x0) * 0.06 + 4), ky = Math.round((y1 - y0) * 0.06 + 4);
  const side = (pos, lo, hi, vertical, k) => {
    let best = pos, bestD = 22;
    for (let o = -k; o <= k; o++) {
      const p = Math.round(pos + o);
      const a = vertical ? stripMean(P, p - 2, lo, p - 1, hi) : stripMean(P, lo, p - 2, hi, p - 1);
      const c = vertical ? stripMean(P, p, lo, p + 1, hi) : stripMean(P, lo, p, hi, p + 1);
      const d = dist(a, c); if (d > bestD) { bestD = d; best = p; }
    }
    return best;
  };
  const my0 = y0 + (y1 - y0) * 0.25, my1 = y1 - (y1 - y0) * 0.25, mx0 = x0 + (x1 - x0) * 0.25, mx1 = x1 - (x1 - x0) * 0.25;
  const nx0 = side(x0, my0, my1, true, kx), nx1 = side(x1, my0, my1, true, kx), ny0 = side(y0, mx0, mx1, false, ky), ny1 = side(y1, mx0, mx1, false, ky);
  return nx1 - nx0 > 3 && ny1 - ny0 > 3 ? { x0: nx0, y0: ny0, x1: nx1, y1: ny1 } : { x0, y0, x1, y1 };
}
function colours(P, r) { // background = dominant colour, foreground = strongest "ink" far from it
  const counts = new Map(), px = [];
  const step = Math.max(1, Math.sqrt(((r.x1 - r.x0) * (r.y1 - r.y0)) / 9000) | 0);
  for (let y = r.y0 + 1; y < r.y1 - 1; y += step) for (let x = r.x0 + 1; x < r.x1 - 1; x += step) {
    const c = at(P, x, y); px.push(c); const k = (c[0] >> 4) * 256 + (c[1] >> 4) * 16 + (c[2] >> 4); counts.set(k, (counts.get(k) || 0) + 1);
  }
  if (!px.length) return null;
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const inBin = px.filter((c) => (c[0] >> 4) * 256 + (c[1] >> 4) * 16 + (c[2] >> 4) === top);
  const bg = [0, 1, 2].map((i) => inBin.reduce((s, c) => s + c[i], 0) / inBin.length);
  const ds = px.map((c) => dist(c, bg)), sorted = [...ds].sort((a, b) => a - b), cut = Math.max(40, sorted[(sorted.length * 0.85) | 0] * 0.6);
  const ink = px.filter((_, i) => ds[i] > cut);
  let fg = null;
  if (ink.length > px.length * 0.01) { ink.sort((a, b) => dist(b, bg) - dist(a, bg)); const t = ink.slice(0, Math.max(5, (ink.length * 0.4) | 0));
    fg = [0, 1, 2].map((i) => t.reduce((s, c) => s + c[i], 0) / t.length); }
  return { bg, fg, inkShare: ink.length / px.length };
}
function textLines(P, r, bg, fg) { // rows that contain text-coloured ink -> lines of text
  const rows = [], ix = Math.min((r.x1 - r.x0) * 0.12, (r.y1 - r.y0) * 0.6); // skip rounded corners / edges
  const isInk = (c) => dist(c, bg) > 60 && (!fg || dist(c, fg) < dist(c, bg));
  const e = r.tight ? 0 : 2;
  for (let y = r.y0 + e; y < r.y1 - e; y++) { let ink = 0; for (let x = r.x0 + ix; x < r.x1 - ix; x += 2) if (isInk(at(P, x, y))) ink++; rows.push(ink > 1); }
  const lines = []; let s0 = -1;
  rows.forEach((on, i) => { if (on && s0 < 0) s0 = i; if (!on && s0 >= 0) { if (i - s0 > 2) lines.push([s0, i]); s0 = -1; } });
  if (s0 >= 0 && rows.length - s0 > 2) lines.push([s0, rows.length]);
  return lines;
}
function cornerRadius(P, r, bg, outside, border = null) {
  if (border) { // trace the border line: where the diagonal first meets it is the arc
    // radii above ~40px are rare: only look that far, so dividers deeper inside are never mistaken for the arc
    const maxB = Math.min(Math.min(r.x1 - r.x0, r.y1 - r.y0) / 2, 4 + 14);
    const hitB = (cx, cy, dx, dy) => { for (let k = 0; k < maxB; k++) if (dist(at(P, cx + dx * k, cy + dy * k), border) < 22) return Math.max(0, k - 4); return -1; };
    const kb = [hitB(r.x0 - 4, r.y0 - 4, 1, 1), hitB(r.x1 + 3, r.y0 - 4, -1, 1), hitB(r.x0 - 4, r.y1 + 3, 1, -1), hitB(r.x1 + 3, r.y1 + 3, -1, -1)].filter((k) => k >= 0).sort((a, b) => a - b);
    if (kb.length < 2) return null;
    const kk = kb[(kb.length / 2) | 0], rb = kk * 3.41;
    if (rb > 1) return rb >= Math.min(r.x1 - r.x0, r.y1 - r.y0) * 0.45 ? "full" : Math.round(rb);
  }
  if (!outside || dist(bg, outside) < 14) return null; // same colour as around it: no visible corner
  const maxK = Math.min(r.x1 - r.x0, r.y1 - r.y0) / 2;
  // walk the diagonal from just outside each corner until the box's own colour starts
  const corner = (cx, cy, dx, dy) => { for (let k = 0; k < maxK; k++) if (dist(at(P, cx + dx * k, cy + dy * k), bg) < 20) return Math.max(0, k - 2); return maxK; };
  const ks = [corner(r.x0 - 2, r.y0 - 2, 1, 1), corner(r.x1 + 1, r.y0 - 2, -1, 1), corner(r.x0 - 2, r.y1 + 1, 1, -1), corner(r.x1 + 1, r.y1 + 1, -1, -1)].sort((a, b) => a - b);
  const k = (ks[1] + ks[2]) / 2, rad = k <= 0.5 ? 0 : k * 3.41;
  return rad >= Math.min(r.x1 - r.x0, r.y1 - r.y0) * 0.45 ? "full" : Math.round(rad);
}
function borderOf(P, r, bg) { // a thin line around the box that differs from both inside and outside
  const mid = (r.x0 + r.x1) / 2, out = at(P, mid, r.y0 - 5), inside = at(P, mid, r.y0 + 5);
  for (let y = r.y0 - 3; y <= r.y0 + 3; y++) {
    const e = at(P, mid, y), e2 = at(P, mid + (r.x1 - r.x0) * 0.2, y);
    if (dist(e, inside) > 12 && dist(e, out) > 8 && dist(e, e2) < 10 && dist(inside, bg) < 20) return e;
  }
  return null;
}
function inkBounds(P, r, bg) { // tight box around everything that is not background inside r
  let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
  const st = Math.max(1, Math.min(r.x1 - r.x0, r.y1 - r.y0) / 80 | 0);
  const m = r.tight === false ? 7 : 4; // inside a surface, skip its border and anti-aliased edge
  for (let y = r.y0 + m; y < r.y1 - m; y += st) for (let x = r.x0 + m; x < r.x1 - m; x += st)
    if (dist(at(P, x, y), bg) > 40) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return x1 < 0 ? null : { x0, y0, x1: x1 + 1, y1: y1 + 1 };
}

// nearest Tailwind colour (v3 palette, common families) for readable class names
const TW = { white: "#ffffff", black: "#000000",
  "slate-50": "#f8fafc", "slate-100": "#f1f5f9", "slate-200": "#e2e8f0", "slate-300": "#cbd5e1", "slate-400": "#94a3b8", "slate-500": "#64748b", "slate-600": "#475569", "slate-700": "#334155", "slate-800": "#1e293b", "slate-900": "#0f172a",
  "gray-50": "#f9fafb", "gray-100": "#f3f4f6", "gray-200": "#e5e7eb", "gray-300": "#d1d5db", "gray-400": "#9ca3af", "gray-500": "#6b7280", "gray-600": "#4b5563", "gray-700": "#374151", "gray-800": "#1f2937", "gray-900": "#111827",
  "blue-50": "#eff6ff", "blue-100": "#dbeafe", "blue-500": "#3b82f6", "blue-600": "#2563eb", "blue-700": "#1d4ed8",
  "indigo-50": "#eef2ff", "indigo-100": "#e0e7ff", "indigo-500": "#6366f1", "indigo-600": "#4f46e5", "indigo-700": "#4338ca",
  "violet-500": "#8b5cf6", "violet-600": "#7c3aed", "purple-600": "#9333ea", "sky-500": "#0ea5e9",
  "green-50": "#f0fdf4", "green-100": "#dcfce7", "green-500": "#22c55e", "green-600": "#16a34a", "green-700": "#15803d",
  "emerald-500": "#10b981", "emerald-600": "#059669",
  "amber-50": "#fffbeb", "amber-100": "#fef3c7", "amber-400": "#fbbf24", "amber-500": "#f59e0b", "amber-600": "#d97706", "amber-700": "#b45309",
  "red-50": "#fef2f2", "red-100": "#fee2e2", "red-500": "#ef4444", "red-600": "#dc2626", "red-700": "#b91c1c",
  "orange-500": "#f97316", "pink-500": "#ec4899", "teal-500": "#14b8a6" };
const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
function twColor(c) {
  let best = null, bd = 1e9; for (const [n, h] of Object.entries(TW)) { const d = dist(c, hexRgb(h)); if (d < bd) { bd = d; best = n; } }
  return bd < 14 ? best : `[${hex(c)}]`;
}
const FONT = [[12, "text-xs"], [14, "text-sm"], [16, "text-base"], [18, "text-lg"], [20, "text-xl"], [24, "text-2xl"], [30, "text-3xl"], [36, "text-4xl"], [48, "text-5xl"], [60, "text-6xl"]];
const SPACE = (px) => { const n = Math.round(px / 4); return n <= 0 ? "0" : n <= 12 || n % 2 === 0 ? String(n) : `[${Math.round(px)}px]`; };
const RAD = (r) => r === "full" ? "rounded-full" : r <= 1 ? "" : r <= 3 ? "rounded-sm" : r <= 5 ? "rounded" : r <= 7 ? "rounded-md" : r <= 10 ? "rounded-lg" : r <= 14 ? "rounded-xl" : r <= 20 ? "rounded-2xl" : `rounded-[${r}px]`;

function boxOfComp(c) { return c?.bbox ? { x0: c.bbox.x * S.shot.w, y0: c.bbox.y * S.shot.h, x1: (c.bbox.x + c.bbox.width) * S.shot.w, y1: (c.bbox.y + c.bbox.height) * S.shot.h } : null; }
const contains = (o, i) => o.x0 <= i.x0 + 2 && o.y0 <= i.y0 + 2 && o.x1 >= i.x1 - 2 && o.y1 >= i.y1 - 2;

function hoverBox(id) {
  const c = S.analysis.components.find((x) => x.id === id), b = boxOfComp(c); if (!b) return;
  const dpr = dprOf(S.shot.w, S.shot.h), h = $("#insHover");
  h.textContent = `${c.label.slice(0, 40)} · ${Math.round((b.x1 - b.x0) / dpr)}×${Math.round((b.y1 - b.y0) / dpr)}`;
  Object.assign(h.style, { left: `${(c.bbox.x) * 100}%`, top: `${(c.bbox.y + c.bbox.height) * 100}%` }); h.hidden = false;
}

function codeFor(c) { // the element in the current rebuilt HTML whose text best matches this part
  const v = S.versions.html[S.cur.html]; if (!v) return null;
  const doc = new DOMParser().parseFromString(v.code, "text/html");
  const norm = (t) => (t || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const want = norm(c.label); if (!want) return null;
  const words = want.split(" ").filter((w) => w.length > 2);
  let best = null, bestScore = 0;
  for (const el of doc.body.querySelectorAll("*")) {
    if (["SCRIPT", "STYLE"].includes(el.tagName)) continue;
    const t = norm(el.textContent); if (!t) continue;
    const hits = words.filter((w) => t.includes(w)).length / Math.max(1, words.length);
    if (hits < 0.6 && !t.includes(want)) continue;
    const score = (t.includes(want) ? 2 : hits) - Math.min(1, t.length / (want.length * 6 + 40)); // prefer the tightest match
    if (score > bestScore) { bestScore = score; best = el; }
  }
  if (!best) return null;
  let html = best.outerHTML.replace(/\s+\n/g, "\n");
  if (html.length > 1600) html = html.slice(0, 1600) + "\n<!-- … -->";
  return html;
}

async function renderInspect() {
  const box = $("#inspect"), rl = $("#redlines"); rl.innerHTML = "";
  const c = S.analysis?.components.find((x) => x.id === S.sel);
  if (!c) { box.innerHTML = `<p class="muted">Click an element on the screenshot.</p>`; return; }
  if (!c.bbox) { box.innerHTML = `<h3>${esc(c.label)}</h3><p class="muted">No position on the screenshot for this part.</p>`; return; }
  const P = await pixelData(), dpr = dprOf(P.w, P.h);
  const textual = ["heading", "text", "paragraph", "button", "link", "menu_item", "tab", "badge", "label", "list_item", "breadcrumb"].includes(c.type);
  const raw = boxOfComp(c), mid = (raw.y0 + raw.y1) / 2;
  const outside0 = stripMean(P, raw.x0 - 6, mid - 2, raw.x0 - 5, mid + 2), inside0 = colours(P, raw);
  // a box with its own surface (button, card, input) snaps to its edges; plain text is measured by its letters
  const surface = inside0 && (dist(inside0.bg, outside0) > 10 || borderOf(P, raw, inside0.bg));
  let r = surface ? snapBox(P, c.bbox) : raw;
  if (!surface && inside0) { const ib = inkBounds(P, raw, inside0.bg); if (ib) r = { ...ib, tight: true }; }
  const W = (r.x1 - r.x0) / dpr, H = (r.y1 - r.y0) / dpr;
  const col = surface ? colours(P, r) : inside0;
  const out = stripMean(P, r.x0 - 6, (r.y0 + r.y1) / 2 - 2, r.x0 - 5, (r.y0 + r.y1) / 2 + 2);
  let font = null, lines = [];
  if (col && textual) {
    lines = textLines(P, r, col.bg, col.fg);
    if (lines.length) { const hs = lines.map(([a, b]) => (b - a) / dpr).sort((a, b) => a - b); const ink = hs[(hs.length / 2) | 0];
      // ink height vs font size depends on the letters: descenders (g, y) ≈ 0.95, capitals/ascenders ≈ 0.74, x-height ≈ 0.53
      const t = c.label.replace(/[^A-Za-z0-9]/g, ""), k = /[gjpqy]/.test(t) ? (/[A-Zbdfhklt0-9]/.test(t) ? 0.95 : 0.74) : /[A-Zbdfhklt0-9]/.test(t) ? 0.74 : 0.53;
      const est = ink / k; font = FONT.reduce((p, q) => (Math.abs(q[0] - est) < Math.abs(p[0] - est) ? q : p)); }
  }
  const border = surface && col ? borderOf(P, r, col.bg) : null;
  const rad = surface && col ? cornerRadius(P, r, col.bg, out, border) : null;
  // spacing: padding inside the parent, gaps to the nearest neighbours
  const others = S.analysis.components.filter((x) => x.id !== c.id && x.bbox).map((x) => ({ c: x, b: boxOfComp(x) }));
  const parent = others.filter((o) => contains(o.b, r) && !contains(r, o.b)).sort((a, b) => (a.b.x1 - a.b.x0) * (a.b.y1 - a.b.y0) - (b.b.x1 - b.b.x0) * (b.b.y1 - b.b.y0))[0];
  const kids = others.filter((o) => contains(r, o.b) && !contains(o.b, r)).map((o) => o.b);
  const content = kids.length ? { x0: Math.min(...kids.map((k) => k.x0)), y0: Math.min(...kids.map((k) => k.y0)), x1: Math.max(...kids.map((k) => k.x1)), y1: Math.max(...kids.map((k) => k.y1)) }
    : surface && col ? inkBounds(P, { ...r, tight: false }, col.bg) : null;  // no child parts: use the text/icons inside it
  const pad = content && surface ? { t: content.y0 - r.y0, l: content.x0 - r.x0, b: r.y1 - content.y1, r: r.x1 - content.x1 } : null;
  const sib = (dir) => {
    let best = null, gap = 1e9;
    for (const o of others) {
      if (contains(o.b, r) || contains(r, o.b)) continue;
      const vOver = Math.min(o.b.y1, r.y1) - Math.max(o.b.y0, r.y0) > 4, hOver = Math.min(o.b.x1, r.x1) - Math.max(o.b.x0, r.x0) > 4;
      const g = dir === "right" && vOver ? o.b.x0 - r.x1 : dir === "below" && hOver ? o.b.y0 - r.y1 : dir === "left" && vOver ? r.x0 - o.b.x1 : dir === "above" && hOver ? r.y0 - o.b.y1 : -1;
      if (g >= 0 && g < gap && g / dpr <= 160) { gap = g; best = o; } // only real neighbours, not something across the page
    }
    return best ? { o: best, gap } : null;
  };
  const near = { right: sib("right"), below: sib("below"), left: sib("left"), above: sib("above") };
  // redlines (percent of the screenshot)
  const pct = (v, total) => `${(v / total) * 100}%`;
  const line = (x0, y0, x1, y1, label, cls = "") => {
    const horiz = Math.abs(y1 - y0) < 1;
    rl.insertAdjacentHTML("beforeend", `<div class="rline ${horiz ? "h" : "v"} ${cls}" style="left:${pct(Math.min(x0, x1), P.w)};top:${pct(Math.min(y0, y1), P.h)};${horiz ? `width:${pct(Math.abs(x1 - x0), P.w)}` : `height:${pct(Math.abs(y1 - y0), P.h)}`}"><span>${label}</span></div>`);
  };
  rl.insertAdjacentHTML("beforeend", `<div class="rsel" style="left:${pct(r.x0, P.w)};top:${pct(r.y0, P.h)};width:${pct(r.x1 - r.x0, P.w)};height:${pct(r.y1 - r.y0, P.h)}"><span>${Math.round(W)} × ${Math.round(H)}</span></div>`);
  const cy = (r.y0 + r.y1) / 2, cx = (r.x0 + r.x1) / 2;
  if (near.right && near.right.gap > 1) line(r.x1, cy, near.right.o.b.x0, cy, Math.round(near.right.gap / dpr));
  if (near.below && near.below.gap > 1) line(cx, r.y1, cx, near.below.o.b.y0, Math.round(near.below.gap / dpr));
  if (near.left && near.left.gap > 1) line(near.left.o.b.x1, cy, r.x0, cy, Math.round(near.left.gap / dpr));
  if (near.above && near.above.gap > 1) line(cx, near.above.o.b.y1, cx, r.y0, Math.round(near.above.gap / dpr));
  if (pad) {
    if (pad.l > 1) line(r.x0, cy + 6, r.x0 + pad.l, cy + 6, Math.round(pad.l / dpr), "pad");
    if (pad.t > 1) line(cx + 6, r.y0, cx + 6, r.y0 + pad.t, Math.round(pad.t / dpr), "pad");
  }
  // Tailwind classes from the measurements
  const tw = [];
  if (pad) { const px2 = Math.round(Math.max(0, Math.min(pad.l, pad.r)) / dpr), py2 = Math.round(Math.max(0, Math.min(pad.t, pad.b)) / dpr); // left-aligned content: the smaller side is the padding
    tw.push(px2 === py2 ? `p-${SPACE(px2)}` : `px-${SPACE(px2)} py-${SPACE(py2)}`); }
  else if (["button", "input", "search", "badge", "avatar", "icon"].includes(c.type)) tw.push(`w-[${Math.round(W)}px] h-[${Math.round(H)}px]`);
  if (surface && col) tw.push(`bg-${twColor(col.bg)}`);
  if (col?.fg && textual) tw.push(`text-${twColor(col.fg)}`);
  if (font) tw.push(font[1]);
  if (rad && surface) tw.push(RAD(rad));
  if (border) tw.push(`border border-${twColor(border)}`);
  const classes = tw.filter(Boolean).join(" ");
  const code = codeFor(c);
  const sw = (lbl, cc) => cc ? `<div class="sw-row"><i style="background:${hex(cc)}"></i><span>${lbl}</span><code>${hex(cc)}</code><em>${twColor(cc).replace(/^\[|\]$/g, "")}</em><button class="link cp" data-copy="${hex(cc)}">copy</button></div>` : "";
  box.innerHTML = `
    <div class="ins-h"><h3>${esc(c.label)}</h3><span class="kind-t">${esc(c.type)}</span></div>
    <dl class="ins-dl">
      <dt>Size</dt><dd>${Math.round(W)} × ${Math.round(H)} px</dd>
      <dt>Position</dt><dd>x ${Math.round(r.x0 / dpr)}, y ${Math.round(r.y0 / dpr)}</dd>
      ${pad ? `<dt>Padding</dt><dd>${Math.round(Math.max(0, Math.min(pad.t, pad.b)) / dpr)} px top/bottom · ${Math.round(Math.max(0, Math.min(pad.l, pad.r)) / dpr)} px sides</dd>` : ""}
      ${["right", "below"].filter((k) => near[k]).map((k) => `<dt>Gap ${k === "right" ? "→" : "↓"}</dt><dd>${Math.round(near[k].gap / dpr)} px <small>(gap-${SPACE(Math.round(near[k].gap / dpr))}) to ${esc(near[k].o.c.label.slice(0, 22))}</small></dd>`).join("")}
      ${font ? `<dt>Font size</dt><dd>≈ ${font[0]} px <small>(${font[1]}${lines.length > 1 ? `, ${lines.length} lines` : ""})</small></dd>` : ""}
      ${rad ? `<dt>Corners</dt><dd>${rad === "full" ? "fully rounded" : `≈ ${rad} px radius`}</dd>` : ""}
    </dl>
    <div class="ins-sw">${sw("Background", col?.bg)}${textual ? sw("Text", col?.fg) : ""}${sw("Border", border)}</div>
    <div class="ins-block"><div class="ins-bh"><b>Tailwind</b><button class="link cp" data-copy="${esc(classes)}">copy</button></div><code class="tw">${esc(classes) || "–"}</code></div>
    <div class="ins-block"><div class="ins-bh"><b>Code for this element</b>${code ? `<button class="link cp" data-copy-code="1">copy</button>` : ""}</div>
      ${code ? `<pre class="ins-code">${esc(code)}</pre>` : `<p class="muted small">${S.versions.html.length ? "Not found in the rebuilt code." : "Appears once the rebuilt code is ready."}</p>`}</div>
    <p class="muted small">Measured from the screenshot's pixels (${dpr}× screenshot assumed); ≈ values are estimates.</p>`;
  $$("#inspect .cp").forEach((b) => (b.onclick = async () => {
    const t = b.dataset.copyCode ? code : b.dataset.copy;
    try { await navigator.clipboard.writeText(t); toast("Copied"); } catch { toast("Copy failed"); }
  }));
}
