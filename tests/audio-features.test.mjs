// Browser audio features must match the macOS analyser (native/AudioCapture.swift).
import test from "node:test";
import assert from "node:assert/strict";
import { AudioFeatureAnalyzer, bandBins, computeFeatures, createFFT, hannWindow, FEATURE_SIZE } from "../shared/audio-features.mjs";
import { validateAudioFeature } from "../shared/audio-reactive.mjs";

const RATE = 48000;
const tone = (hz, amp = 0.5, n = FEATURE_SIZE, phase = 0) => Float64Array.from({ length: n }, (_, i) => amp * Math.sin(2 * Math.PI * hz * (i + phase) / RATE));

test("FFT equals a direct DFT", () => {
  const n = 64, fft = createFFT(n);
  const x = Array.from({ length: n }, (_, i) => Math.sin(i * 0.3) + 0.25 * Math.cos(i * 1.7) + (i % 5) / 7);
  const re = Float64Array.from(x), im = new Float64Array(n);
  fft(re, im);
  for (let k = 0; k < n; k++) {
    let r = 0, m = 0;
    for (let t = 0; t < n; t++) { r += x[t] * Math.cos((2 * Math.PI * k * t) / n); m -= x[t] * Math.sin((2 * Math.PI * k * t) / n); }
    assert.ok(Math.abs(re[k] - r) < 1e-9 && Math.abs(im[k] - m) < 1e-9, `bin ${k}`);
  }
});

test("Hann window uses the vDSP_HANN_NORM scale (unit RMS)", () => {
  const w = hannWindow();
  assert.equal(w[0], 0);
  const rms = Math.sqrt(w.reduce((s, v) => s + v * v, 0) / w.length);
  assert.ok(Math.abs(rms - 1) < 1e-3, `window rms ${rms}`);
});

test("band edges match the Swift bin arithmetic at 44.1 and 48 kHz", () => {
  assert.deepEqual(bandBins(48000), [[2, 4], [4, 7], [7, 14], [14, 28], [28, 55], [55, 110], [110, 219], [219, 512]]);
  assert.deepEqual(bandBins(44100)[0], [2, 4]);
  assert.deepEqual(bandBins(44100).at(-1), [238, 558].map((v) => Math.min(1024, v)));
});

test("a pure tone lands in its band; silence is zero; output validates", () => {
  for (const [hz, band] of [[60, 0], [440, 3], [1000, 4], [3000, 6], [8000, 7]]) {
    const f = computeFeatures(tone(hz), RATE);
    assert.equal(f.bands.indexOf(Math.max(...f.bands)), band, `${hz} Hz -> band ${band}: ${f.bands.map((b) => b.toFixed(3))}`);
    assert.ok(Math.abs(f.rms - 0.5 / Math.SQRT2) < 0.01, `rms ${f.rms}`);
    validateAudioFeature(f);
  }
  const quiet = computeFeatures(new Float64Array(FEATURE_SIZE), RATE);
  assert.equal(quiet.rms, 0);
  assert.ok(quiet.bands.every((b) => b === 0));
  const loud = computeFeatures(tone(1000, 4), RATE);
  assert.ok(loud.rms <= 1 && loud.bands.every((b) => b <= 1), "clamped to [0, 1]");
});

test("streaming analyser emits every 45 ms of audio after the window fills", () => {
  const a = new AudioFeatureAnalyzer(RATE);
  let emitted = 0, frames = 0;
  for (let block = 0; block < 375; block++) { // 375 * 128 = 1 s at 48 kHz (AudioWorklet quantum)
    if (a.push(tone(440, 0.3, 128, frames))) emitted++;
    frames += 128;
  }
  assert.ok(emitted >= 20 && emitted <= 22, `features per second: ${emitted}`);
  assert.equal(new AudioFeatureAnalyzer(RATE).push(tone(440, 0.3, 1000)), null, "nothing before 2048 samples");
});
