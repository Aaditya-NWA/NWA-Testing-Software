export interface SensorData {
  throttle: number;
  rpm: number;
  accX: number;
  accY: number;
  accZ: number;
  vibX: number;
  vibY: number;
  vibZ: number;
  ts: number;

  sampleIndex?: number;
  /** Per-sample time from the MCU's own micros(), placed on the
   *  fitted uniform grid. This — not `ts` — is the real sample clock. */
  mcuUs?: number;
  /** Legacy RPM from pulse count per 500 ms window. Inherently
   *  quantised to ~120 RPM steps. */
  rpmCount?: number;
  /** RPM from mean pulse interval — continuous resolution. `rpm`
   *  carries this when the motor is turning. */
  rpmPeriod?: number;

  __k?: number;
}

export interface AcquisitionStats {
  /** Sample rate measured from the MCU's own clock, not inferred from
   *  arrival times. */
  rateHz: number;
  framesLost: number;
  crcErrors: number;
  fifoOverruns: number;
  protocol: "binary-v9" | "legacy-ascii" | "unknown" | string;
}

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

// [NEW] IMU sampling rate mode — mirrors the Arduino's SR:<mode> command
export type SamplingRateId = "DEFAULT" | "416" | "833";

// ── Tab 2: Correction Mass Calculation ───────────────────────
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