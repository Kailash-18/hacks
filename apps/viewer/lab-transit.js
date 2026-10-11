// Lab switch transition (Physical <-> Digital), styles in nav.css.
// Leaving: the switch thumb slides, seven slabs close over the page, the destination lab's name lands, then we navigate.
// Arriving: the page starts covered (inline head script adds html.lab-arriving), then the slabs fly apart toward you.
(() => {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const N = 7;
  const LABS = { physical: ["Physical", "Objects, taken apart"], digital: ["Digital", "Screens, taken apart"] };

  function overlay(to, state) {
    const o = document.createElement("div");
    o.className = `lab-transit lt-${to} ${state}`; o.setAttribute("aria-hidden", "true");
    for (let i = 0; i < N; i++) {
      const s = document.createElement("i"), c = i - (N - 1) / 2;
      s.style.setProperty("--i", i); s.style.setProperty("--c", c);
      s.style.setProperty("--y0", (i % 2 ? 104 : -104) + "%"); s.style.setProperty("--rx0", (i % 2 ? -1 : 1) * 24 + "deg");
      s.style.setProperty("--d1", (to === "digital" ? i : N - 1 - i) * 0.045 + "s");   // closes in the direction you are going
      s.style.setProperty("--d2", Math.abs(c) * 0.05 + "s");                          // opens from the middle out
      o.append(s);
    }
    const t = document.createElement("div"); t.className = "lt-title";
    const b = document.createElement("b"), sp = document.createElement("span");
    b.textContent = LABS[to][0]; sp.textContent = LABS[to][1]; t.append(b, sp); o.append(t);
    document.body.append(o);
    return o;
  }

  document.addEventListener("click", (e) => {
    const a = e.target.closest(".lab-switch a[data-lab]");
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const sw = a.closest(".lab-switch"), to = a.dataset.lab;
    if (sw.dataset.on === to) { if (location.pathname === new URL(a.href).pathname) e.preventDefault(); return; }
    if (reduce) return;
    e.preventDefault();
    sw.dataset.on = to;
    try { sessionStorage.setItem("lab-transit", to); } catch { /* private mode: arrive without the cover */ }
    const o = overlay(to, "");
    void o.offsetWidth; o.classList.add("closing");
    setTimeout(() => { location.href = a.href; }, 900);
  });

  const arriving = document.documentElement.className.match(/\blt-(physical|digital)\b/)?.[1];
  if (arriving) {
    try { sessionStorage.removeItem("lab-transit"); } catch { /* ignore */ }
    const start = () => {
      const o = overlay(arriving, "closed");
      document.documentElement.classList.remove("lab-arriving", "lt-" + arriving);
      setTimeout(() => { o.classList.remove("closed"); o.classList.add("opening"); }, 140);
      setTimeout(() => o.remove(), 1500);
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
  }
  // a page restored from the back/forward cache must not keep a closed cover
  addEventListener("pageshow", (e) => { if (e.persisted) document.querySelectorAll(".lab-transit").forEach((o) => o.remove()); });
})();
