"""Recorded responses for VRE_FIXTURE_MODE=1 (frontend development only).

These are hand-written example model outputs, NOT live inference. Every analysis built from
them carries provider.name="fixture" so the UI can show a "sample" badge.
"""

from __future__ import annotations

import json

from .vision_provider import FixtureVisionClient

DIGITAL_FIXTURE = {
    "title": "Landing page (fixture)",
    "summary": "FIXTURE DATA: a marketing landing page with a top navigation bar, a hero section with a "
    "headline and call-to-action button, and a row of three feature cards.",
    "components": [
        {"id": "navbar", "label": "Top navigation bar", "type": "navbar", "status": "observed",
         "evidence": ["Full-width bar at top with logo and links"], "box_2d": [0, 0, 80, 1000], "parentId": None},
        {"id": "logo", "label": "Logo", "type": "logo", "status": "observed",
         "evidence": ["Brand mark at top-left"], "box_2d": [20, 30, 60, 160], "parentId": "navbar"},
        {"id": "hero-section", "label": "Hero section", "type": "hero", "status": "observed",
         "evidence": ["Large banner below navigation"], "box_2d": [90, 0, 520, 1000], "parentId": None},
        {"id": "hero-heading", "label": "Heading: Build faster", "type": "heading", "status": "observed",
         "evidence": ["Visible text: Build faster"], "box_2d": [180, 100, 260, 600], "parentId": "hero-section"},
        {"id": "hero-cta", "label": "Get started button", "type": "button", "status": "observed",
         "evidence": ["Visible label: Get started"], "box_2d": [330, 100, 390, 280], "parentId": "hero-section"},
        {"id": "feature-card-1", "label": "Feature card: Fast", "type": "card", "status": "observed",
         "evidence": ["Card with heading 'Fast'"], "box_2d": [580, 60, 900, 320]},
        {"id": "feature-card-2", "label": "Feature card: Secure", "type": "card", "status": "observed",
         "evidence": ["Card with heading 'Secure'"], "box_2d": [580, 370, 900, 630]},
        {"id": "feature-card-3", "label": "Feature card: Simple", "type": "card", "status": "observed",
         "evidence": ["Card with heading 'Simple'"], "box_2d": [580, 680, 900, 940]},
    ],
    "relationships": [
        {"from": "feature-card-1", "to": "feature-card-2", "type": "visually_aligned_with",
         "evidence": ["Same top edge and size"]},
        {"from": "feature-card-2", "to": "feature-card-3", "type": "visually_aligned_with",
         "evidence": ["Same top edge and size"]},
        {"from": "hero-heading", "to": "hero-cta", "type": "appears_related_to",
         "evidence": ["Button sits directly under the headline"]},
    ],
    "limitations": ["Fixture data for UI development; not produced by a model."],
}

CHAT_FIXTURE = {
    "answer": "FIXTURE ANSWER: The 'Get started' button (hero-cta) inside the hero section appears to be the "
    "main call to action. What it does when clicked is not visible in the screenshot.",
    "referencedComponentIds": ["hero-cta", "hero-section"],
    "referencedRelationshipIds": [],
    "limitations": ["Fixture answer for UI development; not produced by a model."],
}


def default_fixture_client() -> FixtureVisionClient:
    return FixtureVisionClient({"digital": json.dumps(DIGITAL_FIXTURE), "chat": json.dumps(CHAT_FIXTURE)})
