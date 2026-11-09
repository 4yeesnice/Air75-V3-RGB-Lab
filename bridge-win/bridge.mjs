#!/usr/bin/env node
// Windows replacement for bin/HIDBridge: same JSONL stdin/stdout contract (native/PROTOCOL.md).
//   node bridge-win/bridge.mjs --backup <path>\original-lighting.json
// stdout carries JSONL only; diagnostics go to stderr.
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { Air75Device } from "./device.mjs";
import { HidTransport } from "./transport.mjs";
import { InstanceLock } from "./journal.mjs";
import { failure, parseColor, parseColors, hexColors, stateLength } from "./s4.mjs";

const log = (msg) => process.stderr.write(`${msg}\n`);
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

export function defaultDataDir() {
  return process.platform === "win32"
    ? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "NuPhyLab")
    : path.join(os.homedir(), ".nuphylab");
}

// macOS needs TCC permissions; Windows has no equivalent prompts for HID or RegisterHotKey.
const PERMISSIONS = { inputMonitoring: true, accessibility: true, canPostEvents: true, promptsRequested: false };

// Operations the Mac bridge implements with macOS-only APIs. The server already
// handles failures for these (e.g. triggerMonitor falls back to window-only listening).
const UNSUPPORTED = {
  triggerMonitor: ["INPUT_MONITORING_REQUIRED", "Global key observation is not implemented on Windows yet; using the focused window."],
  keyMonitor: ["UNSUPPORTED_ON_WINDOWS", "Codex Control+Option shortcuts are not implemented on Windows yet."],
  shortcut: ["UNSUPPORTED_ON_WINDOWS", "Posting shortcuts to Codex is not implemented on Windows yet."],
  adaptKeys: ["UNSUPPORTED_ON_WINDOWS", "Per-device key remapping has no Windows equivalent."],
  keyMappingStatus: ["UNSUPPORTED_ON_WINDOWS", "Per-device key remapping has no Windows equivalent."],
  readKeymap: ["UNSUPPORTED_ON_WINDOWS", "Function-key adaptation is not available on Windows."],
  prepareFunctionKey: ["UNSUPPORTED_ON_WINDOWS", "Function-key adaptation is not available on Windows."],
  openPermissionSettings: ["UNSUPPORTED_ON_WINDOWS", "Windows does not require these permissions."],
};

export function createBridge({ backupPath, transport, emitEvent = emit, logger = log, lock = null }) {
  const device = new Air75Device({ backupPath, transport, log: logger, emit: emitEvent });

  async function handle(cmd) {
    switch (cmd.op) {
      case "connect": lock?.acquire(); return device.connect();
      case "status": return device.status(PERMISSIONS);
      case "permissions": return PERMISSIONS;
      case "bluetoothDevices": return { devices: [], supported: false };
      case "arm": return device.arm();
      case "paint": return device.paint(parseColors(cmd.colors, 84), cmd.verify === true);
      case "readColors": return { colors: hexColors(await device.readRGB()), ledCount: 104, customColorScale: stateLength(device.firmware) === 22 ? 200 : 255 };
      case "side":
        if (cmd.restore === true) return device.restoreSide();
        if (typeof cmd.color !== "string") throw failure("INVALID_SIDE", "side requires a color string.");
        return device.setSide(parseColor(cmd.color), cmd.brightness ?? 60);
      case "restore": return device.restore();
      case "restoreKeys": return { restored: true };            // nothing is remapped on Windows
      case "restoreFunctionKey": return { restored: true };
      case "systemIdle": return { idleMs: null, recordsKeys: false }; // TODO: GetLastInputInfo
      case "disconnect": { const r = await device.disconnect(); lock?.release(); return r; }
      case "quit": return { quitting: true };
      default:
        if (UNSUPPORTED[cmd.op]) throw failure(...UNSUPPORTED[cmd.op]);
        throw failure("UNKNOWN_OPERATION", `Unknown operation: ${cmd.op}`);
    }
  }

  // Requests run strictly one at a time; pending queue limited to 8 like the Swift bridge.
  const queue = [];
  let processing = false, stopping = false, shutdownPromise = null;

  async function drain() {
    if (processing) return;
    processing = true;
    while (queue.length) {
      const cmd = queue.shift();
      try {
        const result = await handle(cmd);
        emitEvent({ id: cmd.id, ok: true, result });
        if (cmd.op === "quit") stopping = true;
      } catch (e) {
        emitEvent({ id: cmd.id, ok: false, error: { code: e.code ?? "INTERNAL_ERROR", message: e.message } });
      }
      if (stopping) break;
    }
    processing = false;
    if (stopping) api.onShutdown?.(await shutdown());
  }

  function submit(line) {
    if (stopping || !line.trim()) return;
    let cmd;
    if (line.length > 32 * 1024) { emitEvent({ id: null, ok: false, error: { code: "REQUEST_TOO_LARGE", message: "Requests are limited to 32 KiB." } }); return; }
    try { cmd = JSON.parse(line); } catch { emitEvent({ id: null, ok: false, error: { code: "INVALID_JSON", message: "Each line must be one JSON object." } }); return; }
    if (queue.length >= 8) { emitEvent({ id: cmd.id ?? null, ok: false, error: { code: "QUEUE_FULL", message: "Too many pending commands." } }); return; }
    queue.push(cmd);
    drain();
  }

  function shutdown() {
    stopping = true;
    shutdownPromise ??= (async () => {
      while (processing) await new Promise((r) => setTimeout(r, 10));
      const ok = await device.shutdown();
      lock?.release();
      return ok;
    })();
    return shutdownPromise;
  }

  const api = { device, handle, submit, shutdown, onShutdown: null, get idle() { return !processing && queue.length === 0; } };
  return api;
}

async function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf("--backup");
  const backupPath = i >= 0 && args[i + 1] ? path.resolve(args[i + 1]) : path.join(defaultDataDir(), "original-lighting.json");
  const lock = new InstanceLock(path.join(path.dirname(backupPath), "hid-bridge.lock"));
  const bridge = createBridge({ backupPath, transport: new HidTransport({ log }), lock });

  const finish = async () => {
    const ok = await bridge.shutdown();
    process.exit(ok ? 0 : 2);
  };
  bridge.onShutdown = (ok) => process.exit(ok ? 0 : 2); // after a JSON "quit"
  createInterface({ input: process.stdin }).on("line", bridge.submit).on("close", finish);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) {
    try { process.on(sig, finish); } catch {}
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((e) => { log(e.stack ?? String(e)); process.exit(1); });
}
