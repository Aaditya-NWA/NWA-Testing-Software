// fft.ts
// [NEW v9] A real discrete Fourier transform. Dependency-free vanilla TS,
// matching balancing.ts's style so the two analysis modules sit together.
//
// ─────────────────────────────────────────────────────────────────────
// WHY THIS FILE EXISTS
//
// Until v9 this project had NO spectral analysis of any kind. Tab 3's
// "FFT" mode plotted the raw signed time-domain waveform — an exhaustive
// search of App.tsx, balancing.ts, hooks/ and types/ for any Fourier
// machinery turned up only SVG gauge trigonometry and the balancing
// phasor rotation. "FFT accuracy" was therefore not poor, it was
// undefined.
//
// The existing raw-waveform view is genuinely useful and is KEPT (it is
// now labelled WAVEFORM, which is what it always was). This module adds
// the thing the label was promising.
//
// ─────────────────────────────────────────────────────────────────────
// WHAT A SPECTRUM OF THIS DATA IS ALLOWED TO CLAIM
//
// A spectrum is only as trustworthy as the time base under it, and this
// project's time base has a history worth knowing about:
//
//   * Pre-v9 CSVs have NO sample clock. Every timestamp was a host
//     ARRIVAL stamp taken after USB transport; 11-30% of consecutive
//     rows shared a millisecond. Transforming those is possible but the
//     frequency axis is only as good as the assumption that samples were
//     evenly spaced, which they measurably were not.
//
//   * Pre-v9 CSVs are also ALIASED. Sampling ran at ~222 Hz against a
//     416 or 833 Hz sensor ODR with no anti-alias filter, so everything
//     from 111 Hz upward folded into the band. At 5040 RPM the 2x
//     blade-pass (168 Hz) landed at ~51 Hz, where it measured LARGER
//     than the genuine 1x. No transform can undo that — folded energy is
//     mathematically unrecoverable.
//
//   * v9 CSVs carry McuMicros, a uniform grid derived from the MCU's own
//     clock, and are captured at 833 Hz behind a 208 Hz anti-alias
//     filter. These are the files worth transforming.
//
// analyseGrid() below reports which of those two worlds a file came from
// so the UI can say so plainly rather than presenting both identically.

export interface SpectrumPoint {
  freq: number;   // Hz
  amp: number;    // g, amplitude-corrected (peak, not RMS)
}

export interface SpectrumResult {
  points: SpectrumPoint[];
  fs: number;             // sample rate used, Hz
  segments: number;       // how many Welch segments were averaged
  nfft: number;           // transform length (includes zero padding)
  /** True resolving power, fs / segmentLength — the minimum separation
   *  at which two tones are actually distinguishable. */
  resolution: number;
  /** Spacing between plotted points, fs / nfft. Finer than `resolution`
   *  because of zero padding: more points, not more information. */
  binSpacing: number;
}

const ZERO_PAD = 4;

function fftInPlace(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if (n <= 1) return;

  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      const half = len >> 1;
      for (let k = 0; k < half; k++) {
        const uRe = re[i + k];
        const uIm = im[i + k];
        const vRe = re[i + k + half] * curRe - im[i + k + half] * curIm;
        const vIm = re[i + k + half] * curIm + im[i + k + half] * curRe;
        re[i + k] = uRe + vRe;
        im[i + k] = uIm + vIm;
        re[i + k + half] = uRe - vRe;
        im[i + k + half] = uIm - vIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

function hann(n: number): Float64Array {
  const w = new Float64Array(n);
  if (n === 1) { w[0] = 1; return w; }
  for (let i = 0; i < n; i++) {
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  }
  return w;
}

export function computeSpectrum(
  values: number[],
  fs: number,
  opts: { segmentLength?: number; maxSegments?: number } = {}
): SpectrumResult {
  const n = values.length;
  if (n < 8 || !isFinite(fs) || fs <= 0) {
    return { points: [], fs, segments: 0, nfft: 0, resolution: 0, binSpacing: 0 };
  }

  let segLen = opts.segmentLength ?? Math.min(4096, nextPow2(Math.floor(n / 4)));
  segLen = Math.max(256, Math.min(segLen, nextPow2(n)));
  if (segLen > n) segLen = nextPow2(Math.floor(n / 2)) || n;
  if (segLen > n) segLen = n;

  const hop = Math.max(1, Math.floor(segLen / 2));
  const nfft = nextPow2(segLen) * ZERO_PAD;
  const w = hann(segLen);

  // Coherent gain: for amplitude correction the right normaliser is the
  // SUM of the window, not its length. A = 2 * |X_k| / sum(w).
  let wSum = 0;
  for (let i = 0; i < segLen; i++) wSum += w[i];

  const half = nfft >> 1;
  const acc = new Float64Array(half + 1);
  let segments = 0;

  const maxSeg = opts.maxSegments ?? 64;

  for (let start = 0; start + segLen <= n && segments < maxSeg; start += hop) {
    let mean = 0;
    for (let i = 0; i < segLen; i++) mean += values[start + i];
    mean /= segLen;

    const re = new Float64Array(nfft);
    const im = new Float64Array(nfft);
    for (let i = 0; i < segLen; i++) re[i] = (values[start + i] - mean) * w[i];

    fftInPlace(re, im);

    for (let k = 0; k <= half; k++) {
      acc[k] += Math.sqrt(re[k] * re[k] + im[k] * im[k]);
    }
    segments++;
  }

  if (segments === 0) {
    return { points: [], fs, segments: 0, nfft,
             resolution: fs / segLen, binSpacing: fs / nfft };
  }

  const points: SpectrumPoint[] = [];
  for (let k = 0; k <= half; k++) {
    // DC and Nyquist are not mirrored, so they do not get the factor 2.
    const mirror = k === 0 || k === half ? 1 : 2;
    points.push({
      freq: (k * fs) / nfft,
      amp: (mirror * (acc[k] / segments)) / wSum,
    });
  }

  return { points, fs, segments, nfft,
           resolution: fs / segLen, binSpacing: fs / nfft };
}

// ── Time base analysis ───────────────────────────────────────────────

export interface GridInfo {
  /** Best estimate of the sample rate, Hz. */
  fs: number;
  /** True when the file carries a real MCU sample clock (v9+). */
  hasMcuClock: boolean;
  /** Fraction of consecutive intervals that deviate >10% from the median.
   *  On pre-v9 arrival-stamped files this is large. */
  jitterFraction: number;
  /** Nyquist frequency for this rate. */
  nyquist: number;
  /** Human-readable caveat, or null when the grid is trustworthy. */
  warning: string | null;
}

export function analyseGrid(rows: Record<string, number>[]): GridInfo {
  const n = rows.length;
  if (n < 4) {
    return { fs: 0, hasMcuClock: false, jitterFraction: 1, nyquist: 0,
             warning: "Not enough samples for spectral analysis." };
  }

  const hasMcu = rows[0]["McuMicros"] !== undefined && rows[1]["McuMicros"] !== undefined;

  let times: number[];
  if (hasMcu) {
    times = rows.map(r => r["McuMicros"] / 1e6);
  } else if (rows[0]["_tsec"] !== undefined) {
    times = rows.map(r => r["_tsec"]);
  } else {
    return {
      fs: 0, hasMcuClock: false, jitterFraction: 1, nyquist: 0,
      warning:
        "This file has no usable time column. Pre-v9 logs stamp rows on " +
        "arrival, not at sampling; re-record with the v9 firmware for " +
        "spectral analysis.",
    };
  }

  const deltas: number[] = [];
  for (let i = 1; i < times.length; i++) {
    const d = times[i] - times[i - 1];
    if (d > 0) deltas.push(d);
  }
  if (deltas.length === 0) {
    return { fs: 0, hasMcuClock: hasMcu, jitterFraction: 1, nyquist: 0,
             warning: "Timestamps do not advance — cannot establish a sample rate." };
  }

  const span = times[times.length - 1] - times[0];
  const fs = span > 0 ? (times.length - 1) / span : 0;
  const period = fs > 0 ? 1 / fs : 0;

  let off = 0;
  for (const d of deltas) if (Math.abs(d - period) > 0.1 * period) off++;
  const zeroGaps = (times.length - 1) - deltas.length;
  const jitterFraction = (off + zeroGaps) / Math.max(1, times.length - 1);

  let warning: string | null = null;
  if (!hasMcu) {
    warning =
      `No MCU sample clock in this file. Times are host ARRIVAL stamps, and ` +
      `${(jitterFraction * 100).toFixed(0)}% of intervals deviate >10% from the median — ` +
      `the frequency axis is approximate. Pre-v9 logs are also aliased above ` +
      `${(fs / 2).toFixed(0)} Hz with no anti-alias filter, so peaks may be folded ` +
      `images of higher-frequency content rather than real.`;
  } else if (jitterFraction > 0.02) {
    warning =
      `${(jitterFraction * 100).toFixed(1)}% of sample intervals are irregular; ` +
      `there may be dropped samples in this record.`;
  }

  return { fs, hasMcuClock: hasMcu, jitterFraction, nyquist: fs / 2, warning };
}

export function longestContiguousRun<T>(
  rows: T[],
  pred: (r: T) => boolean
): { start: number; end: number; length: number } {
  let bestStart = 0, bestLen = 0;
  let curStart = -1;
  for (let i = 0; i <= rows.length; i++) {
    const ok = i < rows.length && pred(rows[i]);
    if (ok) {
      if (curStart === -1) curStart = i;
    } else if (curStart !== -1) {
      const len = i - curStart;
      if (len > bestLen) { bestLen = len; bestStart = curStart; }
      curStart = -1;
    }
  }
  return { start: bestStart, end: bestStart + bestLen, length: bestLen };
}

/** Rotor order marker positions for a given RPM. */
export function orderFrequencies(rpm: number, maxOrder = 6): { order: number; freq: number }[] {
  const f1 = rpm / 60;
  const out: { order: number; freq: number }[] = [];
  for (let o = 1; o <= maxOrder; o++) out.push({ order: o, freq: o * f1 });
  return out;
}

export function peakNear(points: SpectrumPoint[], freq: number, tolHz: number): SpectrumPoint | null {
  let bestIdx = -1;
  for (let i = 0; i < points.length; i++) {
    if (Math.abs(points[i].freq - freq) > tolHz) continue;
    if (bestIdx === -1 || points[i].amp > points[bestIdx].amp) bestIdx = i;
  }
  if (bestIdx === -1) return null;

  // Cannot interpolate at the very edges of the spectrum.
  if (bestIdx === 0 || bestIdx === points.length - 1) return points[bestIdx];

  const EPS = 1e-20;
  const a = Math.log(Math.max(points[bestIdx - 1].amp, EPS));
  const b = Math.log(Math.max(points[bestIdx].amp, EPS));
  const c = Math.log(Math.max(points[bestIdx + 1].amp, EPS));

  const denom = a - 2 * b + c;
  if (!isFinite(denom) || Math.abs(denom) < 1e-12) return points[bestIdx];

  const delta = (0.5 * (a - c)) / denom;
  if (!isFinite(delta) || Math.abs(delta) > 0.5) return points[bestIdx];

  const binHz = points[1].freq - points[0].freq;
  const interpAmp = Math.exp(b - 0.25 * (a - c) * delta);

  return {
    freq: points[bestIdx].freq + delta * binHz,
    amp: isFinite(interpAmp) ? interpAmp : points[bestIdx].amp,
  };
}
