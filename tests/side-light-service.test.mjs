// User side light colour through the real service: apply, priorities, resume and restore.
// Fake HID state bytes: [9] side mode, [10] side brightness, [14..16] side RGB.
import test from "node:test";
import assert from "node:assert/strict";
import { fakeService, until } from "./helpers/fake-service.mjs";
import { validateSettings, defaultSettings } from "../server/storage.mjs";

const ORIGINAL_SIDE = [2, 65, 0, 0, 0, 19, 51, 68];
const side = (state) => state.device.state.slice(9, 17);
const rgb = (state) => state.device.state.slice(14, 17);
const sideOps = async (s) => (await s.operations()).filter((o) => o.op === "side");

test("validation merges partial side light settings and rejects bad values", () => {
  const a = validateSettings({ sideLight: { enabled: true } });
  assert.deepEqual(a.sideLight, { ...defaultSettings.sideLight, enabled: true });
  const b = validateSettings({ sideLight: { color: "#FF8800", brightness: 30 } }, a);
  assert.deepEqual(b.sideLight, { enabled: true, color: "#ff8800", brightness: 30 });
  for (const bad of [{ color: "red" }, { brightness: 101 }, { brightness: 2.5 }, { enabled: "yes" }, { mode: 1 }]) {
    assert.throws(() => validateSettings({ sideLight: bad }, b), undefined, JSON.stringify(bad));
  }
  assert.deepEqual(validateSettings({ brightness: 50 }).sideLight, defaultSettings.sideLight, "old libraries get the default");
});

test("custom side colour applies, survives games and quota, and restores the original", async (t) => {
  const s = await fakeService(t);
  await until(() => s.state(), (v) => v.device.connected, "keyboard connects");
  assert.deepEqual(side(await s.state()), ORIGINAL_SIDE);

  // Enable: applied immediately with the default white at 60%.
  assert.equal((await s.command({ op: "settings", settings: { sideLight: { enabled: true } } })).ok, true);
  let state = await s.state();
  assert.deepEqual(rgb(state), [255, 255, 255]);
  assert.equal(state.device.state[10], 60);
  assert.equal(state.device.sideLightActive, true);
  assert.equal(state.device.sideColor, "#ffffff");

  // Colour + brightness edit.
  await s.command({ op: "settings", settings: { sideLight: { color: "#ff8800", brightness: 40 } } });
  state = await s.state();
  assert.deepEqual(rgb(state), [255, 136, 0]);
  assert.equal(state.device.state[10], 40);

  // An unchanged colour is not rewritten by the frame loop.
  const before = (await sideOps(s)).length;
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await sideOps(s)).length, before, "no repeated side writes while idle");

  // Games mute the strip; it comes back after the game.
  await s.command({ op: "gameStart", gameType: "whack" });
  await until(() => s.state(), (v) => v.device.state[10] === 0, "game mutes side lights");
  assert.equal((await s.state()).device.sideLightActive, false);
  await s.command({ op: "gameStop" });
  await until(() => s.state(), (v) => v.device.state[10] === 40 && v.device.sideLightActive, "user colour returns after the game");
  assert.deepEqual(rgb(await s.state()), [255, 136, 0]);

  // Codex quota colour has priority; turning it off brings the user colour back.
  await s.command({ op: "settings", settings: { quotaSideEnabled: true } });
  await until(() => s.state(), (v) => v.device.sideColor === "#6f9e85", "quota colour takes the strip");
  assert.equal((await s.state()).device.sideLightActive, false);
  await s.command({ op: "settings", settings: { quotaSideEnabled: false } });
  await until(() => s.state(), (v) => v.device.sideLightActive && v.device.state[10] === 40, "user colour returns after quota");

  // Restore original lights: side restored and stays restored until the next edit.
  await s.command({ op: "restore" });
  await new Promise((r) => setTimeout(r, 200));
  state = await s.state();
  assert.deepEqual(side(state), ORIGINAL_SIDE);
  assert.equal(state.device.sideLightActive, false);
  await s.command({ op: "settings", settings: { sideLight: { brightness: 70 } } });
  state = await s.state();
  assert.equal(state.device.state[10], 70, "an explicit edit reapplies after restore");

  // Disable: original side restored.
  await s.command({ op: "settings", settings: { sideLight: { enabled: false } } });
  state = await s.state();
  assert.deepEqual(side(state), ORIGINAL_SIDE);
  assert.equal(state.device.sideLightActive, false);
  assert.equal(state.device.sideColor, null);
  assert.equal(state.settings.sideLight.color, "#ff8800", "colour choice is kept for next time");
});

test("invalid side colour is rejected without touching the strip", async (t) => {
  const s = await fakeService(t);
  await until(() => s.state(), (v) => v.device.connected, "keyboard connects");
  const result = await s.command({ op: "settings", settings: { sideLight: { enabled: true, color: "#12" } } });
  assert.equal(result.ok, false);
  assert.equal((await sideOps(s)).length, 0);
  assert.deepEqual(side(await s.state()), ORIGINAL_SIDE);
});
