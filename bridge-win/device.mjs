// Air75 V3 lighting session, ported from Air75Device in native/HIDBridge.swift.
// Scope: connect / status / arm / paint / readRGB / side / restore / disconnect / shutdown.
// The transport is injected, so the same code runs against node-hid or a simulated board.
import fs from "node:fs";
import * as S4 from "./s4.mjs";
import { Journals } from "./journal.mjs";

const { failure } = S4;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const prefix6 = (fw) => Array.from(fw ?? []).slice(0, 6);

export class Air75Device {
  constructor({ backupPath, transport, log = () => {}, emit = () => {} }) {
    this.journals = new Journals(backupPath);
    this.transport = transport;
    this.log = log;
    this.emit = emit;
    this.key = 0;
    this.firmware = [];
    this.ledCount = 0;
    this.lightingProfile = 0;
    this.protocolReady = false;
    this.serial = "";
    this.backup = null;
    this.mutationAttempted = false;
    this.armed = false;
    this.firstPaintVerified = false;
    this.lastPaint = null;
    this.lastRGBWriteAt = null;
    transport.onRemoved = () => {
      const wasArmed = this.armed;
      this.armed = false;
      this.emit({ event: "disconnected", needsRestore: this.recoveryPending, message: wasArmed ? "Keyboard unplugged during playback; backup retained." : "Keyboard unplugged." });
    };
  }

  get connected() { return this.transport.connected; }
  get backupPath() { return this.journals.url(this.lightingProfile); }
  get recoveryPending() { return this.backup !== null || this.journals.exists(this.lightingProfile); }
  get deferredProfiles() { return this.journals.profiles.filter((p) => p !== this.lightingProfile); }
  get hasPendingBackups() { return this.journals.profiles.length > 0; }
  get ownsChanges() { return this.mutationAttempted; }

  requireConnected() {
    if (!this.connected) throw failure("NOT_CONNECTED", "Connect the Air75 V3 by USB first.");
  }

  async request(command, length, { address = 0, payload = [] } = {}) {
    this.requireConnected();
    const handle = [0xd5, 0xd6, 0xd8].includes(command) ? this.lightingProfile : 0;
    const raw = await this.transport.exchange(S4.frame({ command, length, address, payload, handle, key: this.key }));
    return S4.decode(raw, { command, length, address, handle, key: this.key });
  }

  async refreshLightingProfile() {
    const geometry = await this.request(0xa0, 8);
    if (!S4.validGeometry(geometry)) throw failure("UNSUPPORTED_PROTOCOL", "Keyboard protocol layout changed; update NuPhyLab. No settings were changed.");
    this.lightingProfile = geometry[0];
  }

  async verifyLightingProfileForWrite() {
    await this.refreshLightingProfile();
    if (this.backup && !eq(prefix6(this.backup.firmware), prefix6(this.firmware))) {
      this.armed = false;
      throw failure("BACKUP_FIRMWARE_MISMATCH", "Firmware differs from the recovery record; backup kept and writes stopped. Reconnect the keyboard.");
    }
    if (this.backup && (this.backup.lightingProfile ?? 0) !== this.lightingProfile) {
      this.armed = false;
      throw failure("LIGHTING_PROFILE_CHANGED", "Keyboard Mac/Win mode changed; play the effect again.");
    }
  }

  dropOwnership() {
    this.backup = null; this.mutationAttempted = false; this.armed = false;
    this.firstPaintVerified = false; this.lastPaint = null; this.lastRGBWriteAt = null;
  }

  async selectRecoveryProfile({ reconnected = false } = {}) {
    if (this.backup && (this.backup.lightingProfile ?? 0) !== this.lightingProfile) this.dropOwnership();
    if (!this.backup && this.journals.exists(this.lightingProfile)) this.backup = this.journals.read(this.lightingProfile, this.serial);
    if (this.backup && !eq(prefix6(this.backup.firmware), prefix6(this.firmware))) {
      if (!this.protocolReady || (this.mutationAttempted && !reconnected)) {
        throw failure("BACKUP_FIRMWARE_MISMATCH", "Firmware differs from the recovery record; backup kept and writes stopped. Reconnect the keyboard.");
      }
      // A firmware update can change the schema: archive the old journal byte-for-byte
      // instead of writing old settings into new firmware.
      const from = this.journals.url(this.lightingProfile);
      const archived = `${this.journals.base}.firmware-recovery-history-${Date.now()}-${process.pid}.json`;
      fs.renameSync(from, archived);
      this.log(`Prior firmware recovery record preserved at ${archived}`);
      this.dropOwnership();
    }
  }

  async identify() {
    const raw = await this.transport.exchange(S4.frame({ command: 0xa1, length: 8, key: 0 }));
    const { key, info } = S4.identify(raw);
    if (!eq(prefix6(this.firmware), prefix6(info))) this.protocolReady = false;
    this.key = key;
    this.firmware = info;
    this.ledCount = S4.decodeLEDCount(await this.transport.exchange(S4.frame({ command: 0xd1, length: S4.LED_COUNT_LENGTH, key })), key);
  }

  get capabilities() {
    return {
      perKey: this.protocolReady && S4.supportsPerKey(this.firmware), sideWholeZone: this.protocolReady,
      sidePixels: false, protocol: "air75-s4", stateBytes: S4.stateLength(this.firmware) ?? 0,
      readProbeVerified: this.protocolReady,
    };
  }

  async connect() {
    if (!this.connected) {
      const { serial } = await this.transport.open();
      this.serial = serial ?? "";
    }
    try { await this.identify(); } catch (e) { await this.transport.close(); throw e; }
    const state = await this.readState();
    await this.readRGB(); // validate the complete D2 route before allowing writes
    this.protocolReady = true;
    await this.selectRecoveryProfile({ reconnected: true });
    return {
      connected: true, firmware: this.firmware, firmwareHex: this.firmware.map((b) => b.toString(16).padStart(2, "0")).join(" "),
      firmwareVersion: S4.firmwareVersion(this.firmware), ledCount: this.ledCount,
      model: "Air75 V3 ANSI", vendorId: S4.VENDOR_ID, productId: S4.PRODUCT_ID, transport: "USB",
      keyLedCount: 84, sideLedCount: 20, sideIndependent: false, originalState: state, state,
      lightingProfile: this.lightingProfile, armed: this.armed, needsRestore: this.recoveryPending,
      recoveryPending: this.recoveryPending, deferredProfiles: this.deferredProfiles, backupPath: this.backupPath,
      capabilities: this.capabilities,
    };
  }

  async status(permissions) {
    let state;
    if (this.connected) { state = await this.readState(); await this.selectRecoveryProfile(); }
    const result = {
      connected: this.connected, armed: this.armed, needsRestore: this.recoveryPending, recoveryPending: this.recoveryPending,
      deferredProfiles: this.deferredProfiles, backupPath: this.backupPath, firmware: this.firmware, ledCount: this.ledCount,
      error: null, permissions,
    };
    if (this.connected) Object.assign(result, { state, lightingProfile: this.lightingProfile, firmwareVersion: S4.firmwareVersion(this.firmware), capabilities: this.capabilities });
    return result;
  }

  async readState() {
    await this.refreshLightingProfile();
    const length = S4.stateLength(this.firmware);
    if (!length) throw failure("UNSUPPORTED_PROTOCOL", "Keyboard protocol layout changed; update NuPhyLab. No settings were changed.");
    const state = await this.request(0xd5, length);
    if (!S4.readableState(state, this.firmware)) {
      this.protocolReady = false;
      throw failure("UNSUPPORTED_PROTOCOL", "Keyboard protocol layout changed; update NuPhyLab. No settings were changed.");
    }
    return state;
  }

  async readRGB() {
    this.requireConnected();
    // D8 ACK precedes the rendered D2 buffer update: wait 45 ms after the last frame (diagnostic reads only).
    if (this.lastRGBWriteAt !== null) {
      const remaining = this.lastRGBWriteAt + 45 - Date.now();
      if (remaining > 0) await sleep(remaining);
    }
    const bytes = [];
    while (bytes.length < 312) {
      bytes.push(...(await this.request(0xd2, Math.min(54, 312 - bytes.length), { address: bytes.length })));
      if (bytes.length < 312) await sleep(8);
    }
    return bytes;
  }

  async ensureBackup() {
    this.requireConnected();
    if (this.mutationAttempted && this.backup) return;
    if (this.recoveryPending) throw failure("RECOVERY_REQUIRED", "A previous lighting backup exists. Call restore before starting another lighting session.");
    if (!this.protocolReady || !S4.supportsPerKey(this.firmware)) throw failure("UNVERIFIED_FIRMWARE", "This firmware did not pass the per-key lighting capability check.");
    const state = await this.readState();
    const capturedProfile = this.lightingProfile;
    if (state[9] > 4) throw failure("UNSUPPORTED_SIDE_MODE", "The current side mode is outside the five stock modes; no configuration was changed.");
    if (state.length === 17 && state[0] === 21 && state[1] !== 100) {
      throw failure("CUSTOM_BACKUP_LOSSY", "Another custom renderer is active below 100% brightness; select a stock effect first.");
    }
    const colors = await this.readRGB();
    await this.refreshLightingProfile();
    if (capturedProfile !== this.lightingProfile) throw failure("LIGHTING_PROFILE_CHANGED", "Keyboard Mac/Win mode changed; play the effect again.");
    this.backup = this.journals.create({
      createdAt: new Date().toISOString(), serial: this.serial, firmware: this.firmware, state,
      renderedColors: colors, lightingProfile: this.lightingProfile,
    });
  }

  async writeStateVerified(state) {
    await this.verifyLightingProfileForWrite();
    const current = await this.readState();
    const payload = S4.stateWritePayload(state, current, this.firmware);
    if (eq(prefix6(this.firmware), [23, 0, 1, 170, 6, 0])) payload.splice(6, 3, ...S4.exactMainColorInput(state.slice(6, 9)));
    // No separate brightness-only commit: on this keyboard it rescales stored RGB.
    const echo = await this.request(0xd6, payload.length, { payload });
    if (!eq(echo, payload)) throw failure("STATE_ACK_MISMATCH", "D6 did not echo the complete lighting payload.");
    await sleep(120);
    let lastRead = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      lastRead = await this.readState();
      if (S4.statesMatch(state, lastRead, this.firmware)) return;
      if (attempt < 4) await sleep(120);
    }
    this.log(`D6 verify expected=${state} actual=${lastRead}`);
    throw failure(S4.stateMismatchCode(state, lastRead), `D5 mismatch: expected ${state}, observed ${lastRead}.`);
  }

  async arm() {
    if (this.armed) return { armed: true, backupPath: this.backupPath, alreadyArmed: true };
    await this.ensureBackup();
    const next = await this.readState();
    next[0] = 21; next[1] = 100; next[4] = 1;          // custom effect, full hardware brightness, RGB mode
    if (next.length === 22) next.splice(6, 3, 255, 255, 255); // new firmware renders palette through main colour value
    this.mutationAttempted = true;
    try {
      await this.writeStateVerified(next);
      if (next.length === 22 && this.backup && !this.backup.customColors) {
        // Persist the board's loaded custom palette before the first D8 can change it.
        const custom = S4.paletteFromRendered((await this.readRGB()).slice(0, 252), this.firmware);
        this.backup = this.journals.saveCustomColors(custom, this.backup, this.serial);
      }
      this.armed = true; this.firstPaintVerified = false; this.lastPaint = null;
      return { armed: true, state: next, backupPath: this.backupPath, verified: true };
    } catch (e) { throw await this.rollbackError(e); }
  }

  async writeRGB(colors, previous = null) {
    await this.verifyLightingProfileForWrite();
    if (colors.length !== 252) throw failure("INVALID_COLORS", "Expected RGB data for 84 keys.");
    const changed = [];
    for (let i = 0; i < 84; i++) {
      if (!previous || previous.length !== 252 || !eq(colors.slice(i * 3, i * 3 + 3), previous.slice(i * 3, i * 3 + 3))) changed.push(i);
    }
    // D8 = independent [index, R, G, B] records, at most 13 per packet (proven size).
    for (let start = 0; start < changed.length; start += 13) {
      const records = changed.slice(start, start + 13).flatMap((i) => [i, ...colors.slice(i * 3, i * 3 + 3)]);
      const echo = await this.request(0xd8, records.length, { payload: records });
      if (!eq(echo, records)) throw failure("COLOR_ACK_MISMATCH", "D8 did not echo the complete indexed RGB records.");
    }
    this.lastRGBWriteAt = Date.now();
  }

  async paint(colors, verify) {
    if (!this.armed) throw failure("NOT_ARMED", "Call arm before painting the 84 key LEDs.");
    if (this.lastPaint && eq(colors, this.lastPaint) && !verify) return { painted: 84, skipped: true, verification: "unchanged" };
    try {
      const full = verify || !this.firstPaintVerified;
      await this.writeRGB(colors, full ? null : this.lastPaint);
      if (full) {
        const rendered = (await this.readRGB()).slice(0, 252);
        const expected = S4.renderedCustomColors(colors, this.firmware);
        if (!eq(rendered, expected)) {
          const bad = expected.map((v, i) => i).filter((i) => rendered[i] !== expected[i]);
          this.log(`D2 verify firmware=${S4.firmwareVersion(this.firmware)} mismatchedChannels=${bad.length} samples=${bad.slice(0, 12).map((i) => `${i}:${expected[i]}->${rendered[i]}`).join(",")}`);
          throw failure("COLOR_VERIFY_FAILED", "D2 did not show the requested key colors; original lighting will be restored.");
        }
        this.firstPaintVerified = true;
      }
      this.lastPaint = colors;
      return { painted: 84, skipped: false, verification: full ? "readback" : "validatedAck" };
    } catch (e) { throw await this.rollbackError(e); }
  }

  async setSide(color, brightness) {
    if (color.length !== 3 || !Number.isInteger(brightness) || brightness < 0 || brightness > 100) {
      throw failure("INVALID_SIDE", "side brightness must be an integer from 0 to 100.");
    }
    const state = await this.readState();
    state[9] = 2; state[10] = brightness; state[12] = 0; state[13] = 0;
    state.splice(14, 3, ...color);
    if (S4.statesMatch(state, await this.readState(), this.firmware)) return { sideIndependent: false, changed: false, state };
    await this.ensureBackup();
    this.mutationAttempted = true;
    try {
      await this.writeStateVerified(state);
      return { sideIndependent: false, changed: true, state, verified: true };
    } catch (e) { throw await this.rollbackError(e); }
  }

  async restoreSide() {
    this.requireConnected();
    if (!this.backup) return { changed: false, reason: "noBackup", sideIndependent: false };
    const state = await this.readState();
    state.splice(9, 8, ...this.backup.state.slice(9, 17));
    if (S4.statesMatch(state, await this.readState(), this.firmware)) return { changed: false, state, sideIndependent: false };
    this.mutationAttempted = true;
    try {
      await this.writeStateVerified(state);
      return { changed: true, restored: true, verified: true, state, sideIndependent: false };
    } catch (e) { throw await this.rollbackError(e); }
  }

  async rollbackError(original) {
    if (original?.code === "LIGHTING_PROFILE_CHANGED") return original;
    try {
      await this.restore();
      return failure(original?.code ?? "LIGHTING_FAILED", `${original?.message ?? original}. Original lighting was restored and verified.`);
    } catch (e) {
      return failure("RESTORE_REQUIRED", `Lighting operation failed: ${original?.message ?? original}. Restoration also failed: ${e.message}. Backup retained at ${this.backupPath}.`);
    }
  }

  async restore() {
    if (!this.connected && this.hasPendingBackups) await this.connect();
    else if (this.connected) { await this.identify(); await this.readState(); await this.selectRecoveryProfile(); }
    if (!this.recoveryPending) {
      return { restored: false, reason: "noBackupForCurrentProfile", verified: true, needsRestore: false, recoveryPending: false, deferredProfiles: this.deferredProfiles };
    }
    const saved = this.backup ?? (this.backup = this.journals.read(this.lightingProfile, this.serial));
    await this.verifyLightingProfileForWrite();
    if (!eq(prefix6(saved.firmware), prefix6(this.firmware))) {
      throw failure("BACKUP_FIRMWARE_MISMATCH", "Firmware changed since the backup. Refusing to restore an unverified configuration.");
    }
    this.mutationAttempted = true;
    if (saved.state.length === 17 && saved.state[0] === 21 && saved.state[1] !== 100) {
      throw failure("CUSTOM_BACKUP_LOSSY", "Cannot exactly restore a dimmed custom framebuffer.");
    }
    const custom = saved.customColors ?? (saved.state[0] === 21 ? saved.renderedColors.slice(0, 252) : null);
    if (custom) {
      const current = await this.readState();
      const fullPalette = [...current];
      fullPalette[0] = 21; fullPalette[1] = 100; fullPalette[4] = 1;
      if (current.length === 22) fullPalette.splice(6, 3, 255, 255, 255);
      if (!eq(current, fullPalette)) await this.writeStateVerified(fullPalette);
      await this.writeRGB(custom);
      if (saved.customColors) await sleep(1150); // new firmware debounces palette persistence ~1 s
      if (!eq((await this.readRGB()).slice(0, 252), S4.renderedCustomColors(custom, this.firmware))) {
        throw failure("RESTORE_COLOR_MISMATCH", "The original custom palette did not verify. Backup retained.");
      }
    }
    let target = S4.restoreTarget(saved.state);
    const restoresOff = !eq(target, saved.state);
    if (restoresOff && S4.statesMatch(saved.state, await this.readState(), this.firmware)) {
      target = saved.state; // already unchanged: no write needed
    } else {
      await this.writeStateVerified(target);
    }
    if (restoresOff && !(await this.readRGB()).every((v) => v === 0)) {
      throw failure("RESTORE_COLOR_MISMATCH", "The prior off state did not render completely dark. Backup retained.");
    }
    if (saved.state[0] === 21) {
      await sleep(40);
      let actual = await this.readRGB();
      const original = saved.renderedColors.slice(0, 252);
      if (saved.customColors && saved.state.length === 22 && !eq(actual.slice(0, 252), original)) {
        // D2 is quantized: try the other end of each identical-output interval where needed.
        const upper = S4.paletteFromRendered(S4.renderedCustomColors(saved.customColors, this.firmware), this.firmware, true);
        const adjusted = saved.customColors.map((v, i) => (actual[i] !== original[i] ? upper[i] : v));
        await this.writeRGB(adjusted);
        await sleep(1150);
        actual = await this.readRGB();
      }
      if (!eq(actual.slice(0, 252), original)) {
        throw failure("RESTORE_COLOR_MISMATCH", "State restored, but the prior custom key colors did not verify. Backup retained.");
      }
    }
    const observed = await this.readState();
    if (!S4.statesMatch(target, observed, this.firmware)) throw failure("RESTORE_STATE_MISMATCH", "Lighting state changed during restoration. Backup retained.");
    this.journals.remove(this.lightingProfile);
    this.dropOwnership();
    return {
      restored: true, verified: true, state: observed, needsRestore: false, recoveryPending: false, deferredProfiles: this.deferredProfiles,
      verification: restoresOff ? "allLightsOff" : saved.state[0] === 21 ? "stateAndCustomColors" : "completeState",
    };
  }

  async disconnect() {
    let restoration = { restored: false };
    if (this.recoveryPending && this.connected) {
      try { restoration = await this.restore(); }
      catch (e) { restoration = { restored: false, verified: false, error: e.message }; this.log(`Disconnect recovery deferred: ${e.message}`); }
    }
    await this.transport.close();
    this.armed = false;
    return { connected: false, armed: false, restoration, recoveryPending: this.recoveryPending, needsRestore: this.recoveryPending };
  }

  /** Attempts restoration before exit. Returns true only if nothing owned is left unverified. */
  async shutdown() {
    let ok = true, lightingRestored = false, lightingDeferred = false;
    if (this.mutationAttempted) {
      try {
        if (!this.connected) {
          // USB already gone: a validated durable journal is a safe deferred exit, not a restore.
          const profile = this.backup?.lightingProfile ?? this.lightingProfile;
          this.journals.read(profile, this.serial);
          lightingDeferred = true;
          this.emit({ event: "restoreDeferred", reason: "disconnected", backupPath: this.journals.url(profile) });
        } else {
          const result = await this.restore();
          lightingRestored = true;
          this.emit({ event: "restoredOnExit", result });
        }
      } catch (e) {
        ok = false;
        this.emit({ event: "restoreFailed", error: e.message, backupPath: this.backupPath });
      }
    } else lightingRestored = true;
    await this.transport.close();
    this.emit({ event: "shutdownComplete", lightingRestored, lightingDeferred, keysRestored: true });
    return ok;
  }
}
