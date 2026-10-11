"""Build the two curated Physical samples: a 14-inch laptop and a desktop PC tower.

    cd apps/api
    python scripts/make_curated_samples.py        # writes samples/laptop.json and samples/desktop-pc.json

These are hand-made reference models (standard teardown layouts), NOT AI scans of a photo: the viewer
labels them "curated reference model". To replace one with a real AI scan later, upload photos of a real
laptop / PC in the app and save that result with:  python scripts/save_physical_sample.py laptop
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


# ---------------------------------------------------------------- 14-inch laptop (lid open, upright at the back)
def laptop():
    W, D, T = 320.0, 220.0, 17.0
    back = -D / 2
    P = [
        part("bottom_cover", "Bottom cover (D panel)", "cover", True, "Closes the base from below and carries the rubber feet and air intake vents.",
             "The internals are exposed and unprotected; airflow through the vents is lost.",
             "plate", (W - 2, 1.5, D - 2), (0, -T / 2 + 0.75, 0), "#8d939b", "aluminum", (0, -1, 0), 1.2, r=9),
        part("battery", "Li-ion battery pack (4-cell, ~60 Wh)", "power_source", False, "Stores energy and powers the whole laptop when unplugged.",
             "Runs only while the charger is plugged in.", "rounded_box", (250, 6, 78), (0, -4, 58), "#2b2f36", "plastic", (0, -1, 0), 1.0, r=4),
        part("speakers", "Stereo speakers", "interface", False, "Turn the audio signal into sound.", "No built-in sound; headphones still work.",
             "box", (38, 6, 16), (-132, -3, 72), "#1b1d21", "plastic", (0, -1, 0), 1.0),
        part("motherboard", "Logic board (motherboard)", "controller", False, "Connects every part: power, CPU, memory, storage, display and ports.",
             "Nothing works: it is the hub every other part plugs into.", "plate", (280, 1.2, 108), (0, -1.5, -46), "#1f6f43", "pcb", (0, -1, 0), 0.9),
        part("cpu", "Processor (CPU / SoC)", "controller", False, "Runs the operating system and every program.", "The laptop cannot start.",
             "box", (24, 2, 24), (-30, 0.6, -52), "#b9bcc2", "metal", (0, -1, 0), 1.0),
        part("ram", "RAM module (SO-DIMM, 16 GB)", "storage", False, "Working memory for running programs.", "The laptop beeps and will not boot.",
             "plate", (68, 3, 30), (52, 0.3, -36), "#16323a", "pcb", (0, -1, 0), 1.0),
        part("ssd", "M.2 NVMe SSD (512 GB)", "storage", False, "Stores the operating system, programs and files.", "Starts but finds nothing to boot from.",
             "plate", (80, 2.5, 22), (104, 0.0, -14), "#1d2a44", "pcb", (0, -1, 0), 1.0),
        part("wifi", "Wi-Fi / Bluetooth card", "interface", False, "Wireless networking and Bluetooth.", "No Wi-Fi or Bluetooth.",
             "plate", (30, 2, 22), (-104, 0.0, -22), "#20435c", "pcb", (0, -1, 0), 1.0),
        part("fan", "Cooling fan (blower)", "actuator", False, "Pushes air through the heat sink to cool the CPU.",
             "The CPU overheats, slows down and the laptop shuts itself off.", "cylinder", (62, 7, 62), (-100, 0.5, -76), "#23262b", "plastic", (0, -1, 0), 1.0),
        part("heatpipe", "Copper heat pipe and fins", "mechanism", False, "Carries heat from the CPU to the fan's fins.",
             "Heat stays at the CPU: it throttles hard and may shut down.", "box", (96, 2.5, 9), (-62, 2.6, -62), "#c47a3c", "metal", (0, -1, 0), 1.1),
        part("display_cable", "eDP display cable", "cable", False, "Carries the picture from the logic board to the screen.", "The screen stays black.",
             "box", (12, 2, 40), (40, 1.5, back + 24), "#2a2a2a", "plastic", (0, -1, 0), 1.0),
        part("keyboard_deck", "Keyboard deck / palm rest (C panel)", "cover", True, "Top of the base: holds the keyboard and touchpad.",
             "Keyboard and touchpad have nothing to sit in.", "plate", (W - 2, 1.5, D - 2), (0, T / 2 - 0.75, 0), "#a7adb5", "aluminum", (0, 1, 0), 0.5, r=9),
        part("keyboard", "Backlit keyboard", "interface", True, "Typing input.", "No typing without an external keyboard.",
             "plate", (282, 1.4, 104), (0, T / 2 + 0.6, -38), "#1b1d21", "plastic", (0, 1, 0), 1.6, r=3),
        part("touchpad", "Glass touchpad", "interface", True, "Pointer and gesture input.", "Needs an external mouse.",
             "plate", (116, 1.0, 72), (0, T / 2 + 0.4, 62), "#9aa1aa", "glossy_plastic", (0, 1, 0), 1.6, r=5),
        part("usb_ports", "USB-C / USB-A ports", "connector", True, "Charging and accessories.", "No charging port and no wired accessories.",
             "box", (6, 6, 42), (-W / 2 + 2, 0, 10), "#9ca3af", "metal", (-1, 0, 0), 1.2),
        part("hinge", "Display hinges", "mechanism", True, "Hold the lid and let it open and close.", "The lid falls off the base.",
             "cylinder", (9, 250, 9), (0, T / 2 + 3, back + 4), "#3a3f47", "metal", (0, 0, -1), 0.5, rot=(0, 0, 90)),
        part("lid_back", "Display lid (A cover)", "cover", True, "Protects the back of the screen and carries the logo.", "The screen is unprotected.",
             "plate", (W - 2, 206, 5), (0, T / 2 + 105, back - 2), "#a7adb5", "aluminum", (0, 0, -1), 1.2, r=9),
        part("display_panel", "14\" IPS display panel", "display", True, "Shows the picture.", "No picture; an external monitor still works.",
             "plate", (300, 188, 3), (0, T / 2 + 104, back + 2), "#0d1117", "screen", (0, 0, 1), 0.7, r=3),
        part("bezel", "Display bezel", "cover", True, "Frames the screen and holds the webcam.", "The panel edges are exposed.",
             "frame", (310, 198, 2.5), (0, T / 2 + 104, back + 4.5), "#16181c", "plastic", (0, 0, 1), 1.3, r=7, wall=9),
        part("webcam", "Webcam (1080p)", "sensor", True, "Video calls.", "No built-in camera.",
             "cylinder", (6, 3, 6), (0, T / 2 + 198, back + 6), "#0b0c0f", "glass", (0, 0, 1), 1.5, rot=(90, 0, 0)),
    ]
    Dt = [
        det("keyboard", "slots", (250, 0.6, 14), (0, T / 2 + 1.4, -76), "#2a2d33", count=1),
        det("keyboard", "slots", (262, 0.6, 14), (0, T / 2 + 1.4, -56), "#2a2d33", count=13),
        det("keyboard", "slots", (262, 0.6, 14), (0, T / 2 + 1.4, -38), "#2a2d33", count=13),
        det("keyboard", "slots", (258, 0.6, 14), (0, T / 2 + 1.4, -20), "#2a2d33", count=12),
        det("keyboard", "slots", (250, 0.6, 14), (0, T / 2 + 1.4, -2), "#2a2d33", count=11),
        det("keyboard", "rounded_box", (100, 0.6, 14), (0, T / 2 + 1.4, 14), "#2a2d33", r=2),
        det("bottom_cover", "slots", (180, 1.0, 24), (0, -T / 2 - 0.5, -60), "#1a1c20", count=16),
        det("bottom_cover", "disc", (16, 2.0, 16), (-140, -T / 2 - 1, -95), "#1a1a1a", "rubber"),
        det("bottom_cover", "disc", (16, 2.0, 16), (140, -T / 2 - 1, -95), "#1a1a1a", "rubber"),
        det("bottom_cover", "disc", (16, 2.0, 16), (-140, -T / 2 - 1, 95), "#1a1a1a", "rubber"),
        det("bottom_cover", "disc", (16, 2.0, 16), (140, -T / 2 - 1, 95), "#1a1a1a", "rubber"),
        det("lid_back", "rounded_box", (40, 1.0, 14), (0, T / 2 + 120, back - 5), "#e6e8eb", "glossy_plastic", r=2),
        det("usb_ports", "rounded_box", (2, 3.5, 9), (-W / 2, 0, 0), "#111111"),
        det("usb_ports", "rounded_box", (2, 4.5, 13), (-W / 2, 0, 20), "#111111"),
        det("fan", "torus", (40, 2, 40), (-100, 4.5, -76), "#30343b"),
    ]
    R = [
        rel("battery", "powers", "motherboard", "The battery feeds the board's power circuit."),
        rel("motherboard", "supports", "cpu", "The CPU is soldered to the logic board."),
        rel("motherboard", "powers", "cpu", "The board's voltage regulators power the CPU."),
        rel("motherboard", "powers", "ram", "RAM sits in the board's SO-DIMM slot."),
        rel("motherboard", "powers", "ssd", "The SSD sits in the board's M.2 slot."),
        rel("motherboard", "powers", "wifi", "The Wi-Fi card sits in an M.2 slot."),
        rel("motherboard", "powers", "fan", "The fan is powered from a board header."),
        rel("motherboard", "powers", "speakers", "Speakers plug into the board."),
        rel("cpu", "depends_on", "ram", "The CPU runs programs out of RAM."),
        rel("cpu", "controls", "ssd", "The CPU reads and writes the SSD."),
        rel("cpu", "controls", "wifi", "The CPU drives the wireless card."),
        rel("fan", "depends_on", "cpu", "Without airflow the CPU overheats."),
        rel("heatpipe", "depends_on", "cpu", "The heat pipe carries heat away from the CPU."),
        rel("fan", "drives", "heatpipe", "The fan blows air through the heat pipe's fins."),
        rel("motherboard", "transmits", "display_cable", "The picture leaves the board through the eDP cable."),
        rel("display_cable", "feeds", "display_panel", "The cable carries the picture and backlight power."),
        rel("keyboard", "transmits", "motherboard", "Key presses go to the board."),
        rel("touchpad", "transmits", "motherboard", "Touch input goes to the board."),
        rel("webcam", "transmits", "motherboard", "Video goes to the board through the lid cable."),
        rel("usb_ports", "connected_to", "motherboard", "The ports are part of / plug into the board."),
        rel("hinge", "supports", "lid_back", "The hinges hold the lid."),
        rel("lid_back", "supports", "display_panel", "The panel is mounted in the lid."),
        rel("bezel", "covers", "display_panel", "The bezel frames the panel."),
        rel("bezel", "supports", "webcam", "The webcam sits in the bezel."),
        rel("keyboard_deck", "supports", "keyboard", "The keyboard is fixed to the deck."),
        rel("keyboard_deck", "supports", "touchpad", "The touchpad is fixed to the deck."),
        rel("keyboard_deck", "supports", "motherboard", "The board is screwed to the deck from below."),
        rel("bottom_cover", "covers", "battery", "The bottom cover closes over the battery."),
    ]
    product = {"category": "laptop", "brand": None, "model": None, "searchQuery": "14 inch laptop teardown",
               "identifiedFrom": "Curated reference model (no photo).", "confidence": None}
    return build("laptop", "Laptop (14-inch)", "14-inch laptop",
                 "A 14-inch laptop: the logic board with its CPU, RAM and SSD sits under the keyboard deck, cooled by a fan and copper "
                 "heat pipe and powered by a flat battery under the palm rest; the display hangs on two hinges in its own lid.",
                 product, P, Dt, R, [W, 225.0, D + 8])


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
        part("motherboard", "ATX motherboard", "controller", True, "Connects CPU, memory, storage, graphics card and power.",
             "Nothing works: it is the hub every other part plugs into.", "plate", (3, 305, 244), (X / 2 - 14, 45, -40), "#1f6f43", "pcb", (1, 0, 0), 0.9),
        part("cpu", "Processor (CPU)", "controller", False, "Runs the operating system and every program.", "The PC cannot start.",
             "box", (4, 40, 40), (X / 2 - 17.5, 120, -20), "#c9ccd2", "metal", (-1, 0, 0), 0.8, why="Hidden under the air cooler."),
        part("ram", "RAM (2× DDR5 DIMM, 32 GB)", "storage", True, "Working memory for running programs.", "The PC beeps and will not boot.",
             "box", (32, 133, 18), (X / 2 - 31, 120, 50), "#1c1f26", "metal", (-1, 0, 0), 1.0),
        part("cooler", "CPU tower air cooler", "mechanism", True, "Draws heat away from the CPU through heat pipes and fins.",
             "The CPU overheats within seconds and the PC shuts down.", "box", (78, 150, 120), (X / 2 - 60, 120, -20), "#b8bec6", "aluminum", (-1, 0, 0), 1.2),
        part("cooler_fan", "Cooler fan (120 mm)", "actuator", True, "Blows air through the cooler fins.", "The cooler loses most of its capacity; the CPU throttles.",
             "box", (78, 120, 25), (X / 2 - 60, 120, 53), "#23262b", "plastic", (-1, 0, 0), 1.3),
        part("gpu", "Graphics card (GPU)", "controller", True, "Draws the picture on the monitor and runs games and 3D.",
             "No picture from the card's ports (the CPU's own graphics may still work).", "box", (118, 45, 270), (X / 2 - 75, -40, -40), "#23262b", "plastic", (-1, 0, 0), 1.0),
        part("ssd", "M.2 NVMe SSD (1 TB)", "storage", False, "Stores the operating system, programs and files.", "Starts but finds nothing to boot from.",
             "plate", (3, 22, 80), (X / 2 - 17, 20, 20), "#1d2a44", "pcb", (-1, 0, 0), 0.6, why="On the motherboard, under its heat spreader."),
        part("psu", "Power supply (PSU, 750 W)", "power_source", False, "Turns mains power into the voltages every part needs.", "The PC is dead: nothing gets power.",
             "box", (150, 86, 150), (0, -Y / 2 + 49, -Z / 2 + 82), "#202227", "metal", (0, -1, 0), 1.0, why="Inside the PSU shroud at the bottom."),
        part("hdd", "3.5\" hard drive", "storage", False, "Large storage for files and media.", "Files on it are unavailable; the PC still boots from the SSD.",
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
    product = {"category": "desktop computer", "brand": None, "model": None, "searchQuery": "desktop pc build parts",
               "identifiedFrom": "Curated reference model (no photo).", "confidence": None}
    return build("desktop-pc", "Desktop PC (tower)", "desktop PC tower",
                 "A mid-tower desktop PC: the PSU powers the ATX motherboard, which carries the CPU (under a tower air cooler), RAM, "
                 "an M.2 SSD and the graphics card; front fans pull air in and a rear fan pushes it out.",
                 product, P, Dt, R, [X, Y + 6, Z + 6])


def main() -> int:
    out = API / "samples"
    for a, name in ((laptop(), "laptop"), (desktop(), "desktop-pc")):
        (out / f"{name}.json").write_text(json.dumps(a.dump(), ensure_ascii=False), encoding="utf-8")
        print(f"samples/{name}.json: {len(a.components)} parts, {len(a.relationships)} links")
    return 0


if __name__ == "__main__":
    sys.exit(main())
