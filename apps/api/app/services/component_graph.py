"""Deterministic component-graph operations: validation + what-if traversal.

Edge direction convention: ``from -> to`` means "``to`` depends on ``from``"
for propagating types (e.g. battery --powers--> motor). Removing a component
affects everything reachable through outgoing propagating edges.

This is graph-based reasoning over the extracted relationships, NOT a physics
or engineering simulation.
"""
from __future__ import annotations

import re
from collections import deque

from ..schemas import Component, Relationship

# Types where losing ``from`` plausibly disables/affects ``to``.
PROPAGATING_TYPES = {"powers", "drives", "controls", "supports", "transmits", "feeds", "mounts", "depends_on"}
# Types that describe structure only; they never propagate failure.
NON_PROPAGATING_TYPES = {"connected_to", "contains", "attached_to", "adjacent_to", "covers"}
ALLOWED_TYPES = PROPAGATING_TYPES | NON_PROPAGATING_TYPES

# What the last link in a chain means for the affected part.
IMPACT = {
    "powers": ("loses power", "fails"), "feeds": ("loses its supply", "fails"),
    "controls": ("loses its control signal", "fails"), "depends_on": ("stops working", "fails"),
    "drives": ("stops moving", "fails"), "transmits": ("stops receiving motion", "fails"),
    "supports": ("comes loose", "loose"), "mounts": ("falls off its mount", "loose"),
}
CRITICAL_TYPES = {"power_source", "controller"}

METHOD = "graph-based what-if (dependency traversal over AI-extracted relationships; not a physics simulation)"


def validate_relationships(
    components: list[Component], relationships: list[Relationship]
) -> tuple[list[Relationship], list[str]]:
    """Drop edges with unknown endpoints, self-loops or duplicates; return warnings."""
    ids = {c.id for c in components}
    seen: set[tuple[str, str, str]] = set()
    seen_ids: set[str] = set()
    valid: list[Relationship] = []
    warnings: list[str] = []
    for r in relationships:
        key = (r.from_, r.to, r.type)
        if r.from_ not in ids or r.to not in ids:
            warnings.append(f"Dropped relationship '{r.id}': unknown endpoint.")
            continue
        if r.from_ == r.to:
            warnings.append(f"Dropped relationship '{r.id}': self-loop.")
            continue
        if key in seen:
            warnings.append(f"Dropped relationship '{r.id}': duplicate.")
            continue
        if r.id in seen_ids:
            r = r.model_copy(update={"id": f"{r.id}-{len(valid)}"})
        seen.add(key)
        seen_ids.add(r.id)
        valid.append(r)
    return valid, warnings


def what_if(
    components: list[Component], relationships: list[Relationship], removed_id: str
) -> dict:
    by_id = {c.id: c for c in components}
    if removed_id not in by_id:
        raise KeyError(removed_id)
    rels, _ = validate_relationships(components, relationships)

    out: dict[str, list[Relationship]] = {}
    for r in rels:
        if r.type in PROPAGATING_TYPES:
            out.setdefault(r.from_, []).append(r)
    for edges in out.values():
        edges.sort(key=lambda e: (e.to, e.id))  # determinism

    # BFS with state: a removed or failed part passes failure along every dependency edge; a part that
    # only comes loose passes on only structural effects (what is mounted on it comes loose too).
    structural = {"supports", "mounts"}
    parent: dict[str, tuple[str, Relationship]] = {}
    depth = {removed_id: 0}
    state = {removed_id: "fails"}
    queue = deque([removed_id])
    order: list[str] = []
    while queue:
        node = queue.popleft()
        for e in out.get(node, []):
            if state[node] == "loose" and e.type not in structural:
                continue
            new = "loose" if e.type in structural else "fails"
            if e.to == removed_id:
                continue
            if e.to in state and not (state[e.to] == "loose" and new == "fails"):
                continue
            if e.to not in state:
                order.append(e.to)
            depth[e.to] = depth[node] + 1
            parent[e.to] = (node, e)
            state[e.to] = new
            queue.append(e.to)
    first = {c: i for i, c in enumerate(order)}
    order.sort(key=lambda c: (depth[c], first[c]))

    affected = []
    for cid in order:
        path_ids = [cid]
        via: list[Relationship] = []
        cur = cid
        while cur != removed_id and len(path_ids) <= len(components):  # guard: never loop
            prev, edge = parent[cur]
            via.append(edge)
            path_ids.append(prev)
            cur = prev
        path_ids.reverse()
        via.reverse()
        chain = by_id[path_ids[0]].label
        for edge, nid in zip(via, path_ids[1:]):
            chain += f" --{edge.type}--> {by_id[nid].label}"
        uncertain = any(e.status != "observed" for e in via)
        impact, severity = IMPACT.get(via[-1].type, ("is affected", "fails"))
        severity = state[cid]
        affected.append({
            "impact": impact,
            "severity": severity,
            "why": via[-1].evidence[0] if via[-1].evidence else "",
            "componentId": cid,
            "label": by_id[cid].label,
            "hops": depth[cid],
            "path": path_ids,
            "viaRelationshipIds": [e.id for e in via],
            "explanation": chain,
            "uncertain": uncertain,
        })

    unaffected = [c.id for c in components if c.id != removed_id and c.id not in depth]
    label = by_id[removed_id].label
    if affected:
        summary = (f"Removing {label} affects {len(affected)} component(s) through dependency edges. "
                   + ("Some links are inferred, so treat these as hypotheses." if any(a["uncertain"] for a in affected) else ""))
    else:
        summary = f"No dependency edges lead out of {label}, so the graph predicts no downstream effect."
    # System health: share of importance that keeps working (parts that only come loose count half).
    weight = {c.id: _weight(c) for c in components}
    total = sum(weight.values()) or 1.0
    lost = weight[removed_id] + sum(weight[a["componentId"]] * (1.0 if a["severity"] == "fails" else 0.5) for a in affected)
    health = max(0, min(100, round(100 * (1 - lost / total))))
    fails = sum(a["severity"] == "fails" for a in affected)
    removed = by_id[removed_id]
    critical = removed.type in CRITICAL_TYPES or (weight[removed_id] >= 0.85)
    # an electronic device without its board or its power source does not work, whatever the graph links say
    electronic = sum(c.type in _ELECTRIC for c in components if c.id != removed_id) >= 2
    # the only sensor of a device is what it exists for (a mouse without its optical sensor cannot track)
    core = removed.type in _CORE_IO and not _DECOR.search(removed.label) \
        and sum(c.type == removed.type and not _DECOR.search(c.label) for c in components) == 1
    if core and removed.type == "sensor":
        critical = True
    if (critical and (fails or electronic)) or health < 35:
        verdict = "dead"
    elif affected or weight[removed_id] >= 0.3:
        verdict = "degraded"
    else:
        verdict = "works"
    if verdict == "dead":  # the main function is gone: what is left working is only passive structure
        health = min(health, 10)
    elif core:  # the only screen is gone: it still runs, but you cannot use it
        verdict, health = "degraded", min(health, 30)
    return {
        "removedComponentId": removed_id,
        "consequence": getattr(removed, "if_removed", "") or _why(removed, verdict, core, affected),
        "health": health,
        "verdict": verdict,
        "affected": affected,
        "unaffectedComponentIds": unaffected,
        "summary": summary.strip(),
        "method": METHOD,
    }


# ---------------------------------------------------------------- completing a sparse graph
# The model often returns only structural links (housing mounts button), which leaves the board, battery
# and connectors floating with no edges. These rules add the usual functional backbone from the part
# types alone. Every added edge is status "inferred" and says so in its evidence; observed edges are
# never changed and nothing is added where the model already linked the parts.
_POWER_WORDS = ("batter", "power", "charg", "cell", "psu", "supply")
# typical share of the device's function when the model gave no importance (0..1)
_TYPE_WEIGHT = {"controller": 0.95, "power_source": 0.9, "sensor": 0.75, "display": 0.75, "mechanism": 0.7, "actuator": 0.4,
                "wheel": 0.35, "interface": 0.3, "connector": 0.3, "structure": 0.45, "cover": 0.35, "fastener": 0.15, "cable": 0.3}
_CORE_IO = {"sensor", "display"}


def _why(c: Component, verdict: str, core: bool, affected: list) -> str:
    """One plain sentence for the impact card when the model gave none."""
    name = c.label[0].lower() + c.label[1:] if c.label else "this part"
    if verdict == "dead" and c.type == "power_source":
        return f"Nothing gets power without the {name}."
    if verdict == "dead" and c.type == "controller":
        return f"The {name} runs everything else; without it nothing responds."
    if verdict == "dead" and core:
        return f"The {name} is what the device exists for; without it it cannot do its job."
    if verdict == "dead":
        return f"The device cannot work without the {name}."
    if core:
        return f"It still runs, but without its only {c.type} it cannot be used."
    if not affected:
        return f"Nothing else depends on the {name}; you lose only what it does itself."
    return ""


def _weight(c: Component) -> float:
    if _DECOR.search(c.label):
        return 0.05  # a logo or sticker carries almost no function
    if getattr(c, "importance", None) is not None:
        return c.importance
    return _TYPE_WEIGHT.get(c.type, 0.4)


_ELECTRIC = {"controller", "power_source", "display", "sensor", "actuator", "interface", "mechanism", "light", "speaker"}
_OUTPUT_TYPES = {"display", "interface", "mechanism", "light", "speaker"}
_INPUT_TYPES = {"actuator", "sensor", "wheel", "button", "switch"}
_DECOR = re.compile(r"logo|badge|sticker|label|decal|emblem|print", re.I)


def _is_power(c: Component) -> bool:
    return c.type == "power_source" or any(w in c.label.lower() for w in _POWER_WORDS)


def complete_relationships(components: list[Component], relationships: list[Relationship]) -> list[Relationship]:
    """Return relationships plus inferred type-based edges that connect the functional parts."""
    if not components:
        return relationships
    rels = list(relationships)
    linked = {(r.from_, r.to) for r in rels} | {(r.to, r.from_) for r in rels}
    typed = {(r.from_, r.to, r.type) for r in rels}
    functional = {(r.from_, r.to) for r in rels if r.type in ("controls", "powers", "feeds", "depends_on", "drives")}
    degree: dict[str, int] = {}
    for r in rels:
        degree[r.from_] = degree.get(r.from_, 0) + 1
        degree[r.to] = degree.get(r.to, 0) + 1
    imp = lambda c: (c.importance if c.importance is not None else 0.5, degree.get(c.id, 0))  # noqa: E731
    controllers = [c for c in components if c.type == "controller"]
    board = max(controllers, key=imp) if controllers else None
    shells = [c for c in components if c.type in ("structure", "cover")]
    housing = max(shells, key=lambda c: (c.type == "structure", degree.get(c.id, 0), imp(c))) if shells else None
    n = 0

    def add(a: Component, b: Component, typ: str, why: str) -> None:
        nonlocal n
        if a.id == b.id or (a.id, b.id, typ) in typed or (typ in ("contains", "supports") and (a.id, b.id) in linked):
            return
        n += 1
        rels.append(Relationship(id=f"auto-{n}-{a.id}-{b.id}"[:80], **{"from": a.id}, to=b.id, type=typ, status="inferred",
                                 evidence=[f"Not seen in the photo: inferred from the part types ({why})."]))
        linked.add((a.id, b.id)); linked.add((b.id, a.id)); typed.add((a.id, b.id, typ))
        degree[a.id] = degree.get(a.id, 0) + 1
        degree[b.id] = degree.get(b.id, 0) + 1

    powers_out = {r.from_ for r in rels if r.type in ("powers", "feeds")}
    controlled = {r.to for r in rels if r.type == "controls"}
    for c in components:
        if board is not None and c.id != board.id:
            if _is_power(c) and c.id not in powers_out and c.type in ("power_source", "connector", "storage", "unknown"):
                add(c, board, "powers", "a battery or power input feeds the main board")
            elif c.type in _OUTPUT_TYPES and c.id not in controlled and not _DECOR.search(c.label):
                add(board, c, "controls", "the main board drives screens, speakers and motors")
            elif c.type in _INPUT_TYPES and (board.id, c.id) not in functional:
                # what-if direction: without the board a button or sensor has nothing to report to
                add(board, c, "controls", "buttons and sensors only do something through the main board")
            elif c.type == "connector" and not _is_power(c):
                add(board, c, "depends_on", "a connector is only useful while the board behind it works")
            elif c.type == "controller":
                add(board, c, "controls", "secondary boards are run by the main board")
    if board is not None and housing is not None:
        add(housing, board, "supports", "the board is screwed into the main housing")
    for c in components:  # anything still floating sits in the housing
        if housing is not None and degree.get(c.id, 0) == 0 and c.id != housing.id:
            add(housing, c, "contains", "it sits inside the main housing")
    return rels
