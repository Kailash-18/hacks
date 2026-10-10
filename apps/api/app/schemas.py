"""Shared SystemAnalysis contract (see API_CONTRACT.md).

Krishna owns the canonical schema. This module mirrors the contract exactly and
adds one optional, additive field: ``scene`` (physical layered-explode data).
"""
from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

Status = Literal["observed", "inferred", "estimated", "unknown"]
Domain = Literal["physical", "digital"]


class _Model(BaseModel):
    model_config = ConfigDict(populate_by_name=True)


class BBox(_Model):
    """Normalized 0-1, origin top-left."""
    x: float = Field(ge=0, le=1)
    y: float = Field(ge=0, le=1)
    width: float = Field(ge=0, le=1)
    height: float = Field(ge=0, le=1)


class Transform(_Model):
    position: list[float] = [0, 0, 0]
    rotation: list[float] = [0, 0, 0]
    scale: list[float] = [1, 1, 1]


class Component(_Model):
    id: str
    label: str
    type: str = "unknown"
    status: Status = "unknown"
    confidence: Optional[float] = Field(default=None, ge=0, le=1)
    evidence: list[str] = []
    bbox: Optional[BBox] = None
    model_node_id: Optional[str] = Field(default=None, alias="modelNodeId")
    transform: Optional[Transform] = None


class Relationship(_Model):
    id: str
    from_: str = Field(alias="from")
    to: str
    type: str
    status: Status = "inferred"
    confidence: Optional[float] = Field(default=None, ge=0, le=1)
    evidence: list[str] = []


class Source(_Model):
    kind: Literal["image"] = "image"
    filename: str


class Provider(_Model):
    name: str
    model: str


# ---- Physical "layered explode" scene (additive extension) -----------------

class SceneLayer(_Model):
    component_id: str = Field(alias="componentId")
    bbox: BBox
    cutout: str  # data URL, RGBA image cropped to bbox
    depth_rank: int = Field(alias="depthRank")  # 0 = front-most (model estimate)
    view_index: int = Field(default=0, alias="viewIndex")


class SceneView(_Model):
    """One photo of the object. Multi-photo analyses have one entry per photo."""
    index: int
    view: str = "unknown"  # top | bottom | front | back | left | right | three-quarter | inside | unknown
    filename: str = ""
    image_width: int = Field(alias="imageWidth")
    image_height: int = Field(alias="imageHeight")
    plate: Optional[str] = None
    plate_bbox: Optional[BBox] = Field(default=None, alias="plateBbox")
    layers: list[SceneLayer] = []


class Product(_Model):
    """Model-stated identification. Only as reliable as the visible logos/text."""
    category: str = ""
    brand: Optional[str] = None
    model: Optional[str] = None
    search_query: str = Field(default="", alias="searchQuery")
    identified_from: str = Field(default="", alias="identifiedFrom")


class AssemblyPart(_Model):
    """One part as a simple solid (model estimate). mm, x right, y up, z front; origin = object centre."""
    component_id: str = Field(alias="componentId")
    shape: str
    size: list[float]
    position: list[float]
    rotation: list[float] = [0, 0, 0]
    color: str = "#9aa0a6"
    material: str = "plastic"
    explode_dir: list[float] = Field(default=[0, 1, 0], alias="explodeDir")
    explode_dist: float = Field(default=1.0, alias="explodeDist")


class AssemblyDetail(_Model):
    """Small surface feature (screw, vent, port, LED, label...) that belongs to and moves with a part."""
    parent_id: str = Field(alias="parentId")
    shape: str
    size: list[float]
    position: list[float]  # absolute, same frame as parts
    rotation: list[float] = [0, 0, 0]
    color: str = "#30343b"
    material: str = "plastic"
    count: int = 1  # for "slots": number of parallel slots


class Assembly(_Model):
    kind: Literal["primitive-assembly"] = "primitive-assembly"
    units: str = "mm"
    overall_size: list[float] = Field(alias="overallSize")
    parts: list[AssemblyPart] = []
    details: list[AssemblyDetail] = []


class Scene(_Model):
    kind: Literal["layered-2.5d"] = "layered-2.5d"
    image_width: int = Field(alias="imageWidth")
    image_height: int = Field(alias="imageHeight")
    plate: Optional[str] = None  # data URL: object body with part holes inpainted
    plate_bbox: Optional[BBox] = Field(default=None, alias="plateBbox")
    layers: list[SceneLayer] = []
    ghost_component_ids: list[str] = Field(default=[], alias="ghostComponentIds")
    notes: list[str] = []
    views: list[SceneView] = []  # all photos (top-level plate/layers mirror views[0] for compatibility)
    product: Optional[Product] = None
    assembly: Optional[Assembly] = None  # simplified 3D model for the 360-degree exploded view


class SystemAnalysis(_Model):
    analysis_id: str = Field(alias="analysisId")
    domain: Domain
    title: str
    source: Source
    asset_id: Optional[str] = Field(default=None, alias="assetId")
    components: list[Component]
    relationships: list[Relationship]
    summary: str = ""
    limitations: list[str] = []
    provider: Provider
    scene: Optional[Scene] = None

    def dump(self) -> dict:
        return self.model_dump(by_alias=True, mode="json")


class WhatIfRequest(_Model):
    analysis_id: str = Field(alias="analysisId")
    removed_component_id: str = Field(alias="removedComponentId")
    # Optional: the client can send the graph itself, so what-if works even after a server restart.
    components: Optional[list[Component]] = None
    relationships: Optional[list[Relationship]] = None
