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
  if (sourceName) sourceName.textContent = "MERIDIAN / MECHANICAL WATCH";
  if (sourceCount) sourceCount.textContent = "100 WATCH MOVEMENT COMPONENTS";
  if (fallback) {
    fallback.alt = "Exploded mechanical watch movement with a layered steel case, visible gears, balance wheel, jeweled bearings, hands, and precision markers";
    fallback.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 680 500">
        <defs>
          <radialGradient id="aura"><stop stop-color="#537df1" stop-opacity=".34"/><stop offset="1" stop-color="#537df1" stop-opacity="0"/></radialGradient>
          <linearGradient id="steel" x2="1" y2="1"><stop stop-color="#eaf5ff"/><stop offset=".42" stop-color="#657f98"/><stop offset=".72" stop-color="#d6e7f4"/><stop offset="1" stop-color="#40556d"/></linearGradient>
          <linearGradient id="brass" x2="1" y2="1"><stop stop-color="#ffe6a2"/><stop offset=".48" stop-color="#bd8040"/><stop offset="1" stop-color="#684324"/></linearGradient>
          <linearGradient id="dial" x2="1" y2="1"><stop stop-color="#19364b"/><stop offset=".5" stop-color="#0c1b2a"/><stop offset="1" stop-color="#253a50"/></linearGradient>
          <filter id="shadow" x="-.3" y="-.3" width="1.6" height="1.8"><feGaussianBlur in="SourceAlpha" stdDeviation="10"/><feOffset dy="14"/><feComponentTransfer><feFuncA type="linear" slope=".55"/></feComponentTransfer><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter>
        </defs>
        <ellipse cx="340" cy="260" rx="255" ry="220" fill="url(#aura)"/>
        <g fill="none" stroke="#78cfff" stroke-opacity=".28"><ellipse cx="340" cy="250" rx="265" ry="93" transform="rotate(-18 340 250)"/><ellipse cx="340" cy="250" rx="244" ry="128" transform="rotate(22 340 250)" stroke="#a28bff"/></g>
        <g filter="url(#shadow)" transform="translate(340 264) rotate(-12)">
          <circle r="166" fill="#08121e" stroke="url(#steel)" stroke-width="18"/>
          <circle r="150" fill="#102438" stroke="#8de8ed" stroke-opacity=".8" stroke-width="2"/>
          <circle r="133" fill="url(#dial)" stroke="url(#brass)" stroke-width="5"/>
          <circle r="119" fill="none" stroke="#8cb7d3" stroke-opacity=".48" stroke-width="1.5"/>
          ${Array.from({length:60},(_,i)=>{const a=i*Math.PI/30,r1=i%5===0?119:124,r2=132,x1=Math.sin(a)*r1,y1=-Math.cos(a)*r1,x2=Math.sin(a)*r2,y2=-Math.cos(a)*r2;return `<path d="M${x1.toFixed(1)} ${y1.toFixed(1)}L${x2.toFixed(1)} ${y2.toFixed(1)}" stroke="${i%5===0?"#f0cf88":"#84afc4"}" stroke-width="${i%5===0?3:1.2}"/>`;}).join("")}
          ${Array.from({length:12},(_,i)=>{const a=i*Math.PI/6,x=Math.sin(a)*102,y=-Math.cos(a)*102;return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="5" fill="#b9d9ec" stroke="#f5d48f" stroke-width="1.5"/>`;}).join("")}
          <g fill="none" stroke="url(#brass)" stroke-width="7">
            <circle cx="-52" cy="-42" r="31"/><circle cx="43" cy="-48" r="24"/><circle cx="57" cy="38" r="35"/><circle cx="-37" cy="55" r="25"/><circle cx="-2" cy="-2" r="40"/>
          </g>
          ${[[-52,-42,31],[43,-48,24],[57,38,35],[-37,55,25],[-2,-2,40]].map(([x,y,r],n)=>`<g transform="translate(${x} ${y})"><circle r="${r-6}" fill="#122339" stroke="#70d9df" stroke-width="2"/>${Array.from({length:12},(_,i)=>{const a=i*Math.PI/6;return `<path d="M${Math.cos(a)*(r-8)} ${Math.sin(a)*(r-8)}L${Math.cos(a)*(r+2)} ${Math.sin(a)*(r+2)}" stroke="#d8a65b" stroke-width="4"/>`;}).join("")}<circle r="${n===4?7:5}" fill="#8de7ec"/><circle r="2" fill="#f4d588"/></g>`).join("")}
          <path d="M0 5 5-54 10-58 13 4M-4 6-42 34-46 32-8 2" fill="#e6f1f8" stroke="#9ee8f0" stroke-width="2"/>
          <circle r="12" fill="url(#brass)" stroke="#fff0c2" stroke-width="2"/><circle r="4" fill="#14263a"/>
          <circle cx="166" r="24" fill="url(#steel)" stroke="#f0d18e" stroke-width="5"/>
          <circle cx="166" r="13" fill="#14263a" stroke="#8ce3e8" stroke-width="2"/>
        </g>
        <g transform="translate(340 76)" filter="url(#shadow)">
          <circle r="53" fill="url(#steel)" stroke="#d9eaff" stroke-width="3"/>
          <circle r="43" fill="#15283d" stroke="#65dbe6" stroke-width="2"/>
          <circle r="34" fill="none" stroke="url(#brass)" stroke-width="8"/>
          <circle r="20" fill="#182c43" stroke="#86b7d8" stroke-width="3"/>
          <circle r="8" fill="#68dae2"/><path d="M-33 0h66M0-33v66" stroke="#bcecf1" stroke-opacity=".62"/>
        </g>
        <g fill="#79e5eb"><circle cx="93" cy="260" r="3"/><circle cx="587" cy="248" r="3"/><circle cx="201" cy="425" r="2.5"/></g>
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
  camera.position.set(0, 0, 7.3);
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

  // The preview is an illustrative watch movement built from inspectable components.
  addPart("Watch case and lugs", [0, 0, -.2], 0, (g) => {
    disc(g, 1.48, .26, mat.graphite, 0, 0, 0, 96);
    disc(g, 1.4, .08, mat.darkSteel, .16, 0, 0, 96);
    torus(g, 1.49, .085, mat.steel, .12);
    for (const side of [-1, 1]) for (const y of [-.9, .9]) {
      box(g, [.38, .22, .2], mat.steel, [side * 1.55, y, -.02], side * -.2);
      disc(g, .055, .08, mat.gold, .12, side * 1.62, y, 20);
    }
    box(g, [.18, .48, .2], mat.darkSteel, [1.48, 0, .04]);
    for (let i = 0; i < 18; i++) {
      const angle = i * Math.PI / 9;
      box(g, [.025, .09, .018], i % 3 ? mat.paleSteel : mat.gold, [Math.cos(angle) * 1.49, Math.sin(angle) * 1.49, .18], angle);
    }
  }, { radial: .04, axial: -.48, radius: 1.8 });

  addPart("Layered exhibition caseback", [0, 0, -.46], 1, (g) => {
    disc(g, 1.31, .1, mat.steel, 0, 0, 0, 96);
    disc(g, 1.18, .04, mat.graphite, -.07, 0, 0, 96);
    torus(g, 1.08, .018, mat.sapphire, -.1);
    for (let i = 0; i < 12; i++) {
      const angle = i * Math.PI / 6;
      disc(g, .045, .04, mat.brass, -.1, Math.cos(angle) * 1.18, Math.sin(angle) * 1.18, 18);
      box(g, [.05, .008, .006], mat.paleSteel, [Math.cos(angle) * 1.18, Math.sin(angle) * 1.18, -.075], angle);
    }
  }, { axial: -.9, radius: 1.25 });

  addPart("Polished sapphire bezel", [0, 0, .14], 5, (g) => {
    torus(g, 1.42, .07, mat.gold, 0);
    torus(g, 1.34, .025, mat.paleSteel, .01);
    disc(g, 1.34, .035, mat.blue, -.05, 0, 0, 96);
    torus(g, 1.25, .025, mat.sapphire, -.025);
    for (let i = 0; i < 12; i++) {
      const angle = i * Math.PI / 6, x = Math.cos(angle) * 1.42, y = Math.sin(angle) * 1.42;
      disc(g, .028, .018, mat.black, .055, x, y, 16);
      disc(g, .012, .02, mat.paleSteel, .066, x, y, 12);
    }
  }, { axial: 1.3, radial: .35, radius: 1.5 });

  addPart("Open-work chapter dial", [0, 0, .2], 2, (g) => {
    disc(g, 1.22, .035, mat.black, 0, 0, 0, 96);
    disc(g, 1.16, .018, mat.substrate, .025, 0, 0, 96);
    torus(g, 1.08, .012, mat.brass, .04);
    torus(g, .82, .008, mat.sapphire, .045);
    for (let i = 0; i < 12; i++) {
      const angle = i * Math.PI / 6;
      box(g, [.055, .19, .025], mat.gold, [Math.sin(angle) * .94, -Math.cos(angle) * .94, .06], -angle);
    }
    for (let i = 0; i < 4; i++) {
      const y = -.56 + i * .37;
      box(g, [.36, .018, .012], mat.trace, [0, y, .052]);
    }
    disc(g, .17, .025, mat.graphite, .06, 0, 0, 48);
  }, { radial: .05, axial: .44, radius: 1.22 });

  const wheelLayout = [
    [-.48, .62, .2], [0, .72, .24], [.49, .6, .18], [-.77, .16, .22],
    [-.27, .18, .24], [.27, .18, .2], [.76, .16, .22], [-.58, -.42, .18],
    [-.12, -.5, .28], [.42, -.5, .2], [.74, -.48, .15], [.02, -.02, .16]
  ];
  wheelLayout.forEach(([x, y, radius], index) => {
    const part = addPart(`${["Barrel", "Center wheel", "Third wheel", "Fourth wheel"][index % 4]} gear ${String(index + 1).padStart(2, "0")}`, [x, y, .3], 3, (g) => {
      disc(g, radius * .9, .05, mat.graphite, 0, 0, 0, 48);
      torus(g, radius * .86, .025, index % 3 ? mat.brass : mat.gold, .03);
      for (let tooth = 0; tooth < 14; tooth++) {
        const angle = tooth * Math.PI / 7, r = radius * .88;
        box(g, [.055, .09, .045], mat.gold, [Math.cos(angle) * r, Math.sin(angle) * r, .015], angle);
      }
      for (let spoke = 0; spoke < 6; spoke++) {
        const angle = spoke * Math.PI / 3;
        box(g, [radius * .78, .025, .025], mat.steel, [Math.cos(angle) * radius * .4, Math.sin(angle) * radius * .4, .05], angle);
      }
      disc(g, radius * .28, .07, mat.darkSteel, .04, 0, 0, 32);
      disc(g, radius * .12, .075, mat.sapphire, .08, 0, 0, 24);
      disc(g, radius * .055, .08, mat.gold, .1, 0, 0, 16);
    }, { layer: 3, angle: Math.atan2(y, x), axial: .8, radius, speed: (index % 2 ? -1 : 1) * (.08 + index * .009) });
    if (index < 3) calloutParts.push(part);
  });

  const bridgePositions = [[-.46, .42, .48], [.42, .42, .49], [-.56, -.27, .47], [.36, -.34, .5], [0, .02, .53], [.02, -.72, .49]];
  bridgePositions.forEach(([x, y, z], index) => {
    const part = addPart(`${["Barrel", "Train", "Pallet", "Escape", "Balance", "Lower"][index]} bridge plate`, [x, y, z], 4, (g) => {
      const width = index === 4 ? .72 : .62, angle = index % 2 ? -.42 : .42;
      box(g, [width, .11, .035], mat.steel, [0, 0, 0], angle);
      box(g, [width * .88, .025, .018], mat.darkSteel, [0, .025, .028], angle);
      for (const side of [-1, 1]) {
        disc(g, .055, .035, mat.gold, .035, side * width * .38, 0, 20);
        disc(g, .026, .04, mat.black, .056, side * width * .38, 0, 16);
      }
    }, { axial: .95, radius: .42 });
    if (index === 4) calloutParts.push(part);
  });

  addPart("Oscillating balance wheel", [-.48, .66, .54], 4, (g) => {
    torus(g, .31, .026, mat.gold, 0);
    torus(g, .25, .014, mat.steel, .015);
    for (let i = 0; i < 8; i++) {
      const angle = i * Math.PI / 4;
      box(g, [.3, .022, .025], mat.brass, [Math.cos(angle) * .14, Math.sin(angle) * .14, .02], angle);
      disc(g, .025, .035, mat.sapphire, .035, Math.cos(angle) * .29, Math.sin(angle) * .29, 16);
    }
    disc(g, .075, .065, mat.darkSteel, .035, 0, 0, 32);
    disc(g, .034, .07, mat.ruby, .07, 0, 0, 24);
  }, { axial: 1.1, radius: .34, speed: .18 });

  addPart("Escape wheel", [.52, -.7, .52], 4, (g) => {
    disc(g, .19, .035, mat.graphite, 0, 0, 0, 48);
    torus(g, .17, .018, mat.gold, .03);
    for (let tooth = 0; tooth < 15; tooth++) {
      const angle = tooth * Math.PI * 2 / 15;
      box(g, [.075, .024, .027], mat.paleSteel, [Math.cos(angle) * .18, Math.sin(angle) * .18, .02], angle);
    }
    disc(g, .055, .07, mat.sapphire, .04, 0, 0, 24);
  }, { axial: 1.05, radius: .23, speed: -.23 });

  addPart("Pallet fork", [.05, .77, .54], 4, (g) => {
    box(g, [.45, .045, .04], mat.steel, [0, 0, 0], -.34);
    box(g, [.16, .04, .035], mat.gold, [-.16, .075, .018], .42);
    box(g, [.16, .04, .035], mat.gold, [.16, -.075, .018], .42);
    disc(g, .055, .045, mat.ruby, .03, 0, 0, 24);
  }, { axial: 1.1, radius: .28, speed: -.05 });

  const jewelPositions = [[-.2,.54],[.24,.58],[.63,.32],[-.68,.36],[-.4,.1],[.42,.07],[-.7,-.1],[.6,-.18],[-.44,-.55],[.1,-.68],[.55,-.55],[.02,.02]];
  jewelPositions.forEach(([x, y], index) => addPart(`Ruby bearing ${String(index + 1).padStart(2, "0")}`, [x, y, .59], 4, (g) => {
    disc(g, .075, .035, mat.gold, 0, 0, 0, 28);
    disc(g, .051, .04, mat.black, .025, 0, 0, 24);
    disc(g, .033, .046, index % 3 ? mat.sapphire : mat.ruby, .05, 0, 0, 24);
    disc(g, .012, .052, mat.paleSteel, .075, 0, 0, 16);
  }, { axial: 1.15, radius: .11 }));

  addPart("Hour hand", [0, 0, .66], 5, (g) => {
    box(g, [.065, .57, .024], mat.paleSteel, [0, .25, 0], -.24);
    box(g, [.025, .35, .018], mat.sapphire, [0, .26, .018], -.24);
    disc(g, .075, .035, mat.gold, .025, 0, 0, 32);
  }, { axial: 1.2, radius: .6 });
  addPart("Minute hand", [0, 0, .7], 5, (g) => {
    box(g, [.045, .83, .02], mat.gold, [0, .38, 0], .12);
    box(g, [.014, .59, .015], mat.sapphire, [0, .4, .015], .12);
    disc(g, .055, .03, mat.paleSteel, .025, 0, 0, 32);
  }, { axial: 1.3, radius: .85 });
  addPart("Seconds hand", [0, 0, .74], 5, (g) => {
    box(g, [.018, 1.03, .014], mat.ruby, [0, .49, 0], -.06);
    disc(g, .042, .028, mat.gold, .02, 0, 0, 28);
    torus(g, .055, .012, mat.ruby, .04);
  }, { axial: 1.35, radius: .95, speed: -.035 });

  for (let index = 0; index < 12; index++) {
    const angle = index * Math.PI / 6, x = Math.sin(angle) * .98, y = -Math.cos(angle) * .98;
    addPart(`Applied hour marker ${String(index + 1).padStart(2, "0")}`, [x, y, .56], 3, (g) => {
      box(g, [.075, .16, .035], mat.gold, [0, 0, 0]);
      box(g, [.034, .11, .02], mat.paleSteel, [0, 0, .025]);
      disc(g, .02, .024, mat.sapphire, .035, 0, -.065, 16);
    }, { angle, axial: .72, radial: .18, radius: .13 });
  }
  for (let index = 0; index < 39; index++) {
    const angle = index * Math.PI * 2 / 39, x = Math.sin(angle) * 1.12, y = -Math.cos(angle) * 1.12;
    addPart(`Minute track index ${String(index + 1).padStart(2, "0")}`, [x, y, .57], 2, (g) => {
      box(g, [.024, .075, .022], index % 3 ? mat.sapphire : mat.paleSteel, [0, 0, 0], -angle);
      disc(g, .014, .018, mat.gold, .015, 0, 0, 12);
    }, { angle, axial: .55, radial: .14, radius: .09 });
  }
  for (let index = 0; index < 8; index++) {
    const angle = index * Math.PI / 4, x = Math.cos(angle) * 1.4, y = Math.sin(angle) * 1.4;
    addPart(`Bezel lock screw ${String(index + 1).padStart(2, "0")}`, [x, y, .31], 4, (g) => {
      disc(g, .052, .045, mat.graphite, 0, 0, 0, 24);
      disc(g, .037, .05, mat.steel, .025, 0, 0, 24);
      box(g, [.046, .008, .008], mat.black, [0, 0, .053], angle);
      disc(g, .009, .012, mat.gold, .06, 0, 0, 12);
    }, { angle, axial: .9, radius: .09 });
  }
  addPart("Winding crown", [1.62, 0, .08], 5, (g) => {
    const crown = disc(g, .12, .2, mat.steel, 0, 0, 0, 32);
    crown.rotation.set(0, Math.PI / 2, 0);
    const cap = disc(g, .09, .03, mat.gold, .1, 0, 0, 32);
    cap.rotation.set(0, Math.PI / 2, 0);
    for (let i = 0; i < 12; i++) {
      const angle = i * Math.PI / 6;
      box(g, [.018, .17, .025], mat.darkSteel, [Math.cos(angle) * .11, Math.sin(angle) * .11, 0], angle);
    }
  }, { angle: 0, axial: .8, radius: .2 });

  if (parts.length !== 100) console.warn("Watch movement should contain 100 components; built", parts.length);
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
    status.textContent = part ? (part === selected ? "PINNED" : "INSPECTING") + " · " + part.name.toUpperCase() : "100 WATCH PARTS · HOVER TO INSPECT";
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
    camera.position.z = camera.aspect < .82 ? 8.1 : camera.aspect < 1.15 ? 7.8 : 7.3; camera.updateProjectionMatrix();
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
    console.info("Illustrative watch preview will use its SVG fallback.", error);
  }
}

start();
