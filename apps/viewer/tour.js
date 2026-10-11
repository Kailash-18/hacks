// Full-site guided tour: open /?tour. Title card -> Physical Lab (7 steps) -> transition -> Digital Lab (8 steps,
// played by build-fx.js) -> closing card. Every step uses saved sample results, so it needs no live AI call.
// It drives the real controls (samples menu, explode slider, spin, X-ray, parts list, what-if), like a user would.
(() => {
  if (!new URLSearchParams(location.search).has("tour")) return;
  const TOTAL = 15, PHYS = 7;
  const q = (s) => document.querySelector(s);
  const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
  const waitFor = async (ok, ms = 60000) => { const t = Date.now(); while (!ok() && Date.now() - t < ms) await sleep(150); return ok(); };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const words = (t) => esc(t).split(" ").map((w, i) => `<span class="w" style="--i:${i}">${w}</span>`).join(" ");

  function cap(n, text, lab = n <= PHYS ? "PHYSICAL" : "DIGITAL") {
    let c = q("#tourCap");
    if (!c) { c = document.createElement("div"); c.id = "tourCap"; c.className = "tour-cap"; document.body.appendChild(c); }
    c.innerHTML = n ? `<span class="lab">${lab}</span><span class="n">${n} / ${TOTAL}</span>${esc(text)}` : esc(text);
    c.classList.remove("in"); void c.offsetWidth; c.classList.add("in");
    let b = q("#tourBar");
    if (!b) { b = document.createElement("div"); b.id = "tourBar"; b.className = "tour-bar"; document.body.appendChild(b); }
    b.style.width = `${(Math.max(0, n) / TOTAL) * 100}%`;
  }
  function hideCap() { q("#tourCap")?.classList.remove("in"); }

  async function card(html, ms) {
    const el = document.createElement("div");
    el.className = "tour-card";
    el.innerHTML = `<div class="beam"></div><div class="tour-inner">${html}</div>`;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add("in"));
    if (ms === Infinity) return el;
    await sleep(ms);
    el.classList.remove("in");
    await sleep(700);
    el.remove();
  }
  const INTRO = `<div class="tour-kicker">Banana Hacks 2026 · Image AI</div>
    <h1 class="tour-title">${words("Visual Reverse Engineering")}</h1>
    <p class="tour-sub">From visual evidence to explorable systems.</p>
    <div class="tour-pair">
      <div class="tour-lab"><b>PHYSICAL LAB</b><h3>Photo of an object</h3><p>Every part found, a 3D model you can pull apart, and what fails if a part breaks.</p></div>
      <div class="tour-mid"><span>one<br>engine</span></div>
      <div class="tour-lab"><b>DIGITAL LAB</b><h3>Screenshot of an app</h3><p>Working code, an X-ray of how it is built, mobile versions and a plan to build it.</p></div>
    </div>`;
  const BRIDGE = `<div class="tour-kicker">Same engine</div><h1 class="tour-title">${words("Now for software.")}</h1>
    <p class="tour-sub">A screenshot is a system too: parts, layout, relationships, behaviour.</p>`;
  const OUTRO = `<div class="tour-kicker">One engine · two worlds</div>
    <h1 class="tour-title">${words("Screenshot or photo in. System out.")}</h1>
    <p class="tour-sub">Components · relationships · behaviours · dependencies, for objects and for screens.</p>
    <div class="tour-pair">
      <div class="tour-lab"><b>PHYSICAL LAB</b><h3>Parts, 3D, what-if</h3><p>Exploded model, X-ray wiring, failure cascade, system graph, grounded chat.</p></div>
      <div class="tour-mid"><span>SystemAnalysis</span></div>
      <div class="tour-lab"><b>DIGITAL LAB</b><h3>Code, X-ray, plan</h3><p>HTML, React, React Native, Flutter; build plan, backend, accessibility audit.</p></div>
    </div>
    <div class="tour-team">Visual Reverse Engineering · built during Banana Hacks 2026</div>`;

  // smooth slider motion that the viewer sees as real input
  function slide(input, from, to, ms) {
    return new Promise((ok) => {
      const t1 = performance.now();
      const st = (now) => {
        const t = Math.min(1, (now - t1) / ms), e = t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        input.value = String(from + (to - from) * e);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        t < 1 ? requestAnimationFrame(st) : ok();
      };
      requestAnimationFrame(st);
    });
  }
  function setCheck(sel, on) { const c = q(sel); if (c && c.checked !== on) { c.checked = on; c.dispatchEvent(new Event("change", { bubbles: true })); } }

  async function physical() {
    await waitFor(() => window.__vre && q("#samples")?.options.length > 1, 20000);
    await card(INTRO, 6200);
    cap(1, "Photograph any object. The AI finds every part, seen and hidden");
    const sel = q("#samples"), id = [...sel.options].find((o) => /game-boy/.test(o.value))?.value || sel.options[1].value;
    sel.value = id; sel.dispatchEvent(new Event("change"));
    await waitFor(() => window.__vre.state.parts > 0 && q("#loading").hidden, 40000);
    await sleep(4200);
    cap(2, "…and builds a 3D model you can turn and explore");
    setCheck("#spin", true);
    await sleep(4500);
    cap(3, "Explode it to see how everything fits together");
    setCheck("#spin", false);
    const ex = q("#explode"), v0 = parseFloat(ex.value) || 0.6;
    await slide(ex, v0, 0, 1300); await sleep(300); await slide(ex, 0, 1, 2200); await sleep(500); await slide(ex, 1, 0.65, 1200);
    await sleep(600);
    cap(4, "X-ray the wiring: how power and signals flow between parts");
    setCheck("#xray", true);
    await sleep(4200);
    setCheck("#xray", false);
    cap(5, "Click any part to see what it does and what it connects to");
    const li = [...document.querySelectorAll("#parts li")];
    const board = li.find((l) => /circuit|pcb|board|logic/i.test(l.textContent)) || li[Math.min(2, li.length - 1)];
    board?.click();
    await sleep(800);
    q("#detail")?.scrollIntoView({ behavior: "smooth", block: "center" });
    await sleep(3600);
    cap(6, "What if it fails? The failure cascade shows everything that stops working");
    q("#whatif")?.click();
    await sleep(6200);
    if (q("#whatif")?.textContent.match(/put it back/i)) q("#whatif").click();
    await sleep(800);
    cap(7, "And the system graph: every part and every dependency");
    q("#graph")?.scrollIntoView({ behavior: "smooth", block: "center" });
    await sleep(4800);
    hideCap();
    await card(BRIDGE, Infinity);
    await sleep(2600);
    location.href = "/digital?tour";
  }

  // the Digital Lab part is played by build-fx.js (demo mode); it calls these to keep one look and one numbering
  window.tour = {
    total: TOTAL, offset: PHYS,
    cap: (n, text) => cap(PHYS + n, text),
    async bridgeOut() { const el = await card(BRIDGE, Infinity); el.style.transition = "none"; el.classList.add("in"); await sleep(900); el.style.transition = ""; el.classList.remove("in"); await sleep(700); el.remove(); },
    async outro() { hideCap(); q("#tourBar")?.remove(); await card(OUTRO, Infinity); },
  };
  if (location.pathname === "/" || location.pathname === "/index.html") {
    const run = () => physical().catch((e) => cap(0, `Tour stopped: ${e.message}`));
    document.readyState === "complete" ? setTimeout(run, 300) : addEventListener("load", () => setTimeout(run, 300));
  }
})();
