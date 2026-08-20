// balancing.ts
// Pure influence-coefficient single-plane balancing math.
// No external dependencies — all vanilla TS.

export interface RunResult {
  amp: number;
  phase: number;
  sampleCount: number;
}

export interface CorrectionResult {
  mass_g: number;
  angle_deg: number;
  radius_mm: number;
  unbalance_gmm: number;
}

// ── Polar ↔ complex ────────────────────────────────────────────────────────────
function polarToComplex(amp: number, deg: number): [number, number] {
  const rad = (deg * Math.PI) / 180;
  return [amp * Math.cos(rad), amp * Math.sin(rad)];
}

function complexAbs(re: number, im: number): number {
  return Math.sqrt(re * re + im * im);
}

function complexAngleDeg(re: number, im: number): number {
  let deg = (Math.atan2(im, re) * 180) / Math.PI;
  if (deg < 0) deg += 360;
  return deg;
}

// Complex division: (a+bi) / (c+di)
function complexDiv(are: number, aim: number, cre: number, cim: number): [number, number] {
  const denom = cre * cre + cim * cim;
  if (denom === 0) throw new Error("Division by zero in complex arithmetic");
  return [(are * cre + aim * cim) / denom, (aim * cre - are * cim) / denom];
}

// ── CSV parser ─────────────────────────────────────────────────────────────────
export interface ParsedCSV {
  rows: Record<string, number>[];
  headers: string[];
}

export function parseCSV(text: string): ParsedCSV {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) throw new Error("CSV has no data rows");

  // Find header line — skip duplicate header rows (logger bug)
  const headers = lines[0].split(",").map((h) => h.trim());

  const rows: Record<string, number>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(",");
    if (parts.length !== headers.length) continue;
    // Skip repeated header rows
    if (parts[0].trim().toLowerCase() === headers[0].toLowerCase()) continue;
    const row: Record<string, number> = {};
    let valid = true;
    for (let j = 0; j < headers.length; j++) {
      const v = parseFloat(parts[j]);
      if (isNaN(v)) { valid = false; break; }
      row[headers[j]] = v;

      if (headers[j] === "Timestamp") {
        const t = Date.parse(parts[j].trim().replace(" ", "T"));
        if (!isNaN(t)) row["_tsec"] = t / 1000;
      }
    }
    if (valid) rows.push(row);
  }

  if (rows.length === 0) throw new Error("No valid numeric rows found in CSV");
  return { rows, headers };
}

// ── Column detection ───────────────────────────────────────────────────────────
function findCol(headers: string[], candidates: string[]): string | null {
  for (const c of candidates) {
    const match = headers.find((h) => h.trim().toLowerCase() === c.toLowerCase());
    if (match) return match;
  }
  return null;
}

export function computeAmpPhase(
  parsed: ParsedCSV,
  targetRpm: number,
  rpmTol: number
): RunResult {
  const { rows, headers } = parsed;

  const rpmCol  = findCol(headers, ["RPM", "rpm"]);
  const vibxCol = findCol(headers, ["VibX", "vibX", "Vib_X", "vib_x", "VIBX"]);
  const vibyCol = findCol(headers, ["VibY", "vibY", "Vib_Y", "vib_y", "VIBY"]);

  if (!rpmCol)  throw new Error("CSV missing RPM column");
  if (!vibxCol) throw new Error("CSV missing VibX column");
  if (!vibyCol) throw new Error("CSV missing VibY column");

  const lo = targetRpm - rpmTol;
  const hi = targetRpm + rpmTol;

  const gated = rows.filter((r) => r[rpmCol] >= lo && r[rpmCol] <= hi);

  if (gated.length < 15) {
    throw new Error(
      `Only ${gated.length} samples in RPM window [${lo}–${hi}]. Need ≥ 15. ` +
      `Check target RPM and tolerance.`
    );
  }

  // Amplitude: mean of per-sample resultant magnitude
  let ampSum = 0;
  let meanRe = 0;
  let meanIm = 0;

  for (const r of gated) {
    const vx = r[vibxCol];
    const vy = r[vibyCol];
    ampSum += Math.sqrt(vx * vx + vy * vy);
    meanRe += vx;
    meanIm += vy;
  }

  const amp   = ampSum / gated.length;
  meanRe /= gated.length;
  meanIm /= gated.length;

  const phase = complexAngleDeg(meanRe, meanIm);

  return { amp, phase, sampleCount: gated.length };
}

// ── Influence coefficient correction ──────────────────────────────────────────
export function calcCorrection(
  initial: RunResult,
  trial: RunResult,
  trialMass_g: number,
  trialAngle_deg: number,
  trialRadius_mm: number,
  correctionRadius_mm: number
): CorrectionResult {
  // Vectors
  const [Ire, Iim] = polarToComplex(initial.amp, initial.phase);
  const [Tre, Tim] = polarToComplex(trial.amp, trial.phase);

  // Trial unbalance vector (g·mm)
  const U_trial = trialMass_g * trialRadius_mm;
  const [Umre, Umim] = polarToComplex(U_trial, trialAngle_deg);

  if (complexAbs(Umre, Umim) === 0)
    throw new Error("Trial unbalance is zero — check trial mass and radius");

  // Effect vector: B - A
  const dRe = Tre - Ire;
  const dIm = Tim - Iim;

  if (complexAbs(dRe, dIm) < 1e-9)
    throw new Error("Initial and trial vibration vectors are identical — runs may be the same data");

  // Influence coefficient: K = (B - A) / U_trial
  const [Kre, Kim] = complexDiv(dRe, dIm, Umre, Umim);

  if (complexAbs(Kre, Kim) === 0)
    throw new Error("Influence coefficient is zero");

  // Required correction unbalance: Uc = -A / K
  const [Ucre, Ucim] = complexDiv(-Ire, -Iim, Kre, Kim);

  const U_c     = complexAbs(Ucre, Ucim);
  const angleDeg = complexAngleDeg(Ucre, Ucim);

  if (correctionRadius_mm <= 0)
    throw new Error("Correction radius must be > 0");

  const mass_g = U_c / correctionRadius_mm;

  return {
    mass_g,
    angle_deg: angleDeg,
    radius_mm: correctionRadius_mm,
    unbalance_gmm: U_c,
  };
}
