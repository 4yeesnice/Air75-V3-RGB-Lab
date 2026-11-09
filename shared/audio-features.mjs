// Audio features for sound-reactive lighting, ported from AudioFeatureAnalyzer in
// native/AudioCapture.swift so the browser capture feeds the renderer the same
// numbers as the macOS app. Pure JS, no DOM: runs in an AudioWorklet and in Node tests.
//
//   window: 2048 samples, Hann (vDSP_HANN_NORM: 0.8165 * (1 - cos(2πn/N)))
//   rms:    of the raw (unwindowed) mono samples, each clamped to [-1, 1]
//   bands:  8 bands with edges 40…12000 Hz, sqrt(Σ|X[k]|²) * 2 / N, capped at 1
//   rate:   at most one feature per 45 ms of audio
export const FEATURE_SIZE = 2048;
export const BAND_EDGES = [40, 80, 160, 320, 640, 1280, 2560, 5120, 12000];
export const EMIT_SECONDS = 0.045;

export function hannWindow(size = FEATURE_SIZE) {
  const window = new Float64Array(size);
  for (let n = 0; n < size; n++) window[n] = 0.8165 * (1 - Math.cos((2 * Math.PI * n) / size));
  return window;
}

/** In-place iterative radix-2 FFT (forward, unnormalized, like vDSP_DFT_Execute). */
export function createFFT(size = FEATURE_SIZE) {
  if (size & (size - 1)) throw new Error("FFT size must be a power of two");
  const bits = Math.log2(size), reverse = new Uint32Array(size);
  for (let i = 0; i < size; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    reverse[i] = r;
  }
  const cos = new Float64Array(size / 2), sin = new Float64Array(size / 2);
  for (let i = 0; i < size / 2; i++) { cos[i] = Math.cos((2 * Math.PI * i) / size); sin[i] = -Math.sin((2 * Math.PI * i) / size); }
  return (re, im) => {
    for (let i = 0; i < size; i++) {
      const j = reverse[i];
      if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let len = 2; len <= size; len <<= 1) {
      const half = len >> 1, step = size / len;
      for (let start = 0; start < size; start += len) {
        for (let k = 0; k < half; k++) {
          const wr = cos[k * step], wi = sin[k * step], a = start + k, b = a + half;
          const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
      }
    }
  };
}

export function bandBins(rate, size = FEATURE_SIZE) {
  return Array.from({ length: 8 }, (_, band) => {
    const lo = Math.max(1, Math.ceil((BAND_EDGES[band] * size) / rate));
    const hi = Math.min(size / 2, Math.max(lo + 1, Math.ceil((BAND_EDGES[band + 1] * size) / rate)));
    return [lo, hi];
  });
}

/** Features for exactly FEATURE_SIZE mono samples (already clamped). */
export function computeFeatures(samples, rate, { window = hannWindow(), fft = createFFT(), bins = bandBins(rate) } = {}) {
  const size = samples.length;
  let sum = 0;
  for (let i = 0; i < size; i++) sum += samples[i] * samples[i];
  const re = new Float64Array(size), im = new Float64Array(size);
  for (let i = 0; i < size; i++) re[i] = samples[i] * window[i];
  fft(re, im);
  const bands = bins.map(([lo, hi]) => {
    if (lo >= hi) return 0;
    let power = 0;
    for (let k = lo; k < hi; k++) power += re[k] * re[k] + im[k] * im[k];
    return Math.min(1, (Math.sqrt(power) * 2) / size);
  });
  return { rms: Math.min(1, Math.sqrt(sum / size)), bands };
}

/** Streaming analyser: push mono blocks of any length, get a feature every ≥45 ms of audio. */
export class AudioFeatureAnalyzer {
  constructor(rate, size = FEATURE_SIZE) {
    if (!(rate > 0)) throw new Error("sample rate must be positive");
    this.rate = rate; this.size = size;
    this.ring = new Float64Array(size); this.filled = 0; this.write = 0;
    this.sinceEmit = Infinity; this.emitFrames = Math.ceil(EMIT_SECONDS * rate);
    this.shared = { window: hannWindow(size), fft: createFFT(size), bins: bandBins(rate, size) };
    this.ordered = new Float64Array(size);
  }
  push(block) {
    for (let i = 0; i < block.length; i++) {
      const v = block[i];
      this.ring[this.write] = Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0;
      this.write = (this.write + 1) % this.size;
    }
    this.filled = Math.min(this.size, this.filled + block.length);
    this.sinceEmit += block.length;
    if (this.filled < this.size || this.sinceEmit < this.emitFrames) return null;
    this.sinceEmit = 0;
    for (let i = 0; i < this.size; i++) this.ordered[i] = this.ring[(this.write + i) % this.size];
    return computeFeatures(this.ordered, this.rate, this.shared);
  }
}
