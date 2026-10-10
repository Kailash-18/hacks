// Dev-only test harness (not loaded by the app). Use from the console: await import('/viewer/devtest.js')
const TITLES = ["File:Game-Boy-FL.jpg", "File:Nintendo-Switch-wJoyCons-BlRd-Standing-FL.jpg", "File:Raspberry Pi 4 Model B - Top.jpg",
  "File:Raspberry Pi 4 Model B - Side.jpg", "File:Quadcopter camera drone in flight.jpg", "File:Apple Magic Mouse.jpg",
  "File:Xbox-360-Pro-wController.jpg", "File:Atari-2600-Wood-4Sw-Set.jpg"];
const d = await fetch(`https://commons.wikimedia.org/w/api.php?origin=*&action=query&titles=${encodeURIComponent(TITLES.join("|"))}&prop=imageinfo&iiprop=url&iiurlwidth=1200&format=json`).then((r) => r.json());
const urls = {};
Object.values(d.query.pages).forEach((p) => { if (p.imageinfo) urls[p.title] = p.imageinfo[0].thumburl; });
const getImg = async (t) => { const r = await fetch(urls[t]); if (!r.ok) throw new Error("img " + r.status); return r.blob(); };
async function run(ts) {
  const fd = new FormData();
  for (const [i, t] of ts.entries()) fd.append("images", await getImg(t), `photo${i + 1}.jpg`);
  const t0 = performance.now();
  const r = await fetch("/api/physical/analyze", { method: "POST", body: fd });
  const data = await r.json(); const secs = ((performance.now() - t0) / 1000).toFixed(1);
  if (!r.ok) return { status: r.status, secs, err: data };
  window.__last = data; await window.__vre.build(data);
  const s = data.scene;
  return { secs, timing: r.headers.get("Server-Timing"), title: data.title, product: s.product && [s.product.brand, s.product.model].join(" "),
    views: (s.views || []).map((v) => v.view + ":" + v.layers.length),
    seen: data.components.filter((c) => c.status === "observed").map((c) => c.label),
    inferred: data.components.filter((c) => c.status !== "observed").map((c) => c.label), rels: data.relationships.length, notes: s.notes };
}
window.__go = (ts) => { window.__res = null; run(ts).then((r) => (window.__res = r)).catch((e) => (window.__res = { jsErr: String(e) })); };
window.__titles = Object.keys(urls);
window.__pick = async (inputId, ts) => { // drive the real <input type=file> change handler
  const dt = new DataTransfer();
  for (const [i, t] of ts.entries()) dt.items.add(new File([await getImg(t)], `photo${i + 1}.jpg`, { type: "image/jpeg" }));
  const inp = document.getElementById(inputId); inp.files = dt.files; inp.dispatchEvent(new Event("change"));
};
