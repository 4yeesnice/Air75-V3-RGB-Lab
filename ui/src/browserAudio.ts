// Sound-reactive capture in a normal browser (Windows, or any OS without the
// NuPhyLab desktop app). It plays the part of native/AudioCapture.swift + AppHost:
// heartbeat `audioInventory`, then latest-wins `audioPacket`s for the server session.
//   microphone: getUserMedia
//   system:     getDisplayMedia; the user picks a screen and enables system audio
import workletURL from "./audio-worklet.ts?worker&url";

type Feature = { rms: number; bands: number[] };
type Source = "system" | "microphone";

export class CaptureError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

/** The macOS desktop app captures audio natively; everywhere else the page does. */
export function browserCaptureMode() {
  const w = window as Window & { webkit?: { messageHandlers?: { audioControl?: unknown } } };
  return !w.webkit?.messageHandlers?.audioControl && typeof AudioWorkletNode !== "undefined" && Boolean(navigator.mediaDevices);
}

async function post(body: Record<string, unknown>) {
  await fetch("/api/command", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Air-Token": window.__AIR_TOKEN__ ?? "" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(2000),
  });
}

class BrowserAudio {
  session: string | null = null;
  starting = false;
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private pending: Record<string, unknown> | null = null;
  private sending = false;
  private lastInventory = 0;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  onEnded: (() => void) | null = null;

  /** Inventory every 4 s keeps the server's "capture available" flag (12 s window) alive. */
  enable() {
    if (this.heartbeat || !browserCaptureMode()) return;
    void this.inventory(true);
    this.heartbeat = setInterval(() => void this.inventory(), 4000);
  }

  async inventory(force = false) {
    const now = performance.now();
    if (!force && now - this.lastInventory < 3500) return;
    this.lastInventory = now;
    let devices: { id: string; name: string }[] = [];
    try {
      const inputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput" && d.deviceId && d.deviceId !== "default" && d.deviceId !== "communications");
      // Labels stay empty until microphone permission is granted once.
      devices = inputs.map((d, i) => ({ id: d.deviceId, name: d.label || `Microphone ${i + 1}` }));
    } catch {}
    let microphonePermission = false;
    try { microphonePermission = (await navigator.permissions.query({ name: "microphone" as PermissionName })).state === "granted"; } catch {}
    try {
      await post({ op: "audioInventory", systemSupported: typeof navigator.mediaDevices.getDisplayMedia === "function", devices, microphonePermission });
    } catch {}
  }

  /**
   * Must be called directly from the click handler: getDisplayMedia needs the user
   * gesture, and an AudioContext created here starts without an autoplay prompt.
   */
  async start(source: Source, deviceId: string) {
    this.stop();
    this.starting = true;
    try {
      const constraints = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
      let stream: MediaStream;
      if (source === "microphone") {
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio: deviceId ? { ...constraints, deviceId: { exact: deviceId } } : constraints });
        } catch (error) {
          const name = (error as DOMException)?.name;
          throw new CaptureError(name === "NotAllowedError" ? "microphonePermission" : "inputUnavailable",
            name === "NotAllowedError" ? "请在浏览器中允许使用麦克风，然后重新开始。" : "麦克风不可用，请检查连接或选择其他设备。");
        }
      } else {
        if (typeof navigator.mediaDevices.getDisplayMedia !== "function") throw new CaptureError("systemUnsupported", "当前浏览器不支持共享系统声音，请使用 Chrome 或 Edge，或改用麦克风。");
        try {
          stream = await navigator.mediaDevices.getDisplayMedia({
            video: { frameRate: { max: 1 } }, // browsers require video; one frame per second costs almost nothing
            audio: constraints,
            systemAudio: "include",
          } as DisplayMediaStreamOptions);
        } catch (error) {
          const name = (error as DOMException)?.name || "Error";
          // NotAllowedError = the picker was cancelled or capture is blocked; anything else is a real failure.
          if (name === "NotAllowedError") throw new CaptureError("systemPermission", "已取消共享。请选择「整个屏幕」并开启「分享系统音频」。");
          throw new CaptureError("systemCapture", `无法开始共享屏幕（${name}），请重试或改用麦克风。`);
        }
        if (stream.getAudioTracks().length === 0) {
          stream.getTracks().forEach((track) => track.stop());
          throw new CaptureError("systemPermission", "共享中没有声音。请选择「整个屏幕」并开启「分享系统音频」。");
        }
      }
      this.stream = stream;
      // Stopping the share from the browser bar ends sound-reactive mode.
      for (const track of stream.getTracks()) track.addEventListener("ended", () => { if (this.stream === stream) this.onEnded?.(); });
      const context = new AudioContext({ latencyHint: "interactive" });
      this.context = context;
      await context.audioWorklet.addModule(workletURL);
      const node = new AudioWorkletNode(context, "nuphy-audio-features", { numberOfInputs: 1, numberOfOutputs: 1 });
      this.node = node;
      node.port.onmessage = (event: MessageEvent<Feature>) => this.feature(event.data);
      // Pull the graph through a muted gain: never play captured audio back.
      const mute = context.createGain();
      mute.gain.value = 0;
      context.createMediaStreamSource(new MediaStream(stream.getAudioTracks())).connect(node).connect(mute).connect(context.destination);
      if (context.state === "suspended") await context.resume();
    } catch (error) {
      this.stop();
      throw error;
    } finally {
      this.starting = false;
    }
  }

  /** Bind the running capture to the server session returned by audioStart. */
  attach(session: string) {
    if (!this.stream) return;
    this.session = session;
    this.send({ op: "audioPacket", session, status: "listening" });
  }

  private feature(feature: Feature) {
    void this.inventory(); // heartbeat driven by audio, even if timers are throttled
    if (!this.session) return;
    this.send({ op: "audioPacket", session: this.session, status: "listening", rms: feature.rms, bands: feature.bands });
  }

  /** Latest wins: never queue stale levels behind a slow request. */
  private send(packet: Record<string, unknown>) {
    this.pending = packet;
    if (this.sending) return;
    const next = () => {
      const body = this.pending;
      this.pending = null;
      if (!body) { this.sending = false; return; }
      this.sending = true;
      post(body).catch(() => {}).finally(next);
    };
    next();
  }

  stop() {
    this.session = null;
    this.pending = null;
    const { stream, context, node } = this;
    this.stream = null; this.context = null; this.node = null;
    if (node) node.port.onmessage = null;
    stream?.getTracks().forEach((track) => track.stop());
    void context?.close().catch(() => {});
  }

  get capturing() { return this.stream !== null; }
}

export const browserAudio = new BrowserAudio();
