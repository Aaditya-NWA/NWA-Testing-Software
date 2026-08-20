// ── Motor profiles [MOVED + EXTENDED v11] ────────────────────────────────────
//
// A motor profile is everything derived from THR_MIN/THR_MAX. On connect,
// /set_motor_profile sends CONFIG:<min>,<max> to the Arduino (firmware v4+)
// so it recalculates its ramp arrays at runtime — no reflash needed when
// switching motors.
//
// [v11] There are now two sources of profiles, and the distinction matters:
//
//   BUILTIN_MOTOR_PROFILES  the three that have always been hardcoded here.
//                           They are also the firmware's boot default, and
//                           they cannot be edited or deleted from the UI.
//
//   custom profiles         measured on the bench in the MOTOR CONFIG tab
//                           and persisted by the BACKEND (motor_profiles.json,
//                           see motor_profiles.py for why not localStorage).
//
// This module is the single place both are merged, so every consumer — the
// CONTROL tab's dropdown, the Motor Config tab's duplicate check — sees the
// same list in the same order. It is a tiny external store rather than React
// state because the two tabs that care never exist at the same time (App
// unmounts a tab when you switch away from it), so the list has to survive
// outside the component tree or a profile saved in one tab would not appear
// in the other until a page reload.

import { useEffect, useSyncExternalStore } from "react";
import { api } from "../hooks/useApi";

export interface MotorProfile {
  id: string;
  label: string;
  thrMin: number;     // µs — 0% / off
  thrMax: number;     // µs — 100%
  rpmGaugeMax: number;
  /** false/undefined for the hardcoded three; true for anything the
   *  operator calibrated. Only these can be deleted or overwritten. */
  custom?: boolean;
  spinUpUs?: number | null;
  /** The highest throttle the calibration sweep reached. */
  maxMeasuredUs?: number | null;
  notes?: string | null;
  updatedAt?: string | null;
}

export const BUILTIN_MOTOR_PROFILES: MotorProfile[] = [
  { id: "u15ii_kv100", label: "U15II KV100 (48V)", thrMin: 1025, thrMax: 1600, rpmGaugeMax: 2800 },
  { id: "u7_v2",       label: "U7 V2.0 KV490",      thrMin: 1165, thrMax: 1515, rpmGaugeMax: 6500 },
  { id: "v605_kv210",  label: "V605 KV210 (test range)", thrMin: 1000, thrMax: 2000, rpmGaugeMax: 9000 },
];

export const ABS_MIN_US = 800;
export const ABS_MAX_US = 2400;
export const MIN_SPAN_US = 10;

// ── The store ────────────────────────────────────────────────────────────────
let customProfiles: MotorProfile[] = [];
let merged: MotorProfile[] = BUILTIN_MOTOR_PROFILES;
let loaded = false;

const listeners = new Set<() => void>();

const BUILTIN_IDS = new Set(BUILTIN_MOTOR_PROFILES.map(p => p.id));

function emit() {
  const fromBackend = customProfiles;
  const seen = new Set(fromBackend.map(p => p.id));
  const fallback = loaded
    ? []
    : BUILTIN_MOTOR_PROFILES.filter(p => !seen.has(p.id));
  merged = [...fallback, ...fromBackend];
  if (merged.length === 0) merged = BUILTIN_MOTOR_PROFILES;
  listeners.forEach(l => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

interface ApiProfile {
  id: string;
  label: string;
  thr_min: number;
  thr_max: number;
  rpm_gauge_max: number;
  spin_up_us?: number | null;
  max_measured_us?: number | null;
  notes?: string | null;
  updated_at?: string | null;
}

const fromApi = (p: ApiProfile): MotorProfile => ({
  id: p.id,
  label: p.label,
  thrMin: p.thr_min,
  thrMax: p.thr_max,
  rpmGaugeMax: p.rpm_gauge_max,
  custom: !BUILTIN_IDS.has(p.id),
  spinUpUs: p.spin_up_us ?? null,
  maxMeasuredUs: p.max_measured_us ?? null,
  notes: p.notes ?? null,
  updatedAt: p.updated_at ?? null,
});

export async function refreshMotorProfiles(): Promise<void> {
  try {
    const j = await api.getMotorProfiles();
    customProfiles = Array.isArray(j.profiles) ? j.profiles.map(fromApi) : [];
  } catch {
    customProfiles = [];
  }
  loaded = true;
  emit();
}

export interface SaveProfileInput {
  label: string;
  thrMin: number;
  thrMax: number;
  rpmGaugeMax: number;
  spinUpUs?: number | null;
  maxMeasuredUs?: number | null;
  notes?: string | null;
  /** Set to update an existing profile in place. */
  id?: string;
  overwrite?: boolean;
}

/** Returns the saved profile, or throws with the backend's message. */
export async function saveMotorProfile(input: SaveProfileInput): Promise<MotorProfile> {
  const j = await api.saveMotorProfile({
    label: input.label,
    thr_min: input.thrMin,
    thr_max: input.thrMax,
    rpm_gauge_max: input.rpmGaugeMax,
    spin_up_us: input.spinUpUs ?? null,
    max_measured_us: input.maxMeasuredUs ?? null,
    notes: input.notes ?? null,
    id: input.id ?? null,
    overwrite: !!input.overwrite,
  });
  if (j.status !== "ok") throw new Error(j.message || "Could not save the motor profile.");
  await refreshMotorProfiles();
  return fromApi(j.profile);
}

export async function deleteMotorProfiles(ids: string[]): Promise<string[]> {
  const j = await api.deleteMotorProfiles(ids);
  if (j.status !== "ok") throw new Error(j.message || "Could not delete the configurations.");
  await refreshMotorProfiles();
  return j.deleted ?? [];
}

/** Built-ins followed by every calibrated profile. The reference is stable
 *  between changes, so it is safe in dependency arrays. */
export function useMotorProfiles(): MotorProfile[] {
  const list = useSyncExternalStore(subscribe, () => merged, () => merged);
  useEffect(() => {
    if (loaded) return;
    loaded = true;
    void refreshMotorProfiles();
  }, []);
  return list;
}

/** Same normalisation the backend uses for collision detection. */
export const normaliseLabel = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

export function profileRangeError(thrMin: number, thrMax: number): string | null {
  if (!Number.isFinite(thrMin) || !Number.isFinite(thrMax)) return "Throttle values must be numbers";
  if (thrMin < ABS_MIN_US || thrMin > ABS_MAX_US) return `0% throttle must be ${ABS_MIN_US}–${ABS_MAX_US} µs`;
  if (thrMax < ABS_MIN_US || thrMax > ABS_MAX_US) return `100% throttle must be ${ABS_MIN_US}–${ABS_MAX_US} µs`;
  if (thrMin >= thrMax) return "0% throttle must be below 100% throttle";
  if (thrMax - thrMin < MIN_SPAN_US) return `Range must span at least ${MIN_SPAN_US} µs`;
  return null;
}
