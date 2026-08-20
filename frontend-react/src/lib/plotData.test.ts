// plotData.test.ts — [NEW v12] correctness checks for chart decimation.
//
// There is no test runner in this repo, so this is a plain script:
//
//   cd frontend-react
//   npm run test:plot
//
// (see run_plot_test.mjs, which bundles and runs it.)
//
// Decimation is a performance fix that touches the numbers on screen, which
// makes it exactly the kind of change that can silently corrupt a
// measurement. The claims worth proving:
//
//   1. The peak marker cannot move. `peakOf` marks the largest-|value|
//      PLOTTED point, so decimation must retain that sample or the marker
//      starts lying about the vibration amplitude — and Tab 2's correction
//      masses are read off amplitudes like it.
//   2. The visible envelope is preserved: y extent identical, x range
//      identical, order preserved.
//   3. It is a no-op below the budget, so small files are untouched.

import {
  decimateEnvelope,
  extentOf,
  extentAcross,
  extentOfPairs,
  PLOT_BUDGET,
} from "./plotData";

declare const process: { exit(code: number): never };

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name} ${detail}`); failures++; }
}

function peakOf(pts: any[], key: string): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  for (const p of pts) {
    const v = p?.[key];
    if (typeof v !== "number" || !isFinite(v)) continue;
    if (best === null || Math.abs(v) > Math.abs(best.y)) best = { x: p.xval, y: v };
  }
  return best;
}

// A vibration-like trace: 1x + 2x orders, noise, and a deliberate one-sample
// spike — the case that separates min/max decimation from LTTB.
function trace(n: number, spikeAt = -1, spikeVal = 0): any[] {
  const pts: any[] = [];
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5;
  for (let i = 0; i < n; i++) {
    let v = 0.2 * Math.sin((2 * Math.PI * i) / 37) + 0.08 * Math.sin((2 * Math.PI * i) / 18.5) + 0.02 * rnd();
    if (i === spikeAt) v = spikeVal;
    pts.push({ xval: 1000 + i * 0.1, VibX: v, _rpm: 1000 + i * 0.1 });
  }
  return pts;
}

console.log("-- Peak preservation (the contract) ----------------");
{
  // Positive spike, negative spike, and a spike placed mid-bucket so it is
  // not accidentally saved by being a bucket boundary.
  const cases: [string, number, number][] = [
    ["positive spike", 20_003, 0.9551],
    ["negative spike (bigger |v| than any positive)", 31_117, -1.4287],
    ["spike in the very first bucket", 3, 0.7777],
    ["spike in the very last bucket", 43_750, -0.8123],
  ];
  for (const [label, at, val] of cases) {
    const full = trace(43_754, at, val);
    const dec = decimateEnvelope(full, "VibX");
    const pf = peakOf(full, "VibX");
    const pd = peakOf(dec, "VibX");
    check(`peak survives: ${label}`,
      pf !== null && pd !== null && pf.y === pd.y && pf.x === pd.x,
      `full=${JSON.stringify(pf)} decimated=${JSON.stringify(pd)}`);
  }
}

console.log("\n-- Envelope, order and metadata --------------------");
{
  const full = trace(43_754);
  const dec = decimateEnvelope(full, "VibX");

  check("decimated to within budget", dec.length <= PLOT_BUDGET, `${dec.length}`);
  check("meaningful reduction", dec.length < full.length / 10,
    `${full.length} -> ${dec.length}`);

  const ef = extentOf(full, "VibX");
  const ed = extentOf(dec, "VibX");
  check("y extent identical", ef.min === ed.min && ef.max === ed.max,
    `full=[${ef.min},${ef.max}] dec=[${ed.min},${ed.max}]`);

  check("x range identical", dec[0].xval === full[0].xval &&
    dec[dec.length - 1].xval === full[full.length - 1].xval,
    `dec x=[${dec[0].xval},${dec[dec.length - 1].xval}]`);

  let ascending = true;
  for (let i = 1; i < dec.length; i++) if (dec[i].xval < dec[i - 1].xval) ascending = false;
  check("x order preserved (no backwards segments)", ascending);

  check("original objects returned, not copies", dec.every(p => full.includes(p)));
  check("per-point metadata (_rpm) intact", dec.every(p => p._rpm === p.xval));
}

console.log("\n-- No-op below the budget -------------------------");
{
  const small = trace(500);
  check("returns the same array reference", decimateEnvelope(small, "VibX") === small);
  const exact = trace(PLOT_BUDGET);
  check("no-op exactly at the budget", decimateEnvelope(exact, "VibX") === exact);
  check("no-op one over the budget still shrinks",
    decimateEnvelope(trace(PLOT_BUDGET + 1), "VibX").length <= PLOT_BUDGET);
}

console.log("\n-- Degenerate input ------------------------------");
{
  check("empty series", decimateEnvelope([], "VibX").length === 0);
  const holey = trace(20_000).map((p, i) => (i % 3 === 0 ? { ...p, VibX: undefined } : p));
  const dh = decimateEnvelope(holey, "VibX");
  check("series with gaps drops no bucket that has data",
    dh.length > 100 && dh.every(p => p.VibX !== undefined), `${dh.length}`);
  const allNaN = trace(20_000).map(p => ({ ...p, VibX: NaN }));
  check("all-NaN series decimates to nothing rather than throwing",
    decimateEnvelope(allNaN, "VibX").length === 0);
}

console.log("\n-- extent* vs the Math.min(...spread) it replaces --");
{
  // The regression this exists to prevent: 130,000 arguments overflows the
  // call stack. rmsBinnedSeries used to do exactly this on every sample.
  const n = 150_000;
  const big = trace(n);
  const xs = big.map(p => p.xval);
  let spreadThrew = false;
  try { Math.min(...xs); } catch { spreadThrew = true; }
  check(`Math.min(...xs) still overflows at ${n} (the bug)`, spreadThrew);

  const e = extentOf(big, "xval");
  check("extentOf handles the same array", e.min === xs[0] && e.max === xs[n - 1],
    `[${e.min},${e.max}]`);

  const a = trace(10), b = trace(10).map(p => ({ ...p, VibX: p.VibX + 5 }));
  const across = extentAcross([a, b], "VibX");
  check("extentAcross spans both series", across.max > 4.9, `${across.max}`);

  const pairs = extentOfPairs([[[a], "VibX"], [[b], "VibX"]]);
  check("extentOfPairs matches extentAcross",
    pairs.min === across.min && pairs.max === across.max);

  check("empty input yields a non-finite extent (callers must fall back)",
    !isFinite(extentOf([], "VibX").min));
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
if (failures > 0) process.exit(1);
