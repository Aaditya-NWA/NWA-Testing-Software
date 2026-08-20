// Throttle percentage <-> microseconds — numerical checks. [NEW v13]
//
//   npm run test:throttle
//
// Exists because this conversion sits between what the operator types and
// what the motor is commanded to do, and every way it can go wrong is quiet:
// a rounding error does not throw, it just sends a slightly different
// throttle, or produces a value the backend rejects for reasons the UI
// cannot explain.
//
// The four properties pinned here are the ones the Control tab depends on:
//
//   1. 0% and 100% are EXACT. 0% has to actually stop the motor and 100% has
//      to reach the top of the calibrated range. An off-by-one at either end
//      is the difference between a command and a rejection, because the
//      backend validates inclusively against active_profile.
//   2. Every percentage resolves INSIDE the profile. Rounding must never push
//      a value past the bound it came from.
//   3. Percent -> µs -> percent round-trips. Not bit-exact in general (µs is
//      coarser than percent on a narrow range), but it must never drift by
//      more than the quantisation the range itself imposes.
//   4. Degenerate ranges do not produce NaN. A zero-width or inverted range
//      is a bad configuration, not a crash.

import { pctToUs, usToPct, pctError } from "./throttle";

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

const RANGES = [
  { name: "U15II KV100", thrMin: 1025, thrMax: 1600 },
  { name: "U7 V2.0",     thrMin: 1165, thrMax: 1515 },
  { name: "V605",        thrMin: 1000, thrMax: 2000 },
  { name: "narrow (10)", thrMin: 1200, thrMax: 1210 },
  { name: "sweep range", thrMin: 800,  thrMax: 2400 },
];

console.log("-- 0% and 100% land exactly on the bounds --------------");
for (const r of RANGES) {
  check(`${r.name}: 0% === thrMin`,   pctToUs(0, r) === r.thrMin,   pctToUs(0, r));
  check(`${r.name}: 100% === thrMax`, pctToUs(100, r) === r.thrMax, pctToUs(100, r));
  check(`${r.name}: thrMin === 0%`,   usToPct(r.thrMin, r) === 0,   usToPct(r.thrMin, r));
  check(`${r.name}: thrMax === 100%`, usToPct(r.thrMax, r) === 100, usToPct(r.thrMax, r));
}

console.log();
console.log("-- Every percentage resolves inside the profile --------");
for (const r of RANGES) {
  let outside = 0;
  let nonInteger = 0;
  for (let p = 0; p <= 100; p++) {
    const us = pctToUs(p, r);
    if (us < r.thrMin || us > r.thrMax) outside++;
    if (!Number.isInteger(us)) nonInteger++;
  }
  check(`${r.name}: no percentage lands outside the range`, outside === 0, outside);
  // The firmware takes an integer microsecond value; a fractional one would
  // be silently truncated somewhere downstream.
  check(`${r.name}: every result is a whole microsecond`, nonInteger === 0, nonInteger);
}

console.log();
console.log("-- Round trip stays within the range quantisation ------");
for (const r of RANGES) {
  const span = r.thrMax - r.thrMin;
  const usPerPct = span / 100;
  const tol = Math.max(1, Math.ceil(1 / usPerPct));
  let worst = 0;
  for (let p = 0; p <= 100; p++) {
    const back = usToPct(pctToUs(p, r), r);
    worst = Math.max(worst, Math.abs(back - p));
  }
  check(`${r.name}: round trip within ${tol}% (worst ${worst}%)`, worst <= tol, worst);
}

console.log();
console.log("-- Out-of-band input is clamped, never propagated ------");
{
  const r = RANGES[0];
  check("negative percent clamps to thrMin", pctToUs(-25, r) === r.thrMin, pctToUs(-25, r));
  check("over-100 percent clamps to thrMax", pctToUs(180, r) === r.thrMax, pctToUs(180, r));
  check("below-range µs reads as 0%",  usToPct(r.thrMin - 200, r) === 0,   usToPct(r.thrMin - 200, r));
  check("above-range µs reads as 100%", usToPct(r.thrMax + 200, r) === 100, usToPct(r.thrMax + 200, r));
  check("NaN percent falls back to thrMin", pctToUs(NaN, r) === r.thrMin, pctToUs(NaN, r));
  check("NaN µs falls back to 0%", usToPct(NaN, r) === 0, usToPct(NaN, r));
}

console.log();
console.log("-- Degenerate ranges do not produce NaN ----------------");
for (const bad of [
  { thrMin: 1500, thrMax: 1500 },   // zero width
  { thrMin: 1600, thrMax: 1025 },   // inverted
]) {
  const us = pctToUs(50, bad);
  const p = usToPct(1300, bad);
  check(`range ${bad.thrMin}-${bad.thrMax}: µs is finite`, Number.isFinite(us), us);
  check(`range ${bad.thrMin}-${bad.thrMax}: percent is finite`, Number.isFinite(p), p);
}

console.log();
console.log("-- Field validation ------------------------------------");
check("0 accepted",    pctError(0) === null);
check("100 accepted",  pctError(100) === null);
check("-1 rejected",   pctError(-1) !== null);
check("101 rejected",  pctError(101) !== null);
check("NaN rejected",  pctError(NaN) !== null);

console.log();
if (failures) {
  console.log(`${failures} CHECK(S) FAILED`);
  process.exit(1);
}
console.log("All throttle conversion checks passed.");
