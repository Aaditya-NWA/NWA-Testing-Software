// fft.test.ts — [NEW v9] numerical checks for the spectrum module.
//
// There is no test runner in this repo, so this is a plain script:
//
//   cd frontend-react
//   npx esbuild src/fft.test.ts --bundle --platform=node --outfile=.fft.test.cjs
//   node .fft.test.cjs
//
// (see run_fft_test.mjs, which does both steps.)
//
// A spectrum is a claim about physics, so these check the numbers rather
// than just that it runs: a known sine must come back at the right
// FREQUENCY and the right AMPLITUDE, Parseval must hold, and the aliasing
// that RESEARCH.md measured in the real data must be reproducible.

import {
  computeSpectrum,
  analyseGrid,
  longestContiguousRun,
  orderFrequencies,
  peakNear,
} from "./fft";

declare const process: { exit(code: number): never };

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name} ${detail}`); failures++; }
}

const FS = 833.0;

function tone(n: number, freq: number, amp: number, phase = 0, dc = 0): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    out.push(dc + amp * Math.sin(2 * Math.PI * freq * (i / FS) + phase));
  }
  return out;
}

console.log("-- Single tone: frequency and amplitude ------------");
{
  const sig = tone(8192, 84.0, 0.2);
  const s = computeSpectrum(sig, FS);
  const pk = peakNear(s.points, 84.0, 3);
  check("peak found near 84 Hz", pk !== null);
  if (pk) {
    check("frequency accurate to <1 Hz", Math.abs(pk.freq - 84) < 1.0, `got ${pk.freq.toFixed(3)}`);
    check("amplitude accurate to <2%", Math.abs(pk.amp - 0.2) / 0.2 < 0.02,
          `got ${pk.amp.toFixed(5)} want 0.2`);
  }
  check("resolution reported", s.resolution > 0 && s.resolution < 5,
        `${s.resolution.toFixed(3)} Hz/bin`);
  check("welch averaged multiple segments", s.segments > 1, `${s.segments}`);
}

console.log("\n-- DC offset must not contaminate the spectrum -----");
{
  // The real Vib columns carry a measured 0.03-0.16 g pedestal.
  const sig = tone(8192, 84.0, 0.2, 0, 1.0);
  const s = computeSpectrum(sig, FS);
  const pk = peakNear(s.points, 84.0, 3);
  check("tone amplitude unaffected by 1 g DC", pk !== null && Math.abs(pk.amp - 0.2) / 0.2 < 0.02,
        pk ? pk.amp.toFixed(5) : "none");
  const dc = s.points[0];
  check("DC bin is suppressed", dc.amp < 0.01, `got ${dc.amp.toExponential(2)}`);
}

console.log("\n-- Two orders resolved separately -------------------");
{
  // 1x at 84 Hz (0.2 g) and 2x at 168 Hz (0.05 g) — the real geometry at
  // 5040 RPM with a 2-blade rotor.
  const a = tone(16384, 84.0, 0.2);
  const b = tone(16384, 168.0, 0.05);
  const sig = a.map((v, i) => v + b[i]);
  const s = computeSpectrum(sig, FS);
  const p1 = peakNear(s.points, 84.0, 3);
  const p2 = peakNear(s.points, 168.0, 3);
  check("1x amplitude correct", p1 !== null && Math.abs(p1.amp - 0.2) / 0.2 < 0.03,
        p1 ? p1.amp.toFixed(5) : "none");
  check("2x amplitude correct", p2 !== null && Math.abs(p2.amp - 0.05) / 0.05 < 0.05,
        p2 ? p2.amp.toFixed(5) : "none");
  // Nothing spurious between them.
  const between = s.points.filter(p => p.freq > 100 && p.freq < 150);
  const maxBetween = Math.max(...between.map(p => p.amp));
  check("no spurious energy between orders", maxBetween < 0.005,
        `max ${maxBetween.toExponential(2)}`);
}

console.log("\n-- Parseval / RMS consistency ----------------------");
{
  const sig = tone(8192, 120.0, 0.3);
  const s = computeSpectrum(sig, FS);
  // For a pure tone, peak amplitude A relates to RMS as A/sqrt(2).
  let sumSq = 0;
  for (const v of sig) sumSq += v * v;
  const rms = Math.sqrt(sumSq / sig.length);
  const pk = peakNear(s.points, 120, 3)!;
  check("peak amp = RMS * sqrt(2)", Math.abs(pk.amp - rms * Math.SQRT2) / pk.amp < 0.03,
        `peak ${pk.amp.toFixed(4)} vs ${(rms * Math.SQRT2).toFixed(4)}`);
}

console.log("\n-- Aliasing reproduction (RESEARCH.md sec 11.2) -----");
{
  const fsOld = 218.9;
  const n = 4096;
  const sig: number[] = [];
  for (let i = 0; i < n; i++) sig.push(0.2 * Math.sin(2 * Math.PI * 168.0 * (i / fsOld)));
  const s = computeSpectrum(sig, fsOld);
  const folded = peakNear(s.points, 50.9, 3);
  check("168 Hz folds to ~50.9 Hz at 218.9 Hz sampling",
        folded !== null && folded.amp > 0.15, folded ? `${folded.freq.toFixed(2)} Hz @ ${folded.amp.toFixed(3)}` : "none");
  // And at v9's 833 Hz it stays where it belongs.
  const good = computeSpectrum(tone(4096, 168.0, 0.2), FS);
  const real = peakNear(good.points, 168.0, 3);
  check("same tone lands at 168 Hz when sampled at 833 Hz",
        real !== null && real.amp > 0.19, real ? `${real.freq.toFixed(2)} Hz` : "none");
}

console.log("\n-- Grid analysis ------------------------------------");
{
  const v9rows = Array.from({ length: 500 }, (_, i) => ({
    McuMicros: i * 1200.48, VibY: 0,
  }));
  const g = analyseGrid(v9rows as any);
  check("v9 grid detected as MCU-clocked", g.hasMcuClock);
  check("v9 rate recovered ~833 Hz", Math.abs(g.fs - 833) < 1, `${g.fs.toFixed(3)}`);
  check("v9 grid has no warning", g.warning === null, String(g.warning));

  // Legacy: arrival stamps, 1 ms quantised, with duplicates — the real
  // shape measured in the old CSVs.
  const legacy = Array.from({ length: 500 }, (_, i) => ({
    _tsec: Math.round((i / 218.9) * 1000) / 1000, VibY: 0,
  }));
  const gl = analyseGrid(legacy as any);
  check("legacy grid flagged as non-MCU", !gl.hasMcuClock);
  check("legacy grid produces a warning", gl.warning !== null);
  check("legacy warning mentions aliasing", !!gl.warning && /alias/i.test(gl.warning));
}

console.log("\n-- Contiguous run selection -------------------------");
{
  const rows = [1, 1, 0, 1, 1, 1, 1, 0, 1];
  const r = longestContiguousRun(rows, (v) => v === 1);
  check("longest run found", r.start === 3 && r.length === 4, JSON.stringify(r));
  const none = longestContiguousRun(rows, (v) => v === 5);
  check("empty when nothing matches", none.length === 0);
}

console.log("\n-- Order markers ------------------------------------");
{
  const o = orderFrequencies(5040, 4);
  check("1x of 5040 RPM is 84 Hz", Math.abs(o[0].freq - 84) < 1e-9, `${o[0].freq}`);
  check("2x is 168 Hz", Math.abs(o[1].freq - 168) < 1e-9);
  check("4 orders returned", o.length === 4);
}

console.log("\n-- Degenerate inputs --------------------------------");
{
  check("empty input returns empty", computeSpectrum([], FS).points.length === 0);
  check("too-short input returns empty", computeSpectrum([1, 2, 3], FS).points.length === 0);
  check("zero fs returns empty", computeSpectrum(tone(1024, 10, 1), 0).points.length === 0);
  const flat = computeSpectrum(new Array(2048).fill(0.5), FS);
  const maxFlat = Math.max(...flat.points.map(p => p.amp));
  check("constant signal has no spectral content", maxFlat < 1e-9, `${maxFlat.toExponential(2)}`);
}

console.log("\n-----------------------------------------------------");
if (failures > 0) { console.log(`FAILED: ${failures} check(s)`); process.exit(1); }
console.log("All FFT checks passed.");
