"""
Owns the serial link to the Arduino: connection, command dispatch, and
decoding the binary telemetry stream into samples for the WebSocket and CSV.

Three invariants, each fixing a bug that was hard to see:

  1. Only _read_loop() may call self._serial.readline(). Two threads reading
     one serial.Serial race for lines. Non-telemetry lines go onto
     _control_line_queue; send_*_and_confirm() reads acks from there.

  2. Commands are confirmed, not fired and forgotten. CONFIG, SR and BAUD each
     block until the firmware echoes its ack, and the value parsed from that
     ack -- not the requested one -- becomes ground truth.

  3. Every connection opens at BOOT_BAUD (115200) first and waits for the
     firmware's "ESC Armed" line. Opening the port triggers a DTR auto-reset
     and the sketch spends ~8.5 s arming the ESC before it reads serial at
     all; commands sent in that window are lost. A failed baud switch is
     non-fatal.

disconnect_async() writes THR_MIN and flushes it BEFORE closing the port --
that write is what actually spins the motor down.
"""
import asyncio
import json
import queue
import re
import threading
import time
from typing import Optional

import serial

from frame_protocol import (
    FLAG_FIFO_OVERRUN,
    FLAG_TAG_FALLBACK,
    FLAG_TX_DROP,
    FrameDecoder,
    g_per_lsb,
)
from logger import CSVLogger
from signal_chain import DCRemover, SampleClock
from websocket_manager import WebSocketManager


def parse_line(line: str) -> Optional[dict]:
    """Parse one pre-v9 ASCII telemetry line → dict, or None if malformed.

    [LEGACY v9] The v9 firmware sends binary frames, so this is no longer
    the primary path. It is kept deliberately: the firmware is flashed by
    hand from the Arduino IDE, so a board can easily still be running an
    older sketch. When that happens the decoder classifies its 8-field
    telemetry as an ASCII line, this function recognises it, and the
    dashboard keeps working at the old ~220 Hz instead of showing a dead
    link with no explanation. Remove only once every board is on v9+.
    """
    parts = line.strip().split(",")
    if len(parts) != 8:
        return None
    try:
        rpm      = round(float(parts[0]), 1)
        vib_x    = round(float(parts[1]), 4)
        vib_y    = round(float(parts[2]), 4)
        vib_z    = round(float(parts[3]), 4)
        acc_x    = round(float(parts[4]), 4)
        acc_y    = round(float(parts[5]), 4)
        acc_z    = round(float(parts[6]), 4)
        throttle = int(float(parts[7]))

        return {
            "throttle": throttle,
            "rpm":      rpm,
            "accX":     acc_x,
            "accY":     acc_y,
            "accZ":     acc_z,
            "vibX":     vib_x,
            "vibY":     vib_y,
            "vibZ":     vib_z,
            "ts":       round(time.time() * 1000),
            "legacy":   True,
        }
    except (ValueError, IndexError) as e:
        print(f"[Parser] Parse error on '{line}': {e}")
        return None


class SerialManager:
    BOOT_BAUD = 115200

    def __init__(self, ws_manager: WebSocketManager, csv_logger: CSVLogger):
        self._ws_manager = ws_manager
        self._csv_logger = csv_logger
        self._serial: Optional[serial.Serial] = None
        self._reader_thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._broadcast_task: Optional[asyncio.Task] = None

        self.is_connected = False
        self.current_port = None

        self._data_queue: queue.Queue = queue.Queue(maxsize=4096)
        self._current_thr_min = 1025  # updated by send_config(); safe default until first CONFIG

        self._control_line_queue: queue.Queue = queue.Queue(maxsize=64)

        self.confirmed_thr_min: Optional[int] = None
        self.confirmed_thr_max: Optional[int] = None

        self.confirmed_sampling_rate: Optional[str] = None

        self.current_baud: int = self.BOOT_BAUD

        # ── [NEW v9] Binary telemetry decode state ───────────────────
        self._decoder = FrameDecoder()
        self._clock = SampleClock()
        self._dc = DCRemover(fc_hz=0.5, fs_hz=833.0)

        self.board_info: Optional[str] = None
        self.firmware_protocol: str = "unknown"   # "binary-v9" | "legacy-ascii"

        self.stats = {
            "frames": 0,
            "samples": 0,
            "frames_lost": 0,       # inferred from sequence gaps
            "crc_errors": 0,
            "fifo_overruns": 0,     # sensor FIFO overran (MCU-side loss)
            "tx_drops": 0,          # MCU dropped a frame, TX ring full
            "ws_drops": 0,          # live-view queue overflow (display only)
            "measured_rate_hz": 0.0,
            "tag_fallback": False,  # multi-word FIFO burst unsupported
        }
        self._last_seq: Optional[int] = None

        # [NEW v10] See _emit_sample() — updated on every sample, read by
        # the Step Test sequencer as the starting point for its first ramp.
        self.last_throttle_us: Optional[int] = None

    async def connect_async(self, port: str, baud_rate: int = 115200):
        if self.is_connected:
            await self.disconnect_async()

        self._serial = serial.Serial(
            port=port,
            baudrate=self.BOOT_BAUD,
            timeout=0.1,
            write_timeout=0.5,
        )
        self._serial.reset_input_buffer()
        self.current_baud = self.BOOT_BAUD

        self._decoder = FrameDecoder()
        self._clock.reset()
        self._dc.reset()
        self._last_seq = None
        self.board_info = None
        self.firmware_protocol = "unknown"
        for k, v in self.stats.items():
            self.stats[k] = (0.0 if isinstance(v, float)
                             else False if isinstance(v, bool) else 0)

        await asyncio.to_thread(self._wait_for_ready)

        self._stop_event.clear()
        self.is_connected = True
        self.current_port = port

        self._loop = asyncio.get_running_loop()

        self._reader_thread = threading.Thread(
            target=self._read_loop,
            daemon=True,
            name="serial-reader",
        )
        self._reader_thread.start()

        self._broadcast_task = asyncio.create_task(self._broadcast_loop())

        print(f"[Serial] Connected to {port} @ {self.BOOT_BAUD} (boot rate)")

        if baud_rate != self.BOOT_BAUD:
            confirmed, _ = await asyncio.to_thread(
                self.send_baud_switch_and_confirm, baud_rate
            )
            if not confirmed:
                print(f"[Serial] Warning: baud switch to {baud_rate} not confirmed — remaining at {self.current_baud}")

    def _wait_for_ready(self, timeout_s: float = 12.0):
        """Blocks (in a worker thread) reading raw lines until the firmware's
        'ESC Armed' readiness message appears, or timeout_s elapses. Falls
        back to a flat wait on timeout so a boot-message wording change in
        firmware doesn't hang the connection forever — just loses the
        early-command guarantee for that one connect. Also captures the
        firmware's own boot-time 'Active profile: THR_MIN=x THR_MAX=y' line
        as ground truth, since it's printed right after ESC Armed."""
        deadline = time.time() + timeout_s
        seen_armed = False
        while time.time() < deadline:
            try:
                raw = self._serial.readline().decode("utf-8", errors="replace").strip()
            except Exception:
                raw = ""
            if not raw:
                continue
            if raw.startswith("BOARD="):
                self.board_info = raw
                print(f"[Serial] {raw}")
                continue
            if "ESC Armed" in raw:
                seen_armed = True
                print("[Serial] Arduino ready (ESC Armed received)")
                continue  # keep reading briefly — the profile line follows immediately
            if seen_armed:
                m = re.search(r"Active profile:\s*THR_MIN=(\d+)\s*THR_MAX=(\d+)", raw)
                if m:
                    self.confirmed_thr_min = int(m.group(1))
                    self.confirmed_thr_max = int(m.group(2))
                    print(f"[Serial] Boot profile confirmed: {self.confirmed_thr_min}-{self.confirmed_thr_max}")
                    return
        if seen_armed:
            print("[Serial] Warning: ESC Armed seen but no profile confirmation line — proceeding anyway")
        else:
            print("[Serial] Warning: timed out waiting for 'ESC Armed' — proceeding anyway")

    def send_config_and_confirm(self, thr_min: int, thr_max: int, timeout_s: float = 3.0):
        """Sends CONFIG and blocks (call via asyncio.to_thread) until the
        Arduino's own 'CONFIG applied: THR_MIN=x THR_MAX=y' line arrives,
        or timeout_s elapses. Returns (confirmed: bool, thr_min, thr_max) —
        the LAST two values are what the Arduino actually reports, not what
        was requested, so a caller can detect a silently-ignored command."""
        cmd = f"CONFIG:{thr_min},{thr_max}\n".encode()
        if not (self._serial and self._serial.is_open):
            return False, self.confirmed_thr_min, self.confirmed_thr_max

        # [FIX] Drain any stale control lines left over from before this
        # command was sent, so we don't match against an old ack.
        while True:
            try:
                self._control_line_queue.get_nowait()
            except queue.Empty:
                break

        try:
            self._serial.write(cmd)
            self._serial.flush()
        except serial.SerialException as e:
            print(f"[Serial] Write error (CONFIG): {e}")
            return False, self.confirmed_thr_min, self.confirmed_thr_max

        deadline = time.time() + timeout_s
        while time.time() < deadline:
            remaining = max(0.0, deadline - time.time())
            try:
                raw = self._control_line_queue.get(timeout=min(0.2, remaining))
            except queue.Empty:
                continue
            m = re.search(r"CONFIG applied:\s*THR_MIN=(\d+)\s*THR_MAX=(\d+)", raw)
            if m:
                self.confirmed_thr_min = int(m.group(1))
                self.confirmed_thr_max = int(m.group(2))
                self._current_thr_min = self.confirmed_thr_min
                print(f"[Serial] CONFIG confirmed: {self.confirmed_thr_min}-{self.confirmed_thr_max}")
                return True, self.confirmed_thr_min, self.confirmed_thr_max
            if "CONFIG parse error" in raw:
                print("[Serial] CONFIG rejected by firmware (parse error)")
                return False, self.confirmed_thr_min, self.confirmed_thr_max
        print("[Serial] Warning: no CONFIG confirmation received within timeout")
        return False, self.confirmed_thr_min, self.confirmed_thr_max

    # [NEW] High-speed sampling modes ────────────────────────────────────────
    def send_sampling_rate_and_confirm(self, mode: str, timeout_s: float = 3.0):
        """Sends SR:<mode> and blocks (call via asyncio.to_thread) until the
        Arduino's own 'SR applied: ...' line arrives, or timeout_s elapses.
        Returns (confirmed: bool, raw_ack: Optional[str]) — mirrors the
        send_config_and_confirm() pattern above (same _control_line_queue,
        same reasoning: only the reader thread may call readline() on this
        serial.Serial, so acks are consumed from that queue, never read
        directly here)."""
        cmd = f"SR:{mode}\n".encode()
        if not (self._serial and self._serial.is_open):
            return False, None

        # Drain stale control lines left over from before this command.
        while True:
            try:
                self._control_line_queue.get_nowait()
            except queue.Empty:
                break

        try:
            self._serial.write(cmd)
            self._serial.flush()
        except serial.SerialException as e:
            print(f"[Serial] Write error (SR): {e}")
            return False, None

        deadline = time.time() + timeout_s
        while time.time() < deadline:
            remaining = max(0.0, deadline - time.time())
            try:
                raw = self._control_line_queue.get(timeout=min(0.2, remaining))
            except queue.Empty:
                continue
            if "SR applied" in raw:
                self.confirmed_sampling_rate = mode
                print(f"[Serial] SR confirmed: {mode}")
                return True, raw
            if "SR parse error" in raw:
                print("[Serial] SR rejected by firmware (parse error)")
                return False, raw
        print("[Serial] Warning: no SR confirmation received within timeout")
        return False, None

    def _send_and_confirm(self, cmd: str, ok_token: str, err_token: str,
                          timeout_s: float = 3.0):
        """Send an ASCII command and block until the firmware acks it.

        Same contract as send_config_and_confirm(): the ack is read from
        _control_line_queue (which the reader thread populates), never
        from the port directly — two threads calling read() on one
        serial.Serial is the race that used to make CONFIG acks vanish.
        Call via asyncio.to_thread.
        """
        if not (self._serial and self._serial.is_open):
            return False, None

        while True:
            try:
                self._control_line_queue.get_nowait()
            except queue.Empty:
                break

        try:
            self._serial.write(cmd.encode())
            self._serial.flush()
        except serial.SerialException as e:
            print(f"[Serial] Write error ({cmd.strip()}): {e}")
            return False, None

        deadline = time.time() + timeout_s
        while time.time() < deadline:
            remaining = max(0.0, deadline - time.time())
            try:
                raw = self._control_line_queue.get(timeout=min(0.2, remaining))
            except queue.Empty:
                continue
            if ok_token in raw:
                print(f"[Serial] {cmd.strip()} confirmed")
                return True, raw
            if err_token in raw:
                print(f"[Serial] {cmd.strip()} rejected by firmware (parse error)")
                return False, raw
        print(f"[Serial] Warning: no confirmation for {cmd.strip()} within timeout")
        return False, None

    def send_anti_alias_and_confirm(self, code: int, timeout_s: float = 3.0):
        """Sends AA:<code> — LPF2 anti-alias corner. v9+ firmware only."""
        return self._send_and_confirm(f"AA:{code}\n", "AA applied",
                                      "AA parse error", timeout_s)

    def send_timing_and_confirm(self, enabled: bool, timeout_s: float = 3.0):
        """Sends TIMING:ON|OFF — P0 instrumentation. v9+ firmware only."""
        arg = "ON" if enabled else "OFF"
        return self._send_and_confirm(f"TIMING:{arg}\n", "TIMING applied",
                                      "TIMING parse error", timeout_s)

    # [NEW] Baud switch — two-phase handshake, see BUG 1 in the .ino's v6
    # header comment for the full story of why this exists.
    def send_baud_switch_and_confirm(self, new_baud: int, timeout_s: float = 3.0):
        """Sends BAUD:<new_baud> at the CURRENT baud, waits for the
        Arduino's 'BAUD applied' ack (still at the old rate — the
        firmware sends and flushes it before switching), then re-baselines
        this side's baudrate to match and waits for a fresh 'READY' line
        to confirm the link is clean at the new rate. Call via
        asyncio.to_thread. Returns (confirmed: bool, raw_ack: Optional[str]).
        Only mutates self._serial.baudrate / self.current_baud after the
        first ack is seen — if the Arduino never acks, the connection is
        left untouched at whatever baud it was already using."""
        cmd = f"BAUD:{new_baud}\n".encode()
        if not (self._serial and self._serial.is_open):
            return False, None

        while True:
            try:
                self._control_line_queue.get_nowait()
            except queue.Empty:
                break

        try:
            self._serial.write(cmd)
            self._serial.flush()
        except serial.SerialException as e:
            print(f"[Serial] Write error (BAUD): {e}")
            return False, None

        # Phase 1: catch "BAUD applied: <n>" — still arrives at the OLD baud.
        deadline = time.time() + timeout_s
        applied = False
        while time.time() < deadline:
            remaining = max(0.0, deadline - time.time())
            try:
                raw = self._control_line_queue.get(timeout=min(0.2, remaining))
            except queue.Empty:
                continue
            if "BAUD applied" in raw:
                applied = True
                break
            if "BAUD parse error" in raw:
                print("[Serial] BAUD rejected by firmware (parse error)")
                return False, raw

        if not applied:
            print("[Serial] Warning: no BAUD ack received — leaving connection untouched")
            return False, None

        try:
            self._serial.baudrate = new_baud
            self.current_baud = new_baud
        except (serial.SerialException, ValueError) as e:
            print(f"[Serial] Failed to switch host baudrate to {new_baud}: {e}")
            return False, None

        deadline = time.time() + timeout_s
        while time.time() < deadline:
            remaining = max(0.0, deadline - time.time())
            try:
                raw = self._control_line_queue.get(timeout=min(0.2, remaining))
            except queue.Empty:
                continue
            if "READY" in raw:
                print(f"[Serial] BAUD confirmed: now at {new_baud}")
                return True, raw
        print(f"[Serial] Warning: switched to {new_baud} but no READY confirmation — link may be unreliable at this rate")
        return False, None

    async def disconnect_async(self):
        self._stop_event.set()
        self.is_connected = False
        self.current_port = None

        if self._broadcast_task and not self._broadcast_task.done():
            self._broadcast_task.cancel()
            try:
                await self._broadcast_task
            except asyncio.CancelledError:
                pass
        self._broadcast_task = None

        if self._serial and self._serial.is_open:
            try:
                self._serial.write(f"{self._current_thr_min}\n".encode())
                self._serial.flush()
                time.sleep(0.05)
                self._serial.close()
            except Exception:
                pass
        self._serial = None
        print("[Serial] Disconnected")

    def send_throttle(self, value: int):
        if self._serial and self._serial.is_open:
            try:
                self._serial.write(f"{value}\n".encode())
                self._serial.flush()
            except serial.SerialException as e:
                print(f"[Serial] Write error: {e}")

    def send_auto_test(self):
        self._send_cmd(b"AUTO_TEST\n", "AUTO_TEST")

    def send_stop_test(self):
        self._send_cmd(b"STOP_TEST\n", "STOP_TEST")

    def send_throttle_hold(self, target_us: int, hold_ms: int):
        """Send THROTTLE_HOLD command: THROTTLE_HOLD:<us>,<hold_ms>"""
        cmd = f"THROTTLE_HOLD:{target_us},{hold_ms}\n".encode()
        self._send_cmd(cmd, f"THROTTLE_HOLD target={target_us}us hold={hold_ms}ms")

    def send_stop_hold(self):
        self._send_cmd(b"STOP_HOLD\n", "STOP_HOLD")

    def _send_cmd(self, cmd_bytes: bytes, label: str):
        if self._serial and self._serial.is_open:
            try:
                self._serial.write(cmd_bytes)
                self._serial.flush()
                print(f"[Serial] Sent: {label}")
            except serial.SerialException as e:
                print(f"[Serial] Write error ({label}): {e}")

    # ── [NEW v9] Telemetry ingestion ─────────────────────────────────────
    def _handle_control_line(self, raw: str, parse_errors: int) -> int:
        """Route one ASCII line. Returns the updated parse_errors count."""
        legacy = parse_line(raw)
        if legacy is not None:
            if self.firmware_protocol != "legacy-ascii":
                self.firmware_protocol = "legacy-ascii"
                print("[Serial] NOTE: board is running pre-v9 ASCII firmware — "
                      "running in compatibility mode (~220 Hz, no MCU timestamps). "
                      "Reflash vib_throttle_dashbaord_v4.ino for the v9 acquisition path.")
            self.stats["samples"] += 1
            self._emit_sample(legacy)
            return 0

        try:
            self._control_line_queue.put_nowait(raw)
        except queue.Full:
            try:
                self._control_line_queue.get_nowait()
            except queue.Empty:
                pass
            self._control_line_queue.put_nowait(raw)

        # [NEW v9] Capture the board identity line — this is the answer to
        # RESEARCH.md §17.1, which could not be settled from the repo.
        if raw.startswith("BOARD="):
            self.board_info = raw
            print(f"[Serial] {raw}")
            return 0

        if raw.startswith("DBG_RPM") or raw.startswith("DBG_TIMING"):
            print(f"[MCU DEBUG] {raw}")
            return 0

        parse_errors += 1
        if parse_errors <= 5:
            print(f"[Parser] No match for line: '{raw}'")
        return parse_errors

    def _handle_telemetry(self, f: dict):
        """Expand one decoded binary frame into per-sample records."""
        if self.firmware_protocol != "binary-v9":
            self.firmware_protocol = "binary-v9"
            print("[Serial] Binary telemetry stream detected (v9 protocol)")

        self.stats["frames"] += 1

        seq = f["seq"]
        if self._last_seq is not None:
            gap = (seq - self._last_seq - 1) & 0xFFFF
            if 0 < gap < 1000:
                self.stats["frames_lost"] += gap
        self._last_seq = seq

        flags = f["flags"]
        if flags & FLAG_FIFO_OVERRUN:
            self.stats["fifo_overruns"] += 1
        if flags & FLAG_TX_DROP:
            self.stats["tx_drops"] += 1
        if flags & FLAG_TAG_FALLBACK and not self.stats["tag_fallback"]:
            self.stats["tag_fallback"] = True
            print("[Serial] NOTE: firmware fell back to single-word FIFO reads — "
                  "multi-word burst not supported by this sensor. Throughput is "
                  "unaffected; I2C transaction count is 4x higher than optimal.")

        n = f["n"]
        if n == 0:
            return

        dt_us = f["dt_us"] or 1200
        rate = 1e6 / dt_us
        if abs(rate - self._dc.fs_hz) > 1.0:
            self._dc.set_rate(rate)
            self._clock.reset_fit()

        host_perf = time.perf_counter()
        mcu_s_last = self._clock.update(
            f["t_us"], f["sample_index"] + n - 1, host_perf
        )
        self.stats["measured_rate_hz"] = round(self._clock.measured_rate_hz, 3)

        scale = g_per_lsb(f["scale_code"])

        rpm_count = f["rpm_count"]
        rpm_period = f["rpm_period"]
        rpm = float(rpm_period) if rpm_period > 0 else float(rpm_count)

        throttle = f["throttle"]
        base_index = f["sample_index"]

        for i, (rx, ry, rz) in enumerate(f["raw"]):
            ax = rx * scale
            ay = ry * scale
            az = rz * scale
            vx, vy, vz = self._dc.process(ax, ay, az)

            fitted = self._clock.time_for_index(base_index + i)
            mcu_s = fitted if fitted is not None else (
                mcu_s_last - (n - 1 - i) * (dt_us / 1e6)
            )

            self.stats["samples"] += 1
            self._emit_sample({
                "throttle": throttle,
                "rpm":      round(rpm, 1),
                "accX":     round(ax, 5),
                "accY":     round(ay, 5),
                "accZ":     round(az, 5),
                "vibX":     round(vx, 5),
                "vibY":     round(vy, 5),
                "vibZ":     round(vz, 5),
                "ts":       round(self._clock.to_wall(mcu_s) * 1000),
                "sampleIndex": base_index + i,
                "mcuUs":    round(mcu_s * 1e6, 1),
                "rpmCount": rpm_count,
                "rpmPeriod": rpm_period,
            })

    def _emit_sample(self, data: dict):
        """Log and enqueue one sample.

        The two-queue split is preserved exactly as it was, and it is the
        one architectural property of the old design that RESEARCH.md
        singled out as correct: the CSV log and the live view are fed by
        independent queues with OPPOSITE drop policies, so a slow browser
        can never throttle acquisition or corrupt the log.
        """
        self.last_throttle_us = data.get("throttle")

        self._csv_logger.write(data)

        try:
            self._data_queue.put_nowait(data)
        except queue.Full:
            try:
                self._data_queue.get_nowait()
                self.stats["ws_drops"] += 1
            except queue.Empty:
                pass
            try:
                self._data_queue.put_nowait(data)
            except queue.Full:
                self.stats["ws_drops"] += 1

    def _read_loop(self):
        print(f"[Serial] Reader thread started on {self.current_port}")
        parse_errors = 0

        while not self._stop_event.is_set():
            try:
                if not self._serial or not self._serial.is_open:
                    time.sleep(0.01)
                    continue

                waiting = self._serial.in_waiting
                chunk = self._serial.read(waiting if waiting else 1)
                if not chunk:
                    continue

                for kind, item in self._decoder.feed(chunk):
                    if kind == "telemetry":
                        self._handle_telemetry(item)
                    else:
                        parse_errors = self._handle_control_line(item, parse_errors)

                self.stats["crc_errors"] = self._decoder.crc_errors

            except serial.SerialException as e:
                print(f"[Serial] SerialException: {e}")
                self._stop_event.set()
                self.is_connected = False
                break
            except Exception as e:
                print(f"[Serial] Unexpected: {e}")
                time.sleep(0.01)

        print("[Serial] Reader thread stopped")

    BROADCAST_INTERVAL_S = 0.04     # 25 Hz
    BROADCAST_MAX_SAMPLES = 200     # cap per message

    async def _broadcast_loop(self):
        print("[Broadcast] Loop started")
        while not self._stop_event.is_set():
            try:
                await asyncio.sleep(self.BROADCAST_INTERVAL_S)

                batch = []
                while len(batch) < self.BROADCAST_MAX_SAMPLES:
                    try:
                        batch.append(self._data_queue.get_nowait())
                    except queue.Empty:
                        break

                if not batch:
                    continue

                pending = self._data_queue.qsize()
                if pending > self.BROADCAST_MAX_SAMPLES:
                    drained = []
                    while True:
                        try:
                            drained.append(self._data_queue.get_nowait())
                        except queue.Empty:
                            break
                    combined = batch + drained
                    step = max(1, len(combined) // self.BROADCAST_MAX_SAMPLES)
                    batch = combined[::step][-self.BROADCAST_MAX_SAMPLES:]

                await self._ws_manager.broadcast(json.dumps({
                    "type": "batch",
                    "samples": batch,
                    "stats": {
                        "rateHz": self.stats["measured_rate_hz"],
                        "framesLost": self.stats["frames_lost"],
                        "crcErrors": self.stats["crc_errors"],
                        "fifoOverruns": self.stats["fifo_overruns"],
                        "protocol": self.firmware_protocol,
                    },
                }))
            except asyncio.CancelledError:
                break
            except Exception as e:
                print(f"[Broadcast] Error: {e}")
                await asyncio.sleep(0.01)

        print("[Broadcast] Loop stopped")