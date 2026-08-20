/**
 * Control — live telemetry and motor control. One of the two tabs that talk to
 * the Arduino; the connection itself is owned by ConnectionProvider above the
 * tabs, so this tab holds only the throttle it commands and the tests it runs.
 *
 * Throttle is entered as a PERCENTAGE of the loaded configuration. Conversion
 * to microseconds happens only at the API boundary (see lib/throttle.ts); the
 * wire protocol, active_profile validation and the CSV all stay in µs.
 *
 * Auto Test takes no input: the firmware sweeps its own confirmed range. Step
 * Test SINGLE calls /start_throttle_hold unchanged; MULTIPLE hands a list to
 * /start_step_test, which the backend drives host-side because the firmware's
 * THROTTLE_HOLD resets to THR_MIN on every invocation and cannot be chained.
 *
 * Logging is test-owned: a run opens a CSV if none is open and closes it when
 * the run ends. A log opened by hand is left alone in both directions.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../hooks/useApi";
import { useWebSocket } from "../hooks/useWebSocket";
import { useConnection } from "../context/connection";
import { pctToUs, usToPct, pctError, PCT_STEP } from "../lib/throttle";

import { Gauge, ValRow, LogRow } from "../components/Readouts";

export type StepTestMode = "single" | "multiple";

export interface TestStep {
  /** Percent of the loaded configuration's range, not µs. */
  target: number;
  /** Seconds; converted to hold_ms at the API boundary. */
  hold: number;
}

interface StepTestStatus {
  running: boolean;
  current_step: number;
  total_steps: number;
  target_us: number | null;
  phase: string;
  message: string | null;
}

/** Capped on the backend too; this is only what "+" will build. */
const MAX_STEPS = 20;

const stepHoldError = (hold: number): string | null => {
  if (!Number.isFinite(hold) || hold <= 0) return "Hold must be greater than 0 s";
  return null;
};

export default function ControlTab() {
  const {
    connected, motorProfile, logging, setLogging, logFile, setLogFile,
  } = useConnection();

  const [throttlePct, setThrottlePct] = useState(0);
  const [csvFilename, setCsvFilename] = useState("");
  const [autoTestRunning, setAutoTestRunning] = useState(false);

  const [throttleHoldRunning, setThrottleHoldRunning] = useState(false);
  const [throttleHoldTarget, setThrottleHoldTarget] = useState(50);   // %
  const [throttleHoldTime, setThrottleHoldTime] = useState(30);

  const [stepTestMode, setStepTestMode] = useState<StepTestMode>("single");
  const [steps, setSteps] = useState<TestStep[]>([{ target: 50, hold: 30 }]);
  const [stepTestRunning, setStepTestRunning] = useState(false);
  const [stepTestStatus, setStepTestStatus] = useState<StepTestStatus | null>(null);

  const lastSendRef    = useRef(0);
  const tableScrollRef = useRef<HTMLDivElement>(null);
  const autoScrollRef  = useRef(true);
  const { data, history } = useWebSocket(connected);

  const autoLogRef = useRef(false);
  const holdLiftedRef = useRef(false);

  useEffect(() => {
    if (autoScrollRef.current && tableScrollRef.current) {
      tableScrollRef.current.scrollTop = tableScrollRef.current.scrollHeight;
    }
  }, [history]);

  const startLogForTest = async () => {
    const status = await api.getStatus();
    if (status.logging) {
      setLogging(true);
      setLogFile(status.log_file || null);
      autoLogRef.current = false;   // already open — not ours to close
      return;
    }
    const r = await api.startLogging(csvFilename || undefined);
    setLogging(true);
    setLogFile(r.file || null);
    autoLogRef.current = true;
  };

  const stopLogIfAuto = useCallback(async () => {
    if (!autoLogRef.current) return;
    autoLogRef.current = false;
    await api.stopLogging();
    setLogging(false);
  }, []);

  useEffect(() => {
    if (!data) return;
    // [FIX v10] Latch that the throttle actually left idle before the
    // return-to-idle can be read as "finished" — see holdLiftedRef.
    if (data.throttle > motorProfile.thrMin) {
      holdLiftedRef.current = true;
      return;
    }
    if (!holdLiftedRef.current) return;
    if (throttleHoldRunning) {
      setThrottleHoldRunning(false);
      holdLiftedRef.current = false;
      // [NEW v10] One-button operation: the run that opened the log
      // closes it again, so a Single-mode Step Test is Run -> walk away.
      void stopLogIfAuto();
    }
    if (autoTestRunning) {
      setAutoTestRunning(false);
      holdLiftedRef.current = false;
      void stopLogIfAuto();
    }
  }, [data?.throttle, motorProfile.thrMin]);

  useEffect(() => {
    if (connected) return;
    setAutoTestRunning(false);
    setThrottleHoldRunning(false);
    setStepTestRunning(false);
    holdLiftedRef.current = false;
  }, [connected]);

  const handleThrottle = useCallback(async (pctVal: number) => {
    setThrottlePct(pctVal);
    const now = Date.now();
    if (now - lastSendRef.current < 50) return;
    lastSendRef.current = now;
    await api.setThrottle(pctToUs(pctVal, motorProfile));
  }, [motorProfile]);

  const handleEStop = async () => {
    setThrottlePct(0);
    setAutoTestRunning(false);
    setThrottleHoldRunning(false);
    setStepTestRunning(false);
    await api.emergencyStop();
    await api.stopAutoTest();
    await api.stopThrottleHold();
    // An E-Stop ends the run, so the log that run opened is closed with it.
    await stopLogIfAuto();
  };

  const handleLogging = async () => {
    if (logging) {
      await api.stopLogging();
      setLogging(false);
      autoLogRef.current = false;
    } else {
      const r = await api.startLogging(csvFilename || undefined);
      setLogging(true);
      setLogFile(r.file || null);
      // Opened by hand — a test finishing must not close it.
      autoLogRef.current = false;
    }
  };

  const handleStartAutoTest = async () => {
    if (!connected) return;
    setAutoTestRunning(true);
    setThrottleHoldRunning(false);
    setStepTestRunning(false);
    holdLiftedRef.current = false;
    await startLogForTest();
    await api.startAutoTest();
  };

  const handleStopAutoTest = async () => {
    setAutoTestRunning(false);
    holdLiftedRef.current = false;
    await api.stopAutoTest();
    await stopLogIfAuto();
  };

  // [NEW] RPM Hold handlers
  const handleStartThrottleHold = async () => {
    if (!connected || !singleValid) return;
    setThrottleHoldRunning(true);
    setAutoTestRunning(false);
    holdLiftedRef.current = false;
    await startLogForTest();
    // [CHANGED v13] Percent in the UI, microseconds on the wire. The
    // conversion happens here and nowhere else on this path.
    await api.startThrottleHold(
      pctToUs(throttleHoldTarget, motorProfile), throttleHoldTime * 1000
    );
  };

  const handleStopThrottleHold = async () => {
    setThrottleHoldRunning(false);
    holdLiftedRef.current = false;
    await api.stopThrottleHold();
    await stopLogIfAuto();
  };

  // ── [NEW v10] Step Test — MULTIPLE mode ────────────────────────────────
  const addStep = () => setSteps(s =>
    s.length >= MAX_STEPS ? s : [...s, { ...s[s.length - 1] }]
  );

  // Always keeps at least one step — the "×" button is hidden at length 1,
  // but guard here too so the invariant does not depend on the render.
  const removeStep = (i: number) =>
    setSteps(s => (s.length <= 1 ? s : s.filter((_, idx) => idx !== i)));

  const updateStep = (i: number, patch: Partial<TestStep>) =>
    setSteps(s => s.map((st, idx) => (idx === i ? { ...st, ...patch } : st)));

  const handleStartStepTest = async () => {
    if (!connected || !stepsValid) return;
    setStepTestRunning(true);
    setAutoTestRunning(false);
    setThrottleHoldRunning(false);
    setStepTestStatus(null);
    await startLogForTest();
    // [CHANGED v13] Same boundary conversion as Single mode above.
    const r = await api.startStepTest(
      steps.map(s => ({
        target_us: pctToUs(s.target, motorProfile),
        hold_ms: Math.round(s.hold * 1000),
      }))
    );
    // The backend re-validates; if it refuses, don't leave the UI claiming
    // a test is running when no motor command was ever sent.
    if (r.status !== "step_test_started") {
      setStepTestRunning(false);
      setStepTestStatus({
        running: false, current_step: 0, total_steps: steps.length,
        target_us: null, phase: "error", message: r.message || "Step test rejected.",
      });
      await stopLogIfAuto();   // nothing ran, so don't leave a log open
    }
  };

  const handleStopStepTest = async () => {
    setStepTestRunning(false);
    await api.stopStepTest();
    await stopLogIfAuto();
  };

  useEffect(() => {
    if (!stepTestRunning) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const s: StepTestStatus = await api.getStepTestStatus();
        if (cancelled) return;
        setStepTestStatus(s);
        if (!s.running) {
          setStepTestRunning(false);
          // Sequence ended on its own — close the log this run opened.
          void stopLogIfAuto();
        }
      } catch { /* backend not reachable — leave state alone */ }
    };
    poll();
    const t = setInterval(poll, 500);
    return () => { cancelled = true; clearInterval(t); };
  }, [stepTestRunning]);

  const singleTargetError = pctError(throttleHoldTarget);
  const singleHoldError   = stepHoldError(throttleHoldTime);
  const singleValid       = !singleTargetError && !singleHoldError;

  const stepErrors = steps.map(s => ({
    target: pctError(s.target),
    hold:   stepHoldError(s.hold),
  }));
  const stepsValid = stepErrors.every(e => !e.target && !e.hold);

  // Anything that must not run while the motor is under automatic control.
  const stepTestBusy = throttleHoldRunning || stepTestRunning;

  const throttleColor = throttlePct > 75 ? "#ff4444" : throttlePct > 40 ? "#f5a623" : "#00ff99";

  return (
    <div className="layout">
      {/* ════ LEFT SIDEBAR ════ */}
      {/* [CHANGED v13] The CONNECTION and MOTOR panels that used to sit here
          are gone — they are the connection bar above the tabs now, shared
          with Configure New Motor. What remains is the range this tab's
          percentages are computed against, which is worth keeping in view
          because every throttle number below is relative to it. */}
      <aside className="sidebar">

        <section className="panel">
          <h3 className="panel-title">ACTIVE RANGE</h3>
          <div className="range-line">
            <span className="range-label">{motorProfile.label}</span>
          </div>
          <div className="range-line range-muted">
            0% = {motorProfile.thrMin} µs · 100% = {motorProfile.thrMax} µs
          </div>
        </section>

        <div className="gauges-grid">
          <Gauge value={data?.rpm ?? 0}                                                   max={motorProfile.rpmGaugeMax} label="RPM"      unit="rpm" color="#00ff99" />
          <Gauge value={data?.throttle ? usToPct(data.throttle, motorProfile) : 0}          max={100}   label="THROTTLE" unit="%"   color="#f5a623" />
          <Gauge value={data ? Math.abs(data.accZ) : 0}                                   max={4}     label="ACC Z"    unit="g"   color="#7df3ff" />
          <Gauge value={data ? Math.sqrt(data.vibX**2 + data.vibY**2 + data.vibZ**2) : 0} max={1}     label="VIB MAG"  unit="g"   color="#ff6b9d" />
        </div>

        <div className="panel data-panel">
          <div className="val-header">
            <span className="val-label" style={{ color: "var(--muted)" }}>SENSOR</span>
            <span className="val-col-head">X</span>
            <span className="val-col-head">Y</span>
            <span className="val-col-head">Z</span>
          </div>
          <ValRow label="ACC (g)" x={data?.accX} y={data?.accY} z={data?.accZ} color="#7df3ff" />
          <ValRow label="VIB (g)" x={data?.vibX} y={data?.vibY} z={data?.vibZ} color="#ff6b9d" />
          <div className="val-row val-row-single">
            <span className="val-label" style={{ color: "#00ff99" }}>RPM</span>
            <span className="val-num rpm-big">{data?.rpm.toFixed(0) ?? "—"}</span>
          </div>
          <div className="val-row val-row-single">
            <span className="val-label" style={{ color: "#f5a623" }}>THR</span>
            <span className="val-num">{data?.throttle ?? "—"} µs</span>
          </div>
        </div>

        {/* AUTO TEST */}
        <section className="panel">
          <h3 className="panel-title">AUTO THROTTLE TEST</h3>
          <div style={{ fontSize: 10, color: "#666", marginBottom: 8, lineHeight: 1.5 }}>
            0→100% in 70s with pauses · 100→0% in 15s
          </div>
          <div className="btn-row">
            <button className="btn btn-start-log" onClick={handleStartAutoTest}
              disabled={!connected || autoTestRunning || stepTestBusy} style={{ flex: 1 }}>
              ▶ START AUTO TEST
            </button>
          </div>
          <div className="btn-row">
            <button className="btn btn-stop-log" onClick={handleStopAutoTest}
              disabled={!connected || !autoTestRunning} style={{ flex: 1 }}>
              ■ STOP AUTO TEST
            </button>
          </div>
          {autoTestRunning && (
            <div style={{ fontSize: 10, color: "#ff8c00", textAlign: "center", marginTop: 4 }}>
              Auto test running…
            </div>
          )}
        </section>

        {/* [RENAMED v10] THROTTLE HOLD -> STEP TEST.
            SINGLE is the original feature, byte-for-byte the same request
            to /start_throttle_hold. MULTIPLE adds the step sequence. */}
        <section className="panel">
          <h3 className="panel-title">STEP TEST</h3>
          <div style={{ fontSize: 10, color: "#666", marginBottom: 8, lineHeight: 1.5 }}>
            Ramp to a target throttle %, hold, then ramp down.
          </div>

          <label className="field-label">TEST TYPE</label>
          <div className="st-mode-row">
            {(["single", "multiple"] as StepTestMode[]).map(m => (
              <label key={m} className="st-radio">
                <input type="radio" name="stepTestMode" value={m}
                  checked={stepTestMode === m}
                  onChange={() => setStepTestMode(m)}
                  disabled={stepTestBusy} />
                <span>{m === "single" ? "SINGLE" : "MULTIPLE"}</span>
              </label>
            ))}
          </div>

          {stepTestMode === "single" ? (
            <>
              <div className="t2-field-row">
                <div className="t2-field">
                  <label className="field-label">TARGET (%)</label>
                  <input className={`t2-input${singleTargetError ? " st-invalid" : ""}`}
                    type="number" min={0} max={100} step={PCT_STEP}
                    value={throttleHoldTarget}
                    onChange={e => setThrottleHoldTarget(Number(e.target.value))}
                    disabled={throttleHoldRunning} />
                  {/* The resolved µs is always shown beside the percentage so
                      the operator can reconcile it with Configure New Motor
                      and with a logged CSV, both of which speak µs. */}
                  <div className="us-hint">
                    = {pctToUs(throttleHoldTarget, motorProfile)} µs
                  </div>
                </div>
                <div className="t2-field">
                  <label className="field-label">HOLD (s)</label>
                  <input className={`t2-input${singleHoldError ? " st-invalid" : ""}`}
                    type="number" min={1} max={300} step={1}
                    value={throttleHoldTime}
                    onChange={e => setThrottleHoldTime(Number(e.target.value))}
                    disabled={throttleHoldRunning} />
                </div>
              </div>
              {(singleTargetError || singleHoldError) && (
                <div className="st-error">{singleTargetError || singleHoldError}</div>
              )}
              <div className="btn-row" style={{ marginTop: 8 }}>
                <button className="btn btn-start-log"
                  onClick={handleStartThrottleHold}
                  disabled={!connected || throttleHoldRunning || autoTestRunning || !singleValid}
                  style={{ flex: 1 }}>
                  ▶ RUN STEP TEST
                </button>
              </div>
              <div className="btn-row">
                <button className="btn btn-stop-log"
                  onClick={handleStopThrottleHold}
                  disabled={!connected || !throttleHoldRunning}
                  style={{ flex: 1 }}>
                  ■ STOP STEP TEST
                </button>
              </div>
              {throttleHoldRunning && (
                <div style={{ fontSize: 10, color: "#00ff99", textAlign: "center", marginTop: 4 }}>
                  Holding at {throttleHoldTarget}% ({pctToUs(throttleHoldTarget, motorProfile)} µs)…
                </div>
              )}
            </>
          ) : (
            <>
              {steps.map((s, i) => (
                <div key={i} className="st-step">
                  <div className="st-step-head">
                    <span className="st-step-label">STEP {i + 1}</span>
                    {steps.length > 1 && (
                      <button className="st-step-del" type="button"
                        title={`Remove step ${i + 1}`}
                        onClick={() => removeStep(i)}
                        disabled={stepTestBusy}>×</button>
                    )}
                  </div>
                  <div className="t2-field-row">
                    <div className="t2-field">
                      <label className="field-label">TARGET (%)</label>
                      <input className={`t2-input${stepErrors[i].target ? " st-invalid" : ""}`}
                        type="number" min={0} max={100} step={PCT_STEP}
                        value={s.target}
                        onChange={e => updateStep(i, { target: Number(e.target.value) })}
                        disabled={stepTestBusy} />
                      <div className="us-hint">= {pctToUs(s.target, motorProfile)} µs</div>
                    </div>
                    <div className="t2-field">
                      <label className="field-label">HOLD (s)</label>
                      <input className={`t2-input${stepErrors[i].hold ? " st-invalid" : ""}`}
                        type="number" min={1} max={300} step={1}
                        value={s.hold}
                        onChange={e => updateStep(i, { hold: Number(e.target.value) })}
                        disabled={stepTestBusy} />
                    </div>
                  </div>
                  {(stepErrors[i].target || stepErrors[i].hold) && (
                    <div className="st-error">{stepErrors[i].target || stepErrors[i].hold}</div>
                  )}
                </div>
              ))}

              <button className="st-add" type="button" onClick={addStep}
                disabled={stepTestBusy || steps.length >= MAX_STEPS}>
                + ADD STEP
              </button>

              <div className="btn-row" style={{ marginTop: 8 }}>
                <button className="btn btn-start-log"
                  onClick={handleStartStepTest}
                  disabled={!connected || stepTestBusy || autoTestRunning || !stepsValid}
                  style={{ flex: 1 }}>
                  ▶ RUN STEP TEST
                </button>
              </div>
              <div className="btn-row">
                <button className="btn btn-stop-log"
                  onClick={handleStopStepTest}
                  disabled={!connected || !stepTestRunning}
                  style={{ flex: 1 }}>
                  ■ STOP STEP TEST
                </button>
              </div>

              {stepTestRunning && stepTestStatus && stepTestStatus.current_step > 0 && (
                <div style={{ fontSize: 10, color: "#00ff99", textAlign: "center", marginTop: 4 }}>
                  Step {stepTestStatus.current_step}/{stepTestStatus.total_steps}
                  {stepTestStatus.target_us != null && ` — ${stepTestStatus.target_us} µs`}
                  {stepTestStatus.phase === "holding" ? " — holding…" : " — ramping…"}
                </div>
              )}
              {!stepTestRunning && stepTestStatus?.phase === "complete" && (
                <div style={{ fontSize: 10, color: "#00ff99", textAlign: "center", marginTop: 4 }}>
                  Sequence complete.
                </div>
              )}
              {stepTestStatus?.message && stepTestStatus.phase !== "complete" && (
                <div className="st-error" style={{ textAlign: "center" }}>
                  {stepTestStatus.message}
                </div>
              )}
            </>
          )}
        </section>

        {/* LOGGING */}
        <section className="panel">
          <h3 className="panel-title">DATA LOGGING</h3>
          <label className="field-label">CSV FILENAME (optional)</label>
          <input className="select" type="text" placeholder="Leave blank for IST timestamp"
            value={csvFilename} onChange={e => setCsvFilename(e.target.value)}
            disabled={logging} style={{ marginBottom: 8 }} />
          <button className={`btn ${logging ? "btn-stop-log" : "btn-start-log"}`}
            onClick={handleLogging} disabled={!connected}>
            {logging ? "■ STOP LOG" : "● START LOG"}
          </button>
          {logFile && (
            <div className="log-file">
              <span className="log-file-label">FILE</span>
              <span className="log-file-name">{logFile.split(/[\\\/]/).pop()}</span>
            </div>
          )}
        </section>

      </aside>

      {/* ════ RIGHT CONTENT ════ */}
      <main className="main">

        <section className="panel throttle-panel">
          <div className="throttle-top-row">
            <h3 className="panel-title" style={{ marginBottom: 0 }}>THROTTLE CONTROL</h3>
            <div className="throttle-readout">
              <span className="throttle-pct" style={{ color: throttleColor }}>
                {throttlePct}<span className="throttle-pct-unit">%</span>
              </span>
              <span className="throttle-sep">|</span>
              <span className="throttle-us">{pctToUs(throttlePct, motorProfile)} µs</span>
            </div>
          </div>

          <div className="slider-zone">
            <div className="slider-track-wrap">
              <div className="slider-fill-bg" />
              <div className="slider-fill-bar" style={{ width: `${throttlePct}%`, background: throttleColor }} />
              <input type="range" min={0} max={100} step={1} value={throttlePct}
                className="slider"
                disabled={!connected || autoTestRunning || stepTestBusy}
                onChange={e => handleThrottle(Number(e.target.value))} />
            </div>
            <div className="slider-ticks">
              {[0,10,20,30,40,50,60,70,80,90,100].map(t => (
                <div key={t} className="tick-item" style={{ left: `${t}%` }}>
                  <div className="tick-line" />
                  <span className="tick-label">{t}</span>
                </div>
              ))}
            </div>
          </div>

          <button className="estop" onClick={handleEStop} disabled={!connected}>
            ⬛ EMERGENCY STOP
          </button>
        </section>

        <section className="panel log-table-panel">
          <div className="log-table-toprow">
            <h3 className="panel-title" style={{ marginBottom: 0 }}>LIVE DATA LOG (IST)</h3>
            <div className="log-table-meta">
              <span className="log-row-count">{history.length} rows</span>
              <label className="autoscroll-label">
                <input type="checkbox" defaultChecked
                  onChange={e => { autoScrollRef.current = e.target.checked; }}
                  className="autoscroll-check" />
                auto-scroll
              </label>
            </div>
          </div>
          <div className="log-table-scroll" ref={tableScrollRef}>
            <table className="log-table">
              <thead>
                <tr>
                  <th className="log-th">TIME (IST)</th>
                  <th className="log-th" style={{ color: "#f5a623" }}>THR (µs)</th>
                  <th className="log-th" style={{ color: "#00ff99" }}>RPM</th>
                  <th className="log-th" style={{ color: "#7df3ff" }}>ACC X</th>
                  <th className="log-th" style={{ color: "#7df3ff" }}>ACC Y</th>
                  <th className="log-th" style={{ color: "#7df3ff" }}>ACC Z</th>
                  <th className="log-th" style={{ color: "#ff6b9d" }}>VIB X</th>
                  <th className="log-th" style={{ color: "#ff6b9d" }}>VIB Y</th>
                  <th className="log-th" style={{ color: "#ff6b9d" }}>VIB Z</th>
                </tr>
              </thead>
              <tbody>
                {history.length === 0 ? (
                  <tr><td colSpan={9} className="log-empty">
                    {connected ? "Waiting for data…" : "Connect to Arduino to see live data"}
                  </td></tr>
                ) : (
                  history.map(row => <LogRow key={row.__k} row={row} />)
                )}
              </tbody>
            </table>
          </div>
        </section>

      </main>
    </div>
  );
}
