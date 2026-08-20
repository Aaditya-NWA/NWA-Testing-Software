/**
 * Chart series maths for the Analyses tab: axis ticks, RMS binning, and peak
 * location.
 *
 * peakOf compares |value| because the waveform and spectrum charts are signed
 * and the largest excursion is often negative. It marks the largest PLOTTED
 * point, which is why plotData.decimateEnvelope keeps both extremes of every
 * bucket — a decimation that could drop a spike would make the marker lie.
 */
import { extentOf } from "./plotData";


export const GA_AXIS_COLOR = { X: "#4472C4", Y: "#ED7D31", Z: "#70AD47" }; // matches Excel-style reference: X=blue, Y=orange, Z=green
export const GA_DASH_PATTERNS = ["", "6 3", "2 2", "8 3 2 3", "1 3", "10 2 2 2"]; // solid, then variants per file

export function gaDashFor(fileIdx: number): string | undefined {
  const d = GA_DASH_PATTERNS[fileIdx % GA_DASH_PATTERNS.length];
  return d === "" ? undefined : d;
}

export function niceTicks(min: number, max: number, maxTickCount = 45): number[] {
  if (!isFinite(min) || !isFinite(max) || min === max) return [0];
  const range = max - min;
  const stepCandidates = [0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10, 20, 25, 50, 100];
  let step = stepCandidates[stepCandidates.length - 1];
  for (const c of stepCandidates) {
    if (Math.ceil(range / c) + 1 <= maxTickCount) { step = c; break; }
  }

  const decimals = (step.toString().split(".")[1] || "").length;
  const round = (v: number) => parseFloat(v.toFixed(decimals));

  const niceMin = round(Math.floor(min / step) * step);
  const niceMax = round(Math.ceil(max / step) * step);
  const count = Math.round((niceMax - niceMin) / step);

  const ticks: number[] = [];
  for (let i = 0; i <= count; i++) {
    ticks.push(round(niceMin + i * step)); // index-based, not accumulated += (avoids compounding drift)
  }
  return ticks;
}

export function gaAvgMax(pts: { xval: number; [k: string]: number }[], key: string): number {
  if (pts.length === 0) return 0;
  const byX = new Map<number, number>();
  pts.forEach(p => {
    const v = p[key];
    if (v === undefined) return;
    byX.set(p.xval, Math.max(byX.get(p.xval) ?? -Infinity, v));
  });
  const maxima = Array.from(byX.values());
  return maxima.length ? maxima.reduce((a, b) => a + b, 0) / maxima.length : 0;
}

export function rmsOf(values: number[]): number {
  if (values.length === 0) return 0;
  const meanSq = values.reduce((s, v) => s + v * v, 0) / values.length;
  return Math.sqrt(meanSq);
}

export function rmsBinnedSeries(
  pts: { xval: number; [k: string]: number }[],
  key: string,
  binCount = 30
): { xval: number; [k: string]: number }[] {
  const valid = pts.filter(p => p[key] !== undefined && !isNaN(p.xval));
  if (valid.length === 0) return [];
  const { min: xMin, max: xMax } = extentOf(valid, "xval");
  const width = (xMax - xMin) / binCount || 1;

  const bins = new Map<number, number[]>();
  valid.forEach(p => {
    const binIdx = width > 0 ? Math.min(binCount - 1, Math.floor((p.xval - xMin) / width)) : 0;
    if (!bins.has(binIdx)) bins.set(binIdx, []);
    bins.get(binIdx)!.push(p[key]);
  });

  return Array.from(bins.keys())
    .sort((a, b) => a - b)
    .map(binIdx => ({
      xval: xMin + (binIdx + 0.5) * width,
      [key]: rmsOf(bins.get(binIdx)!),
    }));
}

export function peakOf(pts: any[], key: string): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  for (const p of pts) {
    const v = p?.[key];
    if (typeof v !== "number" || !isFinite(v)) continue;
    if (best === null || Math.abs(v) > Math.abs(best.y)) best = { x: p.xval, y: v };
  }
  return best;
}
