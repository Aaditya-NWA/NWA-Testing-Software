/**
 * Throttle percentage <-> microseconds.
 *
 * The Control tab takes throttle as a percentage of the loaded motor
 * configuration; the firmware, `active_profile` validation and the CSV all
 * speak microseconds. This is the only place the two meet.
 *
 * Configure New Motor deliberately does not import this: that tab discovers a
 * motor's range, so a percentage there would be computed from the very range
 * being measured.
 *
 * Three properties, pinned by throttle.test.ts: rounding happens once here;
 * clamping happens after rounding (the backend validates inclusively, so one
 * microsecond past a bound is a rejection); 0% and 100% are exact.
 */

export interface ThrottleRange {
  thrMin: number;
  thrMax: number;
}

const clampNum = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v));

export function pctToUs(pctValue: number, p: ThrottleRange): number {
  const span = p.thrMax - p.thrMin;
  if (!Number.isFinite(pctValue) || span <= 0) return p.thrMin;
  const raw = p.thrMin + (clampNum(pctValue, 0, 100) / 100) * span;
  return clampNum(Math.round(raw), p.thrMin, p.thrMax);
}

export function usToPct(us: number, p: ThrottleRange): number {
  const span = p.thrMax - p.thrMin;
  if (!Number.isFinite(us) || span <= 0) return 0;
  return clampNum(Math.round(((us - p.thrMin) / span) * 100), 0, 100);
}

/** Whole percent: at a typical 350-575 µs span that is already finer than the
 *  firmware's 5 µs ramp granularity. */
export const PCT_STEP = 1;

export function pctError(value: number): string | null {
  if (!Number.isFinite(value)) return "Throttle must be 0–100%";
  if (value < 0 || value > 100) return "Throttle must be 0–100%";
  return null;
}
