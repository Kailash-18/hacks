// Edit the rebuild directly: click any text, button or box in the rebuilt page, change its words, colours or size.
// The page updates at once; "Save as a new version" writes the edits into the code (a new version you can compare).
(() => {
  const q = (s, r = document) => r.querySelector(s);
  const escH = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  // runs inside the sandboxed preview: highlight on hover, select on click, inline text editing, live style changes
  const EDIT_JS = `<script>(()=>{let on=false,sel=null,hov=null,orig="";const st=document.createElement("style");
st.textContent=".__eh{outline:2px dashed #4f8cff!important;outline-offset:2px!important;cursor:text!important}.__es{outline:2px solid #4f8cff!important;outline-offset:2px!important;box-shadow:0 0 0 5px rgba(79,140,255,.25)!important}";
document.head.appendChild(st);
const hex=c=>{const m=(c||"").match(/\\d+(\\.\\d+)?/g);if(!m||(m[3]!==undefined&&+m[3]===0))return"";return"#"+m.slice(0,3).map(v=>(+v).toString(16).padStart(2,"0")).join("")};
const bgOf=e=>{for(let x=e;x;x=x.parentElement){const b=hex(getComputedStyle(x).backgroundColor);if(b)return b}return"#ffffff"};
const textOnly=e=>[...e.childNodes].every(n=>n.nodeType===3||(n.nodeType===1&&/^(B|I|EM|STRONG|SPAN|SMALL|BR|A|CODE)$/.test(n.tagName)&&!n.querySelector("svg,img,input,button")));
const pick=t=>{for(let e=t;e&&e!==document.body;e=e.parentElement){if(e.closest("svg")&&e.tagName!=="svg")continue;if(e.innerText&&e.innerText.trim()&&textOnly(e))return e;if(/^(BUTTON|A|INPUT|IMG|svg)$/.test(e.tagName))return e}return t.closest("div,section,header,footer,nav,aside,main,li")||t};
const clsOf=e=>(e.getAttribute("class")||"").split(/\\s+/).filter(c=>c&&!c.startsWith("__e")).join(" ");
const info=e=>{const cs=getComputedStyle(e);return{tag:e.tagName.toLowerCase(),cls:clsOf(e),text:(e.innerText||"").trim().slice(0,200),editable:textOnly(e)&&!!(e.innerText||"").trim(),color:hex(cs.color),bg:bgOf(e),size:parseFloat(cs.fontSize)||16}};
const desel=()=>{if(sel){sel.classList.remove("__es");sel.removeAttribute("contenteditable");sel=null}};
addEventListener("message",v=>{const d=v.data||{};if("edit" in d){on=d.edit;if(!on){desel();if(hov)hov.classList.remove("__eh")}}
if(d.editStyle&&sel){sel.style.setProperty(d.editStyle.prop,d.editStyle.value)}});
document.addEventListener("mouseover",e=>{if(!on)return;const t=pick(e.target);if(hov&&hov!==t)hov.classList.remove("__eh");hov=t;if(t!==sel)t.classList.add("__eh")},true);
document.addEventListener("click",e=>{if(!on)return;if(sel&&sel.contains(e.target)&&sel.isContentEditable)return;e.preventDefault();e.stopPropagation();
const t=pick(e.target);desel();sel=t;t.classList.remove("__eh");t.classList.add("__es");const i=info(t);orig=i.text;
if(i.editable){t.setAttribute("contenteditable","true");t.focus()}parent.postMessage({__edit:{sel:i}},"*")},true);
document.addEventListener("keydown",e=>{if(on&&sel&&e.key==="Enter"&&!e.shiftKey){e.preventDefault();sel.blur()}if(on&&e.key==="Escape"){if(sel&&sel.isContentEditable)sel.innerText=orig;desel();parent.postMessage({__edit:{sel:null}},"*")}},true);
document.addEventListener("focusout",e=>{if(!on||!sel||e.target!==sel)return;const now=(sel.innerText||"").trim();if(now!==orig){parent.postMessage({__edit:{text:{old:orig,now,tag:sel.tagName.toLowerCase(),cls:clsOf(sel)}}},"*");orig=now}},true);
document.addEventListener("submit",e=>{if(on)e.preventDefault()},true);})();<\/script>`;

  if (typeof previewDoc === "function") {
    const base = window.previewDoc;
    window.previewDoc = (v) => {
      const doc = base(v);
      if (!["html", "react"].includes(S.target)) return doc;
      return /<\/body>/i.test(doc) ? doc.replace(/<\/body>(?![\s\S]*<\/body>)/i, EDIT_JS + "</body>") : doc + EDIT_JS;
    };
  }

  let on = false, sel = null, edits = [];
  const frame = () => q("#sideFrame");
  const bar = () => {
    let b = q("#editBar");
    if (!b) {
      b = document.createElement("div"); b.id = "editBar"; b.className = "edit-bar"; b.hidden = true;
      q("#side").before(b);
    }
    return b;
  };
  function renderBar() {
    const b = bar();
    b.hidden = !on;
    if (!on) return;
    const n = edits.length;
    b.innerHTML = sel ? `
      <span class="eb-what">${escH(sel.tag)}${sel.text ? ` · “${escH(sel.text.slice(0, 32))}${sel.text.length > 32 ? "…" : ""}”` : ""}</span>
      ${sel.editable ? `<span class="eb-hint">type to change the text</span>` : ""}
      <label>Text <input type="color" id="ebColor" value="${sel.color || "#000000"}"></label>
      <label>Fill <input type="color" id="ebBg" value="${sel.bg || "#ffffff"}"></label>
      <span class="eb-size"><button type="button" id="ebSmaller" aria-label="Smaller text">A−</button><b>${Math.round(sel.size)}px</b><button type="button" id="ebBigger" aria-label="Bigger text">A+</button></span>
      <button type="button" class="btn primary eb-save" id="ebSave" ${n ? "" : "disabled"}>Save as a new version${n ? ` (${n})` : ""}</button>`
      : `<span class="eb-hint">Click any text, button or box in the rebuilt page to edit it.</span>
      <button type="button" class="btn primary eb-save" id="ebSave" ${n ? "" : "disabled"}>Save as a new version${n ? ` (${n})` : ""}</button>`;
    const style = (prop, value) => { frame().contentWindow.postMessage({ editStyle: { prop, value } }, "*"); edits.push({ kind: "style", target: sel, prop, value }); };
    if (sel) {
      q("#ebColor").oninput = (e) => style("color", e.target.value);
      q("#ebBg").oninput = (e) => style("background-color", e.target.value);
      q("#ebSmaller").onclick = () => { sel.size = Math.max(8, sel.size - 2); style("font-size", `${sel.size}px`); renderBar(); };
      q("#ebBigger").onclick = () => { sel.size += 2; style("font-size", `${sel.size}px`); renderBar(); };
    }
    q("#ebSave").onclick = save;
  }
  function setEdit(v) {
    on = v; sel = null;
    q("#editBtn")?.classList.toggle("on", on);
    if (on) { if (window.fx?.setXray) window.fx.setXray(false); if (S.view !== "side") setView("side"); }
    frame()?.contentWindow?.postMessage({ edit: on }, "*");
    q("#side")?.classList.toggle("editing", on);
    renderBar();
  }
  addEventListener("message", (e) => {
    if (e.source !== frame()?.contentWindow || !e.data?.__edit) return;
    const d = e.data.__edit;
    if ("sel" in d) { sel = d.sel; renderBar(); }
    if (d.text) { edits.push({ kind: "text", ...d.text }); if (sel) sel.text = d.text.now; renderBar(); }
  });
  frame()?.addEventListener("load", () => { if (on) setTimeout(() => frame().contentWindow.postMessage({ edit: true }, "*"), 60); });

  // ---- write the edits into the code ----
  const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const words = (t) => t.trim().split(/\s+/).map(reEsc).join("(?:\\s|&nbsp;|<br\\s*/?>)+");
  // where this visible text is in the code: the whole text between two tags, preferring the element it came from
  // (same tag, same classes) over other copies such as the <title>
  function textAt(code, text, tag = "", cls = "") {
    if (!text) return null;
    const re = new RegExp(`(>\\s*)(${words(text)})(?=\\s*<)`, "g");
    let best = null, m;
    while ((m = re.exec(code))) {
      const start = m.index + m[1].length, open = code.lastIndexOf("<", m.index), head = code.slice(open, m.index + 1);
      const name = (head.match(/^<([\w.-]+)/) || [])[1] || "";
      const score = (name.toLowerCase() === tag ? 2 : 0) + (cls && head.includes(cls) ? 3 : 0) + (/^<(title|meta|option)\b/i.test(head) ? -5 : 0);
      if (!best || score > best.score) best = { start, end: start + m[2].length, score };
    }
    return best;
  }
  function tagOf(code, t) {  // the opening tag of the edited element: by its class (if unique), else just before its text
    if (t.cls) {
      for (const attr of [`class="${t.cls}"`, `className="${t.cls}"`]) {
        const i = code.indexOf(attr);
        if (i >= 0 && code.indexOf(attr, i + 1) < 0) { const s = code.lastIndexOf("<", i); return { s, e: code.indexOf(">", i) }; }
      }
    }
    const at = textAt(code, t.text, t.tag, t.cls);
    if (!at) return null;
    const s = code.lastIndexOf(`<${t.tag}`, at.start);
    return s >= 0 ? { s, e: code.indexOf(">", s) } : null;
  }
  function styleTag(tag, decl, react) {
    if (react) {
      const m = tag.match(/\sstyle=\{\{([\s\S]*?)\}\}/);
      const kv = decl.map(([p, v]) => `${p.replace(/-([a-z])/g, (_, c) => c.toUpperCase())}: "${v}"`).join(", ");
      return m ? tag.replace(m[0], ` style={{${m[1].trim().replace(/,?\s*$/, "")}, ${kv}}}`) : tag.replace(/^<([\w.-]+)/, `<$1 style={{${kv}}}`);
    }
    const css = decl.map(([p, v]) => `${p}:${v}`).join(";");
    const m = tag.match(/\sstyle="([^"]*)"/);
    return m ? tag.replace(m[0], ` style="${m[1].replace(/;?\s*$/, ";")}${css}"`) : tag.replace(/^<([\w-]+)/, `<$1 style="${css}"`);
  }
  function apply(code) {
    let out = code, done = 0, missed = 0;
    const react = S.target === "react", styles = new Map();
    for (const e of edits) if (e.kind === "style") { const k = JSON.stringify([e.target.tag, e.target.cls, e.target.text]); if (!styles.has(k)) styles.set(k, { t: e.target, d: new Map() }); styles.get(k).d.set(e.prop, e.value); }
    for (const { t, d } of styles.values()) {
      const at = tagOf(out, t);
      if (!at || at.e < 0) { missed++; continue; }
      out = out.slice(0, at.s) + styleTag(out.slice(at.s, at.e), [...d.entries()], react) + out.slice(at.e); done++;
    }
    for (const e of edits) if (e.kind === "text") {
      const at = textAt(out, e.old, e.tag, e.cls);
      if (!at) { missed++; continue; }
      out = out.slice(0, at.start) + escH(e.now).replace(/&#39;/g, "'") + out.slice(at.end); done++;
    }
    return { out, done, missed };
  }
  function save() {
    const v = current(); if (!v || !edits.length) return;
    const { out, done, missed } = apply(v.code);
    if (!done) { toast("Could not find these elements in the code; try the Change box instead."); return; }
    S.versions[S.target].push({ ...v, code: out, label: `Edited by hand (${done})`, change: "edited in the preview", cached: false, notes: v.notes });
    S.cur[S.target] = S.versions[S.target].length - 1;
    edits = []; sel = null;
    renderVersions(); renderNotes(); renderCode(); renderBar();
    toast(missed ? `Saved ${done} edits; ${missed} could not be matched in the code` : `Saved as a new version (${done} edits)`);
  }

  const vs = q("#viewSeg");
  if (vs) {
    q("#xrayBtn")?.insertAdjacentHTML("afterend", `<button id="editBtn" class="xray-btn edit-btn" type="button" title="Click any text, button or box in the rebuilt page to change it">Edit</button>`);
    q("#editBtn").onclick = () => setEdit(!on);
    vs.addEventListener("click", (e) => { if (e.target.dataset?.v && e.target.dataset.v !== "side" && on) setEdit(false); });
    q("#targetSeg")?.addEventListener("click", () => on && setEdit(false));
  }
  window.editMode = { set: setEdit, get on() { return on; }, apply: (code, list) => { const keep = edits; edits = list; try { return apply(code); } finally { edits = keep; } } };
})();
