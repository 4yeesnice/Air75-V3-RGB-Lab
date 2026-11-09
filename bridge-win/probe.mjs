#!/usr/bin/env node
// First-run hardware check for the Windows bridge.
//   node bridge-win/probe.mjs            read-only: interfaces, firmware, profile, state, colours
//   node bridge-win/probe.mjs --paint    5 s rainbow on the 84 keys, then verified restore
// Close NuPhyIO and the NuPhyLab app first: only one program may own the lighting interface.
import path from "node:path";
import { HidTransport, isLightingInterface } from "./transport.mjs";
import { Air75Device } from "./device.mjs";
import { VENDOR_ID, PRODUCT_ID, firmwareVersion } from "./s4.mjs";
import { defaultDataDir } from "./bridge.mjs";

const paint = process.argv.includes("--paint");
// Same journal the app uses (%LOCALAPPDATA%\NuPhyLab), so an interrupted probe can be
// recovered by running the probe again or by the app's normal connect + restore.
const backupPath = path.join(defaultDataDir(), "original-lighting.json");
const log = (m) => console.log(m);

try {
  const HID = (await import("node-hid")).default;
  const all = await HID.devicesAsync(VENDOR_ID, PRODUCT_ID);
  log(`Air75 V3 HID interfaces (${all.length}):`);
  for (const d of all) log(`  usagePage=0x${(d.usagePage ?? 0).toString(16)} usage=0x${(d.usage ?? 0).toString(16)} interface=${d.interface} ${isLightingInterface(d) ? "<- lighting" : ""}`);
} catch (e) {
  log(`node-hid unavailable: ${e.message}\nRun: npm --prefix bridge-win install`);
  process.exit(1);
}

const transport = new HidTransport({ log });
const device = new Air75Device({ backupPath, transport, log });
let exitCode = 0;
try {
  const c = await device.connect();
  if (c.recoveryPending) {
    log(`\nA lighting backup from an interrupted session exists (${device.backupPath}). Restoring it first…`);
    const r = await device.restore();
    log(`Restore: ${r.verification}, verified=${r.verified}`);
  }
  log(`\nFirmware ${firmwareVersion(c.firmware)} (${c.firmwareHex}), LEDs ${c.ledCount}, profile ${c.lightingProfile === 1 ? "Win" : "Mac"}`);
  log(`State (${c.state.length} bytes): ${c.state.join(",")}`);
  log(`Capabilities: ${JSON.stringify(c.capabilities)}`);
  const rgb = await device.readRGB();
  log(`First 4 rendered keys: ${[0, 1, 2, 3].map((i) => rgb.slice(i * 3, i * 3 + 3).join("/")).join("  ")}`);
  if (!paint) log("\nRead-only probe OK. Nothing was written. Re-run with --paint to test lighting output.");
  else {
    log("\nArming (backup is written first)…");
    await device.arm();
    const hue = (h) => { h = (h % 360) / 60; const x = Math.round(255 * (1 - Math.abs((h % 2) - 1))); return [[255, x, 0], [x, 255, 0], [0, 255, x], [0, x, 255], [x, 0, 255], [255, 0, x]][Math.floor(h) % 6]; };
    const run = async (label, seconds, frameAt) => {
      const s = transport.stats; s.exchanges = 0; s.writeMs = 0; s.replyMs = 0;
      const t0 = performance.now();
      let frames = 0;
      while (performance.now() - t0 < seconds * 1000) {
        await device.paint(frameAt(performance.now() - t0), false);
        frames++;
      }
      const ms = performance.now() - t0, n = Math.max(1, s.exchanges);
      log(`${label}: ${frames} frames in ${seconds} s = ${(frames / (ms / 1000)).toFixed(1)} fps | ${s.exchanges} packets, write ${(s.writeMs / n).toFixed(1)} ms + reply ${(s.replyMs / n).toFixed(1)} ms per packet`);
    };
    // Worst case: all 84 keys change every frame (7 D8 packets).
    await run("Full rainbow ", 5, (t) => Array.from({ length: 84 }, (_, i) => hue(i * 6 + t / 20)).flat());
    // Typical effect: a dim base with one bright key moving (≈2 keys change per frame, 1 packet).
    await run("Moving dot   ", 3, (t) => { const at = Math.floor(t / 40) % 84; return Array.from({ length: 84 }, (_, i) => (i === at ? [255, 255, 255] : [0, 0, 40])).flat(); });
    log("Restoring…");
    const r = await device.restore();
    log(`Restore: ${r.verification}, verified=${r.verified}`);
  }
} catch (e) {
  exitCode = 1;
  log(`\nFAILED ${e.code ?? ""}: ${e.message}`);
  if (device.recoveryPending) log(`Backup kept at ${device.backupPath}. Run the probe again to retry restore.`);
} finally {
  await device.shutdown();
  process.exit(exitCode);
}
