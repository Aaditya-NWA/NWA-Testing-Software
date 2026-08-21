const BASE = "http://localhost:8000";

let authToken: string | null = null;

export function setAuthToken(t: string | null) {
  authToken = t;
}

export function getAuthToken(): string | null {
  return authToken;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

function headers(isPost: boolean): Record<string, string> {
  const h: Record<string, string> = {};
  if (isPost) h["Content-Type"] = "application/json";
  if (authToken) h["Authorization"] = `Bearer ${authToken}`;
  return h;
}

async function req(path: string, body?: object | null, forcePost = false) {
  const isPost = body !== undefined || forcePost;
  const r = await fetch(`${BASE}${path}`, {
    method: isPost ? "POST" : "GET",
    headers: headers(isPost),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401 || r.status === 403) {
    let detail = r.status === 401 ? "Not signed in" : "Not permitted";
    try { detail = (await r.json()).detail || detail; } catch { /* keep default */ }
    throw new ApiError(r.status, detail);
  }
  return r.json();
}

/** Readiness probe for the startup gate. [NEW v14]
 *
 *  Deliberately outside `req()`: it must resolve to null on a refused
 *  connection rather than throw, because "nothing is listening yet" is the
 *  normal state for the first second of every launch. The signature check
 *  stops some unrelated service on port 8000 from reading as our backend. */
export async function probeHealth(): Promise<{ version: string } | null> {
  try {
    const r = await fetch(`${BASE}/health`, { cache: "no-store" });
    if (!r.ok) return null;
    const j = await r.json();
    return j?.app === "nwa-testing-software" ? j : null;
  } catch {
    return null;
  }
}

// [NEW v11] Saved motor profiles are the only resource with a DELETE.
export const api = {
  // ── [NEW v13] Auth ────────────────────────────────────────────────────
  login:                (username: string, password: string)                 => req("/login",                  { username, password }),
  logout:               ()                                                    => req("/logout",                 null, true),
  me:                   ()                                                    => req("/me"),

  logActivity:          (event: string, detail = "")                          => req("/activity/log",           { event, detail }),
  logsFolder:           ()                                                    => req("/activity/folder"),
  openLogsFolder:       ()                                                    => req("/activity/open_folder",   null, true),

  getPorts:             ()                                                    => req("/ports"),
  connect:              (port: string, baud: number)                          => req("/connect",               { port, baud_rate: baud }),
  disconnect:           ()                                                    => req("/disconnect",             null, true),
  // [NEW] Motor profile — pushes THR_MIN/THR_MAX to backend right after connect
  setMotorProfile:      (thr_min: number, thr_max: number)                    => req("/set_motor_profile",      { thr_min, thr_max }),
  // [NEW] Sampling rate — pushes the selected IMU sampling mode to the Arduino right after connect
  setSamplingRate:      (mode: string)                                        => req("/set_sampling_rate",      { mode }),
  setThrottle:          (value: number)                                       => req("/set_throttle",           { value }),
  emergencyStop:        ()                                                    => req("/emergency_stop",         null, true),
  startLogging:         (filename?: string)                                   => req("/start_logging",          filename ? { filename } : null, true),
  stopLogging:          ()                                                    => req("/stop_logging",           null, true),
  getStatus:            ()                                                    => req("/status"),
  startAutoTest:        ()                                                    => req("/start_auto_test",        null, true),
  stopAutoTest:         ()                                                    => req("/stop_auto_test",         null, true),
  // [NEW] Throttle Hold (replaces RPM Hold) — now the Step Test's SINGLE
  // mode. Left exactly as it was: a one-step test is still one command.
  startThrottleHold:    (target_us: number, hold_ms: number)                  => req("/start_throttle_hold",   { target_us, hold_ms }),
  stopThrottleHold:     ()                                                    => req("/stop_throttle_hold",    null, true),
  // [NEW v10] Step Test MULTIPLE mode — the backend chains one firmware
  // THROTTLE_HOLD per step; see the block comment in main.py.
  startStepTest:        (steps: { target_us: number; hold_ms: number }[])     => req("/start_step_test",       { steps }),
  stopStepTest:         ()                                                    => req("/stop_step_test",        null, true),
  getStepTestStatus:    ()                                                    => req("/step_test_status"),
  getMotorProfiles:     ()                                                    => req("/motor_profiles"),
  saveMotorProfile:     (p: object)                                           => req("/motor_profiles",        p),
  deleteMotorProfiles:  (ids: string[])                                       => req("/motor_profiles/delete", { ids }),
};
