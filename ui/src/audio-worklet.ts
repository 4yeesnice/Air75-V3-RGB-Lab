// Runs on the browser's audio rendering thread, which keeps going when the tab is
// hidden or the window is minimised. Raw PCM never leaves this thread: only the
// aggregate rms + 8 bands are posted, the same privacy boundary as the Mac app.
import { AudioFeatureAnalyzer } from "../../shared/audio-features.mjs";

declare const sampleRate: number;
declare class AudioWorkletProcessor { readonly port: MessagePort; }
declare function registerProcessor(name: string, processor: unknown): void;

class NuPhyAudioFeatures extends AudioWorkletProcessor {
  analyzer = new AudioFeatureAnalyzer(sampleRate);
  silence = new Float32Array(128);
  process(inputs: Float32Array[][]) {
    const channels = inputs[0];
    let mono: Float32Array;
    if (!channels || channels.length === 0) mono = this.silence; // keep the heartbeat while a source is silent
    else {
      mono = new Float32Array(channels[0].length);
      for (const channel of channels) for (let i = 0; i < mono.length; i++) mono[i] += channel[i] / channels.length;
    }
    const feature = this.analyzer.push(mono);
    if (feature) this.port.postMessage(feature);
    return true;
  }
}
registerProcessor("nuphy-audio-features", NuPhyAudioFeatures);
