// USB HID transport via node-hid (hidapi). Works on Windows, and also on macOS/Linux
// for development. The RGB endpoint is the vendor collection usage page 1 / usage 0
// (not the keyboard collection, which Windows locks exclusively).
import { VENDOR_ID, PRODUCT_ID, REPORT_SIZE, validate, failure } from "./s4.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The lighting endpoint: usage page 1 / usage 0, same rule as the Mac bridge.
 * node-hid only sets `usagePage`/`usage` when they are non-zero (src/devices.cc),
 * so usage 0 arrives as a missing field and must be read with `?? 0`.
 */
export const isLightingInterface = (d) => (d.usagePage ?? 0) === 1 && (d.usage ?? 0) === 0;

async function loadHID() {
  try {
    return (await import("node-hid")).default;
  } catch {
    throw failure("HID_UNAVAILABLE", "node-hid is not installed. Run `npm --prefix bridge-win install`.");
  }
}

export class HidTransport {
  constructor({ log = () => {} } = {}) {
    this.log = log;
    this.device = null;
    this.replies = [];
    this.removed = false;
    this.serial = "";
    this.onRemoved = null;
  }

  async open() {
    const HID = await loadHID();
    const all = await HID.devicesAsync(VENDOR_ID, PRODUCT_ID);
    // Exactly one lighting interface, as on the Mac bridge.
    const candidates = all.filter(isLightingInterface);
    if (process.env.AIR_STUDIO_HID_DEBUG) this.log(`HID interfaces: ${JSON.stringify(all.map(({ path, usagePage, usage, interface: i }) => ({ path, usagePage, usage, interface: i })))}`);
    if (candidates.length === 0) throw failure("DEVICE_NOT_FOUND", "Air75 V3 not found. Connect it by USB in wired mode.");
    if (candidates.length > 1) throw failure("MULTIPLE_DEVICES", "More than one Air75 V3 lighting interface found; connect only one keyboard.");
    const info = candidates[0];
    try {
      this.device = await HID.HIDAsync.open(info.path);
    } catch (e) {
      throw failure("HID_OPEN_FAILED", `Cannot open the keyboard lighting interface (${e.message}). Close NuPhyIO and other lighting apps.`);
    }
    this.serial = info.serialNumber ?? "";
    this.replies = [];
    this.removed = false;
    this.device.on("data", (buf) => {
      // hidapi returns 64 bytes for devices without report IDs; drop a leading 0 if a 65-byte read appears.
      const bytes = buf.length === REPORT_SIZE + 1 && buf[0] === 0 ? buf.subarray(1) : buf;
      if (bytes.length === REPORT_SIZE) {
        this.replies.push(Array.from(bytes));
        if (this.replies.length > 64) this.replies.splice(0, this.replies.length - 64);
      }
    });
    this.device.on("error", (e) => {
      this.log(`HID error: ${e?.message ?? e}`);
      this.removed = true;
      this.onRemoved?.();
    });
    return { serial: this.serial };
  }

  get connected() {
    return this.device !== null && !this.removed;
  }

  /** One request, one validated reply. Never resends an uncertain write. */
  async exchange(frame, timeoutMs = 650) {
    if (!this.device) throw failure("NOT_CONNECTED", "Connect the Air75 V3 by USB first.");
    this.replies.length = 0;
    try {
      // hidapi convention: first byte is the report ID (0 = none), then the 64-byte report.
      await this.device.write([0x00, ...frame]);
    } catch (e) {
      throw failure("HID_WRITE_FAILED", `HID output failed (${e.message}); reconnect the cable and close other lighting apps.`);
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.removed) throw failure("DISCONNECTED", "Keyboard unplugged during a transaction; backup retained.");
      while (this.replies.length) {
        const reply = this.replies.shift();
        if (reply[0] === 0xaa && reply[1] === frame[1]) {
          validate(reply, frame[1]);
          return reply;
        }
      }
      await sleep(2);
    }
    throw failure("HID_TIMEOUT", `No valid ${frame[1].toString(16).toUpperCase()} response. Stop other HID clients and reconnect; no blind write retry was performed.`);
  }

  async close() {
    const d = this.device;
    this.device = null;
    this.replies = [];
    try { await d?.close(); } catch {}
  }
}
