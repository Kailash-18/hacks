// "Scroll for samples" pill on both landings: tells people the samples are further down,
// jumps there on click, and fades out once they have scrolled.
for (const cue of document.querySelectorAll(".sample-cue")) {
  const target = document.querySelector(cue.dataset.target);
  const scroller = cue.dataset.scroller ? document.querySelector(cue.dataset.scroller) : null;
  const pos = () => (scroller ? scroller.scrollTop : window.scrollY);
  const update = () => cue.classList.toggle("gone", pos() > 80);
  (scroller || window).addEventListener("scroll", update, { passive: true });
  update();
  cue.addEventListener("click", () => {
    const smooth = !matchMedia("(prefers-reduced-motion: reduce)").matches;
    target?.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "start" });
  });
}
