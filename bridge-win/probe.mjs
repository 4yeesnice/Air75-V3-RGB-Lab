#!/usr/bin/env node
// First-run hardware check for the Windows bridge.
//   node bridge-win/probe.mjs            read-only: interfaces, firmware, profile, state, colours
//   node bridge-win/probe.mjs --paint    5 s rainbow on the 84 keys, then verified restore
// Close NuPhyIO and the NuPhyLab app first: only one program may own the lighting interface.
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { HidTransport } from "./transport.mjs";
import { Air75Device } from "./device.mjs";
import { VENDOR_ID, PRODUCT_ID, firmwareVersion } from "./s4.mjs";

const paint = process.argv.includes("--paint");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nuphylab-probe-"));
const log = (m) => console.log(m);

try {
  const HID = (await import("node-hid")).default;
  const all = await HID.devicesAsync(VENDOR_ID, PRODUCT_ID);
  log(`Air75 V3 HID interfaces (${all.length}):`);
  for (const d of all) log(`  usagePage=0x${(d.usagePage ?? 0).toString(16)} usage=0x${(d.usage ?? 0).toString(16)} interface=${d.interface} ${d.usagePage === 1 && d.usage === 0 ? "<- lighting" : ""}`);
} catch (e) {
  log(`node-hid unavailable: ${e.message}\nRun: npm --prefix bridge-win install`);
  process.exit(1);
}

const transport = new HidTransport({ log });
const device = new Air75Device({ backupPath: path.join(dir, "probe-lighting.json"), transport, log });
let exitCode = 0;
try {
  const c = await device.connect();
  log(`\nFirmware ${firmwareVersion(c.firmware)} (${c.firmwareHex}), LEDs ${c.ledCount}, profile ${c.lightingProfile === 1 ? "Win" : "Mac"}`);
  log(`State (${c.state.length} bytes): ${c.state.join(",")}`);
  log(`Capabilities: ${JSON.stringify(c.capabilities)}`);
  const rgb = await device.readRGB();
  log(`First 4 rendered keys: ${[0, 1, 2, 3].map((i) => rgb.slice(i * 3, i * 3 + 3).join("/")).join("  ")}`);
  if (!paint) log("\nRead-only probe OK. Nothing was written. Re-run with --paint to test lighting output.");
  else {
    log("\nArming (backup is written first)…");
    await device.arm();
    const t0 = Date.now();
    let frames = 0;
    while (Date.now() - t0 < 5000) {
      const shift = (Date.now() - t0) / 20;
      const colors = Array.from({ length: 84 }, (_, i) => {
        const h = ((i * 6 + shift) % 360) / 60, x = Math.round(255 * (1 - Math.abs((h % 2) - 1)));
        return [[255, x, 0], [x, 255, 0], [0, 255, x], [0, x, 255], [x, 0, 255], [255, 0, x]][Math.floor(h) % 6];
      }).flat();
      await device.paint(colors, false);
      frames++;
    }
    log(`Painted ${frames} frames in 5 s (~${(frames / 5).toFixed(1)} fps). Restoring…`);
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
