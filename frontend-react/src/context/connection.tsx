// ── Universal connect [NEW v13] ──────────────────────────────────────────────
//
// The operator connects to the Arduino ONCE, not once per tab.
//
// Before v13 the Control tab owned `connStatus` and the whole connect
// sequence inside its own render, and Configure New Motor had no Connect
// control at all — it polled /status and, when disconnected, told the user
// to go to the Control tab and connect there. Two tabs, one port, one of
// them able to open it.
//
// Connection state now lives ABOVE the tabs, so it survives a tab switch
// exactly as the serial port, the CSV log and the Arduino's loaded range
// always did. The tab bar renders the connection bar; both hardware tabs
// read the same context.
//
// **The backend stays the source of truth.** This provider mirrors /status
// rather than replacing it — connection, baud, log state, sampling rate and
// the confirmed throttle range are all read back from the backend, because
// only the backend knows what the firmware actually acknowledged. The v11
// "adopt state on mount" behaviour is preserved and generalised: it now runs
// once for the whole application instead of once per Control-tab mount.
//
// **What must not break.** Configure New Motor deliberately MOVES the
// validated throttle range during calibration and restores it when the tab
// unmounts. That cleanup is load-bearing: a stale 1000–2000 µs range left
// loaded would let the Control tab's Auto Test sweep a motor rated to 1515.
// Hoisting connection state must not change when that tab unmounts, so this
// provider owns the connection and nothing else — calibration stays entirely
// inside the tab that performs it.

import React, {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from "react";
import { api, ApiError } from "../hooks/useApi";
import { ConnectionStatus, SamplingRateId } from "../types";
import {
  MotorProfile, BUILTIN_MOTOR_PROFILES, useMotorProfiles,
} from "../lib/motorProfiles";

export interface SamplingRateOption {
  id: SamplingRateId;
  label: string;
  recommendedBaud: number;
}

export const SAMPLING_RATES: SamplingRateOption[] = [
  { id: "DEFAULT", label: "Default (Current Behaviour)", recommendedBaud: 115200 },
  { id: "416",     label: "416 Hz",                       recommendedBaud: 460800 },
  { id: "833",     label: "833 Hz",                       recommendedBaud: 921600 },
];

export const BAUD_RATES = [9600, 57600, 115200, 230400, 460800, 921600];

const EXPECTED_PROTOCOL = "binary-v9";
// [v15] First firmware that stops the motor on an IMU fault or a silent host.
const MIN_SAFE_FW = 11;

export interface FirmwareFault {
  kind: "imu" | "failsafe" | "reboot" | string;
  message: string;
  at: number;
}

interface ConnectionState {
  status: ConnectionStatus;
  connected: boolean;
  ports: string[];
  port: string;
  setPort: (p: string) => void;
  refreshPorts: () => Promise<void>;
  baud: number;
  setBaud: (b: number) => void;
  activeBaud: number | null;
  baudSwitchWarning: string | null;

  samplingRateId: SamplingRateId;
  setSamplingRateId: (s: SamplingRateId) => void;
  samplingRate: SamplingRateOption;
  samplingRateAckError: string | null;
  pairingWarning: string | null;

  motorProfiles: MotorProfile[];
  motorProfileId: string;
  setMotorProfileId: (id: string) => void;
  motorProfile: MotorProfile;
  confirmedRange: { min: number; max: number } | null;
  profileMismatch: string | null;

  boardInfo: string | null;
  firmwareWarning: string | null;

  // [v15] Link health, mirrored from /status.
  telemetryStalled: boolean;
  telemetryAgeS: number | null;
  firmwareFault: FirmwareFault | null;
  linkError: string | null;
  backendUnresponsive: boolean;
  dismissFirmwareFault: () => Promise<void>;

  logging: boolean;
  logFile: string | null;
  setLogging: (v: boolean) => void;
  setLogFile: (f: string | null) => void;

  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  refreshFromBackend: () => Promise<void>;
}

const Ctx = createContext<ConnectionState | null>(null);

export function useConnection(): ConnectionState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useConnection must be used inside <ConnectionProvider>");
  return v;
}

export function useOptionalConnection(): ConnectionState | null {
  return useContext(Ctx);
}

export function ConnectionProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<ConnectionStatus>("disconnected");
  const [ports, setPorts] = useState<string[]>([]);
  const [port, setPort] = useState("");
  const [baud, setBaud] = useState(115200);
  const [activeBaud, setActiveBaud] = useState<number | null>(null);
  const [baudSwitchWarning, setBaudSwitchWarning] = useState<string | null>(null);

  const [samplingRateId, setSamplingRateId] = useState<SamplingRateId>("DEFAULT");
  const [samplingRateAckError, setSamplingRateAckError] = useState<string | null>(null);

  const motorProfiles = useMotorProfiles();
  const [motorProfileId, setMotorProfileId] = useState(BUILTIN_MOTOR_PROFILES[0].id);
  const [confirmedRange, setConfirmedRange] = useState<{ min: number; max: number } | null>(null);
  const [profileMismatch, setProfileMismatch] = useState<string | null>(null);

  const [boardInfo, setBoardInfo] = useState<string | null>(null);
  const [firmwareWarning, setFirmwareWarning] = useState<string | null>(null);

  const [telemetryStalled, setTelemetryStalled] = useState(false);
  const [telemetryAgeS, setTelemetryAgeS] = useState<number | null>(null);
  const [firmwareFault, setFirmwareFault] = useState<FirmwareFault | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [backendUnresponsive, setBackendUnresponsive] = useState(false);

  const [logging, setLogging] = useState(false);
  const [logFile, setLogFile] = useState<string | null>(null);

  const connected = status === "connected";
  const samplingRate = SAMPLING_RATES.find(s => s.id === samplingRateId) ?? SAMPLING_RATES[0];
  const motorProfile =
    motorProfiles.find(m => m.id === motorProfileId) ?? BUILTIN_MOTOR_PROFILES[0];

  const pairingWarning = baud !== samplingRate.recommendedBaud
    ? `${samplingRate.label} sampling is recommended with ${samplingRate.recommendedBaud} baud. The selected baud rate (${baud}) may not sustain the required throughput.`
    : null;

  const refreshPorts = useCallback(async () => {
    try {
      const r = await api.getPorts();
      setPorts(r.ports || []);
      setPort(p => (p || (r.ports?.length ? r.ports[0] : "")));
    } catch { /* backend not running, or signed out */ }
  }, []);

  useEffect(() => {
    void refreshPorts();
    const t = setInterval(refreshPorts, 4000);
    return () => clearInterval(t);
  }, [refreshPorts]);

  const checkFirmware = useCallback((s: any) => {
    setBoardInfo(s.board_info ?? null);
    const proto = s.firmware_protocol;
    const fw = /FW=v(\d+)/.exec(s.board_info ?? "");
    if (proto && proto !== "unknown" && proto !== EXPECTED_PROTOCOL) {
      setFirmwareWarning(
        `This board is running ${proto} firmware, not ${EXPECTED_PROTOCOL}. ` +
        `It will keep working in compatibility mode, but sampling is limited to ` +
        `~220 Hz, timestamps are host arrival times rather than MCU times, and ` +
        `the data is aliased. Reflash the board before recording measurements.`
      );
    } else if (fw && Number(fw[1]) < MIN_SAFE_FW) {
      setFirmwareWarning(
        `This board is running firmware v${fw[1]}, which cannot stop the motor by ` +
        `itself if the IMU or the USB link fails, and surges the ESC to 50% on ` +
        `every connect. Reflash nwa_testing_software.ino (v${MIN_SAFE_FW}+) before testing.`
      );
    } else {
      setFirmwareWarning(null);
    }
  }, []);

  const refreshFromBackend = useCallback(async () => {
    try {
      const s = await api.getStatus();
      setBackendUnresponsive(false);
      setFirmwareFault(s.firmware_fault ?? null);
      setLinkError(s.link_error ?? null);
      setTelemetryStalled(!!s.telemetry_stalled);
      setTelemetryAgeS(s.telemetry_age_s ?? null);
      if (!s.connected) {
        setStatus(st => (st === "connecting" ? st : "disconnected"));
        return;
      }
      setStatus("connected");
      setActiveBaud(s.active_baud ?? null);
      setLogging(!!s.logging);
      setLogFile(s.log_file || null);
      if (s.confirmed_sampling_rate) setSamplingRateId(s.confirmed_sampling_rate as SamplingRateId);
      checkFirmware(s);

      const min = s.confirmed_thr_min ?? s.active_profile?.thr_min;
      const max = s.confirmed_thr_max ?? s.active_profile?.thr_max;
      if (min == null || max == null) return;
      setConfirmedRange({ min, max });
      const match = motorProfiles.find(p => p.thrMin === min && p.thrMax === max);
      if (match) {
        setMotorProfileId(match.id);
        setProfileMismatch(null);
      } else {
        setProfileMismatch(
          `The Arduino is running ${min}–${max} µs, which matches no saved configuration. ` +
          `Disconnect and reconnect with the intended motor before running a test.`
        );
      }
    } catch (e) {
      // Signed out / not permitted: leave state alone. A timeout is different —
      // the backend is up but not answering, which the operator must see.
      if (e instanceof ApiError && e.status === 0) setBackendUnresponsive(true);
    }
  }, [motorProfiles, checkFirmware]);

  const dismissFirmwareFault = useCallback(async () => {
    try { await api.clearFirmwareFault(); } catch { /* next poll re-reports it */ }
    setFirmwareFault(null);
  }, []);

  const adoptedRef = useRef(false);
  useEffect(() => {
    if (!adoptedRef.current) adoptedRef.current = true;
    void refreshFromBackend();
    const t = setInterval(refreshFromBackend, 2500);
    return () => clearInterval(t);
  }, [refreshFromBackend]);

  const connect = useCallback(async () => {
    if (!port) return;
    setStatus("connecting");
    setConfirmedRange(null);
    setProfileMismatch(null);
    setSamplingRateAckError(null);
    setActiveBaud(null);
    setBaudSwitchWarning(null);
    setFirmwareWarning(null);
    try {
      const r = await api.connect(port, baud);
      if (r.status !== "connected") {
        setStatus("error");
        return;
      }
      setActiveBaud(r.active_baud);
      if (r.active_baud !== baud) {
        setBaudSwitchWarning(
          `Requested ${baud} baud, but the Arduino only confirmed ${r.active_baud}. ` +
          `Connection is active at ${r.active_baud} — sampling may be throttled by this link speed.`
        );
      }

      const cfg = await api.setMotorProfile(motorProfile.thrMin, motorProfile.thrMax);
      if (cfg.confirmed) {
        setConfirmedRange({ min: cfg.thr_min, max: cfg.thr_max });
        if (cfg.thr_min !== motorProfile.thrMin || cfg.thr_max !== motorProfile.thrMax) {
          setProfileMismatch(
            `Arduino confirmed ${cfg.thr_min}–${cfg.thr_max}, not the requested ${motorProfile.thrMin}–${motorProfile.thrMax}.`
          );
        }
      } else {
        setConfirmedRange(
          cfg.reported_thr_min != null ? { min: cfg.reported_thr_min, max: cfg.reported_thr_max } : null
        );
        setProfileMismatch(cfg.message || "Arduino did not confirm the motor configuration.");
      }

      // Each step surfaces its own unconfirmed-warning without aborting the
      // connection — a board that ignores SR: is still a usable board.
      const sr = await api.setSamplingRate(samplingRateId);
      if (!sr.confirmed) {
        setSamplingRateAckError(sr.message || "Arduino did not confirm the sampling rate.");
      }

      setStatus("connected");
      // Picks up board_info / firmware_protocol, which only exist after the
      // firmware's boot lines have been parsed.
      void refreshFromBackend();
    } catch {
      setStatus("error");
    }
  }, [port, baud, motorProfile, samplingRateId, refreshFromBackend]);

  const disconnect = useCallback(async () => {
    try { await api.disconnect(); } catch { /* report via state below */ }
    setStatus("disconnected");
    setLogging(false);
    setLogFile(null);
    setSamplingRateAckError(null);
    setActiveBaud(null);
    setBaudSwitchWarning(null);
    setFirmwareWarning(null);
    setBoardInfo(null);
  }, []);

  const value = useMemo<ConnectionState>(() => ({
    status, connected, ports, port, setPort, refreshPorts,
    baud, setBaud, activeBaud, baudSwitchWarning,
    samplingRateId, setSamplingRateId, samplingRate, samplingRateAckError, pairingWarning,
    motorProfiles, motorProfileId, setMotorProfileId, motorProfile,
    confirmedRange, profileMismatch,
    boardInfo, firmwareWarning,
    telemetryStalled, telemetryAgeS, firmwareFault, linkError, backendUnresponsive,
    dismissFirmwareFault,
    logging, logFile, setLogging, setLogFile,
    connect, disconnect, refreshFromBackend,
  }), [
    status, connected, ports, port, refreshPorts, baud, activeBaud, baudSwitchWarning,
    samplingRateId, samplingRate, samplingRateAckError, pairingWarning,
    motorProfiles, motorProfileId, motorProfile, confirmedRange, profileMismatch,
    boardInfo, firmwareWarning,
    telemetryStalled, telemetryAgeS, firmwareFault, linkError, backendUnresponsive,
    dismissFirmwareFault,
    logging, logFile, connect, disconnect, refreshFromBackend,
  ]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
