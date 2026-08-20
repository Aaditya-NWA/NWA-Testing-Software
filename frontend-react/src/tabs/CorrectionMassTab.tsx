/**
 * Correction Mass Validation — single-plane balancing from uploaded CSVs.
 *
 * Takes a baseline run and a trial run with a known mass at a known angle, and
 * computes the correction mass and the angle to place it at. Offline: no
 * Arduino connection is used or needed.
 *
 * Both runs must be recorded at the same throttle and RPM; comparing runs at
 * different speeds produces a confident-looking number that is wrong.
 */
import React, { useState } from "react";
import {
  parseCSV, computeAmpPhase, calcCorrection, RunResult, CorrectionResult,
} from "../lib/balancing";

// ── Polar diagram SVG ─────────────────────────────────────────────────────────
function PolarDiagram({ initial, trial, correction }: {
  initial: RunResult | null;
  trial: RunResult | null;
  correction: CorrectionResult | null;
}) {
  const cx = 110; const cy = 110; const r = 85;

  function vecEnd(amp: number, deg: number, scale: number): [number, number] {
    const rad = ((deg - 90) * Math.PI) / 180;
    const len = Math.min(amp * scale, r);
    return [cx + len * Math.sin(rad + Math.PI / 2), cy - len * Math.cos(rad + Math.PI / 2)];
  }

  // compute scale from max amplitude
  const maxAmp = Math.max(
    initial?.amp ?? 0,
    trial?.amp ?? 0,
    correction ? correction.unbalance_gmm / 1000 : 0,
    0.001
  );
  const scale = (r * 0.85) / maxAmp;

  const rings = [0.25, 0.5, 0.75, 1.0];

  return (
    <svg viewBox="0 0 220 220" style={{ width: "100%", maxWidth: 240 }}>
      {/* rings */}
      {rings.map((f) => (
        <circle key={f} cx={cx} cy={cy} r={r * f}
          fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="1" />
      ))}
      {/* axes */}
      {[0, 45, 90, 135].map((a) => {
        const rad = (a * Math.PI) / 180;
        return (
          <line key={a}
            x1={cx - r * Math.cos(rad)} y1={cy - r * Math.sin(rad)}
            x2={cx + r * Math.cos(rad)} y2={cy + r * Math.sin(rad)}
            stroke="rgba(255,255,255,0.07)" strokeWidth="1" />
        );
      })}
      {/* degree labels */}
      {[0, 90, 180, 270].map((a) => {
        const rad = ((a - 90) * Math.PI) / 180;
        const tx = cx + (r + 12) * Math.cos(rad);
        const ty = cy + (r + 12) * Math.sin(rad);
        return (
          <text key={a} x={tx} y={ty} textAnchor="middle" dominantBaseline="middle"
            fill="rgba(255,255,255,0.3)" fontSize="8" fontFamily="'JetBrains Mono', monospace">
            {a}°
          </text>
        );
      })}
      {/* Initial vector */}
      {initial && (() => {
        const [ex, ey] = vecEnd(initial.amp, initial.phase, scale);
        return (
          <>
            <line x1={cx} y1={cy} x2={ex} y2={ey} stroke="#7df3ff" strokeWidth="2" strokeLinecap="round" />
            <circle cx={ex} cy={ey} r={4} fill="#7df3ff" />
            <text x={ex + 6} y={ey - 4} fill="#7df3ff" fontSize="8" fontFamily="'JetBrains Mono', monospace">A</text>
          </>
        );
      })()}
      {/* Trial vector */}
      {trial && (() => {
        const [ex, ey] = vecEnd(trial.amp, trial.phase, scale);
        return (
          <>
            <line x1={cx} y1={cy} x2={ex} y2={ey} stroke="#f5a623" strokeWidth="2" strokeLinecap="round" />
            <circle cx={ex} cy={ey} r={4} fill="#f5a623" />
            <text x={ex + 6} y={ey - 4} fill="#f5a623" fontSize="8" fontFamily="'JetBrains Mono', monospace">B</text>
          </>
        );
      })()}
      {/* Correction vector */}
      {correction && (() => {
        const [ex, ey] = vecEnd(correction.mass_g * 0.01, correction.angle_deg, scale * 50);
        return (
          <>
            <line x1={cx} y1={cy} x2={ex} y2={ey} stroke="#00ff99" strokeWidth="2.5"
              strokeLinecap="round" strokeDasharray="6 3" />
            <circle cx={ex} cy={ey} r={4} fill="#00ff99" />
            <text x={ex + 6} y={ey - 4} fill="#00ff99" fontSize="8" fontFamily="'JetBrains Mono', monospace">C</text>
          </>
        );
      })()}
      {/* center dot */}
      <circle cx={cx} cy={cy} r={3} fill="rgba(255,255,255,0.4)" />
    </svg>
  );
}

// ── CSV Upload + compute panel ────────────────────────────────────────────────
function CsvRunPanel({
  label,
  color,
  result,
  onResult,
  targetRpm,
  rpmTol,
}: {
  label: string;
  color: string;
  result: RunResult | null;
  onResult: (r: RunResult | null, err: string | null) => void;
  targetRpm: number;
  rpmTol: number;
}) {
  const [fileName, setFileName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setError(null);
    onResult(null, null);

    try {
      const text = await file.text();
      const parsed = parseCSV(text);
      const res = computeAmpPhase(parsed, targetRpm, rpmTol);
      onResult(res, null);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      onResult(null, msg);
    }
  };

  return (
    <div className="csv-run-panel" style={{ borderColor: color + "44" }}>
      <div className="csv-run-label" style={{ color }}>{label}</div>

      <label className="csv-upload-btn" style={{ borderColor: color + "88", color }}>
        <span>⬆ Upload CSV</span>
        <input type="file" accept=".csv" onChange={handleFile} style={{ display: "none" }} />
      </label>

      {fileName && (
        <div className="csv-filename">📄 {fileName}</div>
      )}

      {error && (
        <div className="csv-error">⚠ {error}</div>
      )}

      {result && (
        <div className="csv-result">
          <div className="csv-result-row">
            <span className="csv-result-key">Amplitude</span>
            <span className="csv-result-val" style={{ color }}>{result.amp.toFixed(5)} g</span>
          </div>
          <div className="csv-result-row">
            <span className="csv-result-key">Phase</span>
            <span className="csv-result-val" style={{ color }}>{result.phase.toFixed(2)}°</span>
          </div>
          <div className="csv-result-row">
            <span className="csv-result-key">Samples</span>
            <span className="csv-result-val" style={{ color: "rgba(255,255,255,0.4)" }}>{result.sampleCount}</span>
          </div>
        </div>
      )}
    </div>
  );
}

export default function CorrectionMassTab() {
  // RPM gating params
  const [targetRpm, setTargetRpm] = useState(2500);
  const [rpmTol, setRpmTol]       = useState(100);

  // Run results from CSV
  const [initialResult, setInitialResult] = useState<RunResult | null>(null);
  const [trialResult, setTrialResult]     = useState<RunResult | null>(null);

  // Trial mass inputs
  const [trialMass, setTrialMass]       = useState(5.0);
  const [trialAngle, setTrialAngle]     = useState(0.0);
  const [trialRadius, setTrialRadius]   = useState(50.0);
  const [corrRadius, setCorrRadius]     = useState(50.0);

  // Output
  const [correction, setCorrection]   = useState<CorrectionResult | null>(null);
  const [calcError, setCalcError]     = useState<string | null>(null);

  const canCalculate = initialResult !== null && trialResult !== null;

  const handleCalculate = () => {
    setCalcError(null);
    setCorrection(null);
    try {
      const res = calcCorrection(
        initialResult!,
        trialResult!,
        trialMass,
        trialAngle,
        trialRadius,
        corrRadius
      );
      setCorrection(res);
    } catch (err: unknown) {
      setCalcError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleReset = () => {
    setInitialResult(null);
    setTrialResult(null);
    setCorrection(null);
    setCalcError(null);
  };

  return (
    <div className="tab2-layout">

      {/* ── Left: Inputs ── */}
      <div className="tab2-left">

        {/* RPM Gate */}
        <section className="panel">
          <h3 className="panel-title">RPM GATE</h3>
          <div className="t2-field-row">
            <div className="t2-field">
              <label className="field-label">TARGET RPM</label>
              <input className="t2-input" type="number" min={0} max={20000} step={100}
                value={targetRpm} onChange={(e) => {
                  setTargetRpm(Number(e.target.value));
                  setInitialResult(null); setTrialResult(null); setCorrection(null);
                }} />
            </div>
            <div className="t2-field">
              <label className="field-label">TOLERANCE ±</label>
              <input className="t2-input" type="number" min={1} max={500} step={10}
                value={rpmTol} onChange={(e) => {
                  setRpmTol(Number(e.target.value));
                  setInitialResult(null); setTrialResult(null); setCorrection(null);
                }} />
            </div>
          </div>
          <div className="rpm-gate-hint">
            Gating: {targetRpm - rpmTol} – {targetRpm + rpmTol} RPM
          </div>
        </section>

        {/* CSV uploads */}
        <section className="panel">
          <h3 className="panel-title">RUN DATA</h3>
          <CsvRunPanel
            label="INITIAL RUN"
            color="#7df3ff"
            result={initialResult}
            onResult={(r) => { setInitialResult(r); setCorrection(null); }}
            targetRpm={targetRpm}
            rpmTol={rpmTol}
          />
          <div style={{ height: 10 }} />
          <CsvRunPanel
            label="TRIAL RUN"
            color="#f5a623"
            result={trialResult}
            onResult={(r) => { setTrialResult(r); setCorrection(null); }}
            targetRpm={targetRpm}
            rpmTol={rpmTol}
          />
        </section>

        {/* Trial mass params */}
        <section className="panel">
          <h3 className="panel-title">TRIAL MASS</h3>
          <div className="t2-field-row">
            <div className="t2-field">
              <label className="field-label">MASS (g)</label>
              <input className="t2-input" type="number" min={0.01} step={0.1}
                value={trialMass} onChange={(e) => { setTrialMass(Number(e.target.value)); setCorrection(null); }} />
            </div>
            <div className="t2-field">
              <label className="field-label">ANGLE (°)</label>
              <input className="t2-input" type="number" min={0} max={360} step={1}
                value={trialAngle} onChange={(e) => { setTrialAngle(Number(e.target.value)); setCorrection(null); }} />
            </div>
          </div>
          <div className="t2-field" style={{ marginTop: 8 }}>
            <label className="field-label">TRIAL RADIUS (mm)</label>
            <input className="t2-input" type="number" min={1} step={1}
              value={trialRadius} onChange={(e) => { setTrialRadius(Number(e.target.value)); setCorrection(null); }} />
          </div>
        </section>

        {/* Correction radius */}
        <section className="panel">
          <h3 className="panel-title">CORRECTION PLACEMENT</h3>
          <div className="t2-field">
            <label className="field-label">CORRECTION RADIUS (mm)</label>
            <input className="t2-input" type="number" min={1} step={1}
              value={corrRadius} onChange={(e) => { setCorrRadius(Number(e.target.value)); setCorrection(null); }} />
          </div>
        </section>

        {/* Calculate button */}
        <div style={{ display: "flex", gap: 8 }}>
          <button
            className="btn btn-connect"
            style={{ flex: 1, opacity: canCalculate ? 1 : 0.4, cursor: canCalculate ? "pointer" : "not-allowed" }}
            onClick={handleCalculate}
            disabled={!canCalculate}
          >
            ⚙ CALCULATE
          </button>
          <button className="btn btn-disconnect" onClick={handleReset}>
            ↺ RESET
          </button>
        </div>

        {calcError && (
          <div className="csv-error" style={{ marginTop: 8 }}>⚠ {calcError}</div>
        )}
      </div>

      {/* ── Right: Results ── */}
      <div className="tab2-right">

        {/* Polar diagram */}
        <section className="panel" style={{ textAlign: "center" }}>
          <h3 className="panel-title">VECTOR DIAGRAM</h3>
          <div style={{ display: "flex", justifyContent: "center" }}>
            <PolarDiagram initial={initialResult} trial={trialResult} correction={correction} />
          </div>
          <div className="polar-legend">
            <span style={{ color: "#7df3ff" }}>● A — Initial</span>
            <span style={{ color: "#f5a623" }}>● B — Trial</span>
            <span style={{ color: "#00ff99" }}>● C — Correction</span>
          </div>
        </section>

        {/* Correction result */}
        <section className="panel">
          <h3 className="panel-title">CORRECTION MASS</h3>

          {!correction && !calcError && (
            <div className="t2-empty">
              {canCalculate
                ? "Press CALCULATE to compute correction"
                : "Upload both Initial and Trial CSV files first"}
            </div>
          )}

          {correction && (
            <>
              <div className="corr-result-grid">
                <div className="corr-card" style={{ borderColor: "#00ff9944" }}>
                  <div className="corr-card-label">ADD MASS</div>
                  <div className="corr-card-value" style={{ color: "#00ff99" }}>
                    {correction.mass_g.toFixed(3)}
                    <span className="corr-card-unit">g</span>
                  </div>
                </div>
                <div className="corr-card" style={{ borderColor: "#ff6b9d44" }}>
                  <div className="corr-card-label">AT ANGLE</div>
                  <div className="corr-card-value" style={{ color: "#ff6b9d" }}>
                    {correction.angle_deg.toFixed(1)}
                    <span className="corr-card-unit">°</span>
                  </div>
                </div>
                <div className="corr-card" style={{ borderColor: "#7df3ff44" }}>
                  <div className="corr-card-label">AT RADIUS</div>
                  <div className="corr-card-value" style={{ color: "#7df3ff" }}>
                    {correction.radius_mm.toFixed(0)}
                    <span className="corr-card-unit">mm</span>
                  </div>
                </div>
                <div className="corr-card" style={{ borderColor: "#f5a62344" }}>
                  <div className="corr-card-label">UNBALANCE</div>
                  <div className="corr-card-value" style={{ color: "#f5a623" }}>
                    {correction.unbalance_gmm.toFixed(2)}
                    <span className="corr-card-unit">g·mm</span>
                  </div>
                </div>
              </div>

              {/* Summary box */}
              <div className="corr-summary">
                <div className="corr-summary-title">INSTRUCTION</div>
                <div className="corr-summary-text">
                  Add <strong style={{ color: "#00ff99" }}>{correction.mass_g.toFixed(3)} g</strong> at{" "}
                  <strong style={{ color: "#ff6b9d" }}>{correction.angle_deg.toFixed(1)}°</strong> at a radius of{" "}
                  <strong style={{ color: "#7df3ff" }}>{correction.radius_mm.toFixed(0)} mm</strong> from center
                </div>
              </div>

              {/* Input summary */}
              <div className="corr-inputs-summary">
                <div className="panel-title" style={{ marginBottom: 8 }}>INPUTS USED</div>
                <div className="corr-input-row">
                  <span style={{ color: "#7df3ff" }}>Initial</span>
                  <span>{initialResult!.amp.toFixed(5)} g @ {initialResult!.phase.toFixed(2)}° ({initialResult!.sampleCount} samples)</span>
                </div>
                <div className="corr-input-row">
                  <span style={{ color: "#f5a623" }}>Trial</span>
                  <span>{trialResult!.amp.toFixed(5)} g @ {trialResult!.phase.toFixed(2)}° ({trialResult!.sampleCount} samples)</span>
                </div>
                <div className="corr-input-row">
                  <span>Trial mass</span>
                  <span>{trialMass} g @ {trialAngle}° R={trialRadius} mm</span>
                </div>
                <div className="corr-input-row">
                  <span>RPM gate</span>
                  <span>{targetRpm} ± {rpmTol} RPM</span>
                </div>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
