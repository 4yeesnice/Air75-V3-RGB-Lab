// NuPhy S4 protocol for Air75 V3, ported 1:1 from native/HIDBridge.swift (enum S4).
// Pure functions only: no I/O, so everything here is testable without a keyboard.
// Byte semantics, allowlists and verification rules intentionally match the Swift
// bridge; see native/PROTOCOL.md for the reasoning behind each rule.

export class BridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
export const failure = (code, message) => new BridgeError(code, message);

export const VENDOR_ID = 0x19f5;
export const PRODUCT_ID = 0x1028;
export const REPORT_SIZE = 64;
// Air75 V3 D1 returns one byte; the following zero is padding, not a high byte.
export const LED_COUNT_LENGTH = 1;
export const ALLOWED_COMMANDS = new Set([0xa0, 0xa1, 0xb1, 0xb2, 0xb3, 0xd1, 0xd2, 0xd5, 0xd6, 0xd8]);
const PROFILE_COMMANDS = new Set([0xd5, 0xd6, 0xd8]);

const u8 = (n) => n & 0xff;
const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const prefixEq = (fw, bytes) => eq(Array.from(fw).slice(0, bytes.length), bytes);

/** 17-byte state for 1.0.16.6, 22-byte (preset shapes) from 1.0.17.6; null = unsupported. */
export function stateLength(fw) {
  if (fw?.length !== 8 || fw[3] !== 0xaa || fw[2] !== 1 || fw[4] !== 6 || fw[5] !== 0) return null;
  return fw[1] > 0 || fw[0] >= 17 ? 22 : 17;
}
export function supportsPerKey(fw) {
  return stateLength(fw) !== null && (fw[1] > 0 || fw[0] >= 16);
}

/** 1.0.23.6 renders the palette through HSV value capped at 200; LED 83's G/B also by 150/255. */
export function renderedCustomByte(value, index, fw) {
  if (stateLength(fw) !== 22) return value;
  const scaled = Math.trunc((value * 200) / 255);
  return index >= 250 ? Math.trunc((scaled * 150) / 255) : scaled;
}
export function renderedCustomColors(colors, fw) {
  return Array.from(colors, (v, i) => renderedCustomByte(v, i, fw));
}
export function paletteFromRendered(colors, fw, high = false) {
  return Array.from(colors, (value, index) => {
    let pick = null;
    for (let v = 0; v <= 255; v++) {
      if (renderedCustomByte(v, index, fw) === value) {
        pick = v;
        if (!high) break;
      }
    }
    if (pick === null) throw failure("CUSTOM_BACKUP_LOSSY", "Cannot reconstruct the keyboard's custom palette; original state retained.");
    return pick;
  });
}

export function validGeometry(v) {
  return v?.length === 8 && v[0] <= 1 && eq(Array.from(v).slice(1, 5), [8, 4, 6, 16]) &&
    ((v[5] & 0x80) === 0 || (v[5] & 0x7f) === 2);
}
export function validState(s, fw) {
  const length = stateLength(fw);
  if (!length || s?.length !== length) return false;
  return s[0] <= (length === 22 ? 22 : 21) && s[1] <= 100 && s[2] <= 4 && s[3] <= 3 && s[4] <= 1 &&
    s[9] <= 4 && s[10] <= 100 && s[11] <= 4 && s[12] <= 1 && (length === 17 || (s[17] <= 7 && s[21] <= 4));
}
/** Some 1.0.23.6 boards read back an out-of-range preset speed (e.g. 94); keep it, never write it. */
export function readableState(s, fw) {
  if (stateLength(fw) !== 22 || s?.length !== 22) return validState(s, fw);
  const checked = Array.from(s);
  checked[21] = 0;
  return validState(checked, fw);
}
export function stateWritePayload(target, current, fw) {
  if (!readableState(target, fw) || !readableState(current, fw)) {
    throw failure("INVALID_STATE", "Refusing an invalid lighting configuration.");
  }
  if (target.length === 22 && eq(target.slice(17), current.slice(17))) return target.slice(0, 17);
  if (!validState(target, fw)) {
    throw failure("INVALID_STATE", "Cannot overwrite an unrecognized preset parameter; original backup retained.");
  }
  return Array.from(target);
}

// 1.0.23.6 stores the main colour as byte HSV (V scaled to 200); D5 converts back.
// Float32 arithmetic mirrors the Swift code (and the firmware) exactly.
const f = Math.fround;
export function mainColorReadback([r, g, b]) {
  const hi = Math.max(r, g, b), lo = Math.min(r, g, b), delta = hi - lo;
  const value = Math.trunc((Math.trunc((hi * 200) / 255) * 255 + 100) / 200);
  if (delta === 0) return [value, value, value];
  const saturation = Math.trunc(f(f(f(f(delta) / f(hi)) * 255) + 0.5));
  let hue;
  if (hi === r) hue = f(f(f(g - b) / f(delta)) * 43);
  else if (hi === g) hue = f(f(f(f(b - r) / f(delta)) + 2) * 43);
  else hue = f(f(f(f(r - g) / f(delta)) + 4) * 43);
  if (hue < 0) hue = f(hue + 255);
  const h = Math.trunc(f(hue + 0.5)) & 255, region = Math.trunc(h / 43), remainder = (h - region * 43) * 6;
  const p = Math.trunc(((255 - saturation) * value + 127) / 255);
  const q = Math.trunc(((255 - Math.trunc((saturation * remainder) / 255)) * value + 127) / 255);
  const t = Math.trunc(((255 - Math.trunc((saturation * (255 - remainder)) / 255)) * value + 127) / 255);
  switch (region) {
    case 0: return [value, t, p];
    case 1: return [q, value, p];
    case 2: return [p, value, t];
    case 3: return [p, q, value];
    case 4: return [t, p, value];
    default: return [value, p, q];
  }
}
export function exactMainColorInput(target) {
  if (eq(mainColorReadback(target), target)) return Array.from(target);
  for (const radius of [4, 8, 16]) {
    const lo = (c) => Math.max(0, target[c] - radius), hi = (c) => Math.min(255, target[c] + radius);
    for (let r = lo(0); r <= hi(0); r++)
      for (let g = lo(1); g <= hi(1); g++)
        for (let b = lo(2); b <= hi(2); b++)
          if (eq(mainColorReadback([r, g, b]), target)) return [r, g, b];
  }
  throw failure("RESTORE_COLOR_UNREPRESENTABLE", `Cannot exactly encode saved main colour ${target}; original backup retained.`);
}

/** Exact equality except firmware-verified unimplemented slots (5/13 on 1.0.16.6, 13 on 1.0.23.6). */
export function statesMatch(expected, observed, fw) {
  const length = stateLength(fw);
  if (!length || expected?.length !== length || observed?.length !== length) return false;
  const unusedPaletteSlots = prefixEq(fw, [0x10, 0, 1, 0xaa, 6, 0]);
  const unusedSidePalette = prefixEq(fw, [23, 0, 1, 0xaa, 6, 0]);
  return expected.every((v, i) =>
    (unusedPaletteSlots && (i === 5 || i === 13)) || (unusedSidePalette && i === 13) || v === observed[i]);
}

export function checksum(bytes) {
  let sum = 0;
  for (let i = 4; i < bytes.length; i++) sum = (sum + bytes[i]) & 0xff;
  return sum;
}
export function stateMismatchCode(expected, observed) {
  const sized = (s) => s.length === 17 || s.length === 22;
  const wantsLight = sized(expected) && (expected[0] !== 0 || expected[1] > 0 || expected[10] > 0);
  const staysOff = observed.length === expected.length && sized(observed) && observed[0] === 0 && observed[1] === 0 && observed[10] === 0;
  return wantsLight && staysOff ? "LIGHTING_DISABLED" : "STATE_VERIFY_FAILED";
}
/** D6 cannot store mode 0; restore a master-off snapshot as stock static mode at zero brightness. */
export function restoreTarget(state) {
  if (!(state.length === 17 || state.length === 22) || state[0] !== 0 || state[1] !== 0 || state[10] !== 0) return Array.from(state);
  const target = Array.from(state);
  target[0] = 2;
  return target;
}

export function frame({ command, length, address = 0, payload = [], handle = 0, key }) {
  if (!ALLOWED_COMMANDS.has(command) || length < 0 || length > 56 || payload.length > 56 ||
      address < 0 || address > 65535 || (payload.length && payload.length !== length) ||
      !(handle === 0 || (handle === 1 && PROFILE_COMMANDS.has(command)))) {
    throw failure("INVALID_FRAME", "Command, length, or address is outside the bridge's allowlist.");
  }
  // This bridge has no keymap writer at all (the Swift F4 lease is macOS-specific).
  if (command === 0xb3) throw failure("INVALID_FRAME", "Keymap writes are not available in the Windows bridge.");
  const bytes = new Array(REPORT_SIZE).fill(0);
  bytes[0] = 0x55; bytes[1] = command;
  bytes[4] = u8(length ^ key);
  bytes[5] = u8((address & 255) ^ key);
  bytes[6] = u8((address >> 8) ^ key);
  bytes[7] = u8(handle ^ key);
  payload.forEach((v, i) => { bytes[8 + i] = u8(v ^ key); });
  bytes[3] = checksum(bytes);
  return bytes;
}
export function validate(raw, command) {
  if (raw?.length !== REPORT_SIZE || raw[0] !== 0xaa || raw[1] !== command || raw[2] !== 0) {
    throw failure("INVALID_REPLY", "HID response marker, command or report length did not match.");
  }
  if (raw[3] !== checksum(raw)) throw failure("INVALID_CHECKSUM", "HID response checksum did not match.");
}
export function decode(raw, { command, length, address = 0, handle = 0, key }) {
  validate(raw, command);
  const route = [length, address & 255, address >> 8, handle];
  const rawRoute = Array.from(raw).slice(4, 8);
  if (!eq(rawRoute, route) && !eq(rawRoute.map((v) => v ^ key), route)) {
    throw failure("ROUTE_MISMATCH", "HID response route did not match; another configurator may own the session.");
  }
  return Array.from(raw).slice(8, 8 + length).map((v) => v ^ key);
}
/** A1 payload byte 3 is the constant 0xAA, so the session XOR key is raw[11] ^ 0xAA (no EE handshake). */
export function identify(raw) {
  validate(raw, 0xa1);
  const key = raw[11] ^ 0xaa;
  const info = decode(raw, { command: 0xa1, length: 8, key });
  if (info[3] !== 0xaa) throw failure("FIRMWARE_REPLY", "Unrecognized firmware identification response.");
  return { key, info };
}
export function firmwareVersion(info) {
  if (info?.length !== 8 || info[3] !== 0xaa) return "unknown";
  return `${info[2]}.${info[1]}.${info[0]}.${info[4] | (info[5] << 8)}`;
}
export function decodeLEDCount(raw, key) {
  const [count] = decode(raw, { command: 0xd1, length: LED_COUNT_LENGTH, key });
  if (count !== 104) throw failure("WRONG_LED_COUNT", `LED count check failed: expected 104, got ${count}. Lighting writes stopped.`);
  return count;
}

export function parseColor(value) {
  const s = typeof value === "string" && value.startsWith("#") ? value.slice(1) : value;
  if (typeof s !== "string" || !/^[0-9a-fA-F]{6}$/.test(s)) {
    throw failure("INVALID_COLOR", "Colors must be six hexadecimal digits, for example #ff4080.");
  }
  const n = parseInt(s, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function parseColors(value, count) {
  if (!Array.isArray(value) || value.length !== count || !value.every((v) => typeof v === "string")) {
    throw failure("INVALID_COLORS", `colors must contain exactly ${count} strings in #rrggbb form.`);
  }
  return value.flatMap(parseColor);
}
export function hexColors(bytes) {
  const out = [];
  for (let i = 0; i + 2 < bytes.length; i += 3) {
    out.push("#" + [bytes[i], bytes[i + 1], bytes[i + 2]].map((v) => v.toString(16).padStart(2, "0")).join(""));
  }
  return out;
}
