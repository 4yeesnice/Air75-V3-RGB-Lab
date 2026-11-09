// HidTransport against a fake node-hid module: interface selection and the
// event-driven request/reply path (no setTimeout polling between packets).
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { HidTransport } from "../bridge-win/transport.mjs";
import * as S4 from "../bridge-win/s4.mjs";

class FakeHid extends EventEmitter {
  constructor(mode) { super(); this.mode = mode; this.writes = []; }
  async write(bytes) {
    this.writes.push(bytes);
    const r = [...bytes.slice(1)]; r[0] = 0xaa; r[3] = S4.checksum(r);
    const send = (b) => this.emit("data", Buffer.from(b));
    switch (this.mode) {
      case "early": send(r); return;                                   // reply before write() resolves
      case "silent": return;
      case "unplug": setImmediate(() => this.emit("error", new Error("device disconnected"))); return;
      case "stale": { const s = [...r]; s[1] = 0xd5; s[3] = S4.checksum(s); send(s); break; }
      case "corrupt": r[10] ^= 1; break;
    }
    setImmediate(() => send(this.mode === "65" ? [0, ...r] : r));
  }
  async close() {}
}

async function open(mode, interfaces = [{ path: "p3", usagePage: 1, interface: 3, serialNumber: "S" }]) {
  const device = new FakeHid(mode);
  const hid = { devicesAsync: async () => interfaces, HIDAsync: { open: async (p) => { device.path = p; return device; } } };
  const transport = new HidTransport({ hid });
  await transport.open();
  return { transport, device };
}
const frame = () => S4.frame({ command: 0xd8, length: 4, payload: [0, 1, 2, 3], key: 0x80 });

test("opens the usage-0 interface from the real Windows enumeration", async () => {
  const { device, transport } = await open("normal", [
    { path: "p2a", usagePage: 1, usage: 2, interface: 2 }, { path: "p2b", usagePage: 1, usage: 0x80, interface: 2 },
    { path: "p2c", usagePage: 0xc, usage: 1, interface: 2 }, { path: "p3", usagePage: 1, interface: 3, serialNumber: "S" },
    { path: "p0", usagePage: 1, usage: 6, interface: 0 }, { path: "p1", usagePage: 1, usage: 6, interface: 1 },
  ]);
  assert.equal(device.path, "p3");
  assert.equal(transport.serial, "S");
});

test("report ID 0 is prefixed and the validated reply is returned", async () => {
  for (const mode of ["normal", "early", "65"]) {
    const { transport, device } = await open(mode);
    const reply = await transport.exchange(frame(), 200);
    assert.equal(device.writes[0].length, 65, mode);
    assert.equal(device.writes[0][0], 0, mode);
    assert.equal(reply[0], 0xaa, mode);
    assert.equal(reply.length, 64, mode);
    assert.equal(transport.stats.exchanges, 1, mode);
  }
});

test("replies resolve without timer polling", async () => {
  const { transport } = await open("normal");
  const t0 = performance.now();
  for (let i = 0; i < 50; i++) await transport.exchange(frame(), 200);
  // The old 2 ms setTimeout poll needed >= 100 ms here even on Linux; on Windows ~750 ms.
  assert.ok(performance.now() - t0 < 60, `50 exchanges took ${(performance.now() - t0).toFixed(1)} ms`);
});

test("a reply for another command is ignored, not returned", async () => {
  const { transport } = await open("stale");
  assert.equal((await transport.exchange(frame(), 200))[1], 0xd8);
});

test("corrupt reply, silence and unplug fail without a retry write", async () => {
  for (const [mode, code] of [["corrupt", "INVALID_CHECKSUM"], ["silent", "HID_TIMEOUT"], ["unplug", "DISCONNECTED"]]) {
    const { transport, device } = await open(mode);
    await assert.rejects(transport.exchange(frame(), 80), { code }, mode);
    assert.equal(device.writes.length, 1, `${mode}: exactly one write`);
  }
});
