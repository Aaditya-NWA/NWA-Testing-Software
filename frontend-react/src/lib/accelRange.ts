// Accelerometer full-scale range [v12 firmware]: the selectable ranges, and
// clipping detection for recorded CSVs.
//
// Mirrors backend-fastapi/frame_protocol.py (_MG_PER_LSB, CLIP_COUNTS). A
// sample is clipped when any raw count reached the range limit; in a CSV that
// shows up as |Acc| at CLIP_COUNTS LSBs of the file's range. Logs without an
// AccelRangeG column but with McuMicros are v9-v11 firmware, fixed at 4 g;
// older logs have no recorded range and are not checked.

export type AccelRangeG = 2 | 4 | 8 | 16;

export const DEFAULT_ACCEL_RANGE_G: AccelRangeG = 4;

export const ACCEL_RANGES: { g: AccelRangeG; label: string }[] = [
  { g: 2,  label: "±2 g" },
  { g: 4,  label: "±4 g (default)" },
  { g: 8,  label: "±8 g" },
  { g: 16, label: "±16 g" },
];

const MG_PER_LSB: Record<number, number> = { 2: 0.061, 4: 0.122, 8: 0.244, 16: 0.488 };
const CLIP_COUNTS = 32700;
// CSV values are rounded to 5 decimals; well under one LSB at any range.
const CSV_ROUNDING_G = 1e-5;

export function clipLimitG(rangeG: number): number | null {
  const mg = MG_PER_LSB[rangeG];
  return mg === undefined ? null : (CLIP_COUNTS * mg) / 1000 - CSV_ROUNDING_G;
}

export interface ClipSummary {
  /** False for logs that predate a known range (pre-v9). */
  checked: boolean;
  clipped: number;
  /** Distinct ranges present in the rows, ascending. */
  ranges: number[];
}

export function clipSummary(rows: Record<string, number>[], headers: string[]): ClipSummary {
  const hasCol = headers.includes("AccelRangeG");
  if (!hasCol && !headers.includes("McuMicros")) return { checked: false, clipped: 0, ranges: [] };

  const ranges = new Set<number>();
  let clipped = 0;
  for (const r of rows) {
    const g = hasCol ? r.AccelRangeG : DEFAULT_ACCEL_RANGE_G;
    ranges.add(g);
    const lim = clipLimitG(g);
    if (lim === null) continue;
    if (Math.abs(r.AccX) >= lim || Math.abs(r.AccY) >= lim || Math.abs(r.AccZ) >= lim) clipped++;
  }
  return { checked: true, clipped, ranges: [...ranges].sort((a, b) => a - b) };
}

export function rangeText(ranges: number[]): string {
  return ranges.map(g => `±${g} g`).join(", ");
}
