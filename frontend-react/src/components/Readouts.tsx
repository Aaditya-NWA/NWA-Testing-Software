/**
 * Live telemetry readouts for the Control tab: the circular gauges, the
 * per-axis value rows, and one row of the scrolling log table.
 *
 * LogRow is memoised and keyed on the sample's own `__k` rather than its array
 * index. The history window slides, so index-based keys changed on every
 * message and React remounted ~500 rows 25 times a second instead of adding
 * one. Striping is CSS :nth-child so no positional prop remains.
 */
import { memo } from "react";
import { SensorData } from "../types";
import { clamp, fmt, tsToIST } from "../lib/format";

// ── Gauge ────────────────────────────────────────────────────────────────────
function Gauge({ value, max, label, unit, color }: {
  value: number; max: number; label: string; unit: string; color: string;
}) {
  const r = 44; const circ = 2 * Math.PI * r;
  const filled = clamp(value / max, 0, 1) * circ * 0.75;
  const offset = circ * 0.125;
  return (
    <div className="gauge-wrap">
      <svg viewBox="0 0 100 100" className="gauge-svg">
        <circle cx="50" cy="50" r={r} fill="none" stroke="rgba(255,255,255,0.06)"
          strokeWidth="8" strokeDasharray={`${circ * 0.75} ${circ}`}
          strokeDashoffset={-offset} strokeLinecap="round"
          style={{ transform: "rotate(135deg)", transformOrigin: "50% 50%" }} />
        <circle cx="50" cy="50" r={r} fill="none" stroke={color} strokeWidth="8"
          strokeDasharray={`${filled} ${circ}`} strokeDashoffset={-offset} strokeLinecap="round"
          style={{ transform: "rotate(135deg)", transformOrigin: "50% 50%",
            transition: "stroke-dasharray 0.15s linear",
            filter: `drop-shadow(0 0 4px ${color})` }} />
        <text x="50" y="46" textAnchor="middle" fill="white" fontSize="13" fontWeight="700"
          fontFamily="'JetBrains Mono', monospace">{value.toFixed(0)}</text>
        <text x="50" y="58" textAnchor="middle" fill="rgba(255,255,255,0.4)" fontSize="6.5"
          fontFamily="'JetBrains Mono', monospace">{unit}</text>
      </svg>
      <span className="gauge-label">{label}</span>
    </div>
  );
}

function ValRow({ label, x, y, z, color }: {
  label: string; x?: number; y?: number; z?: number; color: string;
}) {
  return (
    <div className="val-row">
      <span className="val-label" style={{ color }}>{label}</span>
      <span className="val-num">{fmt(x)}</span>
      <span className="val-num">{fmt(y)}</span>
      <span className="val-num">{fmt(z)}</span>
    </div>
  );
}

const LogRow = memo(function LogRow({ row }: { row: SensorData }) {
  return (
    <tr className="log-tr">
      <td className="log-td log-td-ts">{tsToIST(row.ts)}</td>
      <td className="log-td log-td-num" style={{ color: "#f5a623" }}>{row.throttle}</td>
      <td className="log-td log-td-num" style={{ color: "#00ff99" }}>{row.rpm.toFixed(1)}</td>
      <td className="log-td log-td-num">{row.accX.toFixed(3)}</td>
      <td className="log-td log-td-num">{row.accY.toFixed(3)}</td>
      <td className="log-td log-td-num">{row.accZ.toFixed(3)}</td>
      <td className="log-td log-td-num" style={{ color: "#ff6b9d" }}>{row.vibX.toFixed(3)}</td>
      <td className="log-td log-td-num" style={{ color: "#ff6b9d" }}>{row.vibY.toFixed(3)}</td>
      <td className="log-td log-td-num" style={{ color: "#ff6b9d" }}>{row.vibZ.toFixed(3)}</td>
    </tr>
  );
});


export { Gauge, ValRow, LogRow };
