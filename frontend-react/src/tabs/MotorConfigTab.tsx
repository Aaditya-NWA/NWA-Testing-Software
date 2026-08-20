// ═══════════════════════════════════════════════════════════
// CONFIGURE NEW MOTOR  (tab 2 of 4 as of v13; was tab 4) [NEW v11]
// ═══════════════════════════════════════════════════════════
//
// [CHANGED v13] Three things moved:
//
//   * Connection is shared. This tab no longer polls /status for its own
//     idea of "connected" and no longer tells the operator to go to the
//     Control tab to connect — the connection bar above the tabs is the one
//     Connect control, and useConnection() is where its state lives.
//
//   * Throttle here stays RAW MICROSECONDS, deliberately, while the Control
//     tab moved to percentages. This tab exists to DISCOVER a motor's range;
//     a percentage would be computed from the very range being measured.
//
//   * Deletion is a multi-select dialog, and configurations can no longer be
//     edited at all — recalibrate and save instead. See DeleteDialog below.
//
// WHAT THIS IS FOR
//   Mounting an unknown motor and finding the two numbers every other
//   feature depends on: the throttle at which it starts spinning, and the
//   highest throttle it should ever be commanded to. Before this tab that
//   was done by editing MOTOR_PROFILES in the source and rebuilding.
//
//   The measured spin-up point is NOT the profile's 0%. The profile's 0%
//   sits a little BELOW it (the "idle headroom" field), because 0% has to
//   actually stop the motor — if 0% were the spin-up point the motor would
//   idle at the bottom of every ramp instead of stopping. This is the
//   arithmetic behind the shipped U15II profile: spin-up 1080, 0% 1025.
//
// WHY IT NEEDS A "CALIBRATION MODE" AT ALL
//   The sweep has to reach throttle values OUTSIDE the loaded profile, and
//   both gates in the way are real, not incidental:
//
//     * the backend's /set_throttle refuses anything outside active_profile;
//     * the firmware's command handler SILENTLY IGNORES a throttle value
//       outside its own THR_MIN..THR_MAX (nwa_testing_software.ino,
//       the final `else` in handleCommand(): `if (val >= THR_MIN && val <=
//       THR_MAX)`). No error, no ack — the motor simply does not move.
//
//   So sweeping 1000–2000 on a profile configured 1165–1515 would appear
//   to work in the UI and do nothing on the bench over most of its travel.
//   Calibration mode therefore pushes the sweep range to the Arduino as a
//   real CONFIG (the same confirmed path /set_motor_profile always uses)
//   and puts the previous range back when the sweep ends. There is no
//   unvalidated throttle back door; the validation range is moved, openly,
//   and the UI says so the whole time it is moved.
//
// WHAT IT DOES NOT DO
//   It does not log CSV and does not run Auto Test or Step Test. A
//   calibration sweep is someone watching a motor and moving a slider —
//   the measurement is "when did it start turning", which no logged file
//   answers better than the operator's eyes.

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../hooks/useApi";
import { useWebSocket } from "../hooks/useWebSocket";
import {
  MotorProfile,
  ABS_MIN_US,
  ABS_MAX_US,
  deleteMotorProfiles,
  normaliseLabel,
  profileRangeError,
  saveMotorProfile,
  useMotorProfiles,
} from "../lib/motorProfiles";
import { useConnection } from "../context/connection";
import "../App.css";

const DEFAULT_CAL_MIN = 1000;
const DEFAULT_CAL_MAX = 2000;

// Default gap between the measured spin-up point and the profile's 0%.
// 55 µs is what the shipped U15II profile uses (1080 measured -> 1025).
const DEFAULT_HEADROOM_US = 55;

const TELEMETRY_STALE_MS = 1500;

const SWEEP_STEP_US = 5;

interface BackendStatus {
  connected: boolean;
  active_profile?: { thr_min: number; thr_max: number };
  confirmed_thr_min?: number | null;
  confirmed_thr_max?: number | null;
}

const numOrNull = (s: string): number | null => {
  if (s.trim() === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

export default function MotorConfigTab() {
  const profiles = useMotorProfiles();

  const { connected, confirmedRange, refreshFromBackend } = useConnection();

  const { data, wsConnected } = useWebSocket(connected);

  const lastSampleAt = useRef(0);
  useEffect(() => { if (data) lastSampleAt.current = Date.now(); }, [data]);

  // ── Calibration mode ──────────────────────────────────────────────────
  const [calMin, setCalMin] = useState(DEFAULT_CAL_MIN);
  const [calMax, setCalMax] = useState(DEFAULT_CAL_MAX);
  const [calActive, setCalActive] = useState(false);
  const [calBusy, setCalBusy] = useState(false);
  const [calError, setCalError] = useState<string | null>(null);
  const [calNote, setCalNote] = useState<string | null>(null);

  const restoreRef = useRef<{ min: number; max: number } | null>(null);
  // Mirrors calActive for the unmount cleanup, which cannot read state.
  const calActiveRef = useRef(false);
  useEffect(() => { calActiveRef.current = calActive; }, [calActive]);

  const [throttleUs, setThrottleUs] = useState(DEFAULT_CAL_MIN);
  const [throttleField, setThrottleField] = useState("");

  // ── Measurements ──────────────────────────────────────────────────────
  const [spinUpField, setSpinUpField] = useState("");
  const [maxField, setMaxField] = useState("");
  const [headroomField, setHeadroomField] = useState(String(DEFAULT_HEADROOM_US));
  const [thrMinOverride, setThrMinOverride] = useState<number | null>(null);
  const [gaugeField, setGaugeField] = useState("9000");
  const [label, setLabel] = useState("");
  const [peakRpm, setPeakRpm] = useState(0);
  const [fetchMsg, setFetchMsg] = useState<string | null>(null);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);

  useEffect(() => {
    if (data && data.rpm > peakRpm) setPeakRpm(data.rpm);
  }, [data?.rpm]);

  const lastSendRef = useRef(0);
  const trailingRef = useRef<number | null>(null);
  const trailingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const SEND_GAP_MS = 50;

  const sendThrottle = useCallback((us: number) => {
    const now = Date.now();
    const since = now - lastSendRef.current;
    if (since >= SEND_GAP_MS) {
      lastSendRef.current = now;
      void api.setThrottle(us);
      return;
    }
    trailingRef.current = us;
    if (trailingTimer.current) return;
    trailingTimer.current = setTimeout(() => {
      trailingTimer.current = null;
      const v = trailingRef.current;
      trailingRef.current = null;
      if (v == null) return;
      lastSendRef.current = Date.now();
      void api.setThrottle(v);
    }, SEND_GAP_MS - since);
  }, []);

  useEffect(() => () => {
    if (trailingTimer.current) clearTimeout(trailingTimer.current);
  }, []);

  const moveThrottle = (us: number) => {
    const v = Math.round(Math.min(calMax, Math.max(calMin, us)));
    setThrottleUs(v);
    sendThrottle(v);
  };

  // ── Enter / leave calibration ─────────────────────────────────────────
  const calRangeError = profileRangeError(calMin, calMax);

  const startCalibration = async () => {
    setCalError(null);
    setCalNote(null);
    if (calRangeError) { setCalError(calRangeError); return; }
    setCalBusy(true);
    try {
      const s: BackendStatus = await api.getStatus();
      if (!s.connected) {
        setCalError("Not connected. Use CONNECT at the top of the window first.");
        return;
      }
      const prev = s.active_profile;
      restoreRef.current =
        prev && !(prev.thr_min === calMin && prev.thr_max === calMax)
          ? { min: prev.thr_min, max: prev.thr_max }
          : null;

      const cfg = await api.setMotorProfile(calMin, calMax);
      if (!cfg.confirmed) {
        setCalError(cfg.message || "The Arduino did not confirm the calibration range.");
        return;
      }
      if (cfg.thr_min !== calMin || cfg.thr_max !== calMax) {
        setCalNote(`Arduino confirmed ${cfg.thr_min}–${cfg.thr_max} µs, not the requested ${calMin}–${calMax}. The slider follows what it confirmed.`);
        setCalMin(cfg.thr_min);
        setCalMax(cfg.thr_max);
      }
      setThrottleUs(cfg.thr_min);
      setPeakRpm(0);
      setCalActive(true);
      // The loaded range just moved — tell the provider so the Control tab
      // is not left believing the previous configuration is still active.
      void refreshFromBackend();
    } catch (e) {
      setCalError(e instanceof Error ? e.message : "Could not enter calibration mode.");
    } finally {
      setCalBusy(false);
    }
  };

  const endCalibration = useCallback(async (applyInstead?: { min: number; max: number }) => {
    try { await api.emergencyStop(); } catch { /* stopping is best-effort */ }
    const target = applyInstead ?? restoreRef.current;
    restoreRef.current = null;
    calActiveRef.current = false;
    if (target) {
      try { await api.setMotorProfile(target.min, target.max); } catch { /* reported below */ }
    }
    void refreshFromBackend();
    return target;
  }, [refreshFromBackend]);

  const exitCalibration = async () => {
    setCalBusy(true);
    setCalError(null);
    try {
      const target = await endCalibration();
      setCalActive(false);
      setThrottleUs(calMin);
      setCalNote(target
        ? `Calibration ended — the Arduino is back on ${target.min}–${target.max} µs.`
        : "Calibration ended.");
    } finally {
      setCalBusy(false);
    }
  };

  useEffect(() => () => {
    if (calActiveRef.current) void endCalibration();
  }, [endCalibration]);

  const handleEStop = async () => {
    setThrottleUs(calMin);
    await api.emergencyStop();
  };

  // ── FETCH — read the live commanded throttle ───────────────────────────
  const fetchLive = (into: (v: string) => void) => {
    setFetchMsg(null);
    if (!connected) {
      setFetchMsg("Not connected — type the value in instead.");
      return;
    }
    if (!data || Date.now() - lastSampleAt.current > TELEMETRY_STALE_MS) {
      setFetchMsg("No live telemetry — type the value in instead.");
      return;
    }
    into(String(data.throttle));
  };

  // ── Derived profile ───────────────────────────────────────────────────
  const spinUp   = numOrNull(spinUpField);
  const maxMeas  = numOrNull(maxField);
  const headroom = numOrNull(headroomField) ?? 0;
  const gaugeMax = numOrNull(gaugeField);

  const computedMin = spinUp != null ? Math.round(spinUp - headroom) : null;
  const thrMin = thrMinOverride ?? computedMin;
  const thrMax = maxMeas != null ? Math.round(maxMeas) : null;

  const nameTrimmed = label.trim();
  const clash = profiles.find(p => normaliseLabel(p.label) === normaliseLabel(nameTrimmed) && nameTrimmed !== "");
  const clashIsBuiltin = !!clash && !clash.custom;

  const formError: string | null =
    !nameTrimmed                       ? "Enter a motor name."
    : clashIsBuiltin                   ? `"${clash!.label}" is a built-in profile and cannot be replaced. Use a different name.`
    : spinUp == null                   ? "Fetch or enter the minimum (spin-up) throttle."
    : maxMeas == null                  ? "Fetch or enter the maximum throttle."
    : thrMin == null                   ? "0% throttle could not be computed."
    : gaugeMax == null                 ? "Enter a max RPM for the gauge."
    : profileRangeError(thrMin, thrMax!)
      ?? (spinUp > maxMeas ? "Minimum throttle must be below maximum throttle." : null)
      ?? (thrMin > spinUp ? "0% throttle must be at or below the spin-up throttle — the motor has to be able to stop." : null)
      ?? (gaugeMax < 100 || gaugeMax > 60000 ? "Max RPM must be 100–60000." : null);

  const handleConfigure = async () => {
    setSaveErr(null);
    setSaveMsg(null);
    if (formError) { setSaveErr(formError); return; }
    setCalBusy(true);
    try {
      const saved = await saveMotorProfile({
        label: nameTrimmed,
        thrMin: thrMin!,
        thrMax: thrMax!,
        rpmGaugeMax: Math.round(gaugeMax!),
        spinUpUs: spinUp,
        maxMeasuredUs: maxMeas,
        id: clash?.custom ? clash.id : undefined,
        overwrite: !!clash?.custom,
      });

      if (calActive && connected) {
        await endCalibration({ min: saved.thrMin, max: saved.thrMax });
        setCalActive(false);
        setThrottleUs(saved.thrMin);
        setSaveMsg(`Saved "${saved.label}" (${saved.thrMin}–${saved.thrMax} µs) and loaded it on the Arduino. It is now selected on the CONTROL tab.`);
      } else {
        setSaveMsg(`Saved "${saved.label}" (${saved.thrMin}–${saved.thrMax} µs). Select it on the CONTROL tab and connect to use it.`);
      }
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : "Could not save the motor profile.");
    } finally {
      setCalBusy(false);
    }
  };

  const handleDeleteSelected = async (ids: string[]) => {
    setSaveErr(null);
    setSaveMsg(null);
    try {
      const removed = await deleteMotorProfiles(ids);
      setSaveMsg(
        removed.length === 1
          ? `Deleted 1 configuration.`
          : `Deleted ${removed.length} configurations.`
      );
      setDeleteOpen(false);
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : "Could not delete the configurations.");
    }
  };

  const sliderPct = calMax > calMin
    ? ((throttleUs - calMin) / (calMax - calMin)) * 100
    : 0;
  const liveThrottle = data?.throttle;
  const activeRange = confirmedRange;

  return (
    <div className="layout">
      {/* ════ LEFT SIDEBAR ════ */}
      <aside className="sidebar">

        <section className="panel">
          <h3 className="panel-title">CALIBRATION SWEEP</h3>
          <div className="mc-hint">
            Connect on the CONTROL tab first. Starting calibration loads this
            range onto the Arduino so the slider below can reach all of it;
            the previous range is restored when you exit.
          </div>

          <div className="t2-field-row">
            <div className="t2-field">
              <label className="field-label">SWEEP MIN (µs)</label>
              <input className={`t2-input${calRangeError ? " st-invalid" : ""}`}
                type="number" min={ABS_MIN_US} max={ABS_MAX_US} step={5}
                value={calMin}
                onChange={e => setCalMin(Number(e.target.value))}
                disabled={calActive || calBusy} />
            </div>
            <div className="t2-field">
              <label className="field-label">SWEEP MAX (µs)</label>
              <input className={`t2-input${calRangeError ? " st-invalid" : ""}`}
                type="number" min={ABS_MIN_US} max={ABS_MAX_US} step={5}
                value={calMax}
                onChange={e => setCalMax(Number(e.target.value))}
                disabled={calActive || calBusy} />
            </div>
          </div>
          {calRangeError && <div className="st-error">{calRangeError}</div>}
          <div className="mc-hint" style={{ marginTop: 6 }}>
            Default 1000–2000. Raise the max only if the motor is still
            accelerating at 2000 µs.
          </div>

          <div className="btn-row">
            {!calActive ? (
              <button className="btn btn-connect" style={{ flex: 1 }}
                onClick={startCalibration}
                disabled={!connected || calBusy || !!calRangeError}>
                {calBusy ? "…" : "▶ START CALIBRATION"}
              </button>
            ) : (
              <button className="btn btn-disconnect" style={{ flex: 1 }}
                onClick={exitCalibration} disabled={calBusy}>
                {calBusy ? "…" : "■ EXIT CALIBRATION"}
              </button>
            )}
          </div>

          {calError && <div className="st-error">{calError}</div>}
          {calNote && <div className="mc-note">{calNote}</div>}

          <div className="mc-status-line">
            <span>BACKEND</span>
            <span style={{ color: connected ? "var(--green)" : "var(--muted)" }}>
              {status === null ? "unreachable" : connected ? "connected" : "disconnected"}
            </span>
          </div>
          <div className="mc-status-line">
            <span>LIVE RANGE</span>
            <span>{activeRange ? `${activeRange.min}–${activeRange.max} µs` : "—"}</span>
          </div>
          <div className="mc-status-line">
            <span>TELEMETRY</span>
            <span style={{ color: wsConnected ? "var(--green)" : "var(--muted)" }}>
              {wsConnected ? "streaming" : "idle"}
            </span>
          </div>
        </section>

        {/* ── Measured values ── */}
        <section className="panel">
          <h3 className="panel-title">MEASURED VALUES</h3>
          <div className="mc-hint">
            Raise the throttle until the motor just starts turning, then FETCH.
            Do the same at the highest throttle you want this motor to run at.
          </div>

          <label className="field-label">MIN THROTTLE — MOTOR STARTS SPINNING (µs)</label>
          <div className="mc-fetch-row">
            <input className="t2-input" type="number" step={1}
              placeholder="e.g. 1080"
              value={spinUpField}
              onChange={e => { setSpinUpField(e.target.value); setThrMinOverride(null); }} />
            <button className="mc-fetch-btn" type="button"
              onClick={() => fetchLive(v => { setSpinUpField(v); setThrMinOverride(null); })}>
              FETCH
            </button>
          </div>

          <label className="field-label">MAX THROTTLE (µs)</label>
          <div className="mc-fetch-row">
            <input className="t2-input" type="number" step={1}
              placeholder="e.g. 1720"
              value={maxField}
              onChange={e => setMaxField(e.target.value)} />
            <button className="mc-fetch-btn" type="button"
              onClick={() => fetchLive(setMaxField)}>
              FETCH
            </button>
          </div>

          {fetchMsg && <div className="st-error">{fetchMsg}</div>}

          <label className="field-label">IDLE HEADROOM BELOW SPIN-UP (µs)</label>
          <input className="t2-input" type="number" min={0} max={500} step={5}
            value={headroomField}
            onChange={e => { setHeadroomField(e.target.value); setThrMinOverride(null); }} />
          <div className="mc-hint" style={{ marginTop: 6 }}>
            0% must be below the spin-up point so the motor actually stops.
            Spin-up {spinUp ?? "—"} − headroom {headroom} = {computedMin ?? "—"} µs.
          </div>

          <label className="field-label">MAX RPM (GAUGE SCALE)</label>
          <div className="mc-fetch-row">
            <input className="t2-input" type="number" min={100} max={60000} step={100}
              value={gaugeField}
              onChange={e => setGaugeField(e.target.value)} />
            <button className="mc-fetch-btn" type="button"
              title="Round the highest RPM seen this session up to the next 500"
              onClick={() => setGaugeField(String(Math.max(500, Math.ceil((peakRpm * 1.1) / 500) * 500)))}
              disabled={peakRpm <= 0}>
              USE PEAK
            </button>
          </div>
          <div className="mc-hint" style={{ marginTop: 6 }}>
            Peak RPM seen this session: {peakRpm.toFixed(0)}
          </div>
        </section>

        {/* ── Save ── */}
        <section className="panel">
          <h3 className="panel-title">NEW MOTOR PROFILE</h3>
          <label className="field-label">MOTOR NAME</label>
          <input className="select" type="text" placeholder="e.g. U8 II KV150"
            value={label} maxLength={40}
            onChange={e => { setLabel(e.target.value); setSaveErr(null); }} />

          <div className="mc-summary">
            <div className="mc-summary-row">
              <span>0% (THR_MIN)</span>
              <input className="mc-summary-input" type="number" step={1}
                value={thrMin ?? ""}
                placeholder="—"
                onChange={e => setThrMinOverride(numOrNull(e.target.value))} />
            </div>
            <div className="mc-summary-row">
              <span>100% (THR_MAX)</span>
              <span className="mc-summary-val">{thrMax ?? "—"} µs</span>
            </div>
            <div className="mc-summary-row">
              <span>GAUGE MAX</span>
              <span className="mc-summary-val">{gaugeMax ?? "—"} rpm</span>
            </div>
          </div>

          {clash?.custom && (
            <div className="mc-note">
              A profile named "{clash.label}" already exists — CONFIGURE will
              update it in place.
            </div>
          )}

          <div className="btn-row">
            <button className="btn btn-start-log" style={{ flex: 1 }}
              onClick={handleConfigure}
              disabled={calBusy || !!formError}>
              {clash?.custom ? "✔ UPDATE PROFILE" : "✔ CONFIGURE"}
            </button>
          </div>
          {formError && <div className="mc-hint" style={{ marginTop: 6 }}>{formError}</div>}
          {saveErr && <div className="st-error">{saveErr}</div>}
          {saveMsg && <div className="mc-note">{saveMsg}</div>}
        </section>

        {/* ── Saved configurations ── */}
        <section className="panel">
          <h3 className="panel-title">MOTOR CONFIGURATIONS</h3>
          {profiles.map(p => (
            <div key={p.id} className="mc-profile">
              <div className="mc-profile-main">
                <span className="mc-profile-name">{p.label}</span>
                <span className="mc-profile-range">{p.thrMin}–{p.thrMax} µs · {p.rpmGaugeMax} rpm</span>
                {p.spinUpUs != null && (
                  <span className="mc-profile-meta">measured spin-up {p.spinUpUs} µs</span>
                )}
              </div>
              {!p.custom && <span className="mc-builtin">SHIPPED</span>}
            </div>
          ))}
          {/* [CHANGED v13] Deletion is a dialog, not a per-row button.
              Configurations cannot be edited at all — to change a motor's
              range, calibrate it again and save. A hand-edited range is a
              number no bench test ever backed. */}
          <button className="mc-del-open" type="button"
            onClick={() => setDeleteOpen(true)}
            disabled={profiles.length === 0}>
            DELETE MOTOR CONFIGURATION…
          </button>
        </section>

      </aside>

      {deleteOpen && (
        <DeleteDialog
          profiles={profiles}
          onCancel={() => setDeleteOpen(false)}
          onDelete={handleDeleteSelected}
        />
      )}

      {/* ════ RIGHT CONTENT ════ */}
      <main className="main">

        <section className="panel throttle-panel">
          <div className="throttle-top-row">
            <h3 className="panel-title" style={{ marginBottom: 0 }}>CALIBRATION THROTTLE</h3>
            <div className="throttle-readout">
              <span className="throttle-pct" style={{ color: calActive ? "var(--amber)" : "var(--muted)" }}>
                {throttleUs}<span className="throttle-pct-unit">µs</span>
              </span>
              <span className="throttle-sep">|</span>
              <span className="throttle-us">
                live {liveThrottle ?? "—"} µs
              </span>
            </div>
          </div>

          {calActive ? (
            <div className="mc-banner mc-banner-live">
              CALIBRATION MODE ACTIVE — the Arduino's throttle range is
              {" "}{calMin}–{calMax} µs. Exit calibration before running Auto Test
              or Step Test on the CONTROL tab, or they will sweep this whole range.
            </div>
          ) : (
            <div className="mc-banner">
              The slider is disabled until calibration starts. Outside
              calibration the firmware ignores any throttle beyond the loaded
              profile's range, so the sweep would silently do nothing.
            </div>
          )}

          <div className="slider-zone">
            <div className="slider-track-wrap">
              <div className="slider-fill-bg" />
              <div className="slider-fill-bar"
                style={{ width: `${sliderPct}%`, background: calActive ? "var(--amber)" : "var(--bg3)" }} />
              <input type="range" min={calMin} max={calMax} step={SWEEP_STEP_US} value={throttleUs}
                className="slider"
                disabled={!connected || !calActive}
                onChange={e => moveThrottle(Number(e.target.value))} />
            </div>
            <div className="slider-ticks">
              {[0, 25, 50, 75, 100].map(t => (
                <div key={t} className="tick-item" style={{ left: `${t}%` }}>
                  <div className="tick-line" />
                  <span className="tick-label">
                    {Math.round(calMin + (t / 100) * (calMax - calMin))}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Nudges. Finding the exact microsecond a motor starts turning
              is not a drag gesture — it is one step at a time. */}
          <div className="mc-nudge-row">
            {[-25, -5, -1].map(d => (
              <button key={d} className="mc-nudge" type="button"
                disabled={!connected || !calActive}
                onClick={() => moveThrottle(throttleUs + d)}>{d}</button>
            ))}
            <div className="mc-jump">
              <input className="t2-input" type="number" step={1}
                placeholder="go to µs"
                value={throttleField}
                onChange={e => setThrottleField(e.target.value)}
                disabled={!connected || !calActive} />
              <button className="mc-nudge" type="button"
                disabled={!connected || !calActive || numOrNull(throttleField) == null}
                onClick={() => {
                  const v = numOrNull(throttleField);
                  if (v != null) moveThrottle(v);
                }}>GO</button>
            </div>
            {[1, 5, 25].map(d => (
              <button key={d} className="mc-nudge" type="button"
                disabled={!connected || !calActive}
                onClick={() => moveThrottle(throttleUs + d)}>+{d}</button>
            ))}
          </div>

          <button className="estop" onClick={handleEStop} disabled={!connected}>
            ⬛ EMERGENCY STOP
          </button>
        </section>

        <section className="panel data-panel">
          <div className="val-row val-row-single">
            <span className="val-label" style={{ color: "var(--green)" }}>RPM</span>
            <span className="val-num rpm-big">{data?.rpm.toFixed(0) ?? "—"}</span>
          </div>
          <div className="val-row val-row-single">
            <span className="val-label" style={{ color: "var(--amber)" }}>THR</span>
            <span className="val-num">{liveThrottle ?? "—"} µs</span>
          </div>
          <div className="val-row val-row-single">
            <span className="val-label" style={{ color: "var(--pink)" }}>VIB MAG</span>
            <span className="val-num">
              {data ? Math.sqrt(data.vibX ** 2 + data.vibY ** 2 + data.vibZ ** 2).toFixed(3) : "—"} g
            </span>
          </div>
          <div className="val-row val-row-single">
            <span className="val-label" style={{ color: "var(--muted)" }}>PEAK RPM</span>
            <span className="val-num">{peakRpm > 0 ? peakRpm.toFixed(0) : "—"}</span>
          </div>
        </section>

        <section className="panel mc-guide">
          <h3 className="panel-title">HOW TO CALIBRATE</h3>
          <ol className="mc-steps">
            <li>Connect to the Arduino on the CONTROL tab, then come back here.</li>
            <li>Check the sweep range (1000–2000 µs is normal) and press START CALIBRATION.</li>
            <li>Raise the throttle in small steps until the motor just begins to turn. Press FETCH next to MIN THROTTLE.</li>
            <li>Raise it to the highest throttle this motor/prop should ever run at, watching RPM and VIB MAG. Press FETCH next to MAX THROTTLE.</li>
            <li>Leave the idle headroom at {DEFAULT_HEADROOM_US} µs unless you have a reason to change it — it is what puts 0% below the spin-up point so the motor can stop.</li>
            <li>Name the motor and press CONFIGURE. The profile is saved, loaded onto the Arduino, and appears in the CONTROL tab's dropdown.</li>
          </ol>
        </section>

      </main>
    </div>
  );
}

function DeleteDialog({
  profiles, onCancel, onDelete,
}: {
  profiles: MotorProfile[];
  onCancel: () => void;
  onDelete: (ids: string[]) => Promise<void>;
}) {
  const { connected, confirmedRange } = useConnection();
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const loadedId = connected && confirmedRange
    ? profiles.find(p => p.thrMin === confirmedRange.min && p.thrMax === confirmedRange.max)?.id
    : undefined;

  const blockedReason = (p: MotorProfile): string | null => {
    if (p.id === loadedId) return "loaded on the Arduino";
    if (profiles.length <= 1) return "the last remaining configuration";
    return null;
  };

  const wouldEmpty = (next: Set<string>) => next.size >= profiles.length;

  const toggle = (id: string) => {
    setChecked(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return wouldEmpty(next) ? prev : next;
    });
  };

  const selected = profiles.filter(p => checked.has(p.id));
  const names = selected.map(p => p.label).join(", ");

  const submit = async () => {
    if (selected.length === 0 || busy) return;
    setBusy(true);
    try { await onDelete(selected.map(p => p.id)); }
    finally { setBusy(false); }
  };

  return (
    <div className="info-overlay" onClick={onCancel}>
      <div className="info-modal mc-del-modal" onClick={e => e.stopPropagation()}
        role="dialog" aria-modal="true">
        <div className="info-head">
          <h2 className="info-title">Delete motor configurations</h2>
          <button className="info-close" onClick={onCancel} aria-label="Close">×</button>
        </div>

        <p className="mc-del-intro">
          Tick everything you want removed. Configurations cannot be edited —
          to change a motor's range, calibrate it again and save.
        </p>

        <div className="mc-del-list">
          {profiles.map(p => {
            const reason = blockedReason(p);
            const isChecked = checked.has(p.id);
            const capped = !isChecked && wouldEmpty(new Set([...checked, p.id]));
            const disabled = !!reason || capped || busy;
            return (
              <label key={p.id}
                className={`mc-del-row${disabled ? " mc-del-row-off" : ""}`}>
                <input type="checkbox" checked={isChecked} disabled={disabled}
                  onChange={() => toggle(p.id)} />
                <span className="mc-del-name">{p.label}</span>
                {/* The stored values are shown so two near-identical entries
                    can be told apart BEFORE one of them is ticked. */}
                <span className="mc-del-range">{p.thrMin}–{p.thrMax} µs</span>
                {reason && <span className="mc-del-why">{reason}</span>}
              </label>
            );
          })}
        </div>

        <div className="mc-del-actions">
          <button className="btn" type="button" onClick={onCancel} disabled={busy}>
            CANCEL
          </button>
          {/* Names what is about to happen rather than saying "Delete" — the
              button IS the confirmation step, so it has to be specific. */}
          <button className="btn btn-stop-log" type="button"
            onClick={submit} disabled={selected.length === 0 || busy}>
            {busy
              ? "DELETING…"
              : selected.length === 0
                ? "SELECT A CONFIGURATION"
                : `DELETE ${selected.length}: ${names}`}
          </button>
        </div>
      </div>
    </div>
  );
}
