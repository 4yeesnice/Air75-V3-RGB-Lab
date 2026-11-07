# Windows HID bridge (experimental)

Drop-in replacement for the macOS `bin/HIDBridge` (Swift), written in Node.js on
top of [node-hid](https://github.com/node-hid/node-hid). It speaks the same JSONL
contract as `native/PROTOCOL.md`, so `server/` and `ui/` run unchanged.

## Status

| Operation | Windows bridge |
| --- | --- |
| `connect`, `status`, `arm`, `paint`, `readColors`, `side`, `restore`, `disconnect`, `quit` | Ported 1:1 from Swift (17- and 22-byte firmware schemas, Mac/Win profiles, journals) |
| `permissions` | Always granted (Windows has no TCC prompts) |
| `triggerMonitor` | Returns `INPUT_MONITORING_REQUIRED` → server falls back to window-only triggers |
| `keyMonitor`, `shortcut` (Codex) | Not yet — `UNSUPPORTED_ON_WINDOWS` (`RegisterHotKey` / `SendInput` TODO) |
| `adaptKeys`, `readKeymap`, F4 lease | Not available (no per-device remapping on Windows) |
| `systemIdle` | Returns `idleMs: null` (TODO: `GetLastInputInfo`) |
| Bluetooth | Not supported |

Not yet ported from Swift: legacy single-journal migration. Old-firmware journals
are archived (renamed) on reconnect instead of being written to new firmware.

## First run on real hardware

Close NuPhyIO and any other lighting app. Connect the Air75 V3 by **USB, wired mode**.

```powershell
npm --prefix bridge-win install
node bridge-win/probe.mjs          # read-only: firmware, profile, state, colours
node bridge-win/probe.mjs --paint  # 5 s rainbow, then verified restore
```

If the probe works, run the whole app:

```powershell
npm run setup ; npm run build:ui
node server/main.mjs               # picks bridge-win/bridge.mjs on win32
```

## Tests (no keyboard needed)

```
node --test tests/bridge-win-*.test.mjs
```

`bridge-win-s4` replays the Swift `--self-test` vectors (including a captured
D1 reply and the 1.0.23.6 HSV colour drift). `bridge-win-lifecycle` runs full
sessions against a simulated keyboard (`tests/helpers/fake-air75.mjs`).
The simulator is not the real board: the first `probe.mjs --paint` on hardware
is the actual acceptance test.

## Safety

Before the first write the bridge saves the complete original state and the 104
rendered colours to `%LOCALAPPDATA%\NuPhyLab\original-lighting.profile-N.json`
(created exclusively, fsynced). Any failed write triggers verified restoration;
if that fails too, the journal is kept and the next `connect` + `restore` retries.
Do not delete these files until lighting is confirmed restored.
