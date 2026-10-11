// Small 3D pictures of each part for the side panel, rendered from the model itself.
// Used for every part that has no photo cut-out (inside parts, curated samples), so the list always shows the part.
import * as THREE from "three";

export function installThumbs(View) {
  const P = View.prototype;

  P.thumbRenderer = function () {
    if (this._thumbR) return this._thumbR;
    const r = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    r.setPixelRatio(1); r.setSize(112, 112); r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping; r.toneMappingExposure = 1.15;
    const scene = new THREE.Scene(); scene.environment = this.env;
    scene.add(new THREE.HemisphereLight(0xe8f0ff, 0x1a1d24, 1.1));
    const key = new THREE.DirectionalLight(0xffffff, 1.6); key.position.set(3, 5, 4); scene.add(key);
    const rim = new THREE.DirectionalLight(0x59d8ff, 1.2); rim.position.set(-4, 2, -3); scene.add(rim);
    const cam = new THREE.PerspectiveCamera(30, 1, 0.01, 100);
    this._thumbR = { r, scene, cam };
    return this._thumbR;
  };

  // one part, alone, in a three-quarter view; returns a PNG data URL (cached per part)
  P.partThumb = function (id) {
    this._thumbs ||= new Map();
    if (this._thumbs.has(id)) return this._thumbs.get(id);
    const p = this.parts.find((q) => q.id === id); if (!p) return null;
    const { r, scene, cam } = this.thumbRenderer();
    const holder = new THREE.Group(); scene.add(holder);
    p.group.updateMatrixWorld(true);
    const inv = p.group.matrixWorld.clone().invert(), restore = [];
    p.group.traverse((o) => {
      if (!o.isMesh || !o.visible || o.material?.isShaderMaterial || !o.geometry) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) { // show the part as built, not dimmed, glowing or ghosted
        restore.push([m, m.opacity, m.transparent, m.emissive?.getHex(), m.emissiveIntensity, m.depthWrite]);
        m.opacity = m.userData.baseOpacity ?? (m.opacity < 0.2 ? 1 : m.opacity); m.transparent = m.opacity < 1; m.depthWrite = true;
        if (m.emissive) { m.emissive.setHex(0); m.emissiveIntensity = 0; }
      }
      const c = new THREE.Mesh(o.geometry, o.material); c.matrixAutoUpdate = false;
      c.matrix.multiplyMatrices(inv, o.matrixWorld); holder.add(c);
    });
    holder.quaternion.copy(p.baseQuat || new THREE.Quaternion()); holder.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(holder);
    let url = null;
    if (!box.isEmpty()) {
      const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3()), rad = Math.max(1e-3, s.length() / 2);
      const d = rad / Math.sin(THREE.MathUtils.degToRad(cam.fov / 2)) * 1.08;
      cam.position.copy(c).add(new THREE.Vector3(0.62, 0.55, 0.85).normalize().multiplyScalar(d));
      cam.near = d / 50; cam.far = d * 4; cam.updateProjectionMatrix(); cam.lookAt(c);
      r.setClearColor(0x000000, 0); r.render(scene, cam);
      url = r.domElement.toDataURL("image/png");
    }
    for (const [m, op, tr, em, ei, dw] of restore) { m.opacity = op; m.transparent = tr; m.depthWrite = dw; if (m.emissive && em != null) { m.emissive.setHex(em); m.emissiveIntensity = ei; } }
    scene.remove(holder);
    this._thumbs.set(id, url);
    return url;
  };

  // render all thumbnails a few at a time so the page stays smooth; calls back when done
  P.makeThumbs = function (ids, done) {
    this._thumbs = new Map(); const run = (this._thumbRun = (this._thumbRun || 0) + 1);
    const list = [...ids];
    const step = () => {
      if (run !== this._thumbRun) return;
      if (this.intro || !this.lastPaint || !this.root.visible) { setTimeout(step, 200); return; } // after the build-up animation, with the real materials
      for (let i = 0; i < 4 && list.length; i++) this.partThumb(list.shift());
      if (list.length) setTimeout(step, 16); else done?.();
    };
    setTimeout(step, 50);
  };
}
