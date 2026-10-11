// What a part could be swapped for, with one short advantage and one short disadvantage each.
// Engineering rules of thumb matched on the part's label/type, so it works offline and for saved samples.
// First matching rule wins; the type fallbacks at the end make sure every part gets something sensible.

const R = (re, alts) => ({ re, alts: alts.map(([name, pro, con]) => ({ name, pro, con })) });

const RULES = [
  R(/logo|badge|label|sticker|emblem/, [
    ["Laser-etched logo", "Never peels off", "Can't be changed later"],
    ["Printed (pad print)", "Cheapest, any colour", "Rubs off over time"],
    ["Moulded-in logo", "Zero extra parts", "Fixed into the tool"]]),
  R(/lens cover|window|glass|bezel/, [
    ["Gorilla-type glass", "Scratch resistant", "Can shatter"],
    ["Acrylic (PMMA)", "Light, cheap, clear", "Scratches easily"],
    ["Polycarbonate", "Nearly unbreakable", "Scratches, can yellow"]]),
  // power
  R(/coin cell|cr20\d\d|button cell/, [
    ["Rechargeable Li-ion cell", "Charge it, no swaps", "Needs a charging circuit"],
    ["AAA battery", "Sold everywhere", "Bigger and heavier"],
    ["Supercapacitor", "Charges in seconds", "Runs for minutes, not months"]]),
  R(/battery|batteries|\baa\b|aaa|\bcell\b|power source|battery compartment|battery contacts/, [
    ["Built-in Li-ion pack", "Rechargeable, thinner", "Wears out, hard to replace"],
    ["Li-polymer pouch", "Any shape, very light", "Can swell if abused"],
    ["USB-C wired power", "Never runs flat", "Cable limits movement"]]),
  R(/charg|power supply|adapter|psu/, [
    ["GaN charger", "Smaller, runs cooler", "Costs more"],
    ["Wireless (Qi) pad", "No plug to wear out", "Slower, wastes heat"],
    ["Linear regulator", "Simple and quiet", "Wastes power as heat"]]),
  // electronics
  R(/pcb|circuit board|motherboard|mainboard|logic board|controller|mcu|microcontroller|chip|processor|cpu|soc/, [
    ["Single-chip SoC design", "Fewer parts, cheaper", "One fault kills everything"],
    ["Flexible PCB", "Folds into tight spaces", "Fragile, costly to make"],
    ["Modular boards", "Swap one module to repair", "Bigger, more connectors"]]),
  R(/optical sensor|tracking sensor|laser/, [
    ["Laser sensor", "Works on glass, more precise", "Picks up surface noise"],
    ["Trackball (ball + rollers)", "No sensor drift", "Collects dirt, wears"],
    ["Gyroscope / IMU", "Works in mid-air", "Drifts over time"]]),
  R(/camera|lens|image sensor/, [
    ["Larger 1-inch sensor", "Better in low light", "Bulkier, pricier"],
    ["Periscope lens", "Long zoom, thin body", "Dimmer, more complex"],
    ["Fixed-focus module", "Cheap, nothing moves", "Blurry up close"]]),
  R(/sensor|thermistor|accelerometer|gyro|hall/, [
    ["Digital (I²C) sensor", "Calibrated, less wiring", "Needs firmware support"],
    ["Analog sensor", "Cheap and simple", "Noise, needs calibration"],
    ["Combo sensor chip", "Several sensors in one", "One part fails, all fail"]]),
  R(/antenna|wireless|bluetooth|receiver|transceiver|wifi|\brf\b/, [
    ["Bluetooth LE", "No dongle, low power", "Slight extra latency"],
    ["2.4 GHz dongle", "Fast, plug and play", "Uses a USB port, easy to lose"],
    ["Wired USB", "Zero lag, no battery", "Cable on the desk"]]),
  // display & sound
  R(/lcd|display|screen|monitor|panel/, [
    ["OLED", "True blacks, thinner", "Burn-in, costs more"],
    ["E-ink", "Readable in sun, tiny power", "Slow, mostly greyscale"],
    ["IPS LCD", "Cheap, long life", "Greyish blacks, needs backlight"]]),
  R(/speaker|buzzer|audio|earpiece/, [
    ["Piezo buzzer", "Tiny and cheap", "Thin, harsh sound"],
    ["Balanced-armature driver", "Clear sound, very small", "Weak bass, pricier"],
    ["Bone-conduction exciter", "Leaves ears open", "Lower quality"]]),
  R(/microphone|\bmic\b/, [
    ["MEMS microphone", "Tiny, consistent", "Picks up board noise"],
    ["Electret mic", "Cheap, warm sound", "Bigger, varies part to part"],
    ["Mic array", "Cancels background noise", "Needs DSP, more power"]]),
  R(/\bled\b|\bleds\b|light|backlight|lamp|bulb/, [
    ["RGB LED", "Any colour on demand", "Needs a driver chip"],
    ["Light pipe + one LED", "Fewer parts, even glow", "Dimmer at the far end"],
    ["OLED/edge-lit strip", "Smooth, thin light", "Costs more"]]),
  // input
  R(/scroll|wheel(?!s? (?:hub|tyre|tire))|encoder|knob|dial/, [
    ["Optical encoder", "No contacts to wear", "Costs a little more"],
    ["Free-spin metal wheel", "Fast long scrolls", "Heavier, less precise"],
    ["Touch scroll strip", "Sealed, no moving parts", "No clicky feedback"]]),
  R(/d-pad|dpad|directional|joystick|thumbstick|analog stick/, [
    ["Hall-effect stick", "No drift, lasts longer", "Costs more"],
    ["Membrane d-pad", "Cheap, soft and quiet", "Mushy, wears out"],
    ["Mechanical switches", "Crisp, precise clicks", "Louder, bigger"]]),
  R(/button|click|switch|\bkey\b|trigger|start|select/, [
    ["Optical switch", "No bounce, very long life", "Needs power to sense"],
    ["Membrane dome", "Quiet and cheap", "Mushy feel, wears sooner"],
    ["Capacitive touch pad", "Sealed, no moving parts", "Easy to press by accident"]]),
  R(/touch|trackpad|touchpad/, [
    ["Glass trackpad", "Smooth, scratch-proof", "More expensive"],
    ["Force-sensing pad", "Pressure as input", "Needs calibration"],
    ["Physical buttons", "Works with gloves", "Takes more space"]]),
  // motion
  R(/motor|fan|actuator|servo|vibrat|haptic/, [
    ["Brushless motor", "Quieter, lasts longer", "Needs a controller"],
    ["Linear resonant actuator", "Crisp haptic taps", "Narrow frequency range"],
    ["Stepper motor", "Precise positions", "Noisy, power hungry"]]),
  R(/tyre|tire|wheel|caster|roller/, [
    ["Solid rubber", "Never punctures", "Harsher ride"],
    ["Pneumatic", "Grips and absorbs bumps", "Can go flat"],
    ["Polyurethane", "Hard-wearing, quiet", "Slips when wet"]]),
  R(/gear|belt|chain|pulley|spring|hinge|axle|bearing|mechanism/, [
    ["Belt drive", "Quiet, no oiling", "Can slip or stretch"],
    ["Metal gears", "Strong, precise", "Noisier, heavier"],
    ["Compliant (flexure) part", "One piece, no wear", "Limited movement"]]),
  // connection
  R(/usb|port|connector|jack|socket|plug/, [
    ["USB-C", "Reversible, power + data", "Small pins can wear"],
    ["Magnetic connector", "Breaks away safely", "Fewer data lines"],
    ["Wireless link", "No port to break", "Adds battery drain"]]),
  R(/cable|wire|wiring|harness|ribbon|flex/, [
    ["Flex ribbon", "Thin, folds neatly", "Tears if bent too often"],
    ["Board-to-board connector", "No loose wires", "Boards must line up exactly"],
    ["Wireless link", "Nothing to snag", "Needs power and pairing"]]),
  // structure
  R(/screw|bolt|fastener|clip|rivet|snap/, [
    ["Snap-fit clips", "Fast, tool-free assembly", "Can break when opened"],
    ["Adhesive", "Clean look, sealed", "Hard to repair"],
    ["Torx screws", "Strong, re-openable", "Slower to assemble"]]),
  R(/shell|housing|\bcase\b|cover|chassis|\bbody\b|frame|enclosure|palm rest|plate|base|lid|bezel/, [
    ["Polycarbonate", "Tough, takes knocks", "Scratches more easily"],
    ["Aluminium", "Premium, cools better", "Dents, blocks radio"],
    ["Recycled ABS", "Cheap, greener", "Feels less premium"]]),
  R(/\bpad\b|feet|foot|grip|rubber/, [
    ["PTFE glide feet", "Very smooth gliding", "Wear down over time"],
    ["Silicone grip", "Soft and non-slip", "Attracts dust"],
    ["Textured plastic", "Lasts forever", "Less grip"]]),
];

const find = (word) => RULES.find((r) => r.re.test(word));
const BY_TYPE = {
  power_source: find("battery"), controller: find("pcb"), sensor: find("sensor"), display: find("lcd"), interface: find("button"),
  actuator: find("motor"), connector: find("usb"), cable: find("cable"), wheel: find("tyre"), mechanism: find("gear"),
  structure: find("housing"), cover: find("housing"), fastener: find("screw"),
};

export function alternativesFor(c) {
  if (!c) return [];
  const text = `${c.label || ""} ${String(c.type || "").replace(/_/g, " ")}`.toLowerCase();
  const rule = RULES.find((r) => r.re.test(text)) || BY_TYPE[c.type];
  return rule ? rule.alts : [];
}
