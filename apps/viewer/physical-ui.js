(() => {
  const root = document.documentElement;
  const themeToggle = document.querySelector("#themeToggle");
  const themeText = themeToggle?.querySelector("span");

  function setTheme(theme) {
    root.dataset.theme = theme;
    try { localStorage.setItem("vre-theme", theme); } catch { /* theme remains usable for this visit */ }
    const next = theme === "dark" ? "light" : "dark";
    const label = next === "light" ? "Light mode" : "Dark mode";
    themeToggle?.setAttribute("aria-label", `Switch to ${label.toLowerCase()}`);
    themeToggle?.setAttribute("title", `Switch to ${label.toLowerCase()}`);
    themeToggle?.setAttribute("aria-pressed", String(theme === "dark"));
    if (themeText) themeText.textContent = label;
  }

  setTheme(root.dataset.theme === "light" ? "light" : "dark");
  themeToggle?.addEventListener("click", () => setTheme(root.dataset.theme === "light" ? "dark" : "light"));

  document.querySelectorAll(".labswitch a").forEach((link) => {
    link.addEventListener("click", (event) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.defaultPrevented || reducedMotionPreference()) return;
      const target = new URL(link.href, location.href);
      if (target.origin !== location.origin || target.pathname === location.pathname) return;
      event.preventDefault();
      const mask = document.createElement("div");
      mask.className = "physical-route-transition";
      mask.setAttribute("aria-hidden", "true");
      document.body.append(mask);
      requestAnimationFrame(() => mask.classList.add("is-active"));
      setTimeout(() => location.assign(target.href), 560);
    });
  });

  const visual = document.querySelector(".physical-visual");
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const finePointer = matchMedia("(pointer: fine)");
  if (visual && finePointer.matches && !reducedMotion.matches) {
    visual.addEventListener("pointermove", (event) => {
      const bounds = visual.getBoundingClientRect();
      const x = (event.clientX - bounds.left) / bounds.width - 0.5;
      const y = (event.clientY - bounds.top) / bounds.height - 0.5;
      visual.style.setProperty("--pointer-tilt-x", `${(-y * 8).toFixed(2)}deg`);
      visual.style.setProperty("--pointer-tilt-y", `${(x * 10).toFixed(2)}deg`);
    });
    visual.addEventListener("pointerleave", () => {
      visual.style.setProperty("--pointer-tilt-x", "0deg");
      visual.style.setProperty("--pointer-tilt-y", "0deg");
    });
  }

  const empty = document.querySelector("#empty");
  const upload = document.querySelector("#file");
  if (!empty || !upload) return;

  const sampleSelect = document.querySelector("#samples");
  const sampleShelf = document.querySelector("#physicalSamples");
  const sampleGrid = document.querySelector("#physicalSampleGrid");
  const sampleCount = document.querySelector("#physicalSampleCount");
  const sampleTypes = {
    "game-boy": "PORTABLE CONSOLE",
    "iphone-17": "SMARTPHONE",
    "lenovo-mouse": "INPUT DEVICE"
  };
  const samplePreviews = new Map();
  const apiBase = new URLSearchParams(location.search).get("api") || "";

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = src;
    });
  }

  function sourceView(analysis) {
    const scene = analysis?.scene;
    if (!scene) return null;
    return scene.views?.[0] || {
      imageWidth: scene.imageWidth, imageHeight: scene.imageHeight,
      plate: scene.plate, plateBbox: scene.plateBbox, layers: scene.layers || []
    };
  }

  function drawAtBbox(context, image, bbox, width, height) {
    if (!image || !bbox) return;
    context.drawImage(image, bbox.x * width, bbox.y * height, bbox.width * width, bbox.height * height);
  }

  async function loadSamplePreview(id) {
    if (!samplePreviews.has(id)) {
      samplePreviews.set(id, (async () => {
        const response = await fetch(`${apiBase}/api/physical/samples/${encodeURIComponent(id)}`);
        if (!response.ok) throw new Error("Could not load saved photo analysis");
        const analysis = await response.json();
        const view = sourceView(analysis);
        if (!view?.plate || !view.imageWidth || !view.imageHeight) throw new Error("Saved analysis has no source photo");
        const scale = Math.min(1, 420 / view.imageWidth, 510 / view.imageHeight);
        const width = Math.max(1, Math.round(view.imageWidth * scale));
        const height = Math.max(1, Math.round(view.imageHeight * scale));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        const plate = await loadImage(view.plate);
        drawAtBbox(context, plate, view.plateBbox || { x: 0, y: 0, width: 1, height: 1 }, width, height);
        const layers = await Promise.all((view.layers || []).map(async (layer) => ({ ...layer, image: await loadImage(layer.cutout) })));
        layers.sort((a, b) => (a.depthRank || 0) - (b.depthRank || 0));
        layers.forEach((layer) => drawAtBbox(context, layer.image, layer.bbox, width, height));
        const components = analysis.components || [];
        const observed = components.filter((part) => part.status === "observed");
        const inferred = components.filter((part) => part.status === "inferred");
        return {
          id, title: analysis.title || id, width, height,
          src: canvas.toDataURL("image/webp", 0.84), components, observed, inferred,
          view, layers
        };
      })());
    }
    return samplePreviews.get(id);
  }

  const sampleReveal = !reducedMotion.matches && "IntersectionObserver" in window
    ? new IntersectionObserver((entries, observer) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add("is-visible");
          entry.target.loadPhotoPreview?.();
          observer.unobserve(entry.target);
        });
      }, { rootMargin: "0px 0px -8% 0px", threshold: 0.12 })
    : null;

  function addSampleDetectionBoxes(card, preview) {
    const frame = card.querySelector(".sample-photo-frame");
    const image = card.querySelector(".sample-photo");
    const boxes = card.querySelector(".sample-photo-overlays");
    image.src = preview.src;
    image.alt = `${preview.title} source photo with detected visible components`;
    frame.style.setProperty("--photo-aspect", `${preview.width} / ${preview.height}`);
    const visibleParts = preview.observed.filter((part) => part.bbox).sort((a, b) => (b.bbox.width * b.bbox.height) - (a.bbox.width * a.bbox.height));
    visibleParts.slice(0, 7).forEach((part) => {
      const box = document.createElement("i");
      box.className = "sample-detection-box";
      box.style.left = `${part.bbox.x * 100}%`;
      box.style.top = `${part.bbox.y * 100}%`;
      box.style.width = `${part.bbox.width * 100}%`;
      box.style.height = `${part.bbox.height * 100}%`;
      box.setAttribute("aria-hidden", "true");
      boxes.append(box);
    });
    card.querySelector(".sample-card-status").innerHTML = `<i></i> ${preview.layers.length} MASKS`;
    card.querySelector(".sample-card-analysis").textContent = `${preview.observed.length} seen in photo  ·  ${preview.inferred.length} inferred inside`;
    card.dataset.previewReady = "true";
    card.style.setProperty("--photo-aspect", `${preview.width} / ${preview.height}`);
  }

  function createSampleCard(option, index) {
    const id = option.value;
    const title = option.textContent.trim();
    const card = document.createElement("button");
    card.type = "button";
    card.className = "physical-sample-card";
    card.dataset.sampleId = id;
    card.style.setProperty("--sample-index", String(index));
    card.setAttribute("aria-label", `Open the ${title} photo analysis and teardown`);
    card.innerHTML = `<span class="sample-card-top"><span class="sample-card-index">PHOTO STUDY / ${String(index + 1).padStart(2, "0")}</span><span class="sample-card-status"><i></i> LOADING</span></span><span class="sample-card-art"><span class="sample-photo-frame"><img class="sample-photo" alt="" /><span class="sample-photo-overlays"></span></span><span class="sample-photo-caption">SOURCE PHOTO / SEGMENT MAP</span><span class="sample-photo-scan"></span></span><span class="sample-card-title-row"><span class="sample-card-title"></span><span class="sample-card-category"></span></span><span class="sample-card-analysis">Loading saved image evidence…</span><span class="sample-card-bottom"><span>OPEN PHOTO TEARDOWN</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h15m-6-6 6 6-6 6"/></svg></span>`;
    card.querySelector(".sample-card-title").textContent = title;
    card.querySelector(".sample-card-category").textContent = sampleTypes[id] || "OBJECT STUDY";
    const requestPreview = () => {
      if (card.dataset.previewRequested) return;
      card.dataset.previewRequested = "true";
      loadSamplePreview(id).then((preview) => addSampleDetectionBoxes(card, preview)).catch(() => {
        card.querySelector(".sample-card-status").innerHTML = "<i></i> STUDY";
        card.querySelector(".sample-card-analysis").textContent = "Open the saved analysis to inspect its source and parts.";
        card.classList.add("no-photo-preview");
      });
    };
    if (sampleReveal) {
      card.dataset.observed = "true";
      card.loadPhotoPreview = requestPreview;
      sampleReveal.observe(card);
    } else {
      card.classList.add("is-visible");
      requestPreview();
    }

    if (finePointer.matches && !reducedMotion.matches) {
      card.addEventListener("pointermove", (event) => {
        const bounds = card.getBoundingClientRect();
        const x = (event.clientX - bounds.left) / bounds.width;
        const y = (event.clientY - bounds.top) / bounds.height;
        card.style.setProperty("--tilt-x", `${(-(y - 0.5) * 7).toFixed(2)}deg`);
        card.style.setProperty("--tilt-y", `${((x - 0.5) * 9).toFixed(2)}deg`);
        card.style.setProperty("--pointer-x", `${(x * 100).toFixed(1)}%`);
        card.style.setProperty("--pointer-y", `${(y * 100).toFixed(1)}%`);
      });
      card.addEventListener("pointerleave", () => {
        card.style.setProperty("--tilt-x", "0deg");
        card.style.setProperty("--tilt-y", "0deg");
        card.style.setProperty("--pointer-x", "50%");
        card.style.setProperty("--pointer-y", "45%");
      });
    }
    return card;
  }

  if (sampleSelect && sampleShelf && sampleGrid) {
    const renderSampleCards = () => {
      const options = [...sampleSelect.options].filter((option) => option.value);
      sampleGrid.replaceChildren(...options.map(createSampleCard));
      sampleShelf.hidden = options.length === 0;
      if (sampleCount) sampleCount.textContent = `${String(options.length).padStart(2, "0")} ${options.length === 1 ? "STUDY" : "STUDIES"}`;
    };
    sampleGrid.addEventListener("click", (event) => {
      const card = event.target.closest(".physical-sample-card");
      if (!card || !sampleGrid.contains(card)) return;
      sampleSelect.value = card.dataset.sampleId;
      sampleSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    new MutationObserver(renderSampleCards).observe(sampleSelect, { childList: true });
    renderSampleCards();
  }

  const story = document.querySelector("#physicalScrollStory");
  const chapters = story ? [...story.querySelectorAll(".physical-chapter")] : [];
  const stageLabel = document.querySelector("#physicalStageLabel");
  const storyProgress = document.querySelector("#physicalStoryProgress");
  const stageNames = ["01 / SOURCE PHOTO", "02 / IMAGE SEGMENTS", "03 / DEPTH ASSEMBLY", "04 / INSPECT + TRACE"];
  let activeStage = 0;
  let scrollFrame = 0;
  if (story && visual && chapters.length) {
    const activateChapter = (index) => {
      activeStage = index;
      visual.dataset.stage = String(index);
      if (stageLabel) stageLabel.textContent = stageNames[index];
      chapters.forEach((chapter, chapterIndex) => {
        chapter.classList.toggle("is-active", chapterIndex === index);
        if (chapterIndex === index) chapter.setAttribute("aria-current", "step");
        else chapter.removeAttribute("aria-current");
      });
    };
    const updateStoryProgress = () => {
      scrollFrame = 0;
      const firstBounds = chapters[0].getBoundingClientRect();
      const lastBounds = chapters[chapters.length - 1].getBoundingClientRect();
      const center = window.innerHeight * 0.56;
      const sequenceLength = Math.max(1, lastBounds.bottom - firstBounds.top);
      const progress = Math.max(0, Math.min(1, (center - firstBounds.top) / sequenceLength));
      visual.dataset.storyMode = firstBounds.top < window.innerHeight * 0.84 && lastBounds.bottom > window.innerHeight * 0.16 ? "active" : "idle";
      storyProgress?.style.setProperty("width", `${(progress * 100).toFixed(2)}%`);
      visual.style.setProperty("--scroll-depth", progress.toFixed(3));
      const centerShift = window.matchMedia("(min-width: 1121px)").matches ? -24 * progress : 0;
      const stageZoom = window.matchMedia("(min-width: 1121px)").matches ? .12 : .06;
      const modelBlur = reducedMotion.matches ? 0 : progress * 1.8;
      visual.style.setProperty("--model-scroll-x", `${centerShift.toFixed(2)}vw`);
      visual.style.setProperty("--model-scroll-y", `${(-2.5 * progress).toFixed(2)}vh`);
      visual.style.setProperty("--model-scroll-scale", (1 + stageZoom * progress).toFixed(3));
      visual.style.setProperty("--model-scroll-opacity", (1 - .32 * progress).toFixed(3));
      visual.style.setProperty("--model-scroll-filter", `blur(${modelBlur.toFixed(2)}px) saturate(${(1 - .16 * progress).toFixed(3)}) brightness(${(1 - .1 * progress).toFixed(3)})`);
      visual.style.setProperty("--scan-y", `${(8 + (reducedMotion.matches ? 0 : progress * 84)).toFixed(1)}%`);
      visual.style.setProperty("--explode-progress", reducedMotion.matches ? "0" : progress.toFixed(3));
      visual.dataset.storyProgress = progress.toFixed(3);
      let nearestStage = 0;
      let nearestDistance = Infinity;
      chapters.forEach((chapter, index) => {
        const rect = chapter.getBoundingClientRect();
        const distance = Math.abs(rect.top + rect.height * 0.5 - center);
        if (distance < nearestDistance) { nearestDistance = distance; nearestStage = index; }
      });
      if (nearestStage !== activeStage) activateChapter(nearestStage);
    };
    const queueStoryProgress = () => {
      if (scrollFrame) return;
      scrollFrame = requestAnimationFrame(updateStoryProgress);
    };
    addEventListener("scroll", queueStoryProgress, { passive: true });
    addEventListener("resize", queueStoryProgress, { passive: true });
    activateChapter(activeStage);
    updateStoryProgress();
  }

  empty.addEventListener("dragenter", (event) => {
    if (empty.hidden || ![...(event.dataTransfer?.items || [])].some((item) => item.kind === "file")) return;
    event.preventDefault();
    empty.dataset.dragging = "true";
  });
  empty.addEventListener("dragover", (event) => {
    if (empty.hidden) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    empty.dataset.dragging = "true";
  });
  empty.addEventListener("dragleave", (event) => {
    if (event.relatedTarget instanceof Node && empty.contains(event.relatedTarget)) return;
    delete empty.dataset.dragging;
  });
  empty.addEventListener("drop", (event) => {
    if (empty.hidden) return;
    event.preventDefault();
    delete empty.dataset.dragging;
    const files = [...(event.dataTransfer?.files || [])].filter((file) => ["image/jpeg", "image/png", "image/webp"].includes(file.type));
    if (!files.length) return;
    try {
      const transfer = new DataTransfer();
      files.slice(0, 4).forEach((file) => transfer.items.add(file));
      upload.files = transfer.files;
      upload.dispatchEvent(new Event("change", { bubbles: true }));
    } catch { /* The photo picker remains available if the browser blocks assigning dropped files. */ }
  });
  document.addEventListener("paste", (event) => {
    if (empty.hidden) return;
    const files = [...(event.clipboardData?.items || [])]
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file) => file && ["image/jpeg", "image/png", "image/webp"].includes(file.type))
      .slice(0, 4);
    if (!files.length) return;
    event.preventDefault();
    try {
      const transfer = new DataTransfer();
      files.forEach((file) => transfer.items.add(file));
      upload.files = transfer.files;
      upload.dispatchEvent(new Event("change", { bubbles: true }));
    } catch { /* Keep the drop zone and photo picker usable if clipboard files are restricted. */ }
  });
})();

function reducedMotionPreference() {
  return matchMedia("(prefers-reduced-motion: reduce)").matches;
}
