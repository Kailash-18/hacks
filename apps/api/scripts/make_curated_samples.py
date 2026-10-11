"""Build the two curated Physical samples: a MacBook Air 13-inch (M3) and a custom gaming PC tower.

    cd apps/api
    python scripts/make_curated_samples.py        # writes samples/macbook-air.json and samples/gaming-pc.json

These are hand-made reference models (standard teardown layouts), NOT AI scans of a photo: the viewer
labels them "curated reference model". To replace one with a real AI scan later, upload photos of a real
laptop / PC in the app and save that result with:  python scripts/save_physical_sample.py macbook-air
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

API = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(API))
from app.schemas import SystemAnalysis  # noqa: E402
from app.services.component_graph import complete_relationships  # noqa: E402

CURATED = "Curated reference model of a typical {kind} (standard teardown layout), not an AI scan of a photo."


def part(cid, label, ctype, seen, fn, if_removed, shape, size, pos, color, material="plastic", d=(0, 1, 0), dist=1.0,
         rot=(0, 0, 0), r=None, wall=None, why=""):
    return {"c": {"id": cid, "label": label, "type": ctype, "status": "observed" if seen else "inferred",
                  "function": fn, "ifRemoved": if_removed,
                  "evidence": [why or ("Visible from outside." if seen else "Inside the case: standard part of this kind of device."),
                               ]},
            "a": {"componentId": cid, "shape": shape, "size": list(size), "position": list(pos), "rotation": list(rot),
                  "color": color, "material": material, "explodeDir": list(d), "explodeDist": dist,
                  "cornerRadius": r, "wall": wall}}


def det(parent, shape, size, pos, color="#30343b", material="plastic", count=1, rot=(0, 0, 0), r=None):
    return {"parentId": parent, "shape": shape, "size": list(size), "position": list(pos), "rotation": list(rot),
            "color": color, "material": material, "count": count, "cornerRadius": r}


def rel(a, t, b, why):
    return {"id": f"{a}--{t}--{b}", "from": a, "to": b, "type": t, "status": "inferred", "evidence": [why]}


def tilt_lid(parts, details, hy, hz, deg, ids):
    """Open the lid past vertical (like a laptop in use): turn the lid parts and their details back around the hinge."""
    import math
    a = math.radians(deg); ca, sa = math.cos(a), math.sin(a)
    def turn(pos):
        x, y, z = pos; dy, dz = y - hy, z - hz
        return [x, hy + dy * ca + dz * sa, hz - dy * sa + dz * ca]
    for p in parts:
        A = p["a"]
        if A["componentId"] in ids:
            A["position"] = turn(A["position"])
            A["rotation"] = [A["rotation"][0] - deg, A["rotation"][1], A["rotation"][2]]
            d = A["explodeDir"]; A["explodeDir"] = [d[0], d[1] * ca + d[2] * sa, -d[1] * sa + d[2] * ca]
    for d in details:
        if d["parentId"] in ids:
            d["position"] = turn(d["position"]); d["rotation"] = [d["rotation"][0] - deg, d["rotation"][1], d["rotation"][2]]


def build(sid, title, kind, summary, product, parts, details, rels, overall):
    kind_txt = CURATED.format(kind=kind)
    comps = []
    for p in parts:
        c = p["c"]; c["evidence"].append(kind_txt); comps.append(c)
    data = {
        "analysisId": f"curated-{sid}", "domain": "physical", "title": title,
        "source": {"kind": "image", "filename": f"curated reference model ({kind})"},
        "components": comps, "relationships": rels, "summary": summary,
        "limitations": [kind_txt, "Dimensions and positions are typical values for this class of device, not measured from a unit.",
                        "Inside parts follow a standard layout; a specific model can differ."],
        "provider": {"name": "curated", "model": "reference-model"},
        "scene": {"kind": "layered-2.5d", "imageWidth": 1000, "imageHeight": 1000, "layers": [], "views": [],
                  "ghostComponentIds": [c["id"] for c in comps if c["status"] != "observed"],
                  "notes": [kind_txt], "product": product,
                  "assembly": {"kind": "primitive-assembly", "units": "mm", "overallSize": overall,
                               "parts": [p["a"] for p in parts], "details": details}},
    }
    a = SystemAnalysis.model_validate(data)
    a.relationships = complete_relationships(a.components, a.relationships)
    return a


# ---------------------------------------------------------------- MacBook Air 13-inch (M3), lid open
def macbook():
    W, D, T = 304.1, 215.0, 11.3
    back = -D / 2
    P = [
        part("bottom_case", "Aluminium bottom case", "cover", True, "Closes the base from below; no vents, because the M3 Air has no fan.",
             "The inside is exposed.", "plate", (W - 2, 1.2, D - 2), (0, -T / 2 + 0.6, 0), "#2e3440", "aluminum", (0, -1, 0), 1.2, r=10),
        part("battery", "Li-polymer battery (4 cells, 52.6 Wh)", "power_source", False,
             "Stores energy and powers the Mac when it is unplugged.", "Runs only while plugged in.",
             "rounded_box", (232, 3.5, 112), (0, -2.8, 44), "#2b2f36", "plastic", (0, -1, 0), 1.0, r=4,
             why="Four glued pouch cells fill most of the base under the trackpad and palm rest."),
        part("speakers", "Stereo speakers (4-speaker system)", "interface", False, "Turn the audio signal into sound.",
             "No built-in sound; headphones still work.", "box", (22, 5, 60), (-W / 2 + 18, -2, -20), "#1b1d21", "plastic", (0, -1, 0), 1.0,
             why="Sit at both sides of the logic board and fire up through the keyboard gaps."),
        part("logic_board", "Logic board", "controller", False, "Carries the M3 chip, storage and power circuits; every part plugs into it.",
             "Nothing works: it is the hub every other part plugs into.", "plate", (150, 1.0, 62), (0, -1.6, -62), "#1f6f43", "pcb", (0, -1, 0), 0.9,
             why="A small board near the hinge; Apple's boards are far smaller than a PC motherboard."),
        part("m3_chip", "Apple M3 chip", "controller", False,
             "Runs macOS and every app: the 8-core CPU, up to 10-core GPU and the Neural Engine are on one chip.", "The Mac cannot start.",
             "box", (24, 1.6, 22), (-12, -0.4, -62), "#b9bcc2", "metal", (0, -1, 0), 1.0,
             why="Soldered to the logic board."),
        part("unified_memory", "Unified memory (on the M3 package)", "storage", False,
             "8–24 GB of working memory shared by the CPU and GPU.", "The Mac cannot start; it cannot be replaced or upgraded.",
             "box", (10, 1.6, 22), (12, -0.4, -62), "#16323a", "metal", (0, -1, 0), 1.0,
             why="The memory chips sit next to the M3 on the same package, not in a slot."),
        part("ssd_nand", "SSD storage (soldered NAND)", "storage", False,
             "Stores macOS, apps and files.", "Starts but finds nothing to boot from; the chips are soldered, not swappable.",
             "box", (16, 1.2, 14), (46, -0.6, -62), "#1d2a44", "metal", (0, -1, 0), 1.0,
             why="Flash memory chips are soldered to the logic board; there is no M.2 slot."),
        part("heat_spreader", "Heat spreader (fanless cooling)", "mechanism", False,
             "Spreads the M3's heat across the aluminium body; there is no fan.", "The chip heats up and slows itself down sooner.",
             "plate", (90, 0.6, 48), (-12, 1.2, -60), "#b0b5bd", "metal", (0, -1, 0), 1.2,
             why="A thin metal plate over the chip instead of a fan and heat pipe."),
        part("io_board", "MagSafe 3 + 2× USB-C ports", "connector", True, "Charging (MagSafe or USB-C) and Thunderbolt / USB 4 accessories.",
             "No charging and no wired accessories.", "box", (6, 5, 40), (-W / 2 + 3, -0.5, -55), "#9ca3af", "metal", (-1, 0, 0), 1.2),
        part("headphone_jack", "3.5 mm headphone jack", "connector", True, "Wired headphones.", "No wired headphones.",
             "cylinder", (6, 5, 6), (W / 2 - 3, -0.5, -70), "#9ca3af", "metal", (1, 0, 0), 1.2, rot=(0, 0, 90)),
        part("display_cables", "Display and camera cables", "cable", False, "Carry the picture to the screen and the camera feed back.",
             "The screen stays black and the camera stops.", "box", (40, 1.0, 14), (0, 0.6, back + 12), "#2a2a2a", "plastic", (0, -1, 0), 1.0),
        part("top_case", "Top case with keyboard", "cover", True, "Top of the base: the aluminium deck holding the keyboard and trackpad.",
             "Keyboard and trackpad have nothing to sit in.", "plate", (W - 2, 1.4, D - 2), (0, T / 2 - 0.7, 0), "#2e3440", "aluminum", (0, 1, 0), 0.5, r=10),
        part("keyboard", "Magic Keyboard (backlit)", "interface", True, "Typing input.", "No typing without an external keyboard.",
             "plate", (268, 1.0, 102), (0, T / 2 + 0.4, -42), "#1b1d21", "plastic", (0, 1, 0), 1.6, r=3),
        part("touch_id", "Touch ID power button", "sensor", True, "Turns the Mac on and reads your fingerprint.",
             "No fingerprint unlock or Apple Pay; the Mac still starts by opening the lid.", "rounded_box", (14, 1.2, 12), (126, T / 2 + 0.6, -84),
             "#0e0f12", "glossy_plastic", (0, 1, 0), 1.6, r=2),
        part("trackpad", "Force Touch trackpad", "interface", True, "Pointer, gestures and pressure clicks.",
             "Needs an external mouse.", "plate", (120, 1.0, 76), (0, T / 2 + 0.3, 58), "#b9bec6", "glossy_plastic", (0, 1, 0), 1.6, r=6),
        part("taptic_engine", "Taptic Engine (click feel)", "actuator", False, "Makes the solid trackpad feel like it clicks.",
             "Pressing the trackpad gives no click; tracking still works.", "box", (40, 3, 10), (0, 2, 58), "#4b5563", "metal", (0, -1, 0), 1.1,
             why="Sits under the trackpad; there is no moving hinge, only a vibration motor."),
        part("hinge", "Display hinge (clutch)", "mechanism", True, "Holds the lid at any angle.", "The lid flops shut or falls off.",
             "cylinder", (7, 250, 7), (0, T / 2 + 2, back + 4), "#9aa1aa", "aluminum", (0, 0, -1), 0.5, rot=(0, 0, 90)),
        part("lid", "Display lid (aluminium)", "cover", True, "Protects the back of the screen.",
             "The screen is unprotected.", "plate", (W - 2, 200, 4), (0, T / 2 + 102, back - 2), "#2e3440", "aluminum", (0, 0, -1), 1.2, r=10),
        part("display_panel", "13.6\" Liquid Retina display", "display", True, "Shows the picture (2560 × 1664).",
             "No picture; an external display still works.", "plate", (292, 186, 2.5), (0, T / 2 + 101, back + 1.5), "#0d1117", "screen", (0, 0, 1), 0.7, r=8),
        part("bezel", "Display bezel with notch", "cover", True, "Thin border around the screen, with the camera notch.",
             "Panel edges are exposed.", "frame", (298, 194, 1.5), (0, T / 2 + 101, back + 3.5), "#0e0f12", "plastic", (0, 0, 1), 1.3, r=9, wall=5),
        part("camera", "1080p FaceTime HD camera", "sensor", True, "Video calls.", "No built-in camera.",
             "cylinder", (5, 2, 5), (0, T / 2 + 195, back + 4.5), "#0b0c0f", "glass", (0, 0, 1), 1.5, rot=(90, 0, 0)),
        part("antennas", "Wi-Fi 6E / Bluetooth antennas", "interface", False, "Wireless networking.", "No Wi-Fi or Bluetooth.",
             "box", (60, 2, 3), (0, T / 2 + 3, back - 1), "#2a2d33", "plastic", (0, 0, -1), 0.9, why="Hidden in the hinge area behind a plastic window."),
    ]
    Dt = [
        det("keyboard", "slots", (236, 0.5, 10), (-10, T / 2 + 1.0, -84), "#2a2d33", count=13),
        det("keyboard", "slots", (260, 0.5, 15), (0, T / 2 + 1.0, -66), "#2a2d33", count=14),
        det("keyboard", "slots", (260, 0.5, 15), (0, T / 2 + 1.0, -48), "#2a2d33", count=14),
        det("keyboard", "slots", (256, 0.5, 15), (0, T / 2 + 1.0, -30), "#2a2d33", count=13),
        det("keyboard", "slots", (248, 0.5, 15), (0, T / 2 + 1.0, -12), "#2a2d33", count=12),
        det("keyboard", "rounded_box", (96, 0.5, 15), (0, T / 2 + 1.0, 6), "#2a2d33", r=2),
        det("bezel", "rounded_box", (32, 1.2, 7), (0, T / 2 + 195, back + 4.4), "#050607", "plastic", r=3),
        det("lid", "disc", (24, 0.6, 28), (0, T / 2 + 112, back - 4.2), "#d9dde3", "metal", rot=(90, 0, 0)),
        det("battery", "slots", (228, 0.6, 108), (0, -0.9, 44), "#3a3f47", count=4),
        det("trackpad", "rounded_box", (118, 0.3, 74), (0, T / 2 + 0.85, 58), "#c4c9d0", "glass", r=6),
        det("bottom_case", "disc", (12, 1.2, 12), (-135, -T / 2 - 0.6, -92), "#1a1a1a", "rubber"),
        det("bottom_case", "disc", (12, 1.2, 12), (135, -T / 2 - 0.6, -92), "#1a1a1a", "rubber"),
        det("bottom_case", "disc", (12, 1.2, 12), (-135, -T / 2 - 0.6, 92), "#1a1a1a", "rubber"),
        det("bottom_case", "disc", (12, 1.2, 12), (135, -T / 2 - 0.6, 92), "#1a1a1a", "rubber"),
        det("io_board", "rounded_box", (1.5, 2.5, 8.5), (-W / 2, 0, -70), "#111111"),
        det("io_board", "rounded_box", (1.5, 2.5, 8.5), (-W / 2, 0, -55), "#111111"),
        det("io_board", "rounded_box", (1.5, 3.0, 11), (-W / 2, 0, -38), "#111111"),
    ]
    tilt_lid(P, Dt, T / 2 + 2, back + 4, 18, {"lid", "display_panel", "bezel", "camera"})
    R = [
        rel("battery", "powers", "logic_board", "The battery feeds the logic board's power circuit."),
        rel("io_board", "feeds", "battery", "MagSafe / USB-C charge the battery."),
        rel("logic_board", "supports", "m3_chip", "The M3 is soldered to the logic board."),
        rel("logic_board", "powers", "m3_chip", "The board's power stages run the M3."),
        rel("m3_chip", "depends_on", "unified_memory", "The M3 runs everything out of its unified memory."),
        rel("logic_board", "powers", "ssd_nand", "The storage chips are on the logic board."),
        rel("m3_chip", "controls", "ssd_nand", "The M3 has the storage controller built in."),
        rel("heat_spreader", "depends_on", "m3_chip", "Without the spreader the chip throttles sooner."),
        rel("logic_board", "transmits", "display_cables", "The picture leaves the board through the display cable."),
        rel("display_cables", "feeds", "display_panel", "The cable carries picture and backlight power."),
        rel("camera", "transmits", "display_cables", "The camera feed returns through the lid cable."),
        rel("logic_board", "powers", "speakers", "The speakers plug into the board."),
        rel("logic_board", "powers", "antennas", "The antennas connect to the board's wireless radios."),
        rel("keyboard", "transmits", "logic_board", "Key presses go to the board."),
        rel("touch_id", "transmits", "m3_chip", "Fingerprints go to the M3's Secure Enclave."),
        rel("trackpad", "transmits", "logic_board", "Touch and pressure go to the board."),
        rel("taptic_engine", "depends_on", "trackpad", "The Taptic Engine gives the trackpad its click."),
        rel("logic_board", "powers", "taptic_engine", "The board drives the Taptic Engine."),
        rel("io_board", "connected_to", "logic_board", "The ports connect to the board."),
        rel("headphone_jack", "connected_to", "logic_board", "The jack connects to the board."),
        rel("hinge", "supports", "lid", "The hinge holds the lid."),
        rel("lid", "supports", "display_panel", "The panel is mounted in the lid."),
        rel("bezel", "covers", "display_panel", "The bezel frames the panel."),
        rel("bezel", "supports", "camera", "The camera sits in the notch."),
        rel("top_case", "supports", "keyboard", "The keyboard is riveted into the top case."),
        rel("top_case", "supports", "trackpad", "The trackpad is screwed to the top case."),
        rel("top_case", "supports", "logic_board", "The board is screwed to the top case from below."),
        rel("top_case", "supports", "battery", "The battery cells are glued to the top case."),
        rel("bottom_case", "covers", "battery", "The bottom case closes over the battery."),
    ]
    product = {"category": "laptop", "brand": "Apple", "model": "MacBook Air 13-inch (M3)", "searchQuery": "MacBook Air 13 M3 teardown",
               "identifiedFrom": "Curated reference model (no photo), based on the published layout of the M3 MacBook Air.",
               "confidence": None, "dimensionsMm": [304.1, 11.3, 215.0]}
    return build("macbook-air", "MacBook Air 13″ (M3)", "MacBook Air 13-inch (M3, Midnight)",
                 "Apple's MacBook Air with the M3 chip: a fanless laptop whose small logic board carries the M3 with its unified memory and "
                 "soldered SSD, powered by four flat battery cells under the palm rest; the Liquid Retina display hangs on one hinge in its own lid.",
                 product, P, Dt, R, [W, 213.0, D + 6])


# ---------------------------------------------------------------- desktop PC tower (glass side panel on the left)
def desktop():
    X, Y, Z = 210.0, 450.0, 440.0
    P = [
        part("chassis", "Steel chassis frame", "structure", True, "Holds every part in place.", "Nothing has anything to mount to.",
             "frame", (X - 10, Y, Z), (0, 0, 0), "#2a2d33", "metal", (0, 1, 0), 0.0, r=8, wall=6),
        part("side_panel_glass", "Tempered-glass side panel", "cover", True, "Closes the left side and shows the inside.", "Dust gets in; airflow changes.",
             "plate", (4, Y - 10, Z - 10), (-X / 2 + 2, 0, 0), "#9fb4c8", "glass", (-1, 0, 0), 1.6, r=6),
        part("side_panel_right", "Steel side panel", "cover", True, "Closes the right side behind the motherboard.", "Cables behind the board are exposed.",
             "plate", (4, Y - 10, Z - 10), (X / 2 - 2, 0, 0), "#26292e", "plastic", (1, 0, 0), 1.4, r=6),
        part("front_panel", "Front panel with mesh", "cover", True, "Front face; the mesh lets the intake fans breathe.", "Fans are exposed; looks unfinished.",
             "plate", (X - 4, Y - 4, 6), (0, 0, Z / 2 + 3), "#1d1f24", "plastic", (0, 0, 1), 0.7, r=6),
        part("power_button", "Power button", "interface", True, "Turns the PC on and off.", "The PC cannot be switched on from the case.",
             "cylinder", (14, 4, 14), (50, Y / 2 + 2, 160), "#c9ccd2", "metal", (0, 1, 0), 0.5),
        part("front_io", "Front I/O (USB-C, USB-A, audio)", "connector", True, "Front ports for USB and headphones.", "Only the rear ports remain.",
             "box", (70, 4, 16), (-30, Y / 2 + 2, 160), "#15171b", "plastic", (0, 1, 0), 0.5),
        part("motherboard", "B650 ATX motherboard (AM5)", "controller", True, "Connects CPU, memory, storage, graphics card and power.",
             "Nothing works: it is the hub every other part plugs into.", "plate", (3, 305, 244), (X / 2 - 14, 45, -40), "#1f6f43", "pcb", (1, 0, 0), 0.9),
        part("cpu", "AMD Ryzen 7 7800X3D (CPU)", "controller", False, "Runs the operating system and every program.", "The PC cannot start.",
             "box", (4, 40, 40), (X / 2 - 17.5, 120, -20), "#c9ccd2", "metal", (-1, 0, 0), 0.8, why="Hidden under the air cooler."),
        part("ram", "32 GB DDR5-6000 RAM (2 × 16 GB)", "storage", True, "Working memory for running programs.", "The PC beeps and will not boot.",
             "box", (32, 133, 18), (X / 2 - 31, 120, 50), "#1c1f26", "metal", (-1, 0, 0), 1.0),
        part("cooler", "Dual-tower CPU air cooler", "mechanism", True, "Draws heat away from the CPU through heat pipes and fins.",
             "The CPU overheats within seconds and the PC shuts down.", "box", (78, 150, 120), (X / 2 - 60, 120, -20), "#b8bec6", "aluminum", (-1, 0, 0), 1.2),
        part("cooler_fan", "Cooler fan (120 mm)", "actuator", True, "Blows air through the cooler fins.", "The cooler loses most of its capacity; the CPU throttles.",
             "box", (78, 120, 25), (X / 2 - 60, 120, 53), "#23262b", "plastic", (-1, 0, 0), 1.3),
        part("gpu", "NVIDIA GeForce RTX 4070 Super (GPU)", "controller", True, "Draws the picture on the monitor and runs games and 3D.",
             "No picture from the card's ports (the CPU's own graphics may still work).", "box", (118, 45, 270), (X / 2 - 75, -40, -40), "#23262b", "plastic", (-1, 0, 0), 1.0),
        part("ssd", "2 TB PCIe 4.0 NVMe SSD", "storage", False, "Stores the operating system, programs and files.", "Starts but finds nothing to boot from.",
             "plate", (3, 22, 80), (X / 2 - 17, 20, 20), "#1d2a44", "pcb", (-1, 0, 0), 0.6, why="On the motherboard, under its heat spreader."),
        part("psu", "750 W 80+ Gold power supply", "power_source", False, "Turns mains power into the voltages every part needs.", "The PC is dead: nothing gets power.",
             "box", (150, 86, 150), (0, -Y / 2 + 49, -Z / 2 + 82), "#202227", "metal", (0, -1, 0), 1.0, why="Inside the PSU shroud at the bottom."),
        part("hdd", "4 TB 3.5\" hard drive (storage)", "storage", False, "Large storage for files and media.", "Files on it are unavailable; the PC still boots from the SSD.",
             "box", (101, 26, 147), (0, -Y / 2 + 22, Z / 2 - 90), "#9aa1aa", "aluminum", (0, -1, 0), 1.0, why="In the drive cage at the bottom front."),
        part("front_fans", "Front intake fans (3× 120 mm)", "actuator", True, "Pull cool air in through the front mesh.", "The inside heats up; parts throttle.",
             "box", (120, 380, 25), (0, 10, Z / 2 - 20), "#15171b", "plastic", (0, 0, 1), 0.4),
        part("rear_fan", "Rear exhaust fan (120 mm)", "actuator", True, "Pushes hot air out of the back.", "Hot air builds up inside the case.",
             "box", (120, 120, 25), (10, 130, -Z / 2 + 20), "#15171b", "plastic", (0, 0, -1), 0.5),
        part("cables", "Power cables (24-pin, 8-pin, PCIe)", "cable", False, "Carry power from the PSU to the board, CPU and graphics card.",
             "The parts they feed get no power.", "box", (12, 220, 16), (X / 2 - 8, 0, 95), "#1a1a1a", "rubber", (1, 0, 0), 0.8, why="Routed behind the motherboard tray."),
    ]
    Dt = [
        det("front_panel", "slots", (180, 1.5, 400), (0, 0, Z / 2 + 6.5), "#0c0d10", count=22),
        det("front_fans", "disc", (110, 4, 110), (0, 135, Z / 2 - 7), "#2a2d33"),
        det("front_fans", "disc", (110, 4, 110), (0, 10, Z / 2 - 7), "#2a2d33"),
        det("front_fans", "disc", (110, 4, 110), (0, -115, Z / 2 - 7), "#2a2d33"),
        det("rear_fan", "disc", (110, 4, 110), (10, 130, -Z / 2 + 7), "#2a2d33"),
        det("cooler_fan", "disc", (70, 4, 110), (X / 2 - 60, 120, 66), "#30343b"),
        det("cooler", "slots", (74, 1.0, 145), (X / 2 - 100, 120, -20), "#9aa1aa", "aluminum", count=18),
        det("gpu", "disc", (90, 4, 90), (X / 2 - 75, -63, -100), "#2a2d33"),
        det("gpu", "disc", (90, 4, 90), (X / 2 - 75, -63, 10), "#2a2d33"),
        det("gpu", "rounded_box", (110, 2, 30), (X / 2 - 75, -17, 80), "#c9ccd2", "metal", r=2),
        det("motherboard", "box", (6, 120, 10), (X / 2 - 18, -30, -150), "#111111"),
        det("motherboard", "box", (6, 60, 20), (X / 2 - 18, 170, -150), "#9ca3af", "metal"),
        det("psu", "slots", (130, 1.5, 120), (0, -Y / 2 + 6, -Z / 2 + 82), "#111111", count=12),
        det("chassis", "disc", (30, 6, 30), (-80, -Y / 2 - 3, -180), "#1a1a1a", "rubber"),
        det("chassis", "disc", (30, 6, 30), (80, -Y / 2 - 3, -180), "#1a1a1a", "rubber"),
        det("chassis", "disc", (30, 6, 30), (-80, -Y / 2 - 3, 180), "#1a1a1a", "rubber"),
        det("chassis", "disc", (30, 6, 30), (80, -Y / 2 - 3, 180), "#1a1a1a", "rubber"),
    ]
    R = [
        rel("psu", "powers", "cables", "All power leaves the PSU through its cables."),
        rel("cables", "feeds", "motherboard", "24-pin and 8-pin cables power the board and CPU."),
        rel("cables", "feeds", "gpu", "PCIe cables power the graphics card."),
        rel("cables", "feeds", "hdd", "A SATA power cable feeds the hard drive."),
        rel("motherboard", "supports", "cpu", "The CPU sits in the board's socket."),
        rel("motherboard", "powers", "cpu", "The board's VRM powers the CPU."),
        rel("motherboard", "powers", "ram", "RAM sits in the board's DIMM slots."),
        rel("motherboard", "powers", "ssd", "The SSD sits in the board's M.2 slot."),
        rel("motherboard", "powers", "gpu", "The card sits in the board's PCIe slot."),
        rel("motherboard", "powers", "front_fans", "Fans run from board headers."),
        rel("motherboard", "powers", "rear_fan", "The rear fan runs from a board header."),
        rel("motherboard", "powers", "cooler_fan", "The cooler fan runs from the CPU fan header."),
        rel("cpu", "depends_on", "ram", "The CPU runs programs out of RAM."),
        rel("cpu", "controls", "ssd", "The CPU reads and writes the SSD."),
        rel("cpu", "controls", "hdd", "The CPU reads and writes the hard drive."),
        rel("cpu", "controls", "gpu", "The CPU sends drawing work to the graphics card."),
        rel("cooler", "depends_on", "cpu", "Without the cooler the CPU overheats."),
        rel("cooler_fan", "depends_on", "cooler", "The fan pushes air through the cooler fins."),
        rel("power_button", "controls", "motherboard", "The button tells the board to start."),
        rel("front_io", "connected_to", "motherboard", "Front ports plug into board headers."),
        rel("chassis", "supports", "motherboard", "The board is screwed to the chassis tray."),
        rel("chassis", "supports", "psu", "The PSU is screwed into the chassis."),
        rel("chassis", "supports", "hdd", "The drive sits in the chassis cage."),
        rel("chassis", "supports", "front_fans", "Fans are screwed to the chassis."),
        rel("chassis", "supports", "rear_fan", "The fan is screwed to the rear wall."),
        rel("chassis", "supports", "side_panel_glass", "The panel mounts on the chassis."),
        rel("chassis", "supports", "side_panel_right", "The panel mounts on the chassis."),
        rel("chassis", "supports", "front_panel", "The front panel clips onto the chassis."),
        rel("front_panel", "covers", "front_fans", "The mesh front covers the intake fans."),
        rel("motherboard", "supports", "cooler", "The cooler is bolted through the board around the CPU."),
    ]
    product = {"category": "gaming PC", "brand": None, "model": None, "searchQuery": "gaming pc build parts",
               "identifiedFrom": "Curated reference model (no photo).", "confidence": None}
    return build("gaming-pc", "Gaming PC · Ryzen 7 + RTX 4070 Super", "custom-built gaming PC (Ryzen 7 7800X3D, RTX 4070 Super)",
                 "A custom-built 1440p gaming PC in a glass-panel mid-tower: the 750 W PSU powers the ATX motherboard, which carries the Ryzen 7 7800X3D (under a dual-tower air cooler), 32 GB DDR5, "
                 "a 2 TB NVMe SSD and the RTX 4070 Super; front fans pull air in and a rear fan pushes it out.",
                 product, P, Dt, R, [X, Y + 6, Z + 6])


def main() -> int:
    out = API / "samples"
    for a, name in ((macbook(), "macbook-air"), (desktop(), "gaming-pc")):
        (out / f"{name}.json").write_text(json.dumps(a.dump(), ensure_ascii=False), encoding="utf-8")
        print(f"samples/{name}.json: {len(a.components)} parts, {len(a.relationships)} links")
    return 0


if __name__ == "__main__":
    sys.exit(main())
