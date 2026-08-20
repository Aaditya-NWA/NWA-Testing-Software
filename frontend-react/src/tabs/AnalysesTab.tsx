/**
 * Analyses — multi-file comparison of recorded CSVs. Offline; no connection.
 *
 * Four graph modes off the same uploads: RMS (binned, full natural range),
 * WAVEFORM (raw signed per-sample), SPECTRUM (real FFT with order markers),
 * and ALL.
 *
 * Two RPM filters that are easily confused. RPM RANGE gates every chart and
 * keeps RPM on the X axis; binning happens after it, so narrowing genuinely
 * increases resolution. RPM WINDOW (target +- tolerance) is waveform/spectrum
 * only and applies within that range.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, ReferenceDot, ReferenceLine,
} from "recharts";
import { parseCSV } from "../lib/balancing";
import {
  computeSpectrum, analyseGrid, longestContiguousRun, orderFrequencies,
  peakNear, SpectrumResult,
} from "../lib/fft";
import {
  decimateEnvelope, extentOfPairs, isEmptyExtent, PLOT_BUDGET,
} from "../lib/plotData";
import {
  GA_AXIS_COLOR, gaDashFor, niceTicks, gaAvgMax, rmsBinnedSeries, peakOf,
} from "../lib/chartData";

interface GAFile {
  name: string;
  rows: Record<string, number>[];
}

type GraphMode = "RMS" | "WAVEFORM" | "SPECTRUM" | "ALL";

function FftTooltip({ active, payload, label, targetModeActive }: {
  active?: boolean; payload?: any[]; label?: any; targetModeActive: boolean;
}) {
  if (!active || !payload || payload.length === 0) return null;

  const withRpm = payload.find(p => p?.payload?._rpm !== undefined);
  const rpm = withRpm ? withRpm.payload._rpm : Number(label);

  return (
    <div style={{
      background: "#1a1a1a", border: "1px solid #333",
      padding: "6px 10px", fontSize: 13, lineHeight: 1.6,
    }}>
      <div style={{ color: "#fff", fontWeight: 700 }}>
        {isFinite(rpm) ? Math.round(rpm) : "—"} RPM
      </div>
      {targetModeActive && (
        <div style={{ color: "#666", fontSize: 11, marginBottom: 3 }}>
          {Number(label).toFixed(1)}% through window
        </div>
      )}
      {payload.map((p, i) => (
        <div key={i} style={{ color: p.color }}>
          {p.name} : {Number(p.value).toFixed(3)}
        </div>
      ))}
    </div>
  );
}

export default function AnalysesTab({ fullscreen = false }: { fullscreen?: boolean }) {
  const [viewportH, setViewportH] = useState(() => window.innerHeight);
  useEffect(() => {
    const onResize = () => setViewportH(window.innerHeight);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  // 300 px is the chrome above a chart (header, tab bar, controls, title).
  // The floor keeps it from collapsing on a short window.
  const chartH = fullscreen ? Math.max(420, viewportH - 300) : 420;

  const [files, setFiles] = useState<GAFile[]>([]);
  const [parseError, setParseError] = useState<string | null>(null);

  const [graphMode, setGraphMode] = useState<GraphMode>("RMS");
  const showRms  = graphMode === "RMS"      || graphMode === "ALL";
  const showFft  = graphMode === "WAVEFORM" || graphMode === "ALL";
  const showSpec = graphMode === "SPECTRUM" || graphMode === "ALL";

  // [NEW v9] Spectrum controls.
  const [showOrders, setShowOrders] = useState(true);
  const [maxFreq, setMaxFreq] = useState("");   // blank = up to Nyquist
  const [specAxis, setSpecAxis] = useState<"VIB" | "ACC">("VIB");

  const [hiddenSeries, setHiddenSeries] = useState<Set<string>>(new Set());
  const toggleSeries = (id: string) => {
    setHiddenSeries(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const [targetRpm, setTargetRpm] = useState("");
  const [tolerance, setTolerance] = useState("");

  const targetModeActive = targetRpm.trim() !== "" && tolerance.trim() !== "";

  const clearTargetMode = () => {
    setTargetRpm("");
    setTolerance("");
  };

  const [rpmMin, setRpmMin] = useState("");
  const [rpmMax, setRpmMax] = useState("");

  const rangeFilled = rpmMin.trim() !== "" && rpmMax.trim() !== "";
  const rangeMinVal = Number(rpmMin);
  const rangeMaxVal = Number(rpmMax);
  // Ascending is a hard requirement — an inverted range would silently match
  // nothing, so it's rejected up front and reported instead of plotting empty.
  const rangeInverted = rangeFilled && !isNaN(rangeMinVal) && !isNaN(rangeMaxVal) && rangeMinVal >= rangeMaxVal;
  const rangeActive = rangeFilled && !isNaN(rangeMinVal) && !isNaN(rangeMaxVal) && !rangeInverted;

  const clearRange = () => {
    setRpmMin("");
    setRpmMax("");
  };

  const [showPeaks, setShowPeaks] = useState(true);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files;
    if (!fileList || fileList.length === 0) return;
    setParseError(null);

    const newFiles: GAFile[] = [];
    for (let i = 0; i < fileList.length; i++) {
      const f = fileList[i];
      try {
        const text = await f.text();
        const parsed = parseCSV(text);
        if (!parsed.headers.includes("RPM")) {
          setParseError(`${f.name}: no RPM column found`);
          continue;
        }
        newFiles.push({ name: f.name, rows: parsed.rows });
      } catch (err: any) {
        setParseError(`${f.name}: ${err.message || "failed to parse"}`);
      }
    }
    setFiles(prev => [...prev, ...newFiles]);
    e.target.value = ""; // allow re-uploading the same file(s) later
  };

  const removeFile = (idx: number) => {
    setFiles(prev => prev.filter((_, i) => i !== idx));
  };

  const clearAll = () => {
    setFiles([]);
    setTargetRpm(""); setTolerance("");
    setRpmMin(""); setRpmMax("");
  };

  const targetVal = Number(targetRpm);
  const tolVal = Number(tolerance);

  // The RPM RANGE gate, shared by both chart families so they always agree
  // on which rows are in scope.
  const inRange = useCallback(
    (rpm: number) => !rangeActive || (rpm >= rangeMinVal && rpm <= rangeMaxVal),
    [rangeActive, rangeMinVal, rangeMaxVal]
  );

  // Per-file sample counts inside the RPM range — shown in the sidebar so an
  // empty chart is immediately explainable rather than looking broken.
  const rangeMatchCounts = useMemo(() => {
    if (!rangeActive) return [];
    return files.map(f => ({
      name: f.name,
      count: f.rows.filter(r => r.RPM !== undefined && r.RPM >= rangeMinVal && r.RPM <= rangeMaxVal).length,
    }));
  }, [files, rangeActive, rangeMinVal, rangeMaxVal]);

  // Per-file sample counts within target±tolerance (after the range gate) —
  // this is what the FFT charts actually plot in window mode.
  const targetMatchCounts = useMemo(() => {
    if (!targetModeActive || isNaN(targetVal) || isNaN(tolVal)) return [];
    return files.map(f => ({
      name: f.name,
      count: f.rows.filter(r =>
        r.RPM !== undefined && inRange(r.RPM) && Math.abs(r.RPM - targetVal) <= tolVal
      ).length,
    }));
  }, [files, targetModeActive, targetVal, tolVal, inRange]);

  const rmsData = useMemo(() => {
    const build = (key: string) =>
      files.map(f => {
        if (!showRms) return [];
        const pts = f.rows
          .filter(r => r.RPM !== undefined && r[key] !== undefined && inRange(r.RPM))
          .map(r => ({ xval: r.RPM, [key]: r[key] }));
        return rmsBinnedSeries(pts, key);
      });
    return {
      accX: build("AccX"), accY: build("AccY"), accZ: build("AccZ"),
      vibX: build("VibX"), vibY: build("VibY"), vibZ: build("VibZ"),
    };
  }, [files, inRange, showRms]);

  const fftData = useMemo(() => {
    let rawPoints = 0;
    let drawnPoints = 0;

    const build = (key: string) =>
      files.map(f => {
        if (!showFft) return [];        // shape preserved — see rmsData
        let series: { xval: number; [k: string]: number | undefined }[];

        if (targetModeActive && !isNaN(targetVal) && !isNaN(tolVal)) {
          const matches = f.rows.filter(r =>
            r.RPM !== undefined && r[key] !== undefined &&
            inRange(r.RPM) && Math.abs(r.RPM - targetVal) <= tolVal
          );
          const n = matches.length;
          // Occurrence position is already monotonic in row order, so the
          // series is in plot order without sorting.
          series = matches.map((r, i) => ({
            xval: n > 1 ? (i / (n - 1)) * 100 : 0,
            [key]: r[key],
            _rpm: r.RPM,
          }));
        } else {
          series = f.rows
            .filter(r => r.RPM !== undefined && r[key] !== undefined && inRange(r.RPM))
            .map(r => ({ xval: r.RPM, [key]: r[key], _rpm: r.RPM }))
            .sort((a, b) => a.xval - b.xval);
        }

        const decimated = decimateEnvelope(series, key);
        if (key === "VibX") {           // one representative axis
          rawPoints += series.length;
          drawnPoints += decimated.length;
        }
        return decimated;
      });

    return {
      accX: build("AccX"), accY: build("AccY"), accZ: build("AccZ"),
      vibX: build("VibX"), vibY: build("VibY"), vibZ: build("VibZ"),
      rawPoints, drawnPoints,
    };
  }, [files, targetModeActive, targetVal, tolVal, inRange, showFft]);

  const spectrumData = useMemo(() => {
    if (!showSpec) return [];
    return files.map(f => {
      const pred = (r: Record<string, number>) =>
        r.RPM !== undefined && inRange(r.RPM) &&
        (!targetModeActive || isNaN(targetVal) || isNaN(tolVal) ||
         Math.abs(r.RPM - targetVal) <= tolVal);

      const run = longestContiguousRun(f.rows, pred);
      const seg = f.rows.slice(run.start, run.end);
      const grid = analyseGrid(seg);
      const meanRpm = seg.length
        ? seg.reduce((s, r) => s + (r.RPM ?? 0), 0) / seg.length
        : 0;

      // 64 samples is the floor below which even the coarsest useful
      // resolution is unavailable; fft.ts itself requires 8.
      const usable = seg.length >= 64 && grid.fs > 0;
      const spec = (key: string): SpectrumResult | null =>
        usable ? computeSpectrum(seg.map(r => r[key] ?? 0), grid.fs) : null;

      return {
        name: f.name,
        segLength: seg.length,
        grid,
        meanRpm,
        usable,
        accX: spec("AccX"), accY: spec("AccY"), accZ: spec("AccZ"),
        vibX: spec("VibX"), vibY: spec("VibY"), vibZ: spec("VibZ"),
      };
    });
  }, [files, showSpec, inRange, targetModeActive, targetVal, tolVal]);

  const specSeries = useCallback((s: SpectrumResult | null, key: string, cap: number) => {
    if (!s) return [];
    return decimateEnvelope(
      s.points.filter(p => p.freq <= cap).map(p => ({ xval: p.freq, [key]: p.amp })),
      key,
    );
  }, []);

  const maxFreqVal = Number(maxFreq);
  const specNyquist = spectrumData.length
    ? Math.min(...spectrumData.filter(d => d.usable).map(d => d.grid.nyquist).concat([Infinity]))
    : 0;
  const specCap = (maxFreq.trim() !== "" && !isNaN(maxFreqVal) && maxFreqVal > 0)
    ? maxFreqVal
    : (isFinite(specNyquist) && specNyquist > 0 ? specNyquist : 500);

  // Order markers come from the first usable file's own mean RPM.
  const orderRpm = spectrumData.find(d => d.usable && d.meanRpm > 0)?.meanRpm ?? 0;
  const orders = orderRpm > 0 ? orderFrequencies(orderRpm, 6).filter(o => o.freq <= specCap) : [];

  const orderTable = useMemo(() => {
    if (!showSpec || orders.length === 0) return [];
    const axes: [string, string][] = specAxis === "VIB"
      ? [["VibX", "vibX"], ["VibY", "vibY"], ["VibZ", "vibZ"]]
      : [["AccX", "accX"], ["AccY", "accY"], ["AccZ", "accZ"]];
    return spectrumData.filter(d => d.usable).map(d => ({
      name: d.name,
      meanRpm: d.meanRpm,
      rows: axes.map(([label, field]) => {
        const spec = (d as any)[field] as SpectrumResult | null;
        return {
          label,
          peaks: orders.map(o => {
            // Search +-2 bins of true resolution around each order, so a
            // slightly drifting speed still lands the right peak.
            const tol = spec ? Math.max(spec.resolution * 2, 1.5) : 1.5;
            const p = spec ? peakNear(spec.points, o.freq, tol) : null;
            return { order: o.order, freq: o.freq, amp: p ? p.amp : 0 };
          }),
        };
      }),
    }));
  }, [spectrumData, orders, specAxis, showSpec]);

  const rmsAccMinMax = useMemo(() => {
    const e = extentOfPairs([[rmsData.accX, "AccX"], [rmsData.accY, "AccY"], [rmsData.accZ, "AccZ"]]);
    return isEmptyExtent(e) ? { min: 0, max: 1 } : { min: 0, max: e.max };
  }, [rmsData]);
  const rmsVibMinMax = useMemo(() => {
    const e = extentOfPairs([[rmsData.vibX, "VibX"], [rmsData.vibY, "VibY"], [rmsData.vibZ, "VibZ"]]);
    return isEmptyExtent(e) ? { min: 0, max: 1 } : { min: 0, max: e.max };
  }, [rmsData]);
  const fftAccMinMax = useMemo(() => {
    const e = extentOfPairs([[fftData.accX, "AccX"], [fftData.accY, "AccY"], [fftData.accZ, "AccZ"]]);
    return isEmptyExtent(e) ? { min: -1, max: 1 } : e;
  }, [fftData]);
  const fftVibMinMax = useMemo(() => {
    const e = extentOfPairs([[fftData.vibX, "VibX"], [fftData.vibY, "VibY"], [fftData.vibZ, "VibZ"]]);
    return isEmptyExtent(e) ? { min: -1, max: 1 } : e;
  }, [fftData]);

  const rmsAccTicks = useMemo(() => niceTicks(rmsAccMinMax.min, rmsAccMinMax.max), [rmsAccMinMax]);
  const rmsVibTicks = useMemo(() => niceTicks(rmsVibMinMax.min, rmsVibMinMax.max), [rmsVibMinMax]);
  const fftAccTicks = useMemo(() => niceTicks(fftAccMinMax.min, fftAccMinMax.max), [fftAccMinMax]);
  const fftVibTicks = useMemo(() => niceTicks(fftVibMinMax.min, fftVibMinMax.max), [fftVibMinMax]);

  const rmsAccLegendPayload = useMemo(() => files.flatMap((f, i) => ([
    { value: `AccX · ${f.name} (Avg. Max ${gaAvgMax(rmsData.accX[i] as any, "AccX").toFixed(2)})`, id: `rms-ax-${i}`, color: GA_AXIS_COLOR.X, type: "line" as const },
    { value: `AccY · ${f.name} (Avg. Max ${gaAvgMax(rmsData.accY[i] as any, "AccY").toFixed(2)})`, id: `rms-ay-${i}`, color: GA_AXIS_COLOR.Y, type: "line" as const },
    { value: `AccZ · ${f.name} (Avg. Max ${gaAvgMax(rmsData.accZ[i] as any, "AccZ").toFixed(2)})`, id: `rms-az-${i}`, color: GA_AXIS_COLOR.Z, type: "line" as const },
  ])), [files, rmsData]);
  const rmsVibLegendPayload = useMemo(() => files.flatMap((f, i) => ([
    { value: `VibX · ${f.name} (Avg. Max ${gaAvgMax(rmsData.vibX[i] as any, "VibX").toFixed(2)})`, id: `rms-vx-${i}`, color: GA_AXIS_COLOR.X, type: "line" as const },
    { value: `VibY · ${f.name} (Avg. Max ${gaAvgMax(rmsData.vibY[i] as any, "VibY").toFixed(2)})`, id: `rms-vy-${i}`, color: GA_AXIS_COLOR.Y, type: "line" as const },
    { value: `VibZ · ${f.name} (Avg. Max ${gaAvgMax(rmsData.vibZ[i] as any, "VibZ").toFixed(2)})`, id: `rms-vz-${i}`, color: GA_AXIS_COLOR.Z, type: "line" as const },
  ])), [files, rmsData]);
  const fftAccLegendPayload = useMemo(() => files.flatMap((f, i) => ([
    { value: `AccX · ${f.name}`, id: `fft-ax-${i}`, color: GA_AXIS_COLOR.X, type: "line" as const },
    { value: `AccY · ${f.name}`, id: `fft-ay-${i}`, color: GA_AXIS_COLOR.Y, type: "line" as const },
    { value: `AccZ · ${f.name}`, id: `fft-az-${i}`, color: GA_AXIS_COLOR.Z, type: "line" as const },
  ])), [files]);
  const fftVibLegendPayload = useMemo(() => files.flatMap((f, i) => ([
    { value: `VibX · ${f.name}`, id: `fft-vx-${i}`, color: GA_AXIS_COLOR.X, type: "line" as const },
    { value: `VibY · ${f.name}`, id: `fft-vy-${i}`, color: GA_AXIS_COLOR.Y, type: "line" as const },
    { value: `VibZ · ${f.name}`, id: `fft-vz-${i}`, color: GA_AXIS_COLOR.Z, type: "line" as const },
  ])), [files]);

  const waveformDecimation = showFft && fftData.drawnPoints < fftData.rawPoints
    ? { drawn: fftData.drawnPoints, total: fftData.rawPoints }
    : null;

  // Peak markers for one chart. Skips series the legend has hidden, so the
  // markers always match what's actually on screen.
  const peakDots = (series: { data: any[]; key: string; id: string; color: string }[]) => {
    if (!showPeaks) return [];
    return series.flatMap(s => {
      if (hiddenSeries.has(s.id)) return [];
      const pk = peakOf(s.data, s.key);
      if (!pk) return [];
      return [(
        <ReferenceDot
          key={`pk-${s.id}`}
          x={pk.x}
          y={pk.y}
          r={4}
          fill={s.color}
          stroke="#0a0a0a"
          strokeWidth={1.5}
          isFront
          label={{
            value: pk.y.toFixed(3),
            position: pk.y >= 0 ? "top" : "bottom",
            fill: s.color,
            fontSize: 10,
            fontWeight: 700,
          }}
        />
      )];
    });
  };

  // Dims + strikes through the label text of any legend entry currently hidden.
  const legendFormatter = (value: string, entry: any) => (
    <span style={{
      opacity: hiddenSeries.has(entry.id) ? 0.35 : 1,
      textDecoration: hiddenSeries.has(entry.id) ? "line-through" : "none",
    }}>
      {value}
    </span>
  );

  const noData = files.length === 0;

  // Chart-title suffix so an active range is visible on the exported PDF,
  // not just in the sidebar the export crops out.
  const rangeSuffix = rangeActive ? ` · ${rangeMinVal}–${rangeMaxVal} RPM` : "";

  const rmsXAxisDomain: [any, any] = rangeActive ? [rangeMinVal, rangeMaxVal] : ["dataMin", "dataMax"];

  // FFT axis presentation depends on the window — see the comment above targetRpm.
  const fftXAxisDomain: [any, any] = targetModeActive
    ? [0, 100]
    : (rangeActive ? [rangeMinVal, rangeMaxVal] : ["dataMin", "dataMax"]);
  const fftXAxisLabelText = targetModeActive
    ? `Occurrence order within ${targetRpm}±${tolerance} RPM (first → last, %) — hover for actual RPM`
    : "RPM";

  const handleDownloadPdf = () => {
    const originalTitle = document.title;
    document.title = ""; // Chrome's print header uses document.title — blank it for a clean export
    const restore = () => {
      document.title = originalTitle;
      window.removeEventListener("afterprint", restore);
    };
    window.addEventListener("afterprint", restore);
    window.print();
  };

  return (
    <div className="layout">
      <aside className="sidebar">
        <section className="panel">
          <h3 className="panel-title">UPLOAD CSVs</h3>
          <label className="csv-upload-btn" style={{ display: "block", textAlign: "center", cursor: "pointer" }}>
            ⬆ Upload CSV(s)
            <input type="file" accept=".csv" multiple style={{ display: "none" }} onChange={handleFileUpload} />
          </label>
          {parseError && (
            <div style={{ fontSize: 10, color: "#ff6b6b", marginTop: 6 }}>{parseError}</div>
          )}
          {files.length > 0 && (
            <div style={{ marginTop: 10 }}>
              {files.map((f, i) => (
                <div key={i} style={{
                  display: "flex", justifyContent: "space-between", alignItems: "center",
                  fontSize: 13, padding: "4px 0", borderBottom: "1px solid rgba(255,255,255,0.06)",
                }}>
                  <span style={{
                    display: "inline-flex", alignItems: "center", gap: 6, overflow: "hidden",
                    textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 160,
                  }}>
                    <span style={{
                      width: 14, height: 0, borderTop: `2px ${gaDashFor(i) ? "dashed" : "solid"} #888`,
                      display: "inline-block", flexShrink: 0,
                    }} />
                    {f.name}
                  </span>
                  <button onClick={() => removeFile(i)}
                    style={{ background: "none", border: "none", color: "#888", cursor: "pointer", fontSize: 12 }}>
                    ✕
                  </button>
                </div>
              ))}
              <button className="btn btn-disconnect" style={{ marginTop: 8, width: "100%" }} onClick={clearAll}>
                CLEAR ALL
              </button>
            </div>
          )}
        </section>

        <section className="panel">
          <h3 className="panel-title">GRAPH TYPE</h3>
          <div className="ga-mode-row">
            {(["RMS", "WAVEFORM", "SPECTRUM", "ALL"] as GraphMode[]).map(m => (
              <button
                key={m}
                className={`ga-mode-btn ${graphMode === m ? "ga-mode-btn-active" : ""}`}
                onClick={() => setGraphMode(m)}
                style={{ fontSize: 10 }}
              >
                {m}
              </button>
            ))}
          </div>
          <div style={{ fontSize: 11, color: "#666", marginTop: 8, lineHeight: 1.5 }}>
            {graphMode === "RMS" && "RMS-binned trend vs RPM."}
            {graphMode === "WAVEFORM" && "Raw per-sample signal vs RPM (formerly labelled \"FFT\" — it never was one). The RPM window below applies."}
            {graphMode === "SPECTRUM" && "Real FFT: amplitude vs frequency, with rotor order markers. Set an RPM window for a constant-speed segment."}
            {graphMode === "ALL" && "Every chart. The RPM window applies to WAVEFORM and SPECTRUM."}
          </div>
          <label style={{
            display: "flex", alignItems: "center", gap: 7, marginTop: 10,
            fontSize: 11, color: "#888", cursor: "pointer",
          }}>
            <input type="checkbox" checked={showPeaks} onChange={e => setShowPeaks(e.target.checked)} />
            Mark peak spikes
          </label>
        </section>

        <section className="panel">
          <h3 className="panel-title">RPM RANGE (optional)</h3>
          <div style={{ fontSize: 11, color: "#666", marginBottom: 8, lineHeight: 1.5 }}>
            Applies to every chart. Plots only samples between these two RPMs.
          </div>
          <div className="t2-field-row">
            <div className="t2-field">
              <label className="field-label">FROM</label>
              <input className="t2-input" type="number" placeholder="e.g. 2000" value={rpmMin}
                onChange={e => setRpmMin(e.target.value)} />
            </div>
            <div className="t2-field">
              <label className="field-label">TO</label>
              <input className="t2-input" type="number" placeholder="e.g. 4000" value={rpmMax}
                onChange={e => setRpmMax(e.target.value)} />
            </div>
          </div>

          {rangeInverted && (
            <div style={{ fontSize: 11, color: "#ff6b6b", marginTop: 6, lineHeight: 1.5 }}>
              Range must ascend — FROM ({rpmMin}) has to be less than TO ({rpmMax}).
              Filter not applied.
            </div>
          )}

          {rangeActive && (
            <>
              <div style={{ fontSize: 11, color: "#00ff99", marginTop: 6, lineHeight: 1.5 }}>
                Restricted to {rangeMinVal}–{rangeMaxVal} RPM.
              </div>
              {rangeMatchCounts.map((m, i) => (
                <div key={i} style={{ fontSize: 13, color: "#888", marginTop: 4 }}>
                  {m.name}: <span style={{ color: m.count > 0 ? "#00ff99" : "#ff6b6b" }}>{m.count}</span> samples in range
                </div>
              ))}
              <button className="btn btn-disconnect" style={{ marginTop: 8, width: "100%" }} onClick={clearRange}>
                CLEAR RANGE
              </button>
            </>
          )}
        </section>

        {showFft && (
          <section className="panel">
            <h3 className="panel-title">RPM WINDOW (optional)</h3>
            <div style={{ fontSize: 11, color: "#666", marginBottom: 8, lineHeight: 1.5 }}>
              Applies to the FFT charts only{rangeActive ? ", within the RPM range above" : ""}.
              Switches the X axis to occurrence order, so RPM will not ascend
              across it — use RPM RANGE alone if you want RPM on the X axis.
            </div>
            <div className="t2-field-row">
              <div className="t2-field">
                <label className="field-label">TARGET</label>
                <input className="t2-input" type="number" placeholder="e.g. 4500" value={targetRpm}
                  onChange={e => setTargetRpm(e.target.value)} />
              </div>
              <div className="t2-field">
                <label className="field-label">TOLERANCE ±</label>
                <input className="t2-input" type="number" placeholder="e.g. 200" value={tolerance}
                  onChange={e => setTolerance(e.target.value)} />
              </div>
            </div>

            {targetModeActive && (
              <>
                <div style={{ fontSize: 11, color: "#00ff99", marginTop: 6, lineHeight: 1.5 }}>
                  Plotting all samples within {targetRpm}±{tolerance} RPM,
                  spread left→right in the order they occurred (not by RPM value).
                  Hover any point to read its actual RPM.
                </div>
                {targetMatchCounts.map((m, i) => (
                  <div key={i} style={{ fontSize: 13, color: "#888", marginTop: 4 }}>
                    {m.name}: <span style={{ color: m.count > 0 ? "#00ff99" : "#ff6b6b" }}>{m.count}</span> samples matched
                  </div>
                ))}
                <button className="btn btn-disconnect" style={{ marginTop: 8, width: "100%" }} onClick={clearTargetMode}>
                  CLEAR
                </button>
              </>
            )}
          </section>
        )}
        {showSpec && (
          <section className="panel">
            <h3 className="panel-title">SPECTRUM</h3>
            <div style={{ fontSize: 11, color: "#666", marginBottom: 8, lineHeight: 1.5 }}>
              Transforms the longest <em>contiguous</em> stretch of samples
              matching the filters above. Set an RPM WINDOW to isolate a
              constant-speed segment — a spectrum of a speed ramp smears
              every order into a band.
            </div>

            <div className="ga-mode-row" style={{ marginBottom: 8 }}>
              {(["VIB", "ACC"] as const).map(a => (
                <button key={a}
                  className={`ga-mode-btn ${specAxis === a ? "ga-mode-btn-active" : ""}`}
                  onClick={() => setSpecAxis(a)}>
                  {a}
                </button>
              ))}
            </div>

            <div className="t2-field">
              <label className="field-label">MAX FREQUENCY (Hz)</label>
              <input className="t2-input" type="number" placeholder="blank = Nyquist"
                value={maxFreq} onChange={e => setMaxFreq(e.target.value)} />
            </div>

            <label style={{
              display: "flex", alignItems: "center", gap: 7, marginTop: 10,
              fontSize: 11, color: "#888", cursor: "pointer",
            }}>
              <input type="checkbox" checked={showOrders}
                onChange={e => setShowOrders(e.target.checked)} />
              Show rotor order markers (1x-6x)
            </label>

            {spectrumData.map((d, i) => (
              <div key={i} style={{ fontSize: 11, marginTop: 8, lineHeight: 1.5 }}>
                <div style={{ color: "#888" }}>
                  {d.name}: <span style={{ color: d.usable ? "#00ff99" : "#ff6b6b" }}>
                    {d.segLength}</span> contiguous samples
                  {d.usable && ` @ ${d.grid.fs.toFixed(1)} Hz`}
                </div>
                {d.usable && (
                  <div style={{ color: "#666" }}>
                    mean {Math.round(d.meanRpm)} RPM · 1x = {(d.meanRpm / 60).toFixed(1)} Hz ·
                    resolution {d.vibY ? d.vibY.resolution.toFixed(2) : "—"} Hz ·
                    {d.vibY ? ` ${d.vibY.segments} avg` : ""}
                  </div>
                )}
                {d.grid.warning && (
                  <div style={{ color: "#ffb347", fontSize: 10, marginTop: 3 }}>
                    ⚠ {d.grid.warning}
                  </div>
                )}
              </div>
            ))}
          </section>
        )}

        <section className="panel">
          <h3 className="panel-title">EXPORT</h3>
          <button className="btn btn-connect" onClick={handleDownloadPdf} style={{ width: "100%" }}>
            ⬇ Download PDF
          </button>
        </section>
      </aside>

      <main className="main">
        {noData ? (
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            height: "100%", color: "#666", fontSize: 15,
          }}>
            Upload one or more CSVs, then pick RMS, FFT or BOTH to plot
            Acceleration and Vibration vs RPM.
          </div>
        ) : (
          <div className="ga-print-area" style={{ overflowY: "auto", height: "100%" }}>

            {showRms && (
              <>
                <section className="panel" style={{ marginBottom: 25 }}>
                  <h3 className="panel-title">RMS · ACCELERATION vs RPM{rangeSuffix}</h3>
                  <ResponsiveContainer width="100%" height={chartH}>
                    <LineChart margin={{ top: 8, right: 24, bottom: 8, left: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.12)" />
                      <XAxis dataKey="xval" type="number" domain={rmsXAxisDomain}
                        tick={{ fill: "#888", fontSize: 10 }} label={{ value: "RPM", position: "insideBottom", offset: 2, fill: "#888", fontSize: 11 }} />
                      <YAxis domain={[rmsAccTicks[0], rmsAccTicks[rmsAccTicks.length - 1]]} ticks={rmsAccTicks}
                        tickFormatter={(v) => Number(v.toFixed(2)).toString()}
                        tick={{ fill: "#888", fontSize: 9 }} label={{ value: "g", angle: -90, position: "insideLeft", fill: "#888", fontSize: 11 }} />
                      <Tooltip contentStyle={{ background: "#1a1a1a", border: "1px solid #333", fontSize: 13 }}
                        labelFormatter={(v) => `${Math.round(Number(v))} RPM`}
                        formatter={(v: any) => Number(v).toFixed(3)} />
                      <Legend payload={rmsAccLegendPayload} onClick={(o: any) => toggleSeries(o.id)}
                        formatter={legendFormatter} wrapperStyle={{ fontSize: 13, cursor: "pointer" }} />
                      {files.map((f, i) => (
                        <Line key={`rms-ax-${i}`} data={rmsData.accX[i]} dataKey="AccX" name={`AccX · ${f.name}`}
                          stroke={GA_AXIS_COLOR.X} strokeDasharray={gaDashFor(i)} dot={false} isAnimationActive={false}
                          hide={hiddenSeries.has(`rms-ax-${i}`)} />
                      ))}
                      {files.map((f, i) => (
                        <Line key={`rms-ay-${i}`} data={rmsData.accY[i]} dataKey="AccY" name={`AccY · ${f.name}`}
                          stroke={GA_AXIS_COLOR.Y} strokeDasharray={gaDashFor(i)} dot={false} isAnimationActive={false}
                          hide={hiddenSeries.has(`rms-ay-${i}`)} />
                      ))}
                      {files.map((f, i) => (
                        <Line key={`rms-az-${i}`} data={rmsData.accZ[i]} dataKey="AccZ" name={`AccZ · ${f.name}`}
                          stroke={GA_AXIS_COLOR.Z} strokeDasharray={gaDashFor(i)} dot={false} isAnimationActive={false}
                          hide={hiddenSeries.has(`rms-az-${i}`)} />
                      ))}
                      {peakDots(files.flatMap((_f, i) => ([
                        { data: rmsData.accX[i], key: "AccX", id: `rms-ax-${i}`, color: GA_AXIS_COLOR.X },
                        { data: rmsData.accY[i], key: "AccY", id: `rms-ay-${i}`, color: GA_AXIS_COLOR.Y },
                        { data: rmsData.accZ[i], key: "AccZ", id: `rms-az-${i}`, color: GA_AXIS_COLOR.Z },
                      ])))}
                    </LineChart>
                  </ResponsiveContainer>
                </section>

                <section className="panel" style={{ marginBottom: 25 }}>
                  <h3 className="panel-title">RMS · VIBRATION vs RPM{rangeSuffix}</h3>
                  <ResponsiveContainer width="100%" height={chartH}>
                    <LineChart margin={{ top: 8, right: 24, bottom: 8, left: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.12)" />
                      <XAxis dataKey="xval" type="number" domain={rmsXAxisDomain}
                        tick={{ fill: "#888", fontSize: 10 }} label={{ value: "RPM", position: "insideBottom", offset: 2, fill: "#888", fontSize: 11 }} />
                      <YAxis domain={[rmsVibTicks[0], rmsVibTicks[rmsVibTicks.length - 1]]} ticks={rmsVibTicks}
                        tickFormatter={(v) => Number(v.toFixed(2)).toString()}
                        tick={{ fill: "#888", fontSize: 9 }} label={{ value: "g", angle: -90, position: "insideLeft", fill: "#888", fontSize: 11 }} />
                      <Tooltip contentStyle={{ background: "#1a1a1a", border: "1px solid #333", fontSize: 13 }}
                        labelFormatter={(v) => `${Math.round(Number(v))} RPM`}
                        formatter={(v: any) => Number(v).toFixed(3)} />
                      <Legend payload={rmsVibLegendPayload} onClick={(o: any) => toggleSeries(o.id)}
                        formatter={legendFormatter} wrapperStyle={{ fontSize: 13, cursor: "pointer" }} />
                      {files.map((f, i) => (
                        <Line key={`rms-vx-${i}`} data={rmsData.vibX[i]} dataKey="VibX" name={`VibX · ${f.name}`}
                          stroke={GA_AXIS_COLOR.X} strokeDasharray={gaDashFor(i)} dot={false} isAnimationActive={false}
                          hide={hiddenSeries.has(`rms-vx-${i}`)} />
                      ))}
                      {files.map((f, i) => (
                        <Line key={`rms-vy-${i}`} data={rmsData.vibY[i]} dataKey="VibY" name={`VibY · ${f.name}`}
                          stroke={GA_AXIS_COLOR.Y} strokeDasharray={gaDashFor(i)} dot={false} isAnimationActive={false}
                          hide={hiddenSeries.has(`rms-vy-${i}`)} />
                      ))}
                      {files.map((f, i) => (
                        <Line key={`rms-vz-${i}`} data={rmsData.vibZ[i]} dataKey="VibZ" name={`VibZ · ${f.name}`}
                          stroke={GA_AXIS_COLOR.Z} strokeDasharray={gaDashFor(i)} dot={false} isAnimationActive={false}
                          hide={hiddenSeries.has(`rms-vz-${i}`)} />
                      ))}
                      {peakDots(files.flatMap((_f, i) => ([
                        { data: rmsData.vibX[i], key: "VibX", id: `rms-vx-${i}`, color: GA_AXIS_COLOR.X },
                        { data: rmsData.vibY[i], key: "VibY", id: `rms-vy-${i}`, color: GA_AXIS_COLOR.Y },
                        { data: rmsData.vibZ[i], key: "VibZ", id: `rms-vz-${i}`, color: GA_AXIS_COLOR.Z },
                      ])))}
                    </LineChart>
                  </ResponsiveContainer>
                </section>
              </>
            )}

            {showSpec && (
              <>
                <section className="panel" style={{ marginBottom: 25 }}>
                  <h3 className="panel-title">
                    SPECTRUM · {specAxis === "VIB" ? "VIBRATION" : "ACCELERATION"}
                    {orderRpm > 0 ? ` · ${Math.round(orderRpm)} RPM` : ""}{rangeSuffix}
                  </h3>

                  {spectrumData.every(d => !d.usable) ? (
                    <div style={{ padding: "40px 10px", color: "#888", fontSize: 13, lineHeight: 1.6 }}>
                      Not enough contiguous samples to transform.
                      {targetModeActive
                        ? " Try widening the RPM WINDOW tolerance — the segment must be one unbroken stretch of the recording."
                        : " Set an RPM WINDOW to select a constant-speed segment."}
                    </div>
                  ) : (
                    <>
                      <ResponsiveContainer width="100%" height={chartH}>
                        <LineChart margin={{ top: 8, right: 24, bottom: 8, left: 0 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.12)" />
                          <XAxis dataKey="xval" type="number" domain={[0, specCap]}
                            tick={{ fill: "#888", fontSize: 10 }}
                            label={{ value: "Frequency (Hz)", position: "insideBottom", offset: 2, fill: "#888", fontSize: 11 }} />
                          <YAxis tick={{ fill: "#888", fontSize: 9 }}
                            tickFormatter={(v) => Number(v).toFixed(3)}
                            label={{ value: "amplitude (g)", angle: -90, position: "insideLeft", fill: "#888", fontSize: 11 }} />
                          <Tooltip
                            contentStyle={{ background: "#1a1a1a", border: "1px solid #333", fontSize: 13 }}
                            labelFormatter={(v) => `${Number(v).toFixed(2)} Hz`}
                            formatter={(v: any) => Number(v).toFixed(5)} />
                          <Legend wrapperStyle={{ fontSize: 13, cursor: "pointer" }}
                            onClick={(o: any) => toggleSeries(o.id)}
                            formatter={legendFormatter}
                            payload={spectrumData.flatMap((d, i) => (
                              (specAxis === "VIB"
                                ? [["VibX", "X"], ["VibY", "Y"], ["VibZ", "Z"]]
                                : [["AccX", "X"], ["AccY", "Y"], ["AccZ", "Z"]]
                              ).map(([label, ax]) => ({
                                value: `${label} · ${d.name}`,
                                id: `spec-${ax.toLowerCase()}-${i}`,
                                color: (GA_AXIS_COLOR as any)[ax],
                                type: "line" as const,
                              }))
                            ))} />

                          {/* Rotor order markers. These are where imbalance
                              (1x) and blade-pass (2x on a 2-blade rotor)
                              MUST appear if they are present at all, so
                              they turn an anonymous peak into a diagnosis. */}
                          {showOrders && orders.map(o => (
                            <ReferenceLine key={`ord-${o.order}`} x={o.freq}
                              stroke="#ffb347" strokeDasharray="4 4" strokeOpacity={0.6}
                              label={{ value: `${o.order}x`, position: "top", fill: "#ffb347", fontSize: 10 }} />
                          ))}

                          {spectrumData.flatMap((d, i) => (
                            (specAxis === "VIB"
                              ? [["VibX", "vibX", "X"], ["VibY", "vibY", "Y"], ["VibZ", "vibZ", "Z"]]
                              : [["AccX", "accX", "X"], ["AccY", "accY", "Y"], ["AccZ", "accZ", "Z"]]
                            ).map(([label, field, ax]) => (
                              <Line
                                key={`spec-${ax}-${i}`}
                                data={specSeries((d as any)[field], label, specCap)}
                                dataKey={label}
                                name={`${label} · ${d.name}`}
                                stroke={(GA_AXIS_COLOR as any)[ax]}
                                strokeDasharray={gaDashFor(i)}
                                strokeWidth={1}
                                dot={false}
                                isAnimationActive={false}
                                hide={hiddenSeries.has(`spec-${ax.toLowerCase()}-${i}`)}
                              />
                            ))
                          ))}
                        </LineChart>
                      </ResponsiveContainer>

                      {/* Peak amplitude at each order — the number an
                          analyst actually writes down. Interpolated, so it
                          does not under-read by up to 15% the way a raw
                          bin maximum would. */}
                      {orderTable.length > 0 && (
                        <div style={{ marginTop: 14, overflowX: "auto" }}>
                          <table style={{ borderCollapse: "collapse", fontSize: 12, width: "100%" }}>
                            <thead>
                              <tr style={{ color: "#888", textAlign: "right" }}>
                                <th style={{ textAlign: "left", padding: "4px 8px" }}>Order peaks (g)</th>
                                {orders.map(o => (
                                  <th key={o.order} style={{ padding: "4px 8px", whiteSpace: "nowrap" }}>
                                    {o.order}x<br />
                                    <span style={{ color: "#555", fontWeight: 400 }}>{o.freq.toFixed(1)} Hz</span>
                                  </th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {orderTable.map((f, fi) => (
                                <React.Fragment key={fi}>
                                  <tr>
                                    <td colSpan={orders.length + 1}
                                      style={{ color: "#666", padding: "8px 8px 2px", fontSize: 11 }}>
                                      {f.name} — mean {Math.round(f.meanRpm)} RPM
                                    </td>
                                  </tr>
                                  {f.rows.map((r, ri) => (
                                    <tr key={ri} style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }}>
                                      <td style={{
                                        padding: "4px 8px",
                                        color: (GA_AXIS_COLOR as any)[r.label.slice(-1)],
                                      }}>{r.label}</td>
                                      {r.peaks.map(p => (
                                        <td key={p.order} style={{
                                          padding: "4px 8px", textAlign: "right",
                                          color: "#ddd", fontVariantNumeric: "tabular-nums",
                                        }}>
                                          {p.amp > 0 ? p.amp.toFixed(4) : "—"}
                                        </td>
                                      ))}
                                    </tr>
                                  ))}
                                </React.Fragment>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </>
                  )}
                </section>
              </>
            )}

            {showFft && (
              <>
                <section className="panel" style={{ marginBottom: 25 }}>
                  <h3 className="panel-title">
                    WAVEFORM · ACCELERATION vs {targetModeActive ? `RPM ${targetRpm}±${tolerance} (by occurrence)` : "RPM"}{rangeSuffix}
                  </h3>
                  {waveformDecimation && (
                    <div style={{ fontSize: 11, color: "#888", marginBottom: 6 }}>
                      Envelope: {waveformDecimation.drawn.toLocaleString()} of{" "}
                      {waveformDecimation.total.toLocaleString()} samples drawn per axis
                      (per-column min/max, budget {PLOT_BUDGET.toLocaleString()}).
                      Peak markers and the g axis are unchanged by this — both extremes of
                      every column are kept. SPECTRUM transforms every sample.
                    </div>
                  )}
                  <ResponsiveContainer width="100%" height={chartH}>
                    <LineChart margin={{ top: 8, right: 24, bottom: 8, left: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.12)" />
                      <XAxis dataKey="xval" type="number" domain={fftXAxisDomain}
                        tick={{ fill: "#888", fontSize: 10 }} label={{ value: fftXAxisLabelText, position: "insideBottom", offset: 2, fill: "#888", fontSize: 11 }} />
                      <YAxis domain={[fftAccTicks[0], fftAccTicks[fftAccTicks.length - 1]]} ticks={fftAccTicks}
                        tickFormatter={(v) => Number(v.toFixed(2)).toString()}
                        tick={{ fill: "#888", fontSize: 9 }} label={{ value: "g", angle: -90, position: "insideLeft", fill: "#888", fontSize: 11 }} />
                      <Tooltip content={<FftTooltip targetModeActive={targetModeActive} />} />
                      <Legend payload={fftAccLegendPayload} onClick={(o: any) => toggleSeries(o.id)}
                        formatter={legendFormatter} wrapperStyle={{ fontSize: 13, cursor: "pointer" }} />
                      {files.map((f, i) => (
                        <Line key={`fft-ax-${i}`} data={fftData.accX[i]} dataKey="AccX" name={`AccX · ${f.name}`}
                          stroke={GA_AXIS_COLOR.X} strokeDasharray={gaDashFor(i)} dot={false} isAnimationActive={false}
                          hide={hiddenSeries.has(`fft-ax-${i}`)} />
                      ))}
                      {files.map((f, i) => (
                        <Line key={`fft-ay-${i}`} data={fftData.accY[i]} dataKey="AccY" name={`AccY · ${f.name}`}
                          stroke={GA_AXIS_COLOR.Y} strokeDasharray={gaDashFor(i)} dot={false} isAnimationActive={false}
                          hide={hiddenSeries.has(`fft-ay-${i}`)} />
                      ))}
                      {files.map((f, i) => (
                        <Line key={`fft-az-${i}`} data={fftData.accZ[i]} dataKey="AccZ" name={`AccZ · ${f.name}`}
                          stroke={GA_AXIS_COLOR.Z} strokeDasharray={gaDashFor(i)} dot={false} isAnimationActive={false}
                          hide={hiddenSeries.has(`fft-az-${i}`)} />
                      ))}
                      {peakDots(files.flatMap((_f, i) => ([
                        { data: fftData.accX[i], key: "AccX", id: `fft-ax-${i}`, color: GA_AXIS_COLOR.X },
                        { data: fftData.accY[i], key: "AccY", id: `fft-ay-${i}`, color: GA_AXIS_COLOR.Y },
                        { data: fftData.accZ[i], key: "AccZ", id: `fft-az-${i}`, color: GA_AXIS_COLOR.Z },
                      ])))}
                    </LineChart>
                  </ResponsiveContainer>
                </section>

                <section className="panel">
                  <h3 className="panel-title">
                    WAVEFORM · VIBRATION vs {targetModeActive ? `RPM ${targetRpm}±${tolerance} (by occurrence)` : "RPM"}{rangeSuffix}
                  </h3>
                  <ResponsiveContainer width="100%" height={chartH}>
                    <LineChart margin={{ top: 8, right: 24, bottom: 8, left: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.12)" />
                      <XAxis dataKey="xval" type="number" domain={fftXAxisDomain}
                        tick={{ fill: "#888", fontSize: 10 }} label={{ value: fftXAxisLabelText, position: "insideBottom", offset: 2, fill: "#888", fontSize: 11 }} />
                      <YAxis domain={[fftVibTicks[0], fftVibTicks[fftVibTicks.length - 1]]} ticks={fftVibTicks}
                        tickFormatter={(v) => Number(v.toFixed(2)).toString()}
                        tick={{ fill: "#888", fontSize: 9 }} label={{ value: "g", angle: -90, position: "insideLeft", fill: "#888", fontSize: 11 }} />
                      <Tooltip content={<FftTooltip targetModeActive={targetModeActive} />} />
                      <Legend payload={fftVibLegendPayload} onClick={(o: any) => toggleSeries(o.id)}
                        formatter={legendFormatter} wrapperStyle={{ fontSize: 13, cursor: "pointer" }} />
                      {files.map((f, i) => (
                        <Line key={`fft-vx-${i}`} data={fftData.vibX[i]} dataKey="VibX" name={`VibX · ${f.name}`}
                          stroke={GA_AXIS_COLOR.X} strokeDasharray={gaDashFor(i)} dot={false} isAnimationActive={false}
                          hide={hiddenSeries.has(`fft-vx-${i}`)} />
                      ))}
                      {files.map((f, i) => (
                        <Line key={`fft-vy-${i}`} data={fftData.vibY[i]} dataKey="VibY" name={`VibY · ${f.name}`}
                          stroke={GA_AXIS_COLOR.Y} strokeDasharray={gaDashFor(i)} dot={false} isAnimationActive={false}
                          hide={hiddenSeries.has(`fft-vy-${i}`)} />
                      ))}
                      {files.map((f, i) => (
                        <Line key={`fft-vz-${i}`} data={fftData.vibZ[i]} dataKey="VibZ" name={`VibZ · ${f.name}`}
                          stroke={GA_AXIS_COLOR.Z} strokeDasharray={gaDashFor(i)} dot={false} isAnimationActive={false}
                          hide={hiddenSeries.has(`fft-vz-${i}`)} />
                      ))}
                      {peakDots(files.flatMap((_f, i) => ([
                        { data: fftData.vibX[i], key: "VibX", id: `fft-vx-${i}`, color: GA_AXIS_COLOR.X },
                        { data: fftData.vibY[i], key: "VibY", id: `fft-vy-${i}`, color: GA_AXIS_COLOR.Y },
                        { data: fftData.vibZ[i], key: "VibZ", id: `fft-vz-${i}`, color: GA_AXIS_COLOR.Z },
                      ])))}
                    </LineChart>
                  </ResponsiveContainer>
                </section>
              </>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
