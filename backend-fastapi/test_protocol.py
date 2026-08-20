"""
test_protocol.py -- [NEW v9] self-contained checks for the wire codec.

This repository has no test framework and no CI (see CLAUDE.md), and the
firmware is flashed by hand from the Arduino IDE, so there is no way to
exercise the real link automatically. The binary protocol is the one
piece where a bug is both easy to introduce and very hard to see -- a
desynced decoder produces plausible-looking numbers rather than an
error. So it gets a round-trip test that runs with nothing but the
standard library:

    python test_protocol.py

Exits non-zero on failure so it can be wired into a gate later.
"""

import random
import sys

from frame_protocol import (
    FrameDecoder,
    crc16_ccitt,
    decode_telemetry_payload,
    encode_telemetry,
    g_per_lsb,
    FLAG_FIFO_OVERRUN,
    TELEMETRY_HEADER_LEN,
)
from signal_chain import DCRemover, SampleClock

_failures = []


def check(name, cond, detail=""):
    if cond:
        print(f"  PASS  {name}")
    else:
        print(f"  FAIL  {name} {detail}")
        _failures.append(name)


def sample_frame(seq=1, index=0, n=4, t_us=1_000_000, flags=0):
    samples = [(i * 10 - 20, i * -7, 8192 + i) for i in range(n)]
    return encode_telemetry(
        seq=seq, sample_index=index, t_us=t_us, dt_us=1200,
        rpm_count=4980, rpm_period=5012, throttle_us=1300,
        samples=samples, flags=flags,
    ), samples


print("-- CRC ---------------------------------------------")
# Known-answer test for CRC16-CCITT (FALSE variant, init 0xFFFF).
check("crc16('123456789') == 0x29B1", crc16_ccitt(b"123456789") == 0x29B1,
      f"got {crc16_ccitt(b'123456789'):#06x}")

print("\n-- Round trip --------------------------------------")
frame, samples = sample_frame(n=16)
expected_len = 6 + TELEMETRY_HEADER_LEN + 16 * 6
check("frame length is 6+header+6n", len(frame) == expected_len,
      f"got {len(frame)} want {expected_len}")

dec = FrameDecoder()
out = dec.feed(frame)
check("one telemetry item decoded", len(out) == 1 and out[0][0] == "telemetry", str(out[:1]))
if out and out[0][0] == "telemetry":
    d = out[0][1]
    check("raw samples survive round trip", d["raw"] == samples)
    check("rpm_count preserved", d["rpm_count"] == 4980)
    check("rpm_period preserved", d["rpm_period"] == 5012)
    check("throttle preserved", d["throttle"] == 1300)
    check("n preserved", d["n"] == 16)
    check("scale code default 4g", d["scale_code"] == 4)

check("g_per_lsb(4) == 0.000122", abs(g_per_lsb(4) - 0.000122) < 1e-12)

print("\n-- Negative / signed values ------------------------")
neg = encode_telemetry(1, 0, 0, 1200, 0, 0, 1000,
                       [(-32768, 32767, -1), (0, -1, 1)])
d = decode_telemetry_payload(neg[4:-2])
check("int16 extremes round trip", d["raw"] == [(-32768, 32767, -1), (0, -1, 1)], str(d["raw"]))

print("\n-- ASCII / binary demultiplexing -------------------")
dec = FrameDecoder()
f1, _ = sample_frame(seq=1, index=0)
f2, _ = sample_frame(seq=2, index=4)
stream = b"ESC Armed. Commands: ...\n" + f1 + b"DBG_RPM,pulses=41,window_ms=500\n" + f2
out = dec.feed(stream)
kinds = [k for k, _ in out]
check("interleaved order preserved",
      kinds == ["line", "telemetry", "line", "telemetry"], str(kinds))
lines = [v for k, v in out if k == "line"]
check("ack line intact", lines[0].startswith("ESC Armed"), lines[0])
check("DBG_RPM line intact", lines[1].startswith("DBG_RPM"), lines[1])

print("\n-- Fragmented delivery (worst case: 1 byte at a time) --")
dec = FrameDecoder()
got = []
for byte in stream:
    got.extend(dec.feed(bytes([byte])))
kinds = [k for k, _ in got]
check("byte-at-a-time yields same result",
      kinds == ["line", "telemetry", "line", "telemetry"], str(kinds))

print("\n-- Random chunk boundaries -------------------------")
random.seed(7)
for trial in range(200):
    dec = FrameDecoder()
    got = []
    i = 0
    while i < len(stream):
        step = random.randint(1, 17)
        got.extend(dec.feed(stream[i:i + step]))
        i += step
    if [k for k, _ in got] != ["line", "telemetry", "line", "telemetry"]:
        check(f"random chunking trial {trial}", False, str([k for k, _ in got]))
        break
else:
    check("200 random chunkings all correct", True)

print("\n-- Payload containing sync bytes and newlines ------")
# 0xAA 0x55 and 0x0A are all legal inside int16 sample data. If the
# decoder trusted the sync pair alone it would desync here.
tricky = [(0x55AA, 0x0A0A, -21846), (0x55AA, 0x55AA, 0x0A0A)]
tf = encode_telemetry(9, 100, 5, 1200, 100, 100, 1200, tricky)
dec = FrameDecoder()
out = dec.feed(b"noise line\n" + tf + b"trailing\n")
tele = [v for k, v in out if k == "telemetry"]
check("frame with embedded sync/newline bytes decodes", len(tele) == 1 and tele[0]["raw"] == tricky,
      str(tele[:1]))

print("\n-- Corruption handling -----------------------------")
bad = bytearray(f1)
bad[10] ^= 0xFF                      # flip a payload bit
dec = FrameDecoder()
out = dec.feed(bytes(bad))
check("corrupted frame is not emitted as telemetry",
      not any(k == "telemetry" for k, _ in out))
check("crc error counted", dec.crc_errors >= 1, f"crc_errors={dec.crc_errors}")

# A good frame immediately after corruption must still be found.
dec = FrameDecoder()
out = dec.feed(bytes(bad) + f2)
tele = [v for k, v in out if k == "telemetry"]
check("resync finds the next good frame", len(tele) == 1 and tele[0]["seq"] == 2, str(tele))

print("\n-- Flags -------------------------------------------")
ff, _ = sample_frame(flags=FLAG_FIFO_OVERRUN)
dec = FrameDecoder()
d = [v for k, v in dec.feed(ff) if k == "telemetry"][0]
check("overrun flag survives", d["flags"] & FLAG_FIFO_OVERRUN != 0)

print("\n-- SampleClock -------------------------------------")
clk = SampleClock()
# Simulate 833 Hz in batches of 16 with jittery host arrival.
random.seed(3)
rate = 833.0
for i in range(400):
    idx = i * 16
    mcu_us = int(idx / rate * 1e6)
    host = 100.0 + idx / rate + random.uniform(0.0, 0.004)   # 0-4 ms transport jitter
    clk.update(mcu_us, idx, host)
check("measured rate recovers ~833 Hz",
      abs(clk.measured_rate_hz - 833.0) < 1.0, f"got {clk.measured_rate_hz:.3f}")

# micros() wrap must not break monotonicity.
clk2 = SampleClock()
base = (1 << 32) - 3_000_000
prev = -1.0
ok = True
for i in range(50):
    raw = (base + i * 100_000) % (1 << 32)
    s = clk2.update(raw, i * 83, 1000.0 + i * 0.1)
    if s <= prev:
        ok = False
    prev = s
check("micros() wrap unwraps monotonically", ok)

print("\n-- DCRemover ---------------------------------------")
dc = DCRemover(fc_hz=0.5, fs_hz=833.0)
# 1 g DC offset + a 84 Hz tone (the 1x at ~5040 RPM), amplitude 0.1 g.
import math as _m
amp_out = 0.0
n = 8000
for i in range(n):
    t = i / 833.0
    x = 1.0 + 0.1 * _m.sin(2 * _m.pi * 84.0 * t)
    ox, _, _ = dc.process(x, 0.0, 0.0)
    if i > 4000:
        amp_out = max(amp_out, abs(ox))
check("DC offset removed, 84 Hz tone preserved",
      0.095 < amp_out < 0.105, f"peak={amp_out:.4f}")

dcz = DCRemover(fc_hz=0.0, fs_hz=833.0)
check("fc=0 disables filtering", dcz.process(1.23, 4.5, 6.7) == (1.23, 4.5, 6.7))

print("\n----------------------------------------------------")
print("\n-- Firmware/backend contract (cross-file) ----------")
import os as _os, re as _re
_ino = _os.path.join(_os.path.dirname(_os.path.abspath(__file__)),
                     "..", "Arduino", "nwa_testing_software.ino")
if not _os.path.exists(_ino):
    check("firmware sketch found", False, _ino)
else:
    with open(_ino, encoding="utf-8", errors="replace") as _fh:
        _src = _fh.read()

    def _define(name):
        m = _re.search(r"^#define\s+" + name + r"\s+(0x[0-9A-Fa-f]+|\d+)", _src, _re.M)
        return int(m.group(1), 0) if m else None

    def _const(name):
        # For `const <type> NAME = value;` declarations, not #define.
        m = _re.search(r"\bconst\s+\w+\s+" + name + r"\s*=\s*(\d+)\s*;", _src)
        return int(m.group(1)) if m else None

    check("firmware TELEMETRY_HEADER_LEN matches codec",
          _define("TELEMETRY_HEADER_LEN") == TELEMETRY_HEADER_LEN,
          f'ino={_define("TELEMETRY_HEADER_LEN")} py={TELEMETRY_HEADER_LEN}')
    check("firmware FRAME_TYPE_TELEMETRY matches codec",
          _define("FRAME_TYPE_TELEMETRY") == 1, str(_define("FRAME_TYPE_TELEMETRY")))
    check("firmware FLAG_FIFO_OVERRUN matches codec",
          _define("FLAG_FIFO_OVERRUN") == FLAG_FIFO_OVERRUN, str(_define("FLAG_FIFO_OVERRUN")))

    # A frame from the largest batch the firmware can emit must fit in
    # its TX ring, or every frame would be dropped at run time.
    _mb, _ring = _define("MAX_BATCH"), _define("TX_RING_SIZE")
    _maxframe = 6 + TELEMETRY_HEADER_LEN + (_mb or 0) * 6
    check("max frame fits the firmware TX ring",
          _ring is not None and _maxframe <= _ring, f"frame={_maxframe} ring={_ring}")

    check("firmware emits the codec's sync bytes",
          "txPushByte(0xAA)" in _src and "txPushByte(0x55)" in _src)

    for _tok in ["ESC Armed", "Active profile: THR_MIN=", "CONFIG applied:",
                 "SR applied", "BAUD applied", "READY",
                 "AA applied", "TIMING applied"]:
        check("ack string present: " + repr(_tok), _tok in _src)

    _main_py = _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "main.py")
    with open(_main_py, encoding="utf-8") as _fh:
        _main_src = _fh.read()
    _m = _re.search(r"^_RAMP_STEP_US\s*=\s*(\d+)", _main_src, _re.M)
    _ramp_step_us = int(_m.group(1)) if _m else None
    check("firmware THR_RAMP_RATE matches Step Test's _RAMP_STEP_US",
          _const("THR_RAMP_RATE") == _ramp_step_us,
          f'ino={_const("THR_RAMP_RATE")} py={_ramp_step_us}')

print("\n----------------------------------------------------")
if _failures:
    print(f"FAILED: {len(_failures)} check(s): {_failures}")
    sys.exit(1)
print("All protocol/signal-chain checks passed.")
