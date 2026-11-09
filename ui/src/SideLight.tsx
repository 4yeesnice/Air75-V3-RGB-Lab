import { useEffect, useRef, useState } from "react";
import { t as tr } from "./i18n";
import { ColorWheel } from "./ColorWheel";
import { run, Switch } from "./primitives";
import type { HSV } from "../../shared/color.mjs";
import type { AppState, Command, SideLight as SideLightSettings } from "./types";

const DEFAULTS: SideLightSettings = { enabled: false, color: "#ffffff", brightness: 60 };

/** Whole side strip colour. The stock firmware has one colour and brightness for all 20 LEDs. */
export function SideLight({ state, command }: { state: AppState | null; command: Command }) {
  const saved = state?.settings.sideLight;
  const [value, setValue] = useState<SideLightSettings>(saved ?? DEFAULTS);
  const memory = useRef<HSV | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const patch = useRef<Partial<SideLightSettings>>({});
  const saving = useRef(false);
  useEffect(() => {
    if (saved && !saving.current && !Object.keys(patch.current).length) setValue(saved);
  }, [saved]);
  const flush = async () => {
    if (timer.current) clearTimeout(timer.current);
    const next = patch.current;
    patch.current = {};
    if (!Object.keys(next).length) return;
    saving.current = true;
    try { await command({ op: "settings", settings: { sideLight: next } }); }
    finally { saving.current = false; }
  };
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    const next = patch.current;
    patch.current = {};
    if (Object.keys(next).length) void command({ op: "settings", settings: { sideLight: next } }).catch(() => {});
  }, [command]);
  // Each side write is a verified USB transaction (~0.3 s), so drags are debounced.
  const change = (next: Partial<SideLightSettings>, delay = 250) => {
    setValue((current) => ({ ...current, ...next }));
    patch.current = { ...patch.current, ...next };
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => run(flush()), delay);
  };
  const connected = Boolean(state?.device.connected);
  const active = state?.device.sideLightActive === true;
  const mode = state?.playback.mode;
  const status = !value.enabled ? "侧灯保持键盘原有设置。"
    : !connected ? "连接键盘后生效。"
    : active ? "侧灯正在显示所选颜色。"
    : state?.lightPower?.sleeping ? "灯光休眠中，唤醒后恢复。"
    : ["game", "trigger", "audio", "agent"].includes(mode ?? "") ? "游戏、状态灯、触发和声音律动期间侧灯熄灭，结束后恢复。"
    : state?.device.sideColor ? "Codex 额度侧灯优先显示。"
    : "点击「恢复原有灯效」后侧灯也会恢复，修改颜色或重新播放后再次生效。";
  return (
    <section className="settings-section side-light-section">
      <div className="section-heading">
        <div>
          <h2>{tr("侧灯")}</h2>
          <p className="muted">{tr("整条侧灯使用同一颜色；原厂固件不支持逐颗控制。")}</p>
        </div>
      </div>
      <div className="preference-row">
        <Switch label={tr("自定义侧灯颜色")} checked={value.enabled}
          onChange={(enabled) => change({ enabled }, 0)} />
      </div>
      {value.enabled && (
        <div className="side-light-controls">
          <ColorWheel color={value.color} onChange={(color) => change({ color: color.toLowerCase() })} memory={memory} />
          <div className="codex-light-row codex-brightness">
            <label htmlFor="side-light-brightness">{tr("侧灯亮度")}</label>
            <strong>{value.brightness}%</strong>
            <input id="side-light-brightness" type="range" min="0" max="100" step="1" aria-label={tr("侧灯亮度")}
              value={value.brightness} onChange={(e) => change({ brightness: Number(e.target.value) })} />
          </div>
        </div>
      )}
      <p className="muted side-light-status">{tr(status)}</p>
    </section>
  );
}
