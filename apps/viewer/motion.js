// Motion that answers what the person did: a tab's underline slides to it, the new view fades in, a new version
// flashes once, a result arrives in one short sequence. Pure DOM observers, so the lab code stays unchanged.
(() => {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const replay = (el, cls) => { if (reduce || !el) return; el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); };

  // elements that appear when their [hidden] goes away: fade in
  const ENTER = ".tab, #wipe, #side, #devices, #codeView, .pview, #screenBar, #detail, #product";
  new MutationObserver((list) => {
    for (const m of list) {
      const el = m.target;
      if (m.attributeName === "hidden" && !el.hidden && el.matches?.(ENTER)) replay(el, "m-enter");
      if (m.attributeName === "hidden" && !el.hidden && el.id === "toast") replay(el, "m-pop");
      if (m.attributeName === "hidden" && !el.hidden && el.id === "work") replay(el, "m-reveal");
      if (m.attributeName === "class" && el.classList?.contains("pview") && el.classList.contains("on") && !m.oldValue?.includes("on")) replay(el, "m-enter");
    }
  }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["hidden", "class"], attributeOldValue: true });

  // Digital tabs: a single underline that slides to the selected tab
  const tabs = $(".tabs[role=tablist]");
  if (tabs) {
    const ink = document.createElement("span"); ink.className = "tab-ink"; tabs.append(ink);
    const place = () => {
      const b = $('button[aria-selected="true"]', tabs); if (!b) return;
      ink.style.width = `${b.offsetWidth}px`; ink.style.transform = `translateX(${b.offsetLeft}px)`;
    };
    new MutationObserver(place).observe(tabs, { subtree: true, attributes: true, attributeFilter: ["aria-selected"] });
    addEventListener("resize", place); document.fonts?.ready.then(place); setTimeout(place, 300);
    const work = $("#work"); if (work) new MutationObserver(() => !work.hidden && requestAnimationFrame(place)).observe(work, { attributes: true, attributeFilter: ["hidden"] });
  }

  // a version just added flashes once
  const versions = $("#versions");
  if (versions) {
    let n = versions.children.length;
    new MutationObserver(() => {
      const k = versions.querySelectorAll("li button").length;
      if (k > n && n > 0) replay(versions.querySelector("li:last-child button"), "m-new");
      n = k;
    }).observe(versions, { childList: true });
  }

  // the match ring settles with a small pulse when a score arrives
  const pct = $("#accPct");
  if (pct) new MutationObserver(() => { if (/^\d+%$/.test(pct.textContent) && !pct.dataset.pulsed) { pct.dataset.pulsed = 1; replay($("#acc"), "m-pulse"); setTimeout(() => delete pct.dataset.pulsed, 1500); } })
    .observe(pct, { childList: true, characterData: true, subtree: true });
})();
