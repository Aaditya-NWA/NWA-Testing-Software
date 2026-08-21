"""
FastAPI backend: serial link, CSV logging, telemetry fan-out, and the HTTP
surface the dashboard drives.

Role gates are expressed as TABS (auth.ROLE_TABS), so the tab bar and the API
derive from one table. UI-only enforcement would be none at all -- a second
browser tab reaches the same port.

active_profile holds the throttle range the firmware CONFIRMED, and is the
validation gate for /set_throttle, /start_throttle_hold and /start_step_test.
It is updated only on a confirmed CONFIG.

The Step Test sequencer is host-side: the firmware sets throttle = THR_MIN on
every THROTTLE_HOLD command, so holds cannot be chained. _run_step_test walks
the plain throttle command instead, at _RAMP_STEP_US per _RAMP_TICK_S to match
the firmware's own ramp.
"""
import asyncio
import os
import subprocess
import sys
from contextlib import asynccontextmanager

import serial.tools.list_ports
from fastapi import (
    Depends, FastAPI, Header, HTTPException, Query, WebSocket, WebSocketDisconnect,
)
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Literal, Optional

import console_tee
console_tee.install()

import activity_log
import app_paths
import auth
import version
import motor_profiles as motor_profile_store
from serial_manager import SerialManager
from logger import CSVLogger
from websocket_manager import WebSocketManager

ws_manager = WebSocketManager()
csv_logger = CSVLogger()
serial_mgr = SerialManager(ws_manager=ws_manager, csv_logger=csv_logger)


@asynccontextmanager
async def lifespan(app: FastAPI):
    motor_profile_store.ensure_seeded()
    activity_log.log("APP_START", f"backend up, data root={app_paths.app_root()}")
    yield
    # [NEW v10] Cancel before the port closes — otherwise the sequencer
    # keeps writing THROTTLE_HOLD commands into a dead serial handle.
    await _cancel_step_test()
    await serial_mgr.disconnect_async()
    csv_logger.stop()
    activity_log.log("APP_STOP", "backend shutting down")


app = FastAPI(title="Motor DAQ API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Process lifecycle: the two endpoints the desktop shell drives ─────────────
# Both are deliberately outside the role gates. /health has to answer before
# anyone has signed in — it is what the "Starting up..." screen waits on — and
# /shutdown has to work when the only caller is the shell, which has no session.

SERVER = None   # set by run_backend.py; None when running under `uvicorn --reload`

HEALTH_SIGNATURE = "nwa-testing-software"


@app.get("/health")
def health():
    """Liveness + identity. Unauthenticated by necessity.

    `app` is an identity check, not decoration: the shell uses it to tell an
    orphaned backend of ours on port 8000 apart from some unrelated service,
    and those two need opposite recovery paths.
    """
    return {
        "status": "ok",
        "app": HEALTH_SIGNATURE,
        "version": version.APP_VERSION,
        "pid": os.getpid(),
        "connected": serial_mgr.is_connected,
        "frozen": app_paths.is_frozen(),
    }


@app.post("/shutdown")
def shutdown(token: Optional[str] = Query(None)):
    """Graceful stop — the safety-relevant exit path.

    Setting should_exit lets uvicorn unwind the lifespan, and it is the
    lifespan's teardown that calls disconnect_async(), which writes THR_MIN
    and flushes it before closing the port. Killing the process instead skips
    all of that and leaves the motor at its last commanded throttle, because
    the firmware has no serial-loss failsafe.

    The token comes from the runtime file (app_paths.runtime_file()), which a
    web page cannot read. Without that gate any page the operator had open
    could stop a running test with one cross-origin POST.
    """
    expected = os.environ.get("NWA_SHUTDOWN_TOKEN")
    if not expected:
        raise HTTPException(status_code=503, detail="Not running under the desktop shell")
    if token != expected:
        raise HTTPException(status_code=403, detail="Bad shutdown token")
    if SERVER is None:
        raise HTTPException(status_code=503, detail="No server handle")
    activity_log.log("SHUTDOWN_REQ", "graceful shutdown requested by the shell")
    SERVER.should_exit = True
    return {"status": "stopping"}


def current_session(authorization: Optional[str] = Header(None)) -> auth.Session:
    token = None
    if authorization and authorization.lower().startswith("bearer "):
        token = authorization[7:].strip()
    s = auth.session_for(token)
    if s is None:
        raise HTTPException(status_code=401, detail="Not signed in")
    return s


def _needs(*tabs):
    """Dependency factory: caller must hold at least one of `tabs`."""
    def dep(sess: auth.Session = Depends(current_session)) -> auth.Session:
        if not sess.may_any(tabs):
            activity_log.log(
                "DENIED", f"role {sess.role} lacks {'/'.join(tabs)}", sess
            )
            raise HTTPException(
                status_code=403,
                detail=f"The {sess.role} role does not have access to this function.",
            )
        return sess
    return dep


needs_hardware  = _needs(*auth.HARDWARE_TABS)
needs_control   = _needs(auth.TAB_CONTROL)
needs_motorcfg  = _needs(auth.TAB_MOTOR_CONFIG)
needs_login     = current_session


class LoginRequest(BaseModel):
    username: str
    password: str


@app.post("/login")
def login(req: LoginRequest):
    s = auth.login(req.username, req.password)
    if s is None:
        activity_log.log("LOGIN_FAIL", f"username={req.username!r}")
        return {"status": "error", "message": "Incorrect username or password."}
    activity_log.log("LOGIN", f"role={s.role}", s)
    return {"status": "ok", "token": s.token, **s.public()}


@app.post("/logout")
def logout(sess: auth.Session = Depends(current_session)):
    if serial_mgr.is_connected:
        activity_log.log("LOGOUT_BLOCKED", "still connected to the Arduino", sess)
        return {
            "status": "error",
            "message": "Disconnect from the Arduino before signing out.",
        }
    auth.logout(sess.token)
    activity_log.log("LOGOUT", "", sess)
    return {"status": "ok"}


@app.get("/me")
def me(sess: auth.Session = Depends(current_session)):
    return {"status": "ok", **sess.public()}


# ── [NEW v13] Activity log ───────────────────────────────────────────────────
class ActivityRequest(BaseModel):
    event: str
    detail: str = ""


@app.post("/activity/log")
def post_activity(req: ActivityRequest, sess: auth.Session = Depends(current_session)):
    """UI-only events the backend cannot observe — tab switches, info panels.

    Without this the log would tell half the story: everything that touched
    the serial port, and nothing about what the operator was looking at when
    they hit the problem.
    """
    activity_log.log(req.event[:24].upper(), req.detail[:400], sess)
    return {"status": "ok"}


@app.get("/activity/folder")
def activity_folder(sess: auth.Session = Depends(current_session)):
    return {
        "status": "ok",
        "folder": activity_log.logs_folder(),
        "today": activity_log.current_log_file(),
    }


@app.post("/activity/open_folder")
def open_activity_folder(sess: auth.Session = Depends(current_session)):
    """Open the Logs folder in the OS file browser.

    The operator is on another machine; "send me the log" works far better
    when the folder is one button away than when it is a path they have to
    paste somewhere.
    """
    folder = activity_log.logs_folder()
    try:
        if sys.platform == "win32":
            os.startfile(folder)
        elif sys.platform == "darwin":
            subprocess.Popen(["open", folder])
        else:
            subprocess.Popen(["xdg-open", folder])
        activity_log.log("OPEN_LOGS", folder, sess)
        return {"status": "ok", "folder": folder}
    except Exception as e:
        return {"status": "error", "message": str(e), "folder": folder}


# ── Request models ─────────────────────────────────────────────────────────────
class ConnectRequest(BaseModel):
    port: str
    baud_rate: int = 115200

class ThrottleRequest(BaseModel):
    value: int

class StartLoggingRequest(BaseModel):
    filename: Optional[str] = None

# [NEW] Motor profile request — pushed by frontend right after /connect
class MotorProfileRequest(BaseModel):
    thr_min: int
    thr_max: int

# Active motor profile (defaults to U15II KV100 values; updated via /set_motor_profile)
active_profile = {"thr_min": 1025, "thr_max": 1600}

# [NEW] Throttle Hold request
class ThrottleHoldRequest(BaseModel):
    target_us: int              # throttle µs to ramp to and hold
    hold_ms: int                # how long to hold (milliseconds)

class StepSpec(BaseModel):
    target_us: int
    hold_ms: int

class StepTestRequest(BaseModel):
    steps: List[StepSpec]

# Guard rail, not a tuning knob. Each step is a firmware command with its
# own ramp; a runaway list would be a very long unattended motor run.
MAX_STEPS = 20

# [NEW] Sampling rate request — pushed by frontend right after /connect
# (and /set_motor_profile), mirroring how the motor profile is applied.
class SamplingRateRequest(BaseModel):
    mode: Literal["DEFAULT", "416", "833"] = "DEFAULT"


# ── Endpoints ──────────────────────────────────────────────────────────────────
@app.get("/ports")
def list_ports(sess: auth.Session = Depends(needs_hardware)):
    ports = [p.device for p in serial.tools.list_ports.comports()]
    return {"ports": ports}


@app.post("/connect")
async def connect(req: ConnectRequest, sess: auth.Session = Depends(needs_hardware)):
    try:
        await serial_mgr.connect_async(req.port, req.baud_rate)
        activity_log.log(
            "CONNECT",
            f"port={req.port} requested_baud={req.baud_rate} "
            f"active_baud={serial_mgr.current_baud} board={serial_mgr.board_info or '-'}",
            sess,
        )
        return {
            "status": "connected",
            "port": req.port,
            "requested_baud": req.baud_rate,
            "active_baud": serial_mgr.current_baud,
        }
    except Exception as e:
        activity_log.log("CONNECT_FAIL", f"port={req.port}: {e}", sess)
        return {"status": "error", "message": str(e)}


@app.post("/disconnect")
async def disconnect(sess: auth.Session = Depends(needs_hardware)):
    await _cancel_step_test()   # [NEW v10] see lifespan()
    await serial_mgr.disconnect_async()
    activity_log.log(
        "DISCONNECT", f"throttle commanded to {active_profile['thr_min']}us, port closed", sess
    )
    return {"status": "disconnected"}


@app.post("/set_motor_profile")
async def set_motor_profile(
    req: MotorProfileRequest, sess: auth.Session = Depends(needs_hardware)
):
    if req.thr_min >= req.thr_max:
        return {"status": "error", "message": "thr_min must be less than thr_max"}
    if not serial_mgr.is_connected:
        return {"status": "error", "message": "Not connected"}

    confirmed, actual_min, actual_max = await asyncio.to_thread(
        serial_mgr.send_config_and_confirm, req.thr_min, req.thr_max
    )

    if confirmed:
        active_profile["thr_min"] = actual_min
        active_profile["thr_max"] = actual_max
        activity_log.log(
            "CONFIG",
            f"requested {req.thr_min}-{req.thr_max}us -> confirmed {actual_min}-{actual_max}us"
            + ("" if (actual_min, actual_max) == (req.thr_min, req.thr_max) else "  ** MISMATCH **"),
            sess,
        )
        return {"status": "ok", "confirmed": True, "thr_min": actual_min, "thr_max": actual_max}
    else:
        activity_log.log(
            "CONFIG_FAIL",
            f"requested {req.thr_min}-{req.thr_max}us, unconfirmed "
            f"(board reports {actual_min}-{actual_max})",
            sess,
        )
        return {
            "status": "error",
            "confirmed": False,
            "message": "Arduino did not confirm the new range — firmware may be running an older sketch without CONFIG support, or the command was lost.",
            "reported_thr_min": actual_min,
            "reported_thr_max": actual_max,
        }


@app.post("/set_sampling_rate")
async def set_sampling_rate(
    req: SamplingRateRequest, sess: auth.Session = Depends(needs_hardware)
):
    if not serial_mgr.is_connected:
        return {"status": "error", "message": "Not connected"}

    confirmed, raw_ack = await asyncio.to_thread(
        serial_mgr.send_sampling_rate_and_confirm, req.mode
    )

    activity_log.log(
        "SAMPLING_RATE",
        f"mode={req.mode} confirmed={confirmed}",
        sess,
    )
    if confirmed:
        return {"status": "ok", "confirmed": True, "mode": req.mode}
    else:
        return {
            "status": "error",
            "confirmed": False,
            "message": "Arduino did not confirm the sampling rate — firmware may be running an older sketch without SR support, or the command was lost.",
        }


class SaveMotorProfileRequest(BaseModel):
    label: str
    thr_min: int
    thr_max: int
    rpm_gauge_max: int = 9000
    spin_up_us: Optional[int] = None
    max_measured_us: Optional[int] = None
    notes: Optional[str] = None
    # Set when editing an existing profile; without it a label collision
    # is an error rather than a silent replacement.
    id: Optional[str] = None
    overwrite: bool = False


@app.get("/motor_profiles")
def get_motor_profiles(sess: auth.Session = Depends(needs_login)):
    return {"profiles": motor_profile_store.list_profiles()}


@app.post("/motor_profiles")
def post_motor_profile(
    req: SaveMotorProfileRequest, sess: auth.Session = Depends(needs_motorcfg)
):
    ok, result = motor_profile_store.save_profile(
        req.model_dump(exclude={"overwrite"}), overwrite=req.overwrite
    )
    if not ok:
        activity_log.log("PROFILE_SAVE_FAIL", f"{req.label!r}: {result}", sess)
        return {"status": "error", "message": result}
    activity_log.log(
        "PROFILE_SAVE",
        f"{result['label']!r} id={result['id']} {result['thr_min']}-{result['thr_max']}us "
        f"gauge={result['rpm_gauge_max']} spin_up={result.get('spin_up_us')}",
        sess,
    )
    return {"status": "ok", "profile": result}


def _loaded_profile_ids() -> List[str]:
    """Ids whose range is the one the Arduino is running right now.

    Matched by range rather than by id because `active_profile` holds the
    range the firmware confirmed, not a reference to the record it came
    from — the same reason the Control tab adopts state by range on mount.
    """
    if not serial_mgr.is_connected:
        return []
    return [
        p["id"] for p in motor_profile_store.list_profiles()
        if p.get("thr_min") == active_profile["thr_min"]
        and p.get("thr_max") == active_profile["thr_max"]
    ]


class DeleteProfilesRequest(BaseModel):
    ids: List[str]


@app.post("/motor_profiles/delete")
def delete_motor_profiles(
    req: DeleteProfilesRequest, sess: auth.Session = Depends(needs_motorcfg)
):
    """Multi-select delete — everything the operator ticked, in one write.

    A per-id loop would leave the store half-deleted if one id failed
    partway through, and the operator would have no way to tell which half.
    """
    ok, result = motor_profile_store.delete_profiles(
        req.ids, protected_ids=_loaded_profile_ids()
    )
    if not ok:
        activity_log.log("PROFILE_DELETE_FAIL", f"ids={req.ids}: {result}", sess)
        return {"status": "error", "message": result}
    # The full values go in the log, not just the labels: this line is the
    # only recovery path if the wrong box was ticked.
    for p in result["removed"]:
        activity_log.log(
            "PROFILE_DELETE",
            f"{p['label']!r} id={p['id']} {p['thr_min']}-{p['thr_max']}us "
            f"gauge={p['rpm_gauge_max']} spin_up={p.get('spin_up_us')} "
            f"max_measured={p.get('max_measured_us')}",
            sess,
        )
    return {
        "status": "ok",
        "deleted": [p["id"] for p in result["removed"]],
        "remaining": result["remaining"],
    }


@app.post("/set_throttle")
def set_throttle(req: ThrottleRequest, sess: auth.Session = Depends(needs_hardware)):
    if not active_profile["thr_min"] <= req.value <= active_profile["thr_max"]:
        return {"status": "error", "message": f"Throttle must be {active_profile['thr_min']}–{active_profile['thr_max']} µs"}
    serial_mgr.send_throttle(req.value)
    # Coalesced: the slider sends every 50 ms during a drag, and logging
    # each one would bury the events either side of it. See activity_log.
    activity_log.log_throttle(req.value, session=sess)
    return {"status": "ok", "throttle": req.value}


@app.post("/emergency_stop")
async def emergency_stop(sess: auth.Session = Depends(needs_hardware)):
    await _cancel_step_test()
    serial_mgr.send_throttle(active_profile["thr_min"])
    activity_log.log("ESTOP", f"throttle -> {active_profile['thr_min']}us", sess)
    return {"status": "emergency_stop"}


@app.post("/start_auto_test")
def start_auto_test(sess: auth.Session = Depends(needs_control)):
    if not serial_mgr.is_connected:
        return {"status": "error", "message": "Not connected"}
    serial_mgr.send_auto_test()
    activity_log.log(
        "AUTO_TEST",
        f"START sweep {active_profile['thr_min']}-{active_profile['thr_max']}us (firmware-driven)",
        sess,
    )
    return {"status": "auto_test_started"}


@app.post("/stop_auto_test")
def stop_auto_test(sess: auth.Session = Depends(needs_control)):
    serial_mgr.send_stop_test()
    activity_log.log("AUTO_TEST", "STOP", sess)
    return {"status": "auto_test_stopped"}


def _as_pct(us: int) -> str:
    """Render a throttle in percent of the ACTIVE profile, for the log.

    Logged alongside the µs rather than instead of it: the operator now
    enters percent on the Control tab, but everything downstream — the
    firmware, the CSV, the Configure New Motor tab — still speaks µs, and a
    log that recorded only one of them would not let you reconcile the two.
    """
    span = active_profile["thr_max"] - active_profile["thr_min"]
    if span <= 0:
        return "?%"
    return f"{round((us - active_profile['thr_min']) / span * 100)}%"


# [NEW] Throttle Hold endpoints
@app.post("/start_throttle_hold")
def start_throttle_hold(
    req: ThrottleHoldRequest, sess: auth.Session = Depends(needs_control)
):
    """
    Send THROTTLE_HOLD command to Arduino.
    Arduino ramps to target_us, holds for hold_ms, then ramps back down.
    No RPM feedback — pure fixed-throttle hold.
    """
    if not serial_mgr.is_connected:
        return {"status": "error", "message": "Not connected"}
    if not active_profile["thr_min"] <= req.target_us <= active_profile["thr_max"]:
        return {"status": "error", "message": f"target_us must be {active_profile['thr_min']}–{active_profile['thr_max']} µs"}
    if req.hold_ms <= 0:
        return {"status": "error", "message": "hold_ms must be > 0"}
    serial_mgr.send_throttle_hold(req.target_us, req.hold_ms)
    activity_log.log(
        "STEP_TEST",
        f"START single target={_as_pct(req.target_us)}/{req.target_us}us "
        f"hold={req.hold_ms / 1000:g}s",
        sess,
    )
    return {
        "status": "throttle_hold_started",
        "target_us": req.target_us,
        "hold_ms": req.hold_ms,
    }


@app.post("/stop_throttle_hold")
async def stop_throttle_hold(sess: auth.Session = Depends(needs_control)):
    """Abort a running throttle hold sequence."""
    activity_log.log("STEP_TEST", "STOP single", sess)
    await _cancel_step_test()
    serial_mgr.send_stop_hold()
    return {"status": "throttle_hold_stopped"}


_step_test = {
    "running": False,
    "current_step": 0,       # 1-based; 0 = not started
    "total_steps": 0,
    "target_us": None,
    "hold_ms": None,
    "phase": "idle",         # idle|ramping|holding|finishing|complete|aborted|error
    "message": None,
}
_step_test_task: Optional[asyncio.Task] = None

_RAMP_STEP_US = 5
_RAMP_TICK_S  = 0.1


async def _ramp_throttle(from_us: int, to_us: int) -> int:
    """Step the motor from from_us to to_us at _RAMP_STEP_US per tick,
    over the plain throttle command. Symmetric in both directions. Returns
    the throttle actually reached (always to_us, unless cancelled)."""
    current = from_us
    if current == to_us:
        serial_mgr.send_throttle(current)
        return current
    step = _RAMP_STEP_US if to_us > from_us else -_RAMP_STEP_US
    while current != to_us:
        await asyncio.sleep(_RAMP_TICK_S)
        current += step
        if (step > 0 and current > to_us) or (step < 0 and current < to_us):
            current = to_us
        serial_mgr.send_throttle(current)
        _step_test["current_us"] = current
    return current


async def _run_step_test(steps: List[StepSpec]):
    """Ramp -> hold -> ramp, chained, entirely on host-side timing."""
    current = serial_mgr.last_throttle_us
    if current is None:
        current = active_profile["thr_min"]

    try:
        for i, step in enumerate(steps):
            _step_test.update(
                current_step=i + 1,
                target_us=step.target_us,
                hold_ms=step.hold_ms,
                phase="ramping",
                message=None,
            )
            current = await _ramp_throttle(current, step.target_us)

            _step_test["phase"] = "holding"
            await asyncio.sleep(step.hold_ms / 1000.0)

        _step_test["phase"] = "finishing"
        await _ramp_throttle(current, active_profile["thr_min"])
        _step_test.update(phase="complete", message=None)

    except asyncio.CancelledError:
        serial_mgr.send_throttle(active_profile["thr_min"])
        _step_test.update(phase="aborted", message="Stopped.")
        raise
    finally:
        _step_test["running"] = False


async def _cancel_step_test():
    """Cancel a running sequence and wait for it to unwind. Safe to call
    when nothing is running."""
    global _step_test_task
    task = _step_test_task
    _step_test_task = None
    if task and not task.done():
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
    _step_test["running"] = False


@app.post("/start_step_test")
async def start_step_test(
    req: StepTestRequest, sess: auth.Session = Depends(needs_control)
):
    """Run a sequence of throttle holds back to back.

    Single-step Step Tests do NOT come through here — the UI calls
    /start_throttle_hold for those, unchanged.
    """
    global _step_test_task

    if not serial_mgr.is_connected:
        return {"status": "error", "message": "Not connected"}
    if _step_test["running"]:
        return {"status": "error", "message": "A step test is already running"}
    if not req.steps:
        return {"status": "error", "message": "At least one step is required"}
    if len(req.steps) > MAX_STEPS:
        return {"status": "error", "message": f"At most {MAX_STEPS} steps are allowed"}

    errors = []
    for i, s in enumerate(req.steps):
        if not active_profile["thr_min"] <= s.target_us <= active_profile["thr_max"]:
            errors.append(
                f"Step {i + 1}: target must be {active_profile['thr_min']}–"
                f"{active_profile['thr_max']} µs (got {s.target_us})"
            )
        if s.hold_ms <= 0:
            errors.append(f"Step {i + 1}: hold must be > 0")
    if errors:
        activity_log.log("STEP_TEST_REJECT", "; ".join(errors), sess)
        return {"status": "error", "message": "; ".join(errors), "errors": errors}

    _step_test.update(
        running=True,
        current_step=0,
        total_steps=len(req.steps),
        target_us=None,
        hold_ms=None,
        phase="ramping",
        message=None,
    )
    activity_log.log(
        "STEP_TEST",
        "START multiple steps=["
        + ", ".join(
            f"{_as_pct(s.target_us)}/{s.target_us}us x{s.hold_ms / 1000:g}s"
            for s in req.steps
        )
        + "]",
        sess,
    )
    _step_test_task = asyncio.create_task(_run_step_test(req.steps))
    return {"status": "step_test_started", "total_steps": len(req.steps)}


@app.post("/stop_step_test")
async def stop_step_test(sess: auth.Session = Depends(needs_control)):
    activity_log.log("STEP_TEST", "STOP", sess)
    await _cancel_step_test()
    serial_mgr.send_stop_hold()
    _step_test.update(phase="aborted", message="Stopped.")
    return {"status": "step_test_stopped"}


@app.get("/step_test_status")
def step_test_status(sess: auth.Session = Depends(needs_control)):
    return dict(_step_test)


@app.post("/start_logging")
def start_logging(
    req: StartLoggingRequest = None, sess: auth.Session = Depends(needs_hardware)
):
    custom = req.filename if req else None
    filename = csv_logger.start(custom_name=custom)
    activity_log.log("CSV_LOG", f"OPEN {filename}", sess)
    return {"status": "logging", "file": filename}


@app.post("/stop_logging")
def stop_logging(sess: auth.Session = Depends(needs_hardware)):
    closed = csv_logger.current_file
    csv_logger.stop()
    activity_log.log("CSV_LOG", f"CLOSE {closed or '-'}", sess)
    return {"status": "stopped"}


@app.get("/status")
def get_status(sess: auth.Session = Depends(needs_login)):
    return {
        "connected": serial_mgr.is_connected,
        "logging":   csv_logger.is_logging,
        "log_file":  csv_logger.current_file,
        "port":      serial_mgr.current_port,
        # Ground truth from the Arduino itself, not the frontend's selection —
        # None until the firmware's boot line or a CONFIG confirmation arrives.
        "confirmed_thr_min": serial_mgr.confirmed_thr_min,
        "confirmed_thr_max": serial_mgr.confirmed_thr_max,
        "active_profile": dict(active_profile),
        # [NEW] Ground truth for the active IMU sampling mode
        "confirmed_sampling_rate": serial_mgr.confirmed_sampling_rate,
        # [NEW] Ground truth for the UART speed actually in use
        "active_baud": serial_mgr.current_baud,
        "board_info": serial_mgr.board_info,
        "firmware_protocol": serial_mgr.firmware_protocol,
        # [NEW v9] Acquisition health. Every one of these was previously
        # either invisible or silently discarded.
        "acquisition": {
            **serial_mgr.stats,
            "csv_rows_dropped": csv_logger.dropped_rows,
        },
    }


class AntiAliasRequest(BaseModel):
    code: int = 0        # 0=ODR/4, 1=ODR/10, 2=ODR/20, 3=ODR/45, 4=ODR/100 ...


@app.post("/set_anti_alias")
async def set_anti_alias(
    req: AntiAliasRequest, sess: auth.Session = Depends(needs_hardware)
):
    if not serial_mgr.is_connected:
        return {"status": "error", "message": "Not connected"}
    if not 0 <= req.code <= 7:
        return {"status": "error", "message": "code must be 0-7"}

    confirmed, raw_ack = await asyncio.to_thread(
        serial_mgr.send_anti_alias_and_confirm, req.code
    )
    if confirmed:
        return {"status": "ok", "confirmed": True, "code": req.code}
    return {
        "status": "error",
        "confirmed": False,
        "message": "Arduino did not confirm the anti-alias setting — firmware "
                   "may predate v9 (no AA: command), or the command was lost.",
    }


class TimingRequest(BaseModel):
    enabled: bool = True


@app.post("/set_timing_debug")
async def set_timing_debug(
    req: TimingRequest, sess: auth.Session = Depends(needs_hardware)
):
    if not serial_mgr.is_connected:
        return {"status": "error", "message": "Not connected"}
    confirmed, _ = await asyncio.to_thread(
        serial_mgr.send_timing_and_confirm, req.enabled
    )
    return {
        "status": "ok" if confirmed else "error",
        "confirmed": confirmed,
        "enabled": req.enabled,
        "note": "DBG_TIMING lines appear in the backend console once per second.",
    }


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket, token: Optional[str] = Query(None)):
    """Live telemetry.

    [NEW v13] Authorised separately from the HTTP endpoints, and deliberately
    so: a WebSocket handshake carries no Authorization header from the
    browser, so the token rides in the query string instead. Leaving this
    open while every HTTP route was gated would have made the gating
    pointless — the telemetry stream is the bulk of what a session sees.

    Refused before `accept()`, so an unauthorised client gets a failed
    handshake rather than an open socket that silently never delivers.
    """
    sess = auth.session_for(token)
    if sess is None or not sess.may_any(auth.HARDWARE_TABS):
        await websocket.close(code=1008)
        return
    await ws_manager.connect(websocket)
    try:
        while True:
            await asyncio.sleep(0.5)
    except WebSocketDisconnect:
        ws_manager.disconnect(websocket)