"""
test_ingest.py -- [NEW v9] end-to-end backend ingestion check, no hardware.

Exercises the whole host-side chain that a real board would drive:

    synthetic binary frames
        -> FrameDecoder
        -> SerialManager._handle_telemetry / _handle_control_line
        -> CSVLogger
        -> an actual .csv on disk

The firmware is flashed by hand and there is no CI, so this is the only
way to prove the backend half of the v9 protocol works before touching a
motor. It deliberately checks the things that would otherwise only show
up as quietly wrong numbers in a test log:

  * sample timestamps are UNIFORM (the whole point of the MCU clock)
  * gravity is removed from Vib but preserved in Acc
  * dropped frames are detected via sequence gaps rather than ignored
  * ASCII acks still reach the control-line queue unharmed while binary
    telemetry flows on the same stream

Run:  python test_ingest.py
"""

import math
import os
import queue
import sys
import tempfile
import time

from frame_protocol import encode_telemetry, FLAG_FIFO_OVERRUN
import logger as _logger_mod
from logger import CSVLogger
from serial_manager import SerialManager

_TMP_CSV_DIR = tempfile.mkdtemp(prefix="nwa-ingest-test-")
_logger_mod._TEST_DATA_DIR = _TMP_CSV_DIR
_logger_mod._DBG_LOGS_DIR = os.path.join(_TMP_CSV_DIR, "DBG Logs")

_failures = []


def check(name, cond, detail=""):
    if cond:
        print(f"  PASS  {name}")
    else:
        print(f"  FAIL  {name} {detail}")
        _failures.append(name)


class _NullWs:
    async def broadcast(self, _msg):
        pass


# ── Build a SerialManager with no port attached ─────────────────────────
log = CSVLogger()
mgr = SerialManager(ws_manager=_NullWs(), csv_logger=log)

FS = 833.0
LSB = 0.000122
N_BATCH = 16
N_BATCHES = 120

frames = []
idx = 0
for b in range(N_BATCHES):
    samples = []
    for k in range(N_BATCH):
        i = idx + k
        t = i / FS
        ax = 0.0
        ay = 0.2 * math.sin(2 * math.pi * 84.0 * t)
        az = 1.0
        samples.append((
            int(round(ax / LSB)),
            int(round(ay / LSB)),
            int(round(az / LSB)),
        ))
    t_us = int(round((idx + N_BATCH - 1) / FS * 1e6))
    frames.append(encode_telemetry(
        seq=b, sample_index=idx, t_us=t_us, dt_us=1200,
        rpm_count=4980, rpm_period=5040, throttle_us=1300, samples=samples,
    ))
    idx += N_BATCH

print("-- Decode + expand -------------------------------------")
path = log.start(custom_name="__v9_ingest_test")
try:
    stream = b"".join(frames)
    # Interleave a couple of ASCII control lines mid-stream, as the real
    # firmware does (DBG_RPM fires every 500 ms).
    stream = (frames[0] + b"DBG_RPM,pulses=41,window_ms=500,rpm_count=4920.0,"
                          b"rpm_period=5040,min_us=11900\n"
              + b"".join(frames[1:5])
              + b"CONFIG applied: THR_MIN=1000 THR_MAX=2000\n"
              + b"".join(frames[5:]))

    for kind, item in mgr._decoder.feed(stream):
        if kind == "telemetry":
            mgr._handle_telemetry(item)
        else:
            mgr._handle_control_line(item, 0)

    expected_samples = N_BATCHES * N_BATCH
    check("all samples ingested",
          mgr.stats["samples"] == expected_samples,
          f'got {mgr.stats["samples"]} want {expected_samples}')
    check("all frames decoded", mgr.stats["frames"] == N_BATCHES,
          f'got {mgr.stats["frames"]}')
    check("no frames reported lost", mgr.stats["frames_lost"] == 0)
    check("no crc errors", mgr.stats["crc_errors"] == 0)
    check("protocol detected as binary-v9", mgr.firmware_protocol == "binary-v9",
          mgr.firmware_protocol)
    check("measured rate ~833 Hz",
          abs(mgr.stats["measured_rate_hz"] - 833.0) < 2.0,
          f'got {mgr.stats["measured_rate_hz"]}')

    print("\n-- Control lines survive the binary stream --------------")
    acks = []
    while True:
        try:
            acks.append(mgr._control_line_queue.get_nowait())
        except queue.Empty:
            break
    check("CONFIG ack reached the control-line queue",
          any("CONFIG applied" in a for a in acks), str(acks))
    # DBG_RPM is printed and consumed, not queued as an ack candidate...
    # it IS queued (all non-telemetry lines are), so it should be present.
    check("DBG_RPM reached the control-line queue",
          any(a.startswith("DBG_RPM") for a in acks), str(acks))

    print("\n-- Sample record contents ------------------------------")
    # Drain what would have gone to the websocket.
    rows = []
    while True:
        try:
            rows.append(mgr._data_queue.get_nowait())
        except queue.Empty:
            break
    check("live queue received samples", len(rows) > 0, str(len(rows)))

    r = rows[len(rows) // 2]
    check("AccZ retains gravity (~1 g)", abs(r["accZ"] - 1.0) < 0.01, str(r["accZ"]))
    check("VibZ has gravity removed (~0 g)", abs(r["vibZ"]) < 0.02, str(r["vibZ"]))
    check("sampleIndex present", "sampleIndex" in r)
    check("mcuUs present", "mcuUs" in r)
    check("period RPM preferred over count RPM",
          abs(r["rpm"] - 5040) < 0.6, str(r["rpm"]))
    check("legacy count RPM retained alongside",
          r["rpmCount"] == 4980, str(r.get("rpmCount")))

    print("\n-- Sample clock uniformity -----------------------------")
    us = [x["mcuUs"] for x in rows]
    deltas = [round(b - a, 4) for a, b in zip(us, us[1:])]
    expected = 1e6 / mgr.stats["measured_rate_hz"]

    WARM = 8 * N_BATCH
    warm_worst = max(abs(d - expected) for d in deltas[:WARM])
    check("warm-up positioning error is bounded (<20 us)",
          warm_worst < 20.0, f"{warm_worst:.2f} us")

    steady = deltas[WARM:]
    worst = max(abs(d - expected) for d in steady)
    check("steady-state spacing uniform to <0.5 us across batch boundaries",
          worst < 0.5, f"worst deviation {worst:.4f} us from {expected:.4f}")
    check("spacing matches the MEASURED rate, not the nominal 1200 us",
          abs(expected - 1200.48) < 0.05, f"expected={expected:.4f}")
    check("no duplicate timestamps", len(set(us)) == len(us))

    idxs = [x["sampleIndex"] for x in rows]
    check("sample indices are contiguous",
          idxs == list(range(idxs[0], idxs[0] + len(idxs))))

    print("\n-- 84 Hz tone preserved through DC removal -------------")
    vy = [x["vibY"] for x in rows[400:]]
    peak = max(abs(v) for v in vy)
    check("84 Hz 0.2 g tone survives high-pass",
          0.19 < peak < 0.21, f"peak={peak:.4f}")

finally:
    log.stop()

print("\n-- CSV output ------------------------------------------")
with open(path, "r", encoding="utf-8") as fh:
    lines = fh.read().strip().split("\n")
header = lines[0].split(",")
check("header has the v9 columns",
      header[:6] == ["Timestamp", "SampleIndex", "McuMicros", "Throttle", "RPM", "RpmCount"],
      str(header))
check("legacy columns still present in order",
      header[6:] == ["AccX", "AccY", "AccZ", "VibX", "VibY", "VibZ"], str(header[6:]))
check("all rows written", len(lines) - 1 == N_BATCHES * N_BATCH,
      f"got {len(lines)-1}")
check("no rows dropped", log.dropped_rows == 0, str(log.dropped_rows))

fields = lines[1].split(",")
check("every row has 12 fields", len(fields) == 12, str(len(fields)))
check("timestamps are distinct across rows",
      lines[1].split(",")[0] != lines[400].split(",")[0])

os.remove(path)

print("\n-- Frame loss detection --------------------------------")
mgr2 = SerialManager(ws_manager=_NullWs(), csv_logger=CSVLogger())
# Deliver frames 0, 1, then skip 2 and 3, then 4.
subset = frames[0] + frames[1] + frames[4]
for kind, item in mgr2._decoder.feed(subset):
    if kind == "telemetry":
        mgr2._handle_telemetry(item)
check("sequence gap detected as 2 lost frames",
      mgr2.stats["frames_lost"] == 2, str(mgr2.stats["frames_lost"]))

print("\n-- Firmware-side flags surface -------------------------")
mgr3 = SerialManager(ws_manager=_NullWs(), csv_logger=CSVLogger())
ovr = encode_telemetry(0, 0, 1000, 1200, 100, 100, 1000,
                       [(0, 0, 8196)] * 4, flags=FLAG_FIFO_OVERRUN)
for kind, item in mgr3._decoder.feed(ovr):
    if kind == "telemetry":
        mgr3._handle_telemetry(item)
check("FIFO overrun counted", mgr3.stats["fifo_overruns"] == 1)

print("\n-- Legacy ASCII firmware compatibility -----------------")
mgr4 = SerialManager(ws_manager=_NullWs(), csv_logger=CSVLogger())
legacy = b"4980.0,0.010,-0.020,0.030,0.011,-0.021,1.031,1300\n"
for kind, item in mgr4._decoder.feed(legacy):
    if kind == "telemetry":
        mgr4._handle_telemetry(item)
    else:
        mgr4._handle_control_line(item, 0)
check("pre-v9 ASCII telemetry still parsed",
      mgr4.stats["samples"] == 1 and mgr4.firmware_protocol == "legacy-ascii",
      f'{mgr4.stats["samples"]} {mgr4.firmware_protocol}')

print("\n--------------------------------------------------------")
if _failures:
    print(f"FAILED: {len(_failures)} check(s): {_failures}")
    sys.exit(1)
print("All backend ingestion checks passed.")
