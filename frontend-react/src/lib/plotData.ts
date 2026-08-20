// plotData.ts — [NEW v12] shared guards for handing large arrays to a chart.
//
// WHY THIS FILE EXISTS
//
// v10 fixed the live view (Tab 1) by stopping React from remounting 500 log
// rows 25 times a second. v12 fixes Tab 3, whose lag had a different
// mechanism but the same shape: **the UI was being handed more data than it
// could possibly display**, and it dutifully processed all of it.
//
// The two bugs are not the same bug and no single mechanism fixes both — one
// was key churn on a sliding window, this one is over-plotting a static
// array. What they share is the principle, so the reusable half lives here
// rather than inside Tab 3, and any tab that plots an array should come
// through these functions.
//
// MEASURED (headless Chrome over CDP, `Test Data/2.csv` = 43,754 rows,
// 4.7 MB, chart ~1,500 px wide, six series):
//
//   switch to WAVEFORM   ONE 1,140 ms blocking main-thread task
//   switch to ALL        ONE 1,168 ms blocking task
//   points handed to recharts   6 x 43,754 = 262,524
//   points a 1,500 px chart can resolve   ~1,500 columns
//
// That is ~175 samples fighting over every single pixel column. Recharts
// scales every one of them and serialises them all into one <path d="...">
// per series; 174 of every 175 land on a pixel that is already painted.

// A pixel column can show one vertical span, so two points per column (the
// column's min and its max) is the complete information a line chart can
// convey. 4,000 covers a 2,000-px-wide chart at that density — i.e. wider
// than any laptop panel this dashboard runs on, with headroom for a
// full-screen 4K monitor, while still being ~1/65th of the work the
// WAVEFORM charts were doing.
//
// Deliberately a constant rather than a measured container width: plumbing
// a live pixel width through ResponsiveContainer would make the plotted
// data (and therefore the peak markers, and therefore the exported PDF)
// depend on the window size at render time. A fixed budget keeps the chart
// reproducible, which matters more here than shaving the last few points.
export const PLOT_BUDGET = 4000;

export function decimateEnvelope<T extends Record<string, any>>(
  pts: T[],
  key: string,
  budget: number = PLOT_BUDGET,
): T[] {
  if (budget < 4 || pts.length <= budget) return pts;

  const hasValue = (i: number) => {
    const v = pts[i][key];
    return typeof v === "number" && isFinite(v);
  };

  let firstI = -1, lastI = -1;
  for (let i = 0; i < pts.length; i++) if (hasValue(i)) { firstI = i; break; }
  for (let i = pts.length - 1; i >= 0; i--) if (hasValue(i)) { lastI = i; break; }
  if (firstI < 0) return [];            // nothing drawable at all

  // Two slots go to the pinned endpoints; the rest bucket the interior.
  const buckets = Math.max(1, Math.floor(budget / 2) - 1);
  const lo = firstI + 1;
  const hi = lastI;                     // exclusive — lastI is pinned
  const span = Math.max(0, hi - lo);
  const out: T[] = [pts[firstI]];

  for (let b = 0; b < buckets && span > 0; b++) {
    const start = lo + Math.floor((b * span) / buckets);
    const end = lo + Math.floor(((b + 1) * span) / buckets);
    if (end <= start) continue;

    let minI = -1, maxI = -1;
    let minV = Infinity, maxV = -Infinity;
    for (let i = start; i < end; i++) {
      const v = pts[i][key];
      if (typeof v !== "number" || !isFinite(v)) continue;
      if (v < minV) { minV = v; minI = i; }
      if (v > maxV) { maxV = v; maxI = i; }
    }

    if (minI < 0 && maxI < 0) continue;
    if (minI < 0) { out.push(pts[maxI]); continue; }
    if (maxI < 0) { out.push(pts[minI]); continue; }

    // Emit in array order, not min-then-max: reversing a pair would draw a
    // tiny backwards segment on an x-ordered axis.
    if (minI === maxI) out.push(pts[minI]);
    else if (minI < maxI) { out.push(pts[minI]); out.push(pts[maxI]); }
    else { out.push(pts[maxI]); out.push(pts[minI]); }
  }

  if (lastI > firstI) out.push(pts[lastI]);
  return out;
}

export interface Extent { min: number; max: number }

const EMPTY_EXTENT: Extent = { min: Infinity, max: -Infinity };

export function extentOf(pts: Array<Record<string, any>>, key: string): Extent {
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < pts.length; i++) {
    const v = pts[i][key];
    if (typeof v !== "number" || !isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max };
}

/** Min/max of one key across several series (one chart's worth). */
export function extentAcross(groups: Array<Array<Record<string, any>>>, key: string): Extent {
  let min = Infinity, max = -Infinity;
  for (const g of groups) {
    const e = extentOf(g, key);
    if (e.min < min) min = e.min;
    if (e.max > max) max = e.max;
  }
  return { min, max };
}

/** Min/max across several (series-group, key) pairs — e.g. X, Y and Z axes. */
export function extentOfPairs(pairs: Array<[Array<Array<Record<string, any>>>, string]>): Extent {
  let min = Infinity, max = -Infinity;
  for (const [groups, key] of pairs) {
    const e = extentAcross(groups, key);
    if (e.min < min) min = e.min;
    if (e.max > max) max = e.max;
  }
  return { min, max };
}

export function isEmptyExtent(e: Extent): boolean {
  return !isFinite(e.min) || !isFinite(e.max);
}

export { EMPTY_EXTENT };
