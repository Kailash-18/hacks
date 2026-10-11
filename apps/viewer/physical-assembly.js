import * as THREE from "three";

const canvas = document.querySelector("#physicalAssemblyCanvas");
const stage = canvas?.parentElement;
const visual = canvas?.closest(".physical-visual");
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
const widePhysicalStage = matchMedia("(min-width: 1121px)");
const apiBase = new URLSearchParams(location.search).get("api") || "";

const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));
const smooth = (from, to, value) => {
  const t = clamp((value - from) / (to - from));
  return t * t * (3 - 2 * t);
};

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });
}

function viewOf(analysis) {
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

async function buildPhoto(analysis) {
  const view = viewOf(analysis);
  if (!view?.plate || !view.imageWidth || !view.imageHeight) throw new Error("This saved study has no image layers");
  const scale = Math.min(1, 680 / view.imageWidth, 780 / view.imageHeight);
  const width = Math.max(1, Math.round(view.imageWidth * scale));
  const height = Math.max(1, Math.round(view.imageHeight * scale));
  const composite = document.createElement("canvas");
  composite.width = width;
  composite.height = height;
  const context = composite.getContext("2d");
  const plateImage = await loadImage(view.plate);
  drawAtBbox(context, plateImage, view.plateBbox || { x: 0, y: 0, width: 1, height: 1 }, width, height);
  const layers = await Promise.all((view.layers || []).map(async (layer) => ({ ...layer, image: await loadImage(layer.cutout) })));
  layers.sort((a, b) => (a.depthRank || 0) - (b.depthRank || 0));
  layers.forEach((layer) => drawAtBbox(context, layer.image, layer.bbox, width, height));
  const components = analysis.components || [];
  return {
    analysis, view, width, height, plateImage, layers, components,
    compositeUrl: composite.toDataURL("image/webp", 0.86),
    observed: components.filter((part) => part.status === "observed"),
    inferred: components.filter((part) => part.status === "inferred")
  };
}

function installPhotoFallback(photo) {
  const image = document.querySelector("#physicalSourceImage");
  const boxes = document.querySelector("#physicalSourceBoxes");
  const name = document.querySelector("#physicalPreviewName");
  const counts = document.querySelector("#physicalPreviewParts");
  const ratio = photo.width / photo.height;
  if (image) {
    image.src = photo.compositeUrl;
    image.alt = `${photo.analysis.title || "Saved object"} source photograph, reconstructed from the saved image layers`;
  }
  if (name) name.textContent = (photo.analysis.title || "OBJECT PHOTO").toUpperCase();
  if (counts) counts.textContent = `${String(photo.observed.length).padStart(2, "0")} OBSERVED  /  ${String(photo.inferred.length).padStart(2, "0")} INFERRED`;
  visual?.style.setProperty("--source-aspect", String(ratio));
  if (boxes) {
    boxes.replaceChildren();
    const entries = photo.observed.filter((part) => part.bbox).sort((a, b) => b.bbox.width * b.bbox.height - a.bbox.width * a.bbox.height).slice(0, 8);
    entries.forEach((part, index) => {
      const box = document.createElement("i");
      box.className = "source-detection-box";
      box.style.left = `${part.bbox.x * 100}%`;
      box.style.top = `${part.bbox.y * 100}%`;
      box.style.width = `${part.bbox.width * 100}%`;
      box.style.height = `${part.bbox.height * 100}%`;
      box.style.setProperty("--box-index", String(index));
      box.dataset.label = (part.label || "VISIBLE PART").toUpperCase().slice(0, 18);
      box.setAttribute("aria-hidden", "true");
      boxes.append(box);
    });
  }
  installRelationshipMap(photo.analysis);
}

function installRelationshipMap(analysis) {
  const map = document.querySelector("#physicalRelationshipMap");
  if (!map) return;
  const componentById = new Map((analysis.components || []).map((part) => [part.id, part]));
  const relationships = (analysis.relationships || []).filter((relation) => componentById.has(relation.from) && componentById.has(relation.to));
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 240 112");
  svg.setAttribute("preserveAspectRatio", "none");
  const selected = relationships.slice(0, 3);
  const ids = [...new Set(selected.flatMap((relation) => [relation.from, relation.to]))].slice(0, 4);
  const positions = [{ x: 24, y: 56 }, { x: 91, y: 56 }, { x: 160, y: 27 }, { x: 160, y: 85 }];
  const positionById = new Map(ids.map((id, index) => [id, positions[index]]));
  selected.forEach((relation) => {
    const from = positionById.get(relation.from);
    const to = positionById.get(relation.to);
    if (!from || !to) return;
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    const middleX = (from.x + to.x) / 2;
    const middleY = (from.y + to.y) / 2 - 8;
    path.setAttribute("d", `M ${from.x} ${from.y} Q ${middleX} ${middleY} ${to.x} ${to.y}`);
    svg.append(path);
  });
  map.replaceChildren(svg);
  ids.forEach((id, index) => {
    const part = componentById.get(id);
    if (!part) return;
    const position = positions[index];
    const node = document.createElement("i");
    node.className = `impact-node ${["node-source", "node-mid", "node-screen", "node-sensor"][index]}`;
    node.textContent = (part.label || "PART").trim().split(/\s+/)[0].slice(0, 7).toUpperCase();
    node.title = part.label || id;
    node.style.left = `${(position.x / 240) * 100}%`;
    node.style.top = `${(position.y / 112) * 100}%`;
    node.setAttribute("aria-hidden", "true");
    map.append(node);
  });
  const summary = document.querySelector("#physicalRelationshipSummary");
  const detail = document.querySelector("#physicalRelationshipDetail");
  const whatIf = document.querySelector("#physicalWhatIfDemo");
  if (!relationships.length) {
    if (summary) summary.textContent = "No saved links in this analysis";
    if (detail) detail.textContent = "Parts can still be inspected individually";
    if (whatIf) whatIf.textContent = "Select a part to inspect";
    return;
  }
  const observed = selected.filter((relation) => relation.status === "observed").length;
  const inferred = selected.filter((relation) => relation.status === "inferred").length;
  if (summary) summary.textContent = `${selected.length} of ${relationships.length} saved links`;
  if (detail) detail.textContent = `${observed} observed · ${inferred} inferred shown`;
  if (whatIf) whatIf.textContent = "Remove a selected component";
}

function labelSprite(text) {
  const textureCanvas = document.createElement("canvas");
  const context = textureCanvas.getContext("2d");
  const fontSize = 28;
  context.font = `600 ${fontSize}px Inter, sans-serif`;
  const width = Math.ceil(context.measureText(text).width) + 28;
  textureCanvas.width = width;
  textureCanvas.height = 52;
  context.font = `600 ${fontSize}px Inter, sans-serif`;
  context.fillStyle = "rgba(7, 14, 25, .82)";
  context.beginPath();
  context.roundRect(1, 1, width - 2, 50, 15);
  context.fill();
  context.strokeStyle = "rgba(128, 206, 255, .5)";
  context.lineWidth = 2;
  context.stroke();
  context.fillStyle = "#d6efff";
  context.textBaseline = "middle";
  context.fillText(text, 14, 26);
  const texture = new THREE.CanvasTexture(textureCanvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, opacity: 0 });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(Math.min(2.25, Math.max(1.05, width / 145)), 0.34, 1);
  sprite.renderOrder = 30;
  return sprite;
}

async function createScene(photo) {
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: "low-power" });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.65));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 80);
  camera.position.set(0, 0.03, 11.5);
  scene.add(new THREE.HemisphereLight(0xe1f1ff, 0x11172b, 1.85));
  const key = new THREE.DirectionalLight(0xffffff, 2.7);
  key.position.set(-4, 6, 8);
  scene.add(key);
  const rim = new THREE.PointLight(0x3bceff, 24, 12, 2);
  rim.position.set(3.8, 1.1, 4);
  scene.add(rim);
  const violet = new THREE.PointLight(0x886cff, 18, 14, 2);
  violet.position.set(-3.4, -2.2, -1);
  scene.add(violet);

  const assembly = new THREE.Group();
  scene.add(assembly);
  const aspect = photo.height / photo.width;
  const imageWidth = 5.05;
  const imageHeight = imageWidth * aspect;
  const makeTexture = (image) => {
    const texture = new THREE.Texture(image);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
    texture.needsUpdate = true;
    return texture;
  };
  const positionFor = (bbox) => new THREE.Vector3(
    (bbox.x + bbox.width / 2 - 0.5) * imageWidth,
    (0.5 - bbox.y - bbox.height / 2) * imageHeight,
    0
  );
  const sizeFor = (bbox) => [bbox.width * imageWidth, bbox.height * imageHeight];
  const materialFor = (texture, options = {}) => new THREE.MeshBasicMaterial({
    map: texture, transparent: true, alphaTest: 0.016, depthWrite: false,
    side: THREE.DoubleSide, ...options
  });
  const planeFor = (image, bbox, z, material) => {
    const [width, height] = sizeFor(bbox);
    const group = new THREE.Group();
    group.position.copy(positionFor(bbox));
    group.position.z = z;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), materialFor(makeTexture(image), material));
    mesh.renderOrder = 2;
    group.add(mesh);
    assembly.add(group);
    return { group, mesh, base: group.position.clone() };
  };

  const plateBox = photo.view.plateBbox || { x: 0, y: 0, width: 1, height: 1 };
  const plate = planeFor(photo.plateImage, plateBox, -0.018, { opacity: 0.98 });
  plate.mesh.renderOrder = 1;

  const maxRank = Math.max(1, ...photo.layers.map((layer, index) => Number(layer.depthRank ?? index)));
  const parts = photo.layers.map((layer, index) => {
    const bbox = layer.bbox || { x: 0.25, y: 0.25, width: 0.5, height: 0.5 };
    const rank = Number(layer.depthRank ?? index);
    const baseZ = 0.018 + index * 0.0015;
    const source = planeFor(layer.image, bbox, baseZ, { opacity: 1 });
    const [width, height] = sizeFor(bbox);
    const volume = Array.from({ length: 4 }, (_, slice) => {
      const material = new THREE.MeshBasicMaterial({
        map: source.mesh.material.map,
        color: [0x719bda, 0x617fc4, 0x685cae, 0x433d83][slice],
        transparent: true, opacity: 0, alphaTest: 0.016,
        depthTest: false, depthWrite: false, side: THREE.DoubleSide
      });
      const mesh = new THREE.Mesh(source.mesh.geometry, material);
      mesh.position.z = -0.012;
      mesh.renderOrder = 2 + index * 6 + slice * 0.5;
      source.group.add(mesh);
      return mesh;
    });
    const halo = new THREE.Mesh(new THREE.PlaneGeometry(width, height), materialFor(makeTexture(layer.image), {
      color: new THREE.Color("#68d9ff"), transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false
    }));
    halo.position.z = -0.012;
    halo.renderOrder = 5 + index * 6;
    source.group.add(halo);
    source.mesh.renderOrder = 4 + index * 6;
    source.group.userData.layer = layer;
    const component = photo.components.find((part) => part.id === layer.componentId);
    const centerX = bbox.x + bbox.width / 2 - 0.5;
    const centerY = 0.5 - bbox.y - bbox.height / 2;
    let length = Math.hypot(centerX, centerY);
    let directionX = centerX / (length || 1);
    let directionY = centerY / (length || 1);
    if (length < 0.035) {
      const angle = index * 2.399;
      directionX = Math.cos(angle);
      directionY = Math.sin(angle);
    }
    return {
      ...source, halo, volume, bbox, rank: clamp(rank / maxRank), index,
      direction: new THREE.Vector2(directionX, directionY), component,
      area: bbox.width * bbox.height
    };
  });

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const interactiveMeshes = parts.map((part) => part.mesh);
  const interactionStatus = document.querySelector("#physicalInteractionStatus");
  let hoveredPart = null;
  let selectedPart = null;
  const partName = (part) => (part.component?.label || `PART ${String(part.index + 1).padStart(2, "0")}`).toUpperCase();
  const updateInteractionStatus = () => {
    if (!interactionStatus) return;
    const part = hoveredPart || selectedPart;
    interactionStatus.textContent = part
      ? `${part === selectedPart ? "PINNED" : "INSPECTING"} · ${partName(part)}`
      : "HOVER A PART · CLICK TO PIN";
  };
  const hitTest = (event) => {
    const bounds = canvas.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return null;
    pointer.set(((event.clientX - bounds.left) / bounds.width) * 2 - 1, -((event.clientY - bounds.top) / bounds.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects(interactiveMeshes, false)[0];
    return hit ? parts.find((part) => part.mesh === hit.object) || null : null;
  };
  canvas.addEventListener("pointermove", (event) => {
    if (event.pointerType === "touch") return;
    const next = hitTest(event);
    if (next !== hoveredPart) {
      hoveredPart = next;
      updateInteractionStatus();
    }
    canvas.style.cursor = hoveredPart ? "pointer" : "grab";
  });
  canvas.addEventListener("pointerleave", () => {
    hoveredPart = null;
    canvas.style.cursor = "grab";
    updateInteractionStatus();
  });
  canvas.addEventListener("click", (event) => {
    const picked = hitTest(event);
    selectedPart = picked === selectedPart ? null : picked;
    hoveredPart = picked;
    updateInteractionStatus();
  });

  // The rings and frame measure the photo volume; they do not imply unseen part geometry.
  const ringMaterial = new THREE.MeshBasicMaterial({ color: 0x598cff, transparent: true, opacity: 0.16, side: THREE.DoubleSide });
  const ring = new THREE.Mesh(new THREE.TorusGeometry(Math.min(imageWidth, imageHeight) * 0.52, 0.006, 6, 140), ringMaterial);
  ring.rotation.x = Math.PI * 0.5;
  ring.scale.set(1, 0.72, 1);
  ring.position.set(0, 0, -0.44);
  assembly.add(ring);
  const orbitMaterial = new THREE.MeshBasicMaterial({ color: 0x8d78ff, transparent: true, opacity: 0.075, side: THREE.DoubleSide });
  const orbit = new THREE.Mesh(new THREE.TorusGeometry(Math.min(imageWidth, imageHeight) * 0.63, 0.004, 5, 160), orbitMaterial);
  orbit.rotation.set(1.24, 0.38, -0.2);
  orbit.scale.set(1.16, 0.86, 1);
  orbit.position.z = -0.62;
  assembly.add(orbit);
  const frame = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(imageWidth * 1.1, imageHeight * 1.1, 0.18)),
    new THREE.LineBasicMaterial({ color: 0x75cfff, transparent: true, opacity: 0.23 })
  );
  frame.position.z = -0.2;
  assembly.add(frame);

  const beamCanvas = document.createElement("canvas");
  beamCanvas.width = 4;
  beamCanvas.height = 96;
  const beamContext = beamCanvas.getContext("2d");
  const beamGradient = beamContext.createLinearGradient(0, 0, 0, beamCanvas.height);
  beamGradient.addColorStop(0, "rgba(81,213,255,0)");
  beamGradient.addColorStop(0.48, "rgba(102,224,255,.12)");
  beamGradient.addColorStop(0.5, "rgba(235,250,255,.92)");
  beamGradient.addColorStop(0.54, "rgba(104,191,255,.24)");
  beamGradient.addColorStop(1, "rgba(91,137,255,0)");
  beamContext.fillStyle = beamGradient;
  beamContext.fillRect(0, 0, beamCanvas.width, beamCanvas.height);
  const beamTexture = new THREE.CanvasTexture(beamCanvas);
  const scanBeam = new THREE.Mesh(
    new THREE.PlaneGeometry(imageWidth * 1.18, imageHeight * 1.2),
    new THREE.MeshBasicMaterial({ map: beamTexture, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false })
  );
  scanBeam.position.z = 0.32;
  scanBeam.renderOrder = 28;
  assembly.add(scanBeam);

  const callouts = [];
  const leaders = new THREE.Group();
  assembly.add(leaders);
  [...parts].sort((a, b) => b.area - a.area).slice(0, 4).forEach((part) => {
    if (!part.component?.label) return;
    const label = labelSprite(part.component.label.toUpperCase().slice(0, 22));
    const geometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    const lineMaterial = new THREE.LineBasicMaterial({ color: 0x7ee4ff, transparent: true, opacity: 0, depthTest: false });
    const line = new THREE.Line(geometry, lineMaterial);
    line.renderOrder = 29;
    leaders.add(line, label);
    callouts.push({ part, label, line, material: lineMaterial });
  });

  const starPositions = [];
  for (let i = 0; i < 54; i++) {
    const angle = i * 2.399;
    const radius = 3.05 + (i % 7) * 0.24;
    starPositions.push(Math.cos(angle) * radius, Math.sin(angle) * radius * 0.7, -0.8 - (i % 5) * 0.17);
  }
  const starsGeometry = new THREE.BufferGeometry();
  starsGeometry.setAttribute("position", new THREE.Float32BufferAttribute(starPositions, 3));
  const stars = new THREE.Points(starsGeometry, new THREE.PointsMaterial({ color: 0x78b9ff, size: 0.018, transparent: true, opacity: 0.46, depthWrite: false }));
  assembly.add(stars);

  let targetProgress = Number(visual.dataset.storyProgress || 0);
  let shownProgress = targetProgress;
  let targetX = -0.07;
  let targetY = 0.11;
  let targetTiltX = 0;
  let targetTiltY = 0;
  let animationFrame = 0;
  const start = performance.now();
  const resize = () => {
    const bounds = stage.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    renderer.setSize(bounds.width, bounds.height, false);
    camera.aspect = bounds.width / bounds.height;
    camera.position.z = 9.7;
    camera.updateProjectionMatrix();
  };
  resize();
  new ResizeObserver(resize).observe(stage);
  visual.addEventListener("pointermove", (event) => {
    const bounds = visual.getBoundingClientRect();
    targetTiltY = ((event.clientX - bounds.left) / bounds.width - 0.5) * 0.18;
    targetTiltX = ((event.clientY - bounds.top) / bounds.height - 0.5) * -0.14;
  });
  visual.addEventListener("pointerleave", () => { targetTiltX = 0; targetTiltY = 0; });

  const update = (time) => {
    animationFrame = 0;
    targetProgress = Number(visual.dataset.storyProgress || 0);
    const damping = reducedMotion.matches ? 1 : 0.085;
    shownProgress += (targetProgress - shownProgress) * damping;
    const segmentation = reducedMotion.matches ? 0 : smooth(0.16, 0.43, shownProgress);
    const depth = reducedMotion.matches ? 0 : smooth(0.39, 0.72, shownProgress);
    const separation = reducedMotion.matches ? 0 : smooth(0.68, 0.97, shownProgress);
    const timeSeconds = (time - start) / 1000;

    assembly.rotation.y += (targetY + targetTiltY - assembly.rotation.y) * (reducedMotion.matches ? 1 : 0.055);
    assembly.rotation.x += (targetX + targetTiltX - assembly.rotation.x) * (reducedMotion.matches ? 1 : 0.055);
    assembly.position.y = reducedMotion.matches ? 0 : Math.sin(timeSeconds * 0.55) * 0.035;
    ring.rotation.z = reducedMotion.matches ? 0 : timeSeconds * 0.035;
    orbit.rotation.z = reducedMotion.matches ? -0.2 : -0.2 + timeSeconds * 0.022;
    stars.rotation.z = reducedMotion.matches ? 0 : -timeSeconds * 0.008;
    scanBeam.position.y = imageHeight * 0.62 - segmentation * imageHeight * 1.24;
    scanBeam.material.opacity = segmentation * 0.74 * (1 - smooth(0.42, 0.58, shownProgress));

    parts.forEach((part) => {
      const focus = part === hoveredPart ? 1 : part === selectedPart ? 0.82 : 0;
      const spread = separation * (0.48 + part.rank * 0.66) + segmentation * 0.035;
      const depthOffset = segmentation * 0.055 + depth * (0.16 + part.rank * 0.42) + separation * (0.12 + part.index * Math.min(0.06, 0.48 / Math.max(1, parts.length))) + focus * 0.16;
      part.group.position.set(
        part.base.x + part.direction.x * spread,
        part.base.y + part.direction.y * spread,
        part.base.z + depthOffset
      );
      const partTilt = (part.rank - 0.5) * separation;
      part.group.rotation.set(partTilt * 0.075, -partTilt * 0.12, part.direction.x * separation * 0.025);
      part.mesh.scale.setScalar(1 + separation * 0.045 + focus * 0.075);
      part.halo.material.opacity = Math.min(0.76, segmentation * 0.24 * (1 - separation * 0.12) + focus * (0.42 + Math.sin(timeSeconds * 3.2) * 0.06));
      part.volume.forEach((slice, sliceIndex) => {
        const relief = separation * (0.055 + part.rank * 0.055);
        slice.position.z = -0.016 - relief * (sliceIndex + 1) / part.volume.length;
        slice.material.opacity = Math.min(0.27, separation * (0.14 - sliceIndex * 0.022) + focus * 0.055);
      });
    });

    callouts.forEach(({ part, label, line, material }, index) => {
      const visible = smooth(0.7 + index * 0.018, 0.95, shownProgress);
      const dx = part.direction.x * (0.5 + (index % 2) * 0.18);
      const dy = part.direction.y * (0.43 + (index % 2) * 0.12);
      const from = part.group.position.clone();
      const to = from.clone().add(new THREE.Vector3(dx, dy, 0.12));
      const points = line.geometry.attributes.position;
      points.setXYZ(0, from.x, from.y, from.z + 0.03);
      points.setXYZ(1, to.x, to.y, to.z);
      points.needsUpdate = true;
      line.geometry.computeBoundingSphere();
      label.position.copy(to).add(new THREE.Vector3(dx * 0.42, dy * 0.16, 0.02));
      label.material.opacity = visible;
      material.opacity = visible * 0.76;
    });

    renderer.render(scene, camera);
    if (!reducedMotion.matches) animationFrame = requestAnimationFrame(update);
  };

  const startAnimation = () => {
    if (!animationFrame) animationFrame = requestAnimationFrame(update);
  };
  if ("IntersectionObserver" in window) {
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) startAnimation();
      else if (animationFrame) { cancelAnimationFrame(animationFrame); animationFrame = 0; }
    }, { threshold: 0.01 });
    observer.observe(visual);
  } else startAnimation();
  visual.classList.add("has-webgl");
  if (reducedMotion.matches) update(performance.now());
}

function createPrecisionScene() {
  if (!canvas || !stage || !visual) return;
  const fallback = document.querySelector("#physicalSourceImage");
  const sourceName = document.querySelector("#physicalPreviewName");
  const sourceCount = document.querySelector("#physicalPreviewParts");
  if (sourceName) sourceName.textContent = "AXIOM / MULTI-DIE CPU";
  if (sourceCount) sourceCount.textContent = "100 CPU PACKAGE COMPONENTS";
  if (fallback) {
    fallback.alt = "Animated exploded CPU assembly with silicon dies, circuit layers, a floating heat spreader, and a dense field of underside contacts";
    fallback.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 680 500">
        <defs>
          <linearGradient id="board" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#1d5664"/><stop offset=".48" stop-color="#102b3d"/><stop offset="1" stop-color="#091625"/></linearGradient>
          <linearGradient id="metal" x1="0" y1="0" x2=".9" y2="1"><stop stop-color="#f4fbff"/><stop offset=".24" stop-color="#a8c2d6"/><stop offset=".58" stop-color="#526c83"/><stop offset=".82" stop-color="#d6e6f2"/><stop offset="1" stop-color="#566b81"/></linearGradient>
          <linearGradient id="silicon" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#79efff"/><stop offset=".42" stop-color="#4e92ec"/><stop offset="1" stop-color="#554dd0"/></linearGradient>
          <linearGradient id="copper" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#ffe2a0"/><stop offset=".44" stop-color="#c68748"/><stop offset="1" stop-color="#704327"/></linearGradient>
          <radialGradient id="aura"><stop stop-color="#557ff4" stop-opacity=".32"/><stop offset="1" stop-color="#557ff4" stop-opacity="0"/></radialGradient>
          <pattern id="microtrace" width="18" height="18" patternUnits="userSpaceOnUse"><path d="M0 9h7l4-4h7M9 18v-5l4-4" fill="none" stroke="#61d6d3" stroke-opacity=".28" stroke-width="1"/><circle cx="7" cy="9" r="1.3" fill="#9ed9c7" fill-opacity=".7"/></pattern>
          <filter id="shadow" x="-.4" y="-.4" width="1.8" height="1.9"><feGaussianBlur in="SourceAlpha" stdDeviation="12"/><feOffset dy="17"/><feComponentTransfer><feFuncA type="linear" slope=".52"/></feComponentTransfer><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter>
          <filter id="glow" x="-.8" y="-.8" width="2.6" height="2.6"><feGaussianBlur stdDeviation="5" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
          <style>
            .orbit{transform-origin:340px 250px;animation:orbit 18s linear infinite}.lid{transform-box:fill-box;transform-origin:center;animation:lid 5.2s ease-in-out infinite}.pulse{animation:pulse 2.4s ease-in-out infinite}.scan{animation:scan 4.6s ease-in-out infinite}.spark{animation:spark 2s ease-in-out infinite alternate}
            @keyframes orbit{to{transform:rotate(360deg)}}@keyframes lid{0%,100%{transform:translateY(0)}50%{transform:translateY(-9px)}}@keyframes pulse{0%,100%{opacity:.45}50%{opacity:1}}@keyframes scan{0%,100%{opacity:0;transform:translateY(-82px)}22%,70%{opacity:.7}55%{transform:translateY(105px);opacity:.18}}@keyframes spark{to{opacity:.3;filter:brightness(1.7)}}
            @media(prefers-reduced-motion:reduce){.orbit,.lid,.pulse,.scan,.spark{animation:none}}
          </style>
        </defs>
        <ellipse cx="340" cy="265" rx="270" ry="210" fill="url(#aura)"/>
        <g class="orbit" fill="none" stroke="#74cfff" stroke-opacity=".34"><ellipse cx="340" cy="250" rx="272" ry="91" transform="rotate(-17 340 250)"/><ellipse cx="340" cy="250" rx="248" ry="126" transform="rotate(23 340 250)" stroke="#9b86ff" stroke-opacity=".26"/></g>
        <g transform="translate(340 251)">
          <g filter="url(#shadow)" transform="translate(11 72) matrix(1 .16 -.18 .91 0 0)">
            <rect x="-168" y="-104" width="336" height="208" rx="20" fill="#07101b" stroke="#90b8d0" stroke-opacity=".75" stroke-width="3"/>
            <rect x="-157" y="-93" width="314" height="186" rx="15" fill="url(#metal)" stroke="#e2f0f8" stroke-opacity=".72" stroke-width="2"/>
            <rect x="-144" y="-80" width="288" height="160" rx="10" fill="#101f31" stroke="#6fe1e4" stroke-opacity=".66" stroke-width="2"/>
            ${Array.from({length:120},(_,i)=>{const x=-130+(i%12)*23.6,y=-68+Math.floor(i/12)*13.7;return `<circle cx="${x}" cy="${y}" r="4.1" fill="url(#copper)" stroke="#fff0bd" stroke-opacity=".48" stroke-width=".8"/>`;}).join("")}
            <path d="M-139-86h278M-139 86h278M-149-72v144M149-72v144" stroke="#f1c77e" stroke-opacity=".78" stroke-width="2"/>
          </g>
          <g transform="matrix(1 .16 -.18 .91 0 0)">
            <rect x="-184" y="-120" width="368" height="240" rx="19" fill="#07101a" stroke="#b2d5e9" stroke-opacity=".9" stroke-width="3"/>
            <rect x="-173" y="-109" width="346" height="218" rx="14" fill="url(#board)" stroke="#4bd6d2" stroke-opacity=".72" stroke-width="2"/>
            <rect x="-165" y="-101" width="330" height="202" rx="10" fill="url(#microtrace)" opacity=".94"/>
            <path d="M-154-85h52l15 14h25m-92 111h41l12-12h24m223-112h-39l-13 13h-24m76 105h-43l-14-13h-20M-111-102v26m220-25v26M-116 102V76m228 25V73" fill="none" stroke="#e6a85e" stroke-width="3" stroke-linecap="round"/>
            <path d="M-153-91h34v18h32m110-24v17h-23m113-6h-29v19h-22M-154 89h29V72h28m102 31V88h24m99 3h-32V73h-18" fill="none" stroke="#77f0dc" stroke-opacity=".68" stroke-width="2"/>
            ${Array.from({length:24},(_,i)=>{const x=-139+(i%12)*25.3,y=i<12?-96:96;return `<g><rect x="${x-5}" y="${y-4}" width="10" height="8" rx="2" fill="#111c28" stroke="#e4b96e" stroke-width="1.3"/><circle cx="${x}" cy="${y}" r="1.4" fill="#79d5ec"/></g>`;}).join("")}
            ${Array.from({length:8},(_,i)=>{const x=i%2?-40:40,y=-68+Math.floor(i/2)*42;return `<g><rect x="${x-33}" y="${y-17}" width="66" height="34" rx="5" fill="#080e1b" stroke="#d09452" stroke-width="2"/><rect x="${x-28}" y="${y-13}" width="56" height="26" rx="3" fill="#172641" stroke="#56b6d8" stroke-width="1.5"/><rect x="${x-21}" y="${y-8}" width="42" height="16" rx="2" fill="url(#silicon)" opacity=".92"/><path d="M${x-17} ${y-3}h34M${x-17} ${y+2}h34" stroke="#c8fbff" stroke-opacity=".48" stroke-width="1"/></g>`;}).join("")}
            ${Array.from({length:20},(_,i)=>{const side=i<10?-1:1,row=i%10,x=side*145,y=-77+row*17;return `<g transform="translate(${x} ${y})"><rect x="-7" y="-5" width="14" height="10" rx="2" fill="#111925" stroke="#d4b072" stroke-width="1.2"/><path d="M-3-5v10M3-5v10" stroke="#e3edf5" stroke-opacity=".62" stroke-width="1"/><circle class="pulse" r="1.5" fill="#62e5dc"/></g>`;}).join("")}
            <path d="M-178-115h28m-28 0v28M178-115h-28m28 0v28M-178 115h28m-28 0v-28M178 115h-28m28 0v-28" fill="none" stroke="#b7d5ff" stroke-width="2"/>
          </g>
          <path d="M-98-115v-28M98-115v-28M-131-101v-23M131-101v-23" stroke="#8fe5ed" stroke-opacity=".55" stroke-dasharray="4 5"/>
          <g transform="translate(-7 -158) matrix(1 .15 -.19 .9 0 0)" filter="url(#shadow)"><g class="lid">
            <rect x="-130" y="-68" width="260" height="136" rx="20" fill="#09111d" stroke="#a4c8e5" stroke-opacity=".8" stroke-width="3"/>
            <rect x="-121" y="-60" width="242" height="118" rx="15" fill="url(#metal)" stroke="#f0f8ff" stroke-opacity=".8" stroke-width="2"/>
            <rect x="-104" y="-44" width="208" height="86" rx="10" fill="#24374d" stroke="#8bb9de" stroke-width="2"/>
            ${Array.from({length:8},(_,i)=>{const y=-31+i*9;return `<path d="M-91${y}h182" stroke="#b3c8da" stroke-opacity=".6" stroke-width="2"/>`;}).join("")}
            <rect x="-37" y="-19" width="74" height="38" rx="9" fill="#121f31" stroke="#a9dff2" stroke-width="2"/><rect class="pulse" x="-27" y="-11" width="54" height="22" rx="6" fill="url(#silicon)" filter="url(#glow)"/>
            <circle cx="-101" cy="-48" r="7" fill="url(#copper)"/><circle cx="101" cy="-48" r="7" fill="url(#copper)"/><circle cx="-101" cy="48" r="7" fill="url(#copper)"/><circle cx="101" cy="48" r="7" fill="url(#copper)"/>
          </g></g>
          <path class="scan" d="M-190-122h380" stroke="#8af4ff" stroke-width="2" stroke-opacity=".85" filter="url(#glow)"/>
          <g class="spark" filter="url(#glow)"><circle cx="-213" cy="-44" r="3.5" fill="#73efff"/><circle cx="218" cy="52" r="3" fill="#a88aff"/><circle cx="-184" cy="149" r="2.6" fill="#62e4d9"/></g>
        </g>
      </svg>`
    );
  }

  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: "low-power" });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, 1, .1, 60);
  camera.position.set(0, 0, 6.7);
  scene.add(new THREE.HemisphereLight(0xe8f2ff, 0x111522, 1.55));
  const key = new THREE.DirectionalLight(0xffedcc, 3.1); key.position.set(-3.5, 5, 7); scene.add(key);
  const cyan = new THREE.PointLight(0x4bcbff, 30, 13, 2); cyan.position.set(3.7, 1.8, 3.8); scene.add(cyan);
  const violet = new THREE.PointLight(0x9070ff, 24, 15, 2); violet.position.set(-3.4, -2.8, -1); scene.add(violet);
  const warm = new THREE.PointLight(0xffa751, 13, 12, 2); warm.position.set(0, 3, -2); scene.add(warm);

  const movement = new THREE.Group(); scene.add(movement);
  const packageModel = new THREE.Group();
  packageModel.scale.setScalar(1.13);
  movement.add(packageModel);
  const parts = [];
  const calloutParts = [];
  const mat = {
    graphite: new THREE.MeshStandardMaterial({ color: 0x202b38, metalness: .78, roughness: .28 }),
    darkSteel: new THREE.MeshStandardMaterial({ color: 0x4b5a69, metalness: .84, roughness: .26 }),
    steel: new THREE.MeshStandardMaterial({ color: 0xa7bacb, metalness: .88, roughness: .2 }),
    paleSteel: new THREE.MeshStandardMaterial({ color: 0xdce5ec, metalness: .77, roughness: .22 }),
    brass: new THREE.MeshStandardMaterial({ color: 0xb98a4e, metalness: .82, roughness: .26 }),
    gold: new THREE.MeshStandardMaterial({ color: 0xe6c276, metalness: .8, roughness: .2 }),
    blue: new THREE.MeshStandardMaterial({ color: 0x5793ba, metalness: .72, roughness: .24 }),
    ruby: new THREE.MeshPhysicalMaterial({ color: 0xf05a73, metalness: .34, roughness: .16, clearcoat: 1 }),
    sapphire: new THREE.MeshPhysicalMaterial({ color: 0x64d7e8, metalness: .36, roughness: .13, clearcoat: 1 }),
    black: new THREE.MeshStandardMaterial({ color: 0x101722, metalness: .54, roughness: .3 }),
    substrate: new THREE.MeshStandardMaterial({ color: 0x163949, metalness: .48, roughness: .39 }),
    copper: new THREE.MeshStandardMaterial({ color: 0xd28c50, metalness: .82, roughness: .22 }),
    die: new THREE.MeshStandardMaterial({ color: 0x131f38, metalness: .65, roughness: .24, emissive: 0x102443, emissiveIntensity: .42 }),
    dieCore: new THREE.MeshStandardMaterial({ color: 0x4c83d3, metalness: .5, roughness: .19, emissive: 0x173864, emissiveIntensity: .75 }),
    solder: new THREE.MeshStandardMaterial({ color: 0xe8bf75, metalness: .9, roughness: .2 }),
    ceramic: new THREE.MeshStandardMaterial({ color: 0xced7df, metalness: .6, roughness: .23 }),
    trace: new THREE.MeshBasicMaterial({ color: 0x4cbdc7 })
  };
  const addMesh = (parent, geometry, material, position = [0, 0, 0], rotation = [0, 0, 0]) => {
    const object = new THREE.Mesh(geometry, material);
    object.position.set(...position); object.rotation.set(...rotation); object.castShadow = true; parent.add(object); return object;
  };
  const disc = (parent, radius, depth, material, z = 0, x = 0, y = 0, segments = 48) =>
    addMesh(parent, new THREE.CylinderGeometry(radius, radius, depth, segments), material, [x, y, z], [Math.PI / 2, 0, 0]);
  const box = (parent, size, material, position, angle = 0) =>
    addMesh(parent, new THREE.BoxGeometry(...size), material, position, [0, 0, angle]);
  const torus = (parent, radius, thickness, material, z = 0, arc = Math.PI * 2) =>
    addMesh(parent, new THREE.TorusGeometry(radius, thickness, 10, 72, arc), material, [0, 0, z]);
  const addPart = (name, position, layer, build, options = {}) => {
    const group = new THREE.Group(); group.position.set(...position); packageModel.add(group); build(group);
    const angle = options.angle ?? Math.atan2(position[1], position[0]);
    const direction = new THREE.Vector3(Math.cos(angle) * (options.radial ?? .56), Math.sin(angle) * (options.radial ?? .56), options.axial ?? (parts.length % 2 ? .82 : -.82)).normalize();
    const part = { name, group, base: group.position.clone(), direction, layer, index: parts.length, radius: options.radius ?? .12, speed: options.speed ?? 0, baseRotation: group.rotation.clone() };
    group.traverse((child) => { if (child.isMesh) child.userData.componentPart = part; });
    parts.push(part); return part;
  };

  // 01: layered package substrate with plated routing and via fields.
  addPart("Organic package substrate", [0, 0, -.21], 0, (g) => {
    box(g, [3.18, 3.18, .2], mat.substrate, [0, 0, 0]);
    box(g, [3.07, 3.07, .035], mat.graphite, [0, 0, .115]);
    box(g, [2.91, 2.91, .02], mat.substrate, [0, 0, .14]);
    for (let side = -1; side <= 1; side += 2) {
      box(g, [.035, 2.88, .014], mat.copper, [side * 1.49, 0, .156]);
      box(g, [2.88, .035, .014], mat.copper, [0, side * 1.49, .156]);
      for (let lane = 0; lane < 6; lane++) {
        const inset = 1.23 - lane * .075;
        box(g, [.012, 2.3, .009], mat.trace, [side * inset, 0, .154]);
        box(g, [2.3, .012, .009], mat.copper, [0, side * inset, .153]);
      }
    }
    for (let i = 0; i < 18; i++) {
      const offset = -.98 + i * .115;
      box(g, [.012, .31 + (i % 3) * .12, .01], i % 2 ? mat.copper : mat.trace, [offset, (i % 2 ? 1 : -1) * .99, .159]);
      box(g, [.31 + (i % 3) * .12, .012, .01], i % 2 ? mat.trace : mat.copper, [(i % 2 ? 1 : -1) * .99, offset, .158]);
    }
    for (let i = 0; i < 16; i++) {
      const x = -.7 + (i % 4) * .47, y = -.7 + Math.floor(i / 4) * .47;
      disc(g, .032, .018, mat.solder, .17, x, y, 12);
      disc(g, .014, .02, mat.black, .181, x, y, 10);
    }
  }, { radial: .08, axial: -.55, radius: 2.25 });

  // 02: lifted nickel heat spreader reveals the silicon complex underneath.
  const lid = addPart("Nickel heat spreader", [1.63, .59, .46], 5, (g) => {
    box(g, [1.16, 1.42, .17], mat.steel, [0, 0, 0]);
    box(g, [1.04, 1.3, .035], mat.paleSteel, [0, 0, .105]);
    box(g, [.83, 1.05, .018], mat.darkSteel, [0, 0, .133]);
    box(g, [.72, .93, .014], mat.steel, [0, 0, .147]);
    for (let i = 0; i < 9; i++) box(g, [.68, .009, .008], i % 2 ? mat.paleSteel : mat.blue, [0, -.39 + i * .098, .158]);
    for (const x of [-.49, .49]) for (const y of [-.61, .61]) {
      disc(g, .045, .024, mat.graphite, .11, x, y, 18);
      disc(g, .022, .018, mat.gold, .13, x, y, 16);
    }
    box(g, [.3, .085, .012], mat.blue, [0, -.59, .164]);
  }, { angle: .34, axial: 1.6, radial: .48, radius: .95 });
  calloutParts.push(lid);

  // 03-10: eight compute tiles with etched die grids.
  const computeY = [-.57, -.19, .19, .57];
  for (let row = 0; row < 4; row++) for (const side of [-1, 1]) {
    const i = row * 2 + (side > 0 ? 1 : 0), x = side * .34, y = computeY[row];
    const part = addPart("Compute tile " + String(i + 1).padStart(2, "0"), [x, y, .22], 3, (g) => {
      box(g, [.53, .33, .09], mat.copper, [0, 0, 0]);
      box(g, [.49, .29, .075], mat.die, [0, 0, .066]);
      box(g, [.39, .205, .019], mat.dieCore, [0, 0, .112]);
      box(g, [.022, .205, .012], mat.sapphire, [-.13, 0, .126]);
      box(g, [.022, .205, .012], mat.sapphire, [.13, 0, .126]);
      for (let n = 0; n < 7; n++) box(g, [.012, .17, .009], n % 2 ? mat.trace : mat.blue, [-.09 + n * .03, 0, .132]);
      for (let n = 0; n < 5; n++) box(g, [.38, .008, .008], mat.copper, [0, -.07 + n * .035, .137]);
      for (const px of [-.22, .22]) for (const py of [-.12, .12]) disc(g, .018, .016, mat.solder, .133, px, py, 12);
    }, { angle: Math.atan2(y, x), axial: i % 2 ? 1.05 : .88, radius: .38 });
    if (i === 2) calloutParts.push(part);
  }

  // 11-18: cache tiles run down either side of the compute array.
  for (let i = 0; i < 8; i++) {
    const side = i < 4 ? -1 : 1, row = i % 4, x = side * .94, y = computeY[row];
    addPart("Cache tile " + String(i + 1).padStart(2, "0"), [x, y, .17], 2, (g) => {
      box(g, [.29, .265, .085], mat.darkSteel, [0, 0, 0]);
      box(g, [.23, .205, .045], mat.die, [0, 0, .057]);
      for (let n = 0; n < 4; n++) {
        box(g, [.18, .012, .009], n % 2 ? mat.blue : mat.trace, [0, -.064 + n * .043, .086]);
        box(g, [.012, .19, .009], mat.copper, [-.068 + n * .045, 0, .087]);
      }
    }, { axial: i % 2 ? 1.15 : -.75, radius: .24 });
  }

  // 19-20: top and bottom I/O chiplets bridge the package edge.
  for (const side of [-1, 1]) {
    const part = addPart(side < 0 ? "Memory I/O die" : "Fabric I/O die", [0, side * .99, .2], 3, (g) => {
      box(g, [.54, .27, .1], mat.brass, [0, 0, 0]);
      box(g, [.49, .23, .08], mat.die, [0, 0, .07]);
      for (let i = 0; i < 6; i++) {
        box(g, [.012, .17, .012], mat.sapphire, [-.18 + i * .072, 0, .12]);
        box(g, [.42, .009, .01], mat.copper, [0, -.075 + i * .03, .128]);
      }
      for (let i = 0; i < 8; i++) disc(g, .014, .015, mat.solder, .14, -.2 + i * .057, .17, 12);
    }, { angle: side < 0 ? Math.PI : 0, axial: 1.1, radius: .32 });
    if (side > 0) calloutParts.push(part);
  }

  // 21-40: decoupling capacitors flank the silicon array.
  for (let i = 0; i < 20; i++) {
    const side = i < 10 ? -1 : 1, row = i % 10, x = side * 1.37, y = -.98 + row * .218;
    const part = addPart("Decoupling capacitor " + String(i + 1).padStart(2, "0"), [x, y, .16], 3, (g) => {
      box(g, [.105, .125, .105], mat.black, [0, 0, 0]);
      box(g, [.025, .132, .111], mat.ceramic, [-.043, 0, .004]);
      box(g, [.025, .132, .111], mat.gold, [.043, 0, .004]);
      box(g, [.035, .075, .012], mat.blue, [0, 0, .06]);
      for (const end of [-1, 1]) box(g, [.024, .02, .084], mat.solder, [end * .044, 0, -.008]);
    }, { axial: i % 2 ? .9 : -.82, radius: .14 });
    if (i === 5) calloutParts.push(part);
  }

  // 41-48: shielded power chokes with layered winding caps.
  for (let i = 0; i < 8; i++) {
    const row = i % 4, side = i < 4 ? -1 : 1, x = [-.78, -.26, .26, .78][row], y = side * 1.21;
    addPart("Power choke " + String(i + 1).padStart(2, "0"), [x, y, .2], 4, (g) => {
      box(g, [.2, .22, .17], mat.graphite, [0, 0, 0]);
      box(g, [.16, .17, .1], mat.copper, [0, 0, .11]);
      box(g, [.12, .12, .035], mat.darkSteel, [0, 0, .178]);
      for (let n = 0; n < 4; n++) box(g, [.012, .16, .012], mat.gold, [-.045 + n * .03, 0, .2]);
      for (const end of [-1, 1]) box(g, [.24, .027, .05], mat.solder, [end * .1, 0, -.035]);
    }, { angle: Math.atan2(y, x), axial: 1.15, radius: .23 });
  }

  // 49-52: package retention clips, lock screws, and alignment rails.
  for (let i = 0; i < 4; i++) {
    const sideX = i % 2 ? 1 : -1, sideY = i < 2 ? -1 : 1, x = sideX * 1.43, y = sideY * 1.43;
    addPart("Package retention clip " + String(i + 1).padStart(2, "0"), [x, y, .04], 4, (g) => {
      box(g, [.29, .065, .09], mat.steel, [0, 0, 0]);
      box(g, [.065, .29, .09], mat.steel, [0, 0, 0]);
      box(g, [.19, .026, .04], mat.blue, [-sideX * .035, -sideY * .035, .064]);
      disc(g, .045, .035, mat.darkSteel, .06, -sideX * .082, -sideY * .082, 20);
      box(g, [.048, .009, .008], mat.paleSteel, [-sideX * .082, -sideY * .082, .084]);
      box(g, [.009, .048, .008], mat.paleSteel, [-sideX * .082, -sideY * .082, .085]);
    }, { axial: 1.25, radius: .22 });
  }

  // 53-100: dense 8 x 6 underside BGA field; each contact can be inspected.
  let contactIndex = 0;
  for (let row = 0; row < 6; row++) for (let col = 0; col < 8; col++) {
    const x = -.99 + col * .283, y = -.9 + row * .36, index = ++contactIndex;
    const part = addPart("BGA solder ball " + String(index).padStart(2, "0"), [x, y, -.34], 1, (g) => {
      disc(g, .064, .024, mat.copper, 0, 0, 0, 14);
      const ball = addMesh(g, new THREE.SphereGeometry(.043, 14, 10), mat.solder, [0, 0, -.035]);
      ball.scale.set(1, 1, .72);
      disc(g, .024, .014, mat.steel, .014, 0, 0, 12);
    }, { angle: Math.atan2(y, x), axial: -1.65, radial: .38, radius: .1 });
    if (index === 24) calloutParts.push(part);
  }

  if (parts.length !== 100) console.warn("CPU package should contain 100 components; built", parts.length);
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const status = document.querySelector("#physicalInteractionStatus");
  const assemblyProgress = document.querySelector("#physicalAssemblyProgress");
  let hovered = null, selected = null, frame = 0, shownProgress = 0;
  let targetTiltX = -.24, targetTiltY = 0;
  const started = performance.now();
  const updateStatus = () => {
    if (!status) return;
    const part = hovered || selected;
    status.textContent = part ? (part === selected ? "PINNED" : "INSPECTING") + " · " + part.name.toUpperCase() : "100 CPU PARTS · HOVER TO INSPECT";
  };
  const pick = (event) => {
    const bounds = canvas.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return null;
    pointer.set((event.clientX - bounds.left) / bounds.width * 2 - 1, -((event.clientY - bounds.top) / bounds.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects(parts.map((part) => part.group), true)[0];
    let node = hit?.object;
    while (node && !node.userData.componentPart) node = node.parent;
    return node?.userData.componentPart || null;
  };

  const orbit = new THREE.Group(); movement.add(orbit);
  const orbitA = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(3.75, 3.75, .015)), new THREE.LineBasicMaterial({ color: 0x57cbff, transparent: true, opacity: .33 }));
  orbitA.rotation.set(.35, .08, -.15); orbit.add(orbitA);
  const orbitB = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(4.05, 4.05, .015)), new THREE.LineBasicMaterial({ color: 0x9e7dff, transparent: true, opacity: .24 }));
  orbitB.rotation.set(-.37, .22, .3); orbit.add(orbitB);
  const focusHalo = new THREE.Mesh(new THREE.TorusGeometry(.2, .009, 7, 48), new THREE.MeshBasicMaterial({ color: 0x6fe5ff, transparent: true, opacity: .88, depthTest: false }));
  focusHalo.visible = false; focusHalo.renderOrder = 20; scene.add(focusHalo);

  const callouts = calloutParts.slice(0, 5).map((part) => {
    const label = labelSprite(part.name.toUpperCase().slice(0, 24));
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineBasicMaterial({ color: 0x80e5ff, transparent: true, opacity: 0, depthTest: false }));
    line.renderOrder = 19; scene.add(line, label); return { part, label, line };
  });
  const points = [];
  for (let i = 0; i < 86; i++) { const a = i * 2.399, r = 2.05 + i % 9 * .28; points.push(Math.cos(a) * r, Math.sin(a) * r * .72, -.6 - i % 7 * .16); }
  const starGeometry = new THREE.BufferGeometry(); starGeometry.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
  const stars = new THREE.Points(starGeometry, new THREE.PointsMaterial({ color: 0x7cbfff, size: .014, transparent: true, opacity: .54, depthWrite: false })); scene.add(stars);

  const resize = () => {
    const bounds = stage.getBoundingClientRect(); if (!bounds.width || !bounds.height) return;
    renderer.setSize(bounds.width, bounds.height, false); camera.aspect = bounds.width / bounds.height;
    camera.position.z = camera.aspect < .82 ? 8.1 : camera.aspect < 1.15 ? 7.4 : 6.7; camera.updateProjectionMatrix();
  };
  resize(); new ResizeObserver(resize).observe(stage);
  const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
  canvas.addEventListener("pointermove", (event) => {
    if (event.pointerType === "touch") return;
    hovered = pick(event);
    const bounds = visual.getBoundingClientRect(); targetTiltY = ((event.clientX - bounds.left) / bounds.width - .5) * .2; targetTiltX = -.24 + ((event.clientY - bounds.top) / bounds.height - .5) * -.16;
    canvas.style.cursor = hovered ? "pointer" : "grab"; updateStatus(); schedule();
  });
  canvas.addEventListener("pointerleave", () => { hovered = null; targetTiltX = -.24; targetTiltY = 0; canvas.style.cursor = "grab"; updateStatus(); schedule(); });
  canvas.addEventListener("click", (event) => { const part = pick(event); selected = part === selected ? null : part; hovered = part; updateStatus(); schedule(); });
  addEventListener("scroll", schedule, { passive: true }); addEventListener("resize", schedule, { passive: true });

  const update = (time) => {
    frame = 0;
    const progress = Number(visual.dataset.storyProgress || 0);
    shownProgress += (progress - shownProgress) * (reducedMotion.matches ? .22 : .075);
    const seconds = (time - started) / 1000;
    const scrollOpen = smooth(.035, .87, shownProgress);
    const autoOpen = reducedMotion.matches ? 0 : smooth(.3, 1.2, seconds) * (1 - smooth(2.2, 3.7, seconds)) * .56;
    const opening = Math.max(scrollOpen, autoOpen);
    const zoomProgress = reducedMotion.matches ? 0 : smooth(.08, .94, shownProgress);
    packageModel.scale.setScalar(1.13 + zoomProgress * (widePhysicalStage.matches ? .14 : .08));
    movement.rotation.x += ((reducedMotion.matches ? -.24 : -.24 + Math.sin(seconds * .31) * .025 + targetTiltX * .18) - movement.rotation.x) * .055;
    movement.rotation.y += ((reducedMotion.matches ? .1 : .1 + Math.sin(seconds * .22) * .055 + targetTiltY) - movement.rotation.y) * .045;
    movement.position.y = reducedMotion.matches ? 0 : Math.sin(seconds * .65) * .035;
    orbit.rotation.z = reducedMotion.matches ? 0 : seconds * .12; stars.rotation.z = reducedMotion.matches ? 0 : -seconds * .012;
    parts.forEach((part) => {
      const focus = part === hovered ? 1 : part === selected ? .72 : 0;
      const spread = opening * (.22 + part.layer * .055);
      part.group.position.copy(part.base).addScaledVector(part.direction, spread);
      part.group.position.z += opening * ((part.index % 2 ? 1 : -1) * (.08 + part.layer * .035));
      part.group.rotation.copy(part.baseRotation); part.group.rotation.z += seconds * part.speed + opening * part.direction.x * .13; part.group.rotation.x += opening * part.direction.y * .11;
      part.group.scale.setScalar(1 + opening * .028 + focus * .12);
    });
    const focus = hovered || selected; focusHalo.visible = Boolean(focus);
    if (focus) { focus.group.getWorldPosition(focusHalo.position); focusHalo.scale.setScalar(Math.max(.5, focus.radius * 4.6)); focusHalo.rotation.set(movement.rotation.x, movement.rotation.y, seconds * .24); }
    callouts.forEach(({ part, label, line }, index) => {
      const opacity = smooth(.28 + index * .045, .7 + index * .03, shownProgress);
      const from = part.group.getWorldPosition(new THREE.Vector3()); const to = from.clone().add(new THREE.Vector3(part.direction.x * .48, part.direction.y * .4, .26));
      const attr = line.geometry.attributes.position; attr.setXYZ(0, from.x, from.y, from.z); attr.setXYZ(1, to.x, to.y, to.z); attr.needsUpdate = true; line.geometry.computeBoundingSphere();
      label.position.copy(to).add(new THREE.Vector3(part.direction.x * .2, .09, .02)); label.material.opacity = opacity; line.material.opacity = opacity * .72;
    });
    if (assemblyProgress) { const opened = Math.round(opening * parts.length); assemblyProgress.textContent = opening < .04 ? "100 PARTS / ASSEMBLED" : String(opened).padStart(2, "0") + " OF 100 / UNFOLDED"; }
    renderer.render(scene, camera);
    if (!reducedMotion.matches && visual.isConnected) frame = requestAnimationFrame(update);
  };
  if ("IntersectionObserver" in window) {
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) schedule(); else if (frame) { cancelAnimationFrame(frame); frame = 0; }
    }, { threshold: .01 });
    observer.observe(visual);
  } else schedule();
  if (reducedMotion.matches) schedule();
  visual.classList.add("has-webgl");
}

function start() {
  if (!canvas || !stage || !visual) return;
  try {
    createPrecisionScene();
  } catch (error) {
    console.info("Illustrative movement preview will use its SVG fallback.", error);
  }
}

start();
