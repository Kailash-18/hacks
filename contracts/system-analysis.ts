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

/** Physical only (spec: docs/PHYSICAL_LAB.md). */
export interface SceneLayer {
  componentId: string;
  bbox: BBox;
  /** data URL, RGBA PNG */
  cutout: string;
  /** 0 = front */
  depthRank: number;
}

export interface Scene {
  kind: "layered-2.5d";
  imageWidth: number;
  imageHeight: number;
  plate: string;
  plateBbox: BBox;
  layers: SceneLayer[];
  ghostComponentIds: string[];
  notes: string[];
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
