// TypeScript mirror of apps/api/app/contract.py (canonical) and contracts/system-analysis.schema.json.
// Owner: Krishna. Additive changes only. Copy into the frontend or import from here.

export type Domain = "physical" | "digital";
export type Status = "observed" | "inferred" | "estimated" | "unknown";

/** Normalized 0–1, top-left origin. Pixel box = { x: x*imgW, y: y*imgH, w: width*imgW, h: height*imgH }. */
export interface BBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Transform {
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
}

export interface Component {
  id: string;
  label: string;
  /** e.g. button, card, heading, input, chart, power_source ... ("unknown" when unsure) */
  type: string;
  status: Status;
  /** Always null today: model scores are not calibrated. */
  confidence: number | null;
  evidence: string[];
  bbox: BBox | null;
  modelNodeId: string | null;
  transform: Transform | null;
  /** Physical only (AI estimate, may be ""): what the part does. */
  function?: string;
  /** Physical only (AI estimate, may be ""): what stops working without it. */
  ifRemoved?: string;
  /** Physical only: 0–1, how much the object's main function depends on it (null = unknown). */
  importance?: number | null;
}

/** Edge rule: from -> to means "to depends on from" (e.g. hero-section --contains--> hero-cta). */
export interface Relationship {
  id: string;
  from: string;
  to: string;
  type: string;
  status: Status;
  confidence: number | null;
  evidence: string[];
}

/** Physical only (spec: docs/PHYSICAL_LAB.md; Python source of truth for these fields: apps/api/app/schemas.py). */
export interface SceneLayer {
  componentId: string;
  bbox: BBox;
  /** data URL, RGBA PNG */
  cutout: string;
  /** 0 = front */
  depthRank: number;
  /** which photo (scene.views[i]) this layer was cut from; 0 for single-photo analyses */
  viewIndex?: number;
}

/** One photo of the object (multi-photo analyses have one per photo). */
export interface SceneView {
  index: number;
  /** top | bottom | front | back | left | right | three-quarter | inside | unknown */
  view: string;
  filename: string;
  imageWidth: number;
  imageHeight: number;
  plate: string | null;
  plateBbox: BBox | null;
  layers: SceneLayer[];
}

/** Exact-product identification (AI match; web-checked when Google Search grounding was available). */
export interface Product {
  category: string;
  brand: string | null;
  model: string | null;
  searchQuery: string;
  /** why: logo, label text, shape match ... */
  identifiedFrom: string;
  /** 0–1 model confidence (null = old result without the identification step) */
  confidence?: number | null;
  /** label/logo text the model could actually read */
  visibleText?: string;
  /** real published size [w, h, d] mm, fed into the 3D proportions */
  dimensionsMm?: number[] | null;
  /** other likely models: show as "Not it? Maybe:" buttons */
  candidates?: { brand: string | null; model: string; confidence: number }[];
  /** web sources (only when web search was used) */
  sources?: { title: string; url: string }[];
  /** model name the user typed/picked (sent back as form field model_hint) */
  userHint?: string;
  /** true only when the answer is backed by web sources */
  webChecked?: boolean;
}

/** One part as a simple solid (model estimate). mm; x right, y up, z front; origin = object centre. */
export interface AssemblyPart {
  componentId: string;
  shape: string;
  size: number[];
  position: number[];
  rotation: number[];
  color: string;
  material: string;
  explodeDir: number[];
  explodeDist: number;
}

/** Small surface feature (screw, vent, port, LED, label...) that moves with its parent part. */
export interface AssemblyDetail {
  parentId: string;
  /** part shapes plus "cross" and "slots" */
  shape: string;
  size: number[];
  /** absolute, same frame as parts */
  position: number[];
  rotation: number[];
  color: string;
  material: string;
  /** "slots": number of parallel slots */
  count: number;
}

/** Simplified 3D model for the 360-degree exploded view. */
export interface Assembly {
  kind: "primitive-assembly";
  units: string;
  overallSize: number[];
  parts: AssemblyPart[];
  details?: AssemblyDetail[];
}

export interface Scene {
  kind: "layered-2.5d";
  imageWidth: number;
  imageHeight: number;
  plate: string | null;
  plateBbox: BBox | null;
  layers: SceneLayer[];
  ghostComponentIds: string[];
  notes: string[];
  /** all photos; top-level plate/layers mirror views[0] */
  views?: SceneView[];
  product?: Product | null;
  assembly?: Assembly | null;
}

export interface SampleInfo {
  id: string;
  title: string;
  savedAt: string | null;
  note: string;
  /** relative to the API base URL */
  imageUrl: string;
}

export interface SystemAnalysis {
  analysisId: string;
  domain: Domain;
  title: string;
  source: { kind: string; filename: string | null };
  assetId: string | null;
  components: Component[];
  relationships: Relationship[];
  summary: string;
  limitations: string[];
  provider: { name: string; model: string };
  /** Present only for physical results. */
  scene?: Scene;
  /** Present only when served from /api/digital/samples/{id}. Show a "saved result" badge. */
  sample?: SampleInfo;
}

export interface DigitalSampleSummary extends SampleInfo {
  analysisId: string;
  components: number;
  relationships: number;
  provider: { name: string; model: string };
}

export interface ChatRequest {
  question: string;
  selectedComponentIds?: string[];
  selectedRelationshipIds?: string[];
}

export interface ChatResponse {
  answer: string;
  referencedComponentIds: string[];
  referencedRelationshipIds: string[];
  limitations: string[];
}

/** POST /api/physical/whatif  body: { analysisId, removedComponentId, components?, relationships? } */
export interface WhatIfAffected {
  componentId: string;
  label: string;
  /** steps from the removed part (use it to time a cascade animation) */
  hops: number;
  path: string[];
  viaRelationshipIds: string[];
  /** e.g. "Main PCB --powers--> Optical sensor" */
  explanation: string;
  /** true when any link on the path is inferred */
  uncertain: boolean;
  /** "loses power" | "loses its control signal" | "stops moving" | "comes loose" | ... */
  impact: string;
  /** fails = stops working; loose = falls off / comes loose */
  severity: "fails" | "loose";
  /** evidence of the last link */
  why: string;
}

export interface WhatIfResponse {
  removedComponentId: string;
  /** removed part's ifRemoved text ("" if unknown) */
  consequence: string;
  /** 0–100 share of the object's function still working (graph estimate, not physics) */
  health: number;
  /** physical what-if: dead | degraded | works; digital what-if (a screen): broken | degraded | works */
  verdict: "dead" | "broken" | "degraded" | "works";
  affected: WhatIfAffected[];
  unaffectedComponentIds: string[];
  summary: string;
  method: string;
}

export interface ApiErrorBody {
  error: { code: string; message: string };
}

export const PROPAGATING_EDGE_TYPES = [
  "powers", "drives", "controls", "supports", "transmits", "feeds", "mounts", "depends_on",
] as const;

/** Unknown edge types are structural (never propagate in what-if). */
export const isPropagating = (type: string): boolean =>
  (PROPAGATING_EDGE_TYPES as readonly string[]).includes(type);

/** True when the result is not live inference (fixture mode) — always show a badge. */
export const isFixture = (a: SystemAnalysis): boolean => a.provider.name === "fixture";
