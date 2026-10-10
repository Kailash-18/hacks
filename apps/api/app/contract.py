"""Canonical SystemAnalysis contract shared by Physical Lab and Digital Lab.

Owner: Krishna. Changes after integration must be additive.

Edge direction rule (agreed with Samvit): ``from -> to`` means "``to`` depends on ``from``".
Example: battery --powers--> flight_controller; hero-section --contains--> hero-cta.
"""

from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

Domain = Literal["physical", "digital"]
Status = Literal["observed", "inferred", "estimated", "unknown"]
STATUSES: frozenset[str] = frozenset({"observed", "inferred", "estimated", "unknown"})

# --- Edge taxonomy -----------------------------------------------------------
# Propagating edges carry a dependency: removing `from` can affect `to` in what-if.
PROPAGATING_EDGE_TYPES: frozenset[str] = frozenset(
    {"powers", "drives", "controls", "supports", "transmits", "feeds", "mounts", "depends_on"}
)
# Structural edges describe layout/containment only; they never propagate in what-if.
STRUCTURAL_EDGE_TYPES: frozenset[str] = frozenset(
    {"connected_to", "contains", "attached_to", "adjacent_to", "covers"}
)
# Digital (single-screenshot) visual relations. Structural: they never propagate.
DIGITAL_VISUAL_EDGE_TYPES: frozenset[str] = frozenset(
    {"contains", "label_for", "visually_aligned_with", "appears_related_to", "adjacent_to", "covers"}
)
# Claims a single screenshot can never establish. Digital analysis rewrites these.
UNPROVABLE_FROM_PIXELS: frozenset[str] = frozenset(
    {"navigates_to", "calls_api", "submits_to", "fetches", "triggers", "opens", "links_to", "updates"}
)


def is_propagating(edge_type: str) -> bool:
    """Unknown types are treated as structural (non-propagating) instead of being rewritten."""
    return edge_type in PROPAGATING_EDGE_TYPES


# --- Models ------------------------------------------------------------------
class _Base(BaseModel):
    # extra="allow" keeps additive fields from teammates instead of failing integration.
    model_config = ConfigDict(extra="allow", populate_by_name=True)


class BBox(_Base):
    """Normalized 0-1 box, top-left origin."""

    x: float = Field(ge=0.0, le=1.0)
    y: float = Field(ge=0.0, le=1.0)
    width: float = Field(gt=0.0, le=1.0)
    height: float = Field(gt=0.0, le=1.0)

    @model_validator(mode="after")
    def _inside_image(self) -> "BBox":
        eps = 1e-6
        if self.x + self.width > 1.0 + eps or self.y + self.height > 1.0 + eps:
            raise ValueError("bbox extends outside the normalized image (x+width or y+height > 1)")
        return self


class Transform(_Base):
    position: list[float] = Field(min_length=3, max_length=3)
    rotation: list[float] = Field(min_length=3, max_length=3)
    scale: list[float] = Field(min_length=3, max_length=3)


class Component(_Base):
    id: str = Field(min_length=1, max_length=120)
    label: str = Field(min_length=1, max_length=200)
    type: str = Field(min_length=1, max_length=60)
    status: Status
    confidence: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    evidence: list[str] = Field(default_factory=list)
    bbox: Optional[BBox] = None
    modelNodeId: Optional[str] = None
    transform: Optional[Transform] = None


class Relationship(_Base):
    id: str = Field(min_length=1, max_length=260)
    from_: str = Field(alias="from", min_length=1)
    to: str = Field(min_length=1)
    type: str = Field(min_length=1, max_length=60)
    status: Status
    confidence: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    evidence: list[str] = Field(default_factory=list)


class Source(_Base):
    kind: str = "image"
    filename: Optional[str] = None


class Provider(_Base):
    name: str
    model: str


class SceneLayer(_Base):
    componentId: str
    bbox: BBox
    cutout: str  # data URL, RGBA PNG
    depthRank: int = Field(ge=0)  # 0 = front


class Scene(_Base):
    """Physical-only layered 2.5D scene (spec: docs/PHYSICAL_LAB.md, owner Samvit)."""

    kind: Literal["layered-2.5d"] = "layered-2.5d"
    imageWidth: int = Field(gt=0)
    imageHeight: int = Field(gt=0)
    plate: Optional[str] = None  # data URL, object body with holes inpainted
    plateBbox: Optional[BBox] = None
    layers: list[SceneLayer] = Field(default_factory=list)
    ghostComponentIds: list[str] = Field(default_factory=list)
    notes: list[str] = Field(default_factory=list)


class SystemAnalysis(_Base):
    analysisId: str = Field(min_length=1)
    domain: Domain
    title: str
    source: Source
    assetId: Optional[str] = None
    components: list[Component] = Field(default_factory=list)
    relationships: list[Relationship] = Field(default_factory=list)
    summary: str = ""
    limitations: list[str] = Field(default_factory=list)
    provider: Provider
    scene: Optional[Scene] = None  # physical only; omitted from digital JSON

    @field_validator("relationships")
    @classmethod
    def _unique_relationship_ids(cls, rels: list[Relationship]) -> list[Relationship]:
        ids = [r.id for r in rels]
        if len(ids) != len(set(ids)):
            raise ValueError("relationship ids must be unique")
        return rels

    @model_validator(mode="after")
    def _referential_integrity(self) -> "SystemAnalysis":
        ids = [c.id for c in self.components]
        if len(ids) != len(set(ids)):
            raise ValueError("component ids must be unique")
        known = set(ids)
        for r in self.relationships:
            if r.from_ not in known or r.to not in known:
                raise ValueError(f"relationship {r.id!r} references an unknown component")
        if self.scene is not None:
            if self.domain != "physical":
                raise ValueError("scene is only valid for domain='physical'")
            for layer in self.scene.layers:
                if layer.componentId not in known:
                    raise ValueError(f"scene layer references unknown component {layer.componentId!r}")
            for gid in self.scene.ghostComponentIds:
                if gid not in known:
                    raise ValueError(f"ghost component {gid!r} is not in components")
        return self

    def to_api(self) -> dict[str, Any]:
        """Wire JSON: `from` alias, nulls kept (bbox/confidence), `scene` omitted when absent."""
        data = self.model_dump(by_alias=True, mode="json")
        if data.get("scene") is None:
            data.pop("scene", None)
        return data


class ChatRequest(_Base):
    question: str = Field(min_length=1, max_length=1000)
    selectedComponentIds: list[str] = Field(default_factory=list, max_length=50)
    selectedRelationshipIds: list[str] = Field(default_factory=list, max_length=50)


class ChatResponse(_Base):
    answer: str
    referencedComponentIds: list[str] = Field(default_factory=list)
    referencedRelationshipIds: list[str] = Field(default_factory=list)
    limitations: list[str] = Field(default_factory=list)


class ErrorBody(_Base):
    code: str
    message: str


class ErrorResponse(_Base):
    error: ErrorBody
