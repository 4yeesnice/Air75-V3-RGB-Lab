export const FEATURE_SIZE: number;
export const BAND_EDGES: number[];
export const EMIT_SECONDS: number;
export type AudioFeature = { rms: number; bands: number[] };
export function hannWindow(size?: number): Float64Array;
export function createFFT(size?: number): (re: Float64Array, im: Float64Array) => void;
export function bandBins(rate: number, size?: number): [number, number][];
export function computeFeatures(samples: ArrayLike<number>, rate: number, shared?: object): AudioFeature;
export class AudioFeatureAnalyzer {
  constructor(rate: number, size?: number);
  push(block: ArrayLike<number>): AudioFeature | null;
}
