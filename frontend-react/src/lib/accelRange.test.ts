// Accelerometer range and CSV clip detection — checks. [v12 firmware]
//
//   npm run test:range
//
// The limits here must agree with the backend's CLIP_COUNTS, or a file the
// backend counted as clipped would load in Analyses without a warning. The
// CSV rows below are written the way logger.py writes them: raw counts times
// the range's g/LSB, rounded to 5 decimals.

import { clipLimitG, clipSummary } from "./accelRange";

declare const process: { exit(code: number): never };

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}`);
    if (detail !== undefined) console.log("        ", detail);
  }
}

const MG: Record<number, number> = { 2: 0.061, 4: 0.122, 8: 0.244, 16: 0.488 };
const asCsv = (count: number, g: number) => Math.round(count * MG[g] / 1000 * 1e5) / 1e5;

const V12 = ["Timestamp", "McuMicros", "RPM", "AccX", "AccY", "AccZ", "AccelRangeG"];
const V11 = ["Timestamp", "McuMicros", "RPM", "AccX", "AccY", "AccZ"];
const PRE_V9 = ["Timestamp", "RPM", "AccX", "AccY", "AccZ"];

const row = (ax: number, ay: number, az: number, g?: number) =>
  ({ Timestamp: 2026, McuMicros: 0, RPM: 0, AccX: ax, AccY: ay, AccZ: az,
     ...(g === undefined ? {} : { AccelRangeG: g }) });

console.log("-- Limits match the backend's count threshold --------");
for (const g of [2, 4, 8, 16]) {
  const lim = clipLimitG(g)!;
  check(`±${g} g: count 32700 is clipped`, asCsv(32700, g) >= lim, { lim, v: asCsv(32700, g) });
  check(`±${g} g: count 32699 is not`, asCsv(32699, g) < lim, { lim, v: asCsv(32699, g) });
  check(`±${g} g: negative full scale is clipped`, Math.abs(asCsv(-32768, g)) >= lim);
}
check("unknown range has no limit", clipLimitG(3) === null);

console.log("\n-- clipSummary -------------------------------------");
const s12 = clipSummary([
  row(0, asCsv(-16393, 2), 0, 2),         // 1 g of gravity at 2 g: fine
  row(0, asCsv(32767, 2), 0, 2),          // clipped
  row(asCsv(-32768, 2), 0, 0, 2),         // clipped
  row(asCsv(32767, 2), 0, 0, 8),          // same g value is nowhere near 8 g full scale
], V12);
check("v12 log: clipped rows counted at each row's own range", s12.clipped === 2, s12);
check("v12 log: ranges listed", s12.checked && s12.ranges.join() === "2,8", s12);

const s11 = clipSummary([row(0, asCsv(32767, 4), 0), row(0, 1.0, 0)], V11);
check("v9-v11 log (no column) is checked at 4 g", s11.checked && s11.clipped === 1
  && s11.ranges.join() === "4", s11);

const s8 = clipSummary([row(0, 3.23, 0)], PRE_V9);
check("pre-v9 log is not checked", !s8.checked && s8.clipped === 0, s8);

console.log("\n----------------------------------------------------");
if (failures) {
  console.log(`FAILED: ${failures} check(s)`);
  process.exit(1);
}
console.log("All accel-range checks passed.");
