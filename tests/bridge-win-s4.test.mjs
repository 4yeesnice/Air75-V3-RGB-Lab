// Vectors ported from `HIDBridge --self-test` (native/HIDBridge.swift), so the
// Windows bridge is held to the same protocol evidence as the Mac helper.
import test from "node:test";
import assert from "node:assert/strict";
import * as S4 from "../bridge-win/s4.mjs";

const code = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };
const reply = (opts) => { const r = S4.frame(opts); r[0] = 0xaa; r[3] = S4.checksum(r); return r; };

const state = [2, 75, 2, 0, 0, 0, 0, 190, 174, 4, 60, 2, 1, 0, 255, 0, 0];
const shapeState = [22, 75, 2, 0, 0, 3, 0, 190, 174, 4, 60, 2, 1, 0, 255, 0, 0, 3, 24, 48, 96, 2];
const lightsOff = [0, 0, 3, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 255, 255, 255];
const fw16 = [16, 0, 1, 170, 6, 0, 0, 0], fw23 = [23, 0, 1, 170, 6, 0, 0, 0], fw99 = [99, 0, 1, 170, 6, 0, 0, 0];

test("schema selection by firmware", () => {
  assert.equal(S4.stateLength(fw16), 17);
  assert.equal(S4.stateLength(fw23), 22);
  assert.equal(S4.stateLength([16, 0, 1, 0, 6, 0, 0, 0]), null);
  assert.ok(S4.supportsPerKey(fw16) && !S4.supportsPerKey([15, 0, 1, 170, 6, 0, 0, 0]));
});

test("A1 key derivation and firmware version, without EE", () => {
  const { key, info } = S4.identify(reply({ command: 0xa1, length: 8, payload: [0x10, 0, 1, 0xaa, 6, 0, 0, 0], key: 0x37 }));
  assert.equal(key, 0x37);
  assert.equal(S4.firmwareVersion(info), "1.0.16.6");
  assert.equal(S4.firmwareVersion([17, 2, 1, 170, 1, 2, 88, 99]), "1.2.17.513");
  assert.equal(S4.firmwareVersion([16, 0, 1, 0, 6, 0, 0, 0]), "unknown");
});

test("captured D1 reply from a real Air75 V3 decodes to 104", () => {
  const captured = [0xaa, 0xd1, 0, 0xe9, 0x81, 0x80, 0x80, 0x80, 0xe8, ...new Array(55).fill(0)];
  assert.equal(S4.decodeLEDCount(captured, 0x80), 104);
  for (let k = 0; k < 256; k++) for (const enc of [false, true]) {
    const r = [0xaa, 0xd1, 0, 0, 1, 0, 0, 0, 104 ^ k, ...new Array(55).fill(0)];
    if (enc) for (let i = 4; i < 8; i++) r[i] ^= k;
    r[3] = S4.checksum(r);
    assert.equal(S4.decodeLEDCount(r, k), 104);
  }
  const stale = [...captured]; stale[4] = 2 ^ 0x80; stale[3] = S4.checksum(stale);
  assert.equal(code(() => S4.decodeLEDCount(stale, 0x80)), "ROUTE_MISMATCH");
  const corrupt = [...captured]; corrupt[8] ^= 1;
  assert.equal(code(() => S4.decodeLEDCount(corrupt, 0x80)), "INVALID_CHECKSUM");
  for (const wrong of [0, 83, 103, 105, 255]) {
    const r = [...captured]; r[8] = wrong ^ 0x80; r[3] = S4.checksum(r);
    assert.equal(code(() => S4.decodeLEDCount(r, 0x80)), "WRONG_LED_COUNT");
  }
});

test("both routing forms decode, wrong profile and corruption are rejected", () => {
  for (const profile of [0, 1]) for (const plaintext of [true, false]) {
    const r = reply({ command: 0xd5, length: 17, payload: state, handle: profile, key: 0x5a });
    assert.equal(r[7], profile ^ 0x5a);
    if (plaintext) { r.splice(4, 4, 17, 0, 0, profile); r[3] = S4.checksum(r); }
    assert.deepEqual(S4.decode(r, { command: 0xd5, length: 17, handle: profile, key: 0x5a }), state);
    assert.equal(code(() => S4.decode(r, { command: 0xd5, length: 17, handle: 1 - profile, key: 0x5a })), "ROUTE_MISMATCH");
    r[10] ^= 1;
    assert.equal(code(() => S4.decode(r, { command: 0xd5, length: 17, handle: profile, key: 0x5a })), "INVALID_CHECKSUM");
  }
  const r22 = reply({ command: 0xd5, length: 22, payload: shapeState, key: 0x80 });
  assert.deepEqual(S4.decode(r22, { command: 0xd5, length: 22, key: 0x80 }), shapeState);
  assert.equal(code(() => S4.decode(r22, { command: 0xd5, length: 17, key: 0x80 })), "ROUTE_MISMATCH");
});

test("frame allowlist: no IAP, no keymap writes, handle 1 only for lighting", () => {
  assert.equal(code(() => S4.frame({ command: 0xef, length: 0, key: 0 })), "INVALID_FRAME");
  assert.equal(code(() => S4.frame({ command: 0xb3, length: 2, address: 8, payload: [0, 61], key: 0 })), "INVALID_FRAME");
  assert.equal(code(() => S4.frame({ command: 0xa0, length: 8, handle: 1, key: 0 })), "INVALID_FRAME");
  assert.equal(S4.frame({ command: 0xd8, length: 4, payload: [0, 8, 16, 24], handle: 1, key: 0x80 })[7], 1 ^ 0x80);
});

test("1.0.23.6 main-colour HSV drift and exact inverse", () => {
  assert.deepEqual(S4.mainColorReadback([64, 0, 14]), [64, 0, 17]);
  assert.deepEqual(S4.mainColorReadback(S4.exactMainColorInput([64, 0, 14])), [64, 0, 14]);
  for (let r = 0; r < 256; r += 51) for (let g = 0; g < 256; g += 51) for (let b = 0; b < 256; b += 51) {
    const observed = S4.mainColorReadback([r, g, b]);
    assert.deepEqual(S4.mainColorReadback(S4.exactMainColorInput(observed)), observed);
  }
});

test("statesMatch skips only firmware-proven reserved bytes", () => {
  for (const i of state.keys()) {
    const changed = [...state]; changed[i] ^= 1;
    assert.equal(S4.statesMatch(state, changed, fw16), i === 5 || i === 13, `fw16 offset ${i}`);
  }
  for (const i of shapeState.keys()) {
    const changed = [...shapeState]; changed[i] ^= 1;
    assert.equal(S4.statesMatch(shapeState, changed, fw23), i === 13, `fw23 offset ${i}`);
    assert.equal(S4.statesMatch(shapeState, changed, fw99), false, `future firmware offset ${i}`);
  }
});

test("geometry, master-off detection and restore target", () => {
  const geometry = [0, 8, 4, 6, 16, 2, 0, 0];
  assert.ok(S4.validGeometry(geometry));
  for (let i = 0; i <= 4; i++) { const g = [...geometry]; g[i] = 99; assert.ok(!S4.validGeometry(g)); }
  const ext = [...lightsOff, 3, 24, 48, 96, 2];
  const restored = S4.restoreTarget(ext);
  assert.equal(restored[0], 2);
  assert.deepEqual(restored.slice(17), ext.slice(17));
  const wants = [...ext]; wants[0] = 21; wants[1] = 100;
  assert.equal(S4.stateMismatchCode(wants, ext), "LIGHTING_DISABLED");
});

test("custom palette rendering round trip on 1.0.23.6", () => {
  const palette = Array.from({ length: 252 }, (_, i) => i % 251);
  const rendered = S4.renderedCustomColors(palette, fw23);
  assert.deepEqual(S4.renderedCustomColors(S4.paletteFromRendered(rendered, fw23), fw23), rendered);
  assert.deepEqual(S4.renderedCustomColors(S4.paletteFromRendered(rendered, fw23, true), fw23), rendered);
  assert.deepEqual(S4.renderedCustomColors(palette, fw16), palette);
});

test("preset speed read tolerance never reaches the setter", () => {
  const raw = [...shapeState]; raw[21] = 94;
  assert.ok(S4.readableState(raw, fw23) && !S4.validState(raw, fw23));
  assert.equal(S4.stateWritePayload(raw, raw, fw23).length, 17);
  const changed = [...raw]; changed[18] = 1;
  assert.equal(code(() => S4.stateWritePayload(changed, raw, fw23)), "INVALID_STATE");
});

test("color parsing", () => {
  assert.equal(S4.parseColors(new Array(84).fill("#ff4080"), 84).length, 252);
  assert.deepEqual(S4.hexColors([255, 64, 128]), ["#ff4080"]);
  assert.equal(code(() => S4.parseColors(["#fff"], 1)), "INVALID_COLOR");
});
