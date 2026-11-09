// Durable per-profile lighting backups: `<base>.profile-0.json` (Mac) and
// `<base>.profile-1.json` (Win), the same layout as the Swift LightingJournals.
// A backup is created exclusively and flushed BEFORE the first write to the keyboard.
import fs from "node:fs";
import path from "node:path";
import { failure } from "./s4.mjs";

const isBytes = (v, len) => Array.isArray(v) && (len === undefined || v.length === len) &&
  v.every((x) => Number.isInteger(x) && x >= 0 && x <= 255);

export class Journals {
  constructor(basePath) {
    this.base = basePath.replace(/\.json$/i, "");
  }
  url(profile) {
    return `${this.base}.profile-${profile}.json`;
  }
  exists(profile) {
    return fs.existsSync(this.url(profile));
  }
  get profiles() {
    return [0, 1].filter((p) => this.exists(p));
  }

  read(profile, serial) {
    let record;
    try {
      record = JSON.parse(fs.readFileSync(this.url(profile), "utf8"));
    } catch (e) {
      throw failure("INVALID_BACKUP", `Cannot read lighting backup ${this.url(profile)}: ${e.message}`);
    }
    const ok = record && isBytes(record.firmware, 8) && isBytes(record.state) &&
      (record.state.length === 17 || record.state.length === 22) && isBytes(record.renderedColors, 312) &&
      (record.lightingProfile ?? 0) === profile &&
      (record.customColors === undefined || isBytes(record.customColors, 252));
    if (!ok) throw failure("INVALID_BACKUP", "The lighting backup is malformed; it was left untouched.");
    if (serial && record.serial && record.serial !== serial) {
      throw failure("BACKUP_DEVICE_MISMATCH", "The lighting backup belongs to a different keyboard; it was left untouched.");
    }
    return record;
  }

  /** O_EXCL create + fsync: two bridges can never overwrite each other's original. */
  create(record) {
    const file = this.url(record.lightingProfile);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    let fd;
    try {
      fd = fs.openSync(file, "wx", 0o600);
    } catch {
      throw failure("BACKUP_CREATE_FAILED", "Cannot exclusively create backup; another lighting session may be active.");
    }
    try {
      fs.writeSync(fd, JSON.stringify(record, null, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return record;
  }

  /** Adds the pre-D8 custom palette without ever touching the original state/frame. */
  saveCustomColors(colors, record, serial) {
    if (!isBytes(colors, 252)) throw failure("INVALID_BACKUP", "Custom palette must contain 84 RGB entries.");
    const current = this.read(record.lightingProfile, serial);
    const next = { ...current, customColors: colors };
    const file = this.url(record.lightingProfile), tmp = `${file}.tmp-${process.pid}`;
    const fd = fs.openSync(tmp, "w", 0o600);
    try {
      fs.writeSync(fd, JSON.stringify(next, null, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
    return next;
  }

  remove(profile) {
    try {
      fs.unlinkSync(this.url(profile));
    } catch (e) {
      throw failure("BACKUP_CLEANUP_FAILED", `Lighting is verified restored, but the backup could not be removed: ${e.message}`);
    }
  }
}

/** Advisory single-instance lock (Windows has no flock): exclusive file with our PID, stale PIDs are reclaimed. */
export class InstanceLock {
  constructor(file) {
    this.file = file;
    this.held = false;
  }
  acquire() {
    if (this.held) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = fs.openSync(this.file, "wx");
        fs.writeSync(fd, String(process.pid));
        fs.closeSync(fd);
        this.held = true;
        return;
      } catch {
        const pid = Number(fs.readFileSync(this.file, "utf8"));
        let alive = false;
        try { if (pid > 0 && pid !== process.pid) { process.kill(pid, 0); alive = true; } } catch {}
        if (alive) throw failure("BRIDGE_BUSY", "Another NuPhyLab bridge is already using the keyboard.");
        try { fs.unlinkSync(this.file); } catch {}
      }
    }
    throw failure("BRIDGE_BUSY", "Cannot acquire the bridge lock.");
  }
  release() {
    if (!this.held) return;
    this.held = false;
    try { fs.unlinkSync(this.file); } catch {}
  }
}
