"""
test_link_safety.py — the host half of "Motor runaway on IMU/link failure"
(CLAUDE.md). Run: python test_link_safety.py   (exits non-zero on failure)

What it pins, each one a way the 2026-10-06 bench incident got worse than it
had to:

  * a write to a device that has stopped taking data RETURNS, bounded,
    instead of spinning in pyserial's untimed Windows flush();
  * Disconnect still writes THR_MIN and still closes the port when the
    device is stuck, without blocking the event loop;
  * the heartbeat actually goes out (v11 firmware stops the motor without it);
  * the firmware's fault lines become firmware_fault, and a mid-session boot
    banner is recognised as a reboot;
  * a telemetry stall commands the motor down and cancels a Step Test;
  * the /ws handler finishes when the client leaves — the old sleep loop
    never did, and uvicorn holds the lifespan teardown (the THR_MIN write on
    app close) until every handler has.

No hardware, no network. Application data is redirected to a temp dir before
anything that could write it is imported.
"""
import asyncio
import sys
import tempfile
import threading
import time
from pathlib import Path

_TMP = Path(tempfile.mkdtemp(prefix="nwa-link-test-"))

import app_paths
app_paths.app_root = lambda: _TMP          # type: ignore[assignment]
app_paths.logs_dir = lambda: _TMP          # type: ignore[assignment]
app_paths.csv_dir = lambda: _TMP           # type: ignore[assignment]

import serial

import auth
import motor_profiles as mp
mp.STORE_PATH = _TMP / "motor_profiles.json"

from serial_manager import SerialManager

_failures = []


def check(name, cond, detail=""):
    if cond:
        print(f"  PASS  {name}")
    else:
        print(f"  FAIL  {name} {detail}")
        _failures.append(name)


class StuckPort:
    """A device that has stopped taking data: write() lands in the driver
    queue, which then never drains. pyserial's flush() spins on this forever."""
    out_waiting = 7

    def __init__(self, write_exc=None):
        self.is_open = True
        self.closed = False
        self.writes = []
        self.write_exc = write_exc

    def write(self, data):
        if self.write_exc is not None:
            raise self.write_exc
        self.writes.append(bytes(data))
        return len(data)

    def close(self):
        self.is_open = False
        self.closed = True


class HealthyPort(StuckPort):
    out_waiting = 0


class _NullLog:
    def write(self, _row):
        pass


class _NullWs:
    async def broadcast(self, _msg):
        pass


def new_mgr(port=None):
    mgr = SerialManager(ws_manager=_NullWs(), csv_logger=_NullLog())
    mgr._serial = port
    return mgr


print("-- Writes are bounded ------------------------------------")

mgr = new_mgr(StuckPort())
t0 = time.monotonic()
ok = mgr._write(b"1200\n", "throttle")
dt = time.monotonic() - t0
check("write to a stuck device returns", True)
check("...and reports failure", ok is False, ok)
check("...within the drain bound", dt < mgr.DRAIN_TIMEOUT_S + 0.5, f"{dt:.2f}s")

mgr = new_mgr(StuckPort(write_exc=serial.SerialTimeoutException("Write timeout")))
check("a write timeout is swallowed, not raised", mgr._write(b"1\n", "x") is False)

mgr = new_mgr(HealthyPort())
check("a healthy write succeeds", mgr._write(b"1200\n", "throttle") is True)
mgr.send_throttle(1300)
check("send_throttle goes through _write", mgr._serial.writes[-1] == b"1300\n",
      mgr._serial.writes)

print("\n-- Disconnect closes a stuck port, off the event loop ----")

for label, port in [("stuck device", StuckPort()),
                    ("write raising", StuckPort(write_exc=serial.SerialException("gone")))]:
    mgr = new_mgr(port)
    mgr.is_connected = True
    mgr._current_thr_min = 1000

    async def _run():
        # A ticker that would stall if disconnect blocked the loop.
        ticks = 0

        async def ticker():
            nonlocal ticks
            while True:
                await asyncio.sleep(0.05)
                ticks += 1

        t = asyncio.create_task(ticker())
        start = time.monotonic()
        await mgr.disconnect_async()
        elapsed = time.monotonic() - start
        t.cancel()
        return elapsed, ticks

    elapsed, ticks = asyncio.run(_run())
    check(f"[{label}] port closed", port.closed)
    check(f"[{label}] returns in bounded time", elapsed < 2.0, f"{elapsed:.2f}s")
    # Only meaningful when disconnect took long enough to have blocked it.
    check(f"[{label}] event loop kept running", elapsed < 0.2 or ticks >= 3,
          f"ticks={ticks} elapsed={elapsed:.2f}s")
    check(f"[{label}] manager forgets the port", mgr._serial is None)

port = StuckPort()
mgr = new_mgr(port)
mgr.is_connected = True
mgr._current_thr_min = 1000
asyncio.run(mgr.disconnect_async())
check("THR_MIN is still attempted on a stuck device", port.writes == [b"1000\n"], port.writes)

port = HealthyPort()
mgr = new_mgr(port)
mgr.is_connected = True
mgr._current_thr_min = 1025
asyncio.run(mgr.disconnect_async())
check("THR_MIN is the write that precedes close", port.writes == [b"1025\n"], port.writes)

print("\n-- Heartbeat -------------------------------------------")

port = HealthyPort()
mgr = new_mgr(port)
mgr._stop_event.clear()
hb = threading.Thread(target=mgr._heartbeat_loop, daemon=True)
hb.start()
time.sleep(0.8)
mgr._stop_event.set()
hb.join(1.0)
n_hb = port.writes.count(b"HB\n")
check("heartbeat is sent repeatedly", n_hb >= 2, f"{n_hb} in 0.8 s")
check("heartbeat stops with the link", not hb.is_alive())

print("\n-- Firmware fault lines ----------------------------------")

events = []
mgr = new_mgr()
mgr.on_event = lambda e, d: events.append((e, d))

mgr._handle_control_line("IMU_FAULT: IMU stopped responding on I2C - motor stopped. Retrying.", 0)
check("IMU_FAULT -> firmware_fault imu",
      mgr.firmware_fault and mgr.firmware_fault["kind"] == "imu", mgr.firmware_fault)
check("...and reaches the activity log", events and events[-1][0] == "FIRMWARE_FAULT", events)
n = len(events)
mgr._handle_control_line("IMU_FAULT: IMU stopped responding on I2C - motor stopped. Retrying.", 0)
check("a repeated identical fault is logged once", len(events) == n, events)
mgr._handle_control_line("IMU_RECOVERED: IMU responding again.", 0)
check("IMU_RECOVERED clears an imu fault", mgr.firmware_fault is None, mgr.firmware_fault)

mgr._handle_control_line("FAILSAFE: no command from host for 1.5 s - motor stopped", 0)
check("FAILSAFE -> firmware_fault failsafe",
      mgr.firmware_fault and mgr.firmware_fault["kind"] == "failsafe")
mgr.clear_fault()

mgr._handle_control_line("Initializing IMU...", 0)
check("a boot banner mid-session is flagged as a reboot",
      mgr.firmware_fault and mgr.firmware_fault["kind"] == "reboot")
mgr._handle_control_line("Active profile: THR_MIN=1025 THR_MAX=1600", 0)
check("the rebooted board's default range is adopted",
      (mgr.confirmed_thr_min, mgr.confirmed_thr_max) == (1025, 1600),
      (mgr.confirmed_thr_min, mgr.confirmed_thr_max))
check("control lines still reach the ack queue",
      not mgr._control_line_queue.empty())

check("telemetry age is None before any sample", mgr.telemetry_age_s is None)
mgr._emit_sample({"throttle": 1100})
check("telemetry age tracks the last sample", 0 <= mgr.telemetry_age_s < 0.5,
      mgr.telemetry_age_s)

print("\n-- Sample timestamps survive an IMU fault gap ------------")
# Across IMU_FAULT -> IMU_RECOVERED the MCU clock runs on but sample_index
# does not. Before v15 every later sample was stamped as if the gap never
# happened (seen on the bench 2026-10-06: ~38 s compressed away).

from frame_protocol import encode_telemetry

GAP_S, FS, NB = 5.0, 833.0, 16
mgr = new_mgr()
idx = 0
last_rows = []
for b in range(100):
    t_us = int(round(((idx + NB - 1) / FS + (GAP_S if b >= 60 else 0.0)) * 1e6))
    frame = encode_telemetry(seq=b, sample_index=idx, t_us=t_us, dt_us=1200,
                             rpm_count=0, rpm_period=0, throttle_us=1000,
                             samples=[(0, 0, 8192)] * NB)
    for kind, item in mgr._decoder.feed(frame):
        if kind == "telemetry":
            mgr._handle_telemetry(item)
    idx += NB

rows = []
while not mgr._data_queue.empty():
    rows.append(mgr._data_queue.get_nowait())
want_last_us = ((idx - 1) / FS + GAP_S) * 1e6
check("the gap is detected once", mgr.stats["timeline_breaks"] == 1,
      mgr.stats["timeline_breaks"])
check("post-gap samples carry the gap in McuMicros",
      abs(rows[-1]["mcuUs"] - want_last_us) < 5000,
      f'got {rows[-1]["mcuUs"]:.0f} want {want_last_us:.0f}')
check("McuMicros stays monotonic across the gap",
      all(b["mcuUs"] > a["mcuUs"] for a, b in zip(rows, rows[1:])))
check("measured rate is still ~833 Hz after the gap",
      abs(mgr.stats["measured_rate_hz"] - FS) < 2.0, mgr.stats["measured_rate_hz"])

print("\n-- Telemetry stall stops the run -------------------------")

import main


class StalledSerial:
    is_connected = True
    telemetry_age_s = 5.0
    last_throttle_us = 1400

    def __init__(self):
        self.sent = []

    def send_throttle(self, v):
        self.sent.append(v)

    def send_stop_hold(self):
        self.sent.append("STOP_HOLD")


fake = StalledSerial()
_real_mgr = main.serial_mgr
main.serial_mgr = fake
main.active_profile["thr_min"] = 1025
main._stall["active"] = False


async def _stall_run():
    task = asyncio.create_task(main._watch_telemetry())
    await asyncio.sleep(0.8)
    task.cancel()


asyncio.run(_stall_run())
check("stall commands THR_MIN", 1025 in fake.sent, fake.sent)
check("stall is flagged for /status", main._stall["active"] is True)
check("throttle-down is sent once per stall, not every tick",
      fake.sent.count(1025) == 1, fake.sent)

main.serial_mgr = _real_mgr

print("\n-- App shutdown after a /ws session reaches the teardown --")
# A real uvicorn, deliberately WITHOUT run_backend's timeout_graceful_shutdown
# backstop: this tests the handler itself. Starlette's TestClient cancels the
# app task on close, which hides the bug, so it cannot be used here.

import socket

import uvicorn
import websockets

sess = auth.login("tester", "tester@123")
check("test session created", sess is not None)

_s = socket.socket()
_s.bind(("127.0.0.1", 0))
_port = _s.getsockname()[1]
_s.close()

server = uvicorn.Server(uvicorn.Config(
    main.app, host="127.0.0.1", port=_port, log_level="warning",
    lifespan="on", ws="websockets",
))
srv = threading.Thread(target=server.run, daemon=True)
srv.start()
_deadline = time.monotonic() + 10
while not server.started and time.monotonic() < _deadline:
    time.sleep(0.05)
check("test server started", server.started)


async def _ws_client():
    async with websockets.connect(f"ws://127.0.0.1:{_port}/ws?token={sess.token}"):
        await asyncio.sleep(0.3)
        return main.ws_manager.client_count

count_open = asyncio.run(_ws_client())
time.sleep(0.3)
check("client was registered while open", count_open == 1, count_open)
check("client unregistered when it left", main.ws_manager.client_count == 0,
      main.ws_manager.client_count)

server.should_exit = True
srv.join(6.0)
check("server shut down (the old sleep loop held it open forever)", not srv.is_alive())
_log = "".join(p.read_text(encoding="utf-8") for p in _TMP.glob("activity-*.txt"))
check("lifespan teardown ran: APP_STOP logged", "APP_STOP" in _log)

print("\n----------------------------------------------------")
if _failures:
    print(f"FAILED: {len(_failures)} check(s): {_failures}")
    sys.exit(1)
print("All link-safety checks passed.")
