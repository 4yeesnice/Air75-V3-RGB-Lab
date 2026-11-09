// End-to-end lifecycle of the Windows bridge against a simulated Air75 V3:
// connect → arm → paint → restore, journals, rollback and the JSONL contract.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Air75Device } from "../bridge-win/device.mjs";
import { createBridge } from "../bridge-win/bridge.mjs";
import * as S4 from "../bridge-win/s4.mjs";
import { FakeAir75 } from "./helpers/fake-air75.mjs";

const FW16 = [16, 0, 1, 170, 6, 0, 0, 0], FW23 = [23, 0, 1, 170, 6, 0, 0, 0];
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nuphylab-win-")), "original-lighting.json");
const colors = (fn) => Array.from({ length: 84 }, (_, i) => fn(i)).flat();

for (const [name, firmware] of [["1.0.16.6 (17-byte state)", FW16], ["1.0.23.6 (22-byte state)", FW23]]) {
  test(`full lighting session restores the original exactly — ${name}`, async () => {
    const board = new FakeAir75({ firmware });
    const originalState = [...board.state], originalRendered = board.rendered();
    const backupPath = tmp();
    const device = new Air75Device({ backupPath, transport: board });

    const c = await device.connect();
    assert.equal(c.ledCount, 104);
    assert.equal(c.capabilities.stateBytes, firmware[0] === 23 ? 22 : 17);
    assert.equal(c.recoveryPending, false);

    const a = await device.arm();
    assert.equal(a.verified, true);
    assert.equal(board.state[0], 21);
    const journal = JSON.parse(fs.readFileSync(device.journals.url(0), "utf8"));
    assert.deepEqual(journal.state, originalState, "journal holds the original state before any D8");
    assert.equal(journal.customColors !== undefined, firmware[0] === 23, "new firmware also journals the custom palette");

    const frame = colors((i) => [i, 255 - i, (i * 3) % 256]);
    assert.equal((await device.paint(frame, false)).verification, "readback", "first paint is always read back");
    const second = colors((i) => (i < 4 ? [1, 2, 3] : [i, 255 - i, (i * 3) % 256]));
    const before = board.writes;
    assert.equal((await device.paint(second, false)).verification, "validatedAck");
    assert.equal(board.writes - before, 1, "only the 4 changed LEDs are sent, in one D8 packet");
    assert.equal((await device.paint(second, false)).skipped, true, "identical frame produces no traffic");

    const r = await device.restore();
    assert.equal(r.restored, true);
    assert.deepEqual(board.state, originalState);
    assert.equal(r.verification, "completeState");
    assert.equal(fs.existsSync(device.journals.url(0)), false, "journal removed only after verified restore");
  });

  test(`original custom effect 21 is restored pixel-exact — ${name}`, async () => {
    const board = new FakeAir75({ firmware });
    board.state[0] = 21; board.state[1] = 100; board.state[4] = 1;
    if (board.state.length === 22) board.state.splice(6, 3, 255, 255, 255);
    // A user's own palette, stored as exact inverse representatives on new firmware.
    const userPalette = colors((i) => [(i * 7) % 256, (i * 13) % 256, (255 - i * 3) % 256]);
    board.rgb = [...(firmware[0] === 23 ? S4.paletteFromRendered(S4.renderedCustomColors(userPalette, firmware), firmware) : userPalette), ...new Array(60).fill(0)];
    const originalState = [...board.state], originalRendered = board.rendered().slice(0, 252);
    const device = new Air75Device({ backupPath: tmp(), transport: board });
    await device.connect(); await device.arm();
    await device.paint(colors(() => [200, 0, 0]), false);
    assert.notDeepEqual(board.rendered().slice(0, 252), originalRendered, "playback really changed the keys");
    const r = await device.restore();
    assert.equal(r.verification, "stateAndCustomColors");
    assert.deepEqual(board.state, originalState);
    assert.deepEqual(board.rendered().slice(0, 252), originalRendered);
  });
}

test("Win-mode keyboard uses profile handle 1 and its own journal", async () => {
  const board = new FakeAir75({ profile: 1 });
  const device = new Air75Device({ backupPath: tmp(), transport: board });
  assert.equal((await device.connect()).lightingProfile, 1);
  await device.arm();
  assert.ok(device.journals.exists(1) && !device.journals.exists(0));
  await device.restore();
  assert.ok(!device.journals.exists(1));
});

test("crash recovery: a leftover journal is restored on the next process", async () => {
  const backupPath = tmp();
  const board = new FakeAir75();
  const originalState = [...board.state];
  const first = new Air75Device({ backupPath, transport: board });
  await first.connect(); await first.arm();
  await first.paint(colors(() => [9, 9, 9]), false);
  // simulate SIGKILL: no shutdown, new bridge process
  await board.close();
  const second = new Air75Device({ backupPath, transport: board });
  const c = await second.connect();
  assert.equal(c.recoveryPending, true);
  await assert.rejects(second.arm(), { code: "RECOVERY_REQUIRED" });
  await second.restore();
  assert.deepEqual(board.state, originalState);
});

test("master lighting switch off → LIGHTING_DISABLED, original kept", async () => {
  const board = new FakeAir75({ state: [0, 0, 3, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 255, 255, 255] });
  board.masterOff = true; // board ACKs D6 but ignores it
  const device = new Air75Device({ backupPath: tmp(), transport: board });
  await device.connect();
  await assert.rejects(device.arm(), (e) => e.code === "LIGHTING_DISABLED" && e.message.includes("restored and verified"));
  assert.equal(device.armed, false);
  assert.equal(device.journals.exists(0), false, "unchanged all-off state verified, nothing left to recover");
});

test("failed colour verification rolls back to the original immediately", async () => {
  const board = new FakeAir75();
  const originalState = [...board.state];
  const device = new Air75Device({ backupPath: tmp(), transport: board, log: () => {} });
  await device.connect(); await device.arm();
  const realRendered = board.rendered.bind(board);
  let broken = true;
  board.rendered = () => { const out = realRendered(); if (broken && board.state[0] === 21) out[0] ^= 1; return out; };
  await assert.rejects(device.paint(colors(() => [7, 7, 7]), false), (e) => {
    broken = false;
    return e.code === "COLOR_VERIFY_FAILED" || e.code === "RESTORE_REQUIRED";
  });
  broken = false;
  if (device.recoveryPending) await device.restore();
  assert.deepEqual(board.state, originalState);
});

test("Mac/Win switch during playback stops writes and keeps the journal", async () => {
  const board = new FakeAir75();
  const device = new Air75Device({ backupPath: tmp(), transport: board });
  await device.connect(); await device.arm();
  board.profile = 1;
  await assert.rejects(device.paint(colors(() => [5, 5, 5]), false), { code: "LIGHTING_PROFILE_CHANGED" });
  assert.ok(device.journals.exists(0));
});

test("unplug during playback: shutdown defers recovery instead of claiming success", async () => {
  const events = [];
  const board = new FakeAir75();
  const device = new Air75Device({ backupPath: tmp(), transport: board, emit: (e) => events.push(e) });
  await device.connect(); await device.arm();
  board.unplug();
  assert.equal(await device.shutdown(), true);
  assert.ok(events.some((e) => e.event === "disconnected" && e.needsRestore));
  assert.ok(events.some((e) => e.event === "restoreDeferred"));
  assert.ok(events.find((e) => e.event === "shutdownComplete").lightingDeferred);
  assert.ok(device.journals.exists(0));
});

test("plaintext reply routing is accepted like the Mac bridge", async () => {
  const board = new FakeAir75({ plaintextRoute: true, key: 0x37 });
  const device = new Air75Device({ backupPath: tmp(), transport: board });
  assert.equal((await device.connect()).ledCount, 104);
});

test("JSONL contract: responses, unsupported ops, quit restores and completes shutdown", async () => {
  const out = [];
  const board = new FakeAir75({ firmware: FW23 });
  const originalState = [...board.state];
  let exitCode = null;
  const bridge = createBridge({ backupPath: tmp(), transport: board, emitEvent: (o) => out.push(o), logger: () => {} });
  bridge.onShutdown = (ok) => { exitCode = ok ? 0 : 2; };
  const send = (o) => bridge.submit(JSON.stringify(o));
  const until = async (pred) => { for (let i = 0; i < 400 && !pred(); i++) await new Promise((r) => setTimeout(r, 10)); assert.ok(pred()); };

  send({ id: 1, op: "connect" });
  send({ id: 2, op: "arm" });
  send({ id: 3, op: "paint", colors: new Array(84).fill("#102030"), verify: true });
  send({ id: 4, op: "readColors" });
  send({ id: 5, op: "triggerMonitor", enabled: true, keyCode: 49 });
  send({ id: 6, op: "paint", colors: ["#zz"] });
  await until(() => out.filter((o) => o.id).length === 6);
  const byId = Object.fromEntries(out.filter((o) => o.id).map((o) => [o.id, o]));
  assert.ok(byId[1].ok && byId[2].ok && byId[3].ok);
  assert.equal(byId[3].result.verification, "readback");
  assert.equal(byId[4].result.colors[0], "#0c1925", "readback shows 200/255 firmware scaling");
  assert.equal(byId[4].result.customColorScale, 200);
  assert.equal(byId[5].error.code, "INPUT_MONITORING_REQUIRED", "server falls back to window-only triggers");
  assert.equal(byId[6].error.code, "INVALID_COLORS");

  send({ id: 7, op: "quit" });
  await until(() => exitCode !== null);
  assert.equal(exitCode, 0);
  assert.ok(out.some((o) => o.event === "restoredOnExit"));
  assert.ok(out.find((o) => o.event === "shutdownComplete").lightingRestored);
  assert.deepEqual(board.state, originalState);
});

test("rendered-colour inverse matches the simulated renderer", () => {
  const board = new FakeAir75({ firmware: FW23 });
  board.state[0] = 21; board.state.splice(6, 3, 255, 255, 255);
  board.rgb = [...S4.paletteFromRendered(S4.renderedCustomColors(colors((i) => [i, i, i]), FW23), FW23), ...new Array(60).fill(0)];
  assert.deepEqual(board.rendered().slice(0, 252), S4.renderedCustomColors(colors((i) => [i, i, i]), FW23));
});

test("real 1.0.23.6 board state (Win profile, custom effect at brightness 63) restores exactly", async () => {
  // D5 captured from an Air75 V3 on Windows via `probe.mjs`; first keys rendered 16/16/126.
  const captured = [21, 63, 0, 0, 1, 0, 0, 6, 161, 4, 60, 2, 1, 0, 255, 0, 0, 0, 255, 0, 0, 0];
  assert.deepEqual(S4.mainColorReadback(captured.slice(6, 9)), captured.slice(6, 9));
  const board = new FakeAir75({ firmware: FW23, state: [...captured], profile: 1 });
  board.rgb = [...Array.from({ length: 252 }, (_, i) => (i % 3 === 2 ? 255 : 32 + (i % 41))), ...new Array(60).fill(0)];
  const originalRendered = board.rendered().slice(0, 252);
  const device = new Air75Device({ backupPath: tmp(), transport: board, log: () => {} });
  await device.connect(); await device.arm();
  for (let f = 0; f < 10; f++) await device.paint(Array.from({ length: 252 }, (_, i) => (i * 7 + f * 13) % 256), false);
  const r = await device.restore();
  assert.equal(r.verification, "stateAndCustomColors");
  assert.deepEqual(board.state, captured);
  assert.deepEqual(board.rendered().slice(0, 252), originalRendered);
});

test("side-only session on the real 1.0.23.6 custom effect never rewrites the palette", async () => {
  const captured = [21, 63, 0, 0, 1, 0, 0, 6, 161, 4, 60, 2, 1, 0, 255, 0, 0, 0, 255, 0, 0, 0];
  const board = new FakeAir75({ firmware: FW23, state: [...captured], profile: 1 });
  const device = new Air75Device({ backupPath: tmp(), transport: board, log: () => {} });
  await device.connect();
  const set = await device.setSide([255, 136, 0], 40);
  assert.equal(set.changed, true);
  assert.deepEqual(board.state.slice(9, 17), [2, 40, captured[11], 0, 0, 255, 136, 0]);
  assert.deepEqual(board.state.slice(0, 9), captured.slice(0, 9), "key lighting untouched");
  assert.deepEqual(board.state.slice(17), captured.slice(17), "preset bytes untouched");
  assert.ok(device.journals.exists(1), "backup written before the side write");
  assert.equal((await device.setSide([255, 136, 0], 40)).changed, false, "same colour is not rewritten");
  const back = await device.restoreSide();
  assert.equal(back.restored, true);
  assert.deepEqual(board.state.slice(9, 17), captured.slice(9, 17));
  const palette = [...board.rgb];
  await device.setSide([0, 0, 255], 100);
  const writesBefore = board.writes;
  const r = await device.restore();
  assert.equal(r.verification, "stateAndCustomColors");
  assert.deepEqual(board.state, captured);
  assert.deepEqual(board.rgb, palette, "the user's palette is untouched");
  assert.equal(board.writes - writesBefore, 1, "only one D6 state write, no D8 palette writes");
  assert.ok(!device.journals.exists(1));
});
