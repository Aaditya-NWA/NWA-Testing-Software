// ── The universal connection bar [NEW v13] ───────────────────────────────────
//
// One Connect control for the whole application, rendered above the tabs.
// Both hardware tabs (Control, Configure New Motor) read the same connection;
// the two offline CSV tabs never need one, and role-based access means an
// Analysis user never sees this bar at all.
//
// It carries session weight beyond connecting: Logout is disabled while the
// Arduino is connected, because disconnecting is what commands the throttle
// down (SerialManager.disconnect_async writes THR_MIN before closing the
// port). Disconnect is therefore the gate a user passes through to sign out,
// which is why it must always be reachable and why connection state has to be
// unmistakable at a glance.

import { useConnection, BAUD_RATES, SAMPLING_RATES } from "../context/connection";
import { SamplingRateId } from "../types";

const STATUS_COLOR: Record<string, string> = {
  disconnected: "#666",
  connecting:   "#f5a623",
  connected:    "#00ff99",
  error:        "#ff4444",
};

export default function ConnectionBar() {
  const c = useConnection();

  return (
    <div className="connbar">
      <div className="connbar-row">
        <span className="connbar-dot" style={{ background: STATUS_COLOR[c.status] }} />
        <span className="connbar-status" style={{ color: STATUS_COLOR[c.status] }}>
          {c.status === "connecting" ? "CONNECTING…" : c.status.toUpperCase()}
        </span>

        <label className="connbar-label">PORT</label>
        <select
          className="connbar-select"
          value={c.port}
          onChange={e => c.setPort(e.target.value)}
          disabled={c.connected}
        >
          {c.ports.length === 0
            ? <option value="">No ports found</option>
            : c.ports.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
        <button
          className="icon-btn"
          onClick={() => void c.refreshPorts()}
          title="Refresh ports"
          disabled={c.connected}
        >⟳</button>

        <label className="connbar-label">BAUD</label>
        <select
          className="connbar-select"
          value={c.baud}
          onChange={e => c.setBaud(Number(e.target.value))}
          disabled={c.connected}
        >
          {BAUD_RATES.map(b => <option key={b} value={b}>{b}</option>)}
        </select>

        <label className="connbar-label">SAMPLING</label>
        <select
          className="connbar-select"
          value={c.samplingRateId}
          onChange={e => c.setSamplingRateId(e.target.value as SamplingRateId)}
          disabled={c.connected}
        >
          {SAMPLING_RATES.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>

        <label className="connbar-label">MOTOR</label>
        <select
          className="connbar-select connbar-select-wide"
          value={c.motorProfileId}
          onChange={e => c.setMotorProfileId(e.target.value)}
          disabled={c.connected}
          title={c.connected ? "Locked while connected — disconnect to change" : undefined}
        >
          {c.motorProfiles.map(m => (
            <option key={m.id} value={m.id}>
              {m.label}{m.custom ? "  ·  calibrated" : ""}
            </option>
          ))}
        </select>

        <span className="connbar-spacer" />

        <button
          className="btn btn-connect connbar-btn"
          onClick={() => void c.connect()}
          disabled={c.status === "connecting" || c.connected || !c.port}
        >
          {c.status === "connecting" ? "…" : "CONNECT"}
        </button>
        <button
          className="btn btn-disconnect connbar-btn"
          onClick={() => void c.disconnect()}
          disabled={!c.connected}
        >
          DISCONNECT
        </button>
      </div>

      {/* Every warning below is non-fatal by design: the connection stands
          and the operator is told what is different from what they asked
          for, rather than the connect being refused outright. */}
      {(c.pairingWarning || c.baudSwitchWarning || c.samplingRateAckError ||
        c.profileMismatch || c.firmwareWarning || (c.connected && c.confirmedRange)) && (
        <div className="connbar-notes">
          {c.connected && c.confirmedRange && !c.profileMismatch && (
            <span className="connbar-ok">
              ✓ Arduino confirmed {c.confirmedRange.min}–{c.confirmedRange.max} µs
              {c.activeBaud != null && !c.baudSwitchWarning ? ` at ${c.activeBaud} baud` : ""}
            </span>
          )}
          {c.firmwareWarning     && <span className="connbar-warn">⚠ {c.firmwareWarning}</span>}
          {c.profileMismatch     && <span className="connbar-warn">⚠ {c.profileMismatch}</span>}
          {c.baudSwitchWarning   && <span className="connbar-warn">⚠ {c.baudSwitchWarning}</span>}
          {c.samplingRateAckError&& <span className="connbar-warn">⚠ {c.samplingRateAckError}</span>}
          {!c.connected && c.pairingWarning && <span className="connbar-hint">⚠ {c.pairingWarning}</span>}
        </div>
      )}
    </div>
  );
}
