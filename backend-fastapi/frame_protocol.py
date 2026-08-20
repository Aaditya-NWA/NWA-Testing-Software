"""
frame_protocol.py — [NEW v9] binary telemetry codec.

This module is one half of a two-sided contract. The other half is
Arduino/vib_throttle_dashbaord_v4.ino. Changing either without the
other breaks the link silently, which is exactly the failure mode
CLAUDE.md's "Firmware/backend contract" section warns about — so the
frame layout is spelled out in both files and the constants below are
the single source of truth on this side.

WHY BINARY AT ALL
    The old wire format spent 51.8 ASCII bytes per sample to carry 6
    bytes of actual information (3 x int16), an 8.6x inflation, and cost
    the firmware 7 float->ASCII conversions and 15 Serial.print() calls
    per sample. Measured result: throughput pinned at ~222 samples/sec
    regardless of baud, with the wire only 12.6% utilised at 921600.
    The link was never the limit; the encoding was.

    v9 sends raw int16 counts and scales to g here, on a machine with an
    FPU, where it is free. ~7.8 B/sample including all framing.

FRAME LAYOUT
    AA 55 | type(1) | len(1) | payload(len) | crc16_ccitt(2, little-endian)

    CRC covers type + len + payload (not the sync bytes — they are a
    resync marker, not data). CRC16-CCITT, poly 0x1021, init 0xFFFF.

TELEMETRY PAYLOAD (type 0x01), all little-endian:
    off  size  field
     0   u16   seq            frame counter, wraps at 65536
     2   u32   sample_index   absolute index of the FIRST sample in batch
     6   u32   t_us           MCU micros() at batch read completion
    10   u32   dt_us          nominal output sample period
    14   u16   rpm_count      RPM from pulse count per 500ms window
    16   u16   rpm_period     RPM from mean pulse interval
    18   u16   throttle_us
    20   u8    n              number of accel samples following
    21   u8    flags          bit0 FIFO overrun, bit1 TX drop,
                              bit2 tag-mismatch fallback active
    22   u8    scale_code     accel full scale in g (2/4/8/16)
    23   u8    odr_code       ODR in Hz / 10  (83 => 833 Hz)
    24   n x { i16 ax, i16 ay, i16 az }   raw counts

COEXISTENCE WITH ASCII
    The control plane (commands and their acks, DBG_RPM, DBG_TIMING,
    boot messages) is still ASCII, deliberately: it is low-rate,
    human-debuggable in a plain serial monitor, and it means every
    existing confirmation regex in serial_manager.py keeps working
    untouched. FrameDecoder below demultiplexes the two streams off one
    port: it hunts for the 0xAA 0x55 sync pair and treats everything
    else as line-oriented text.

    Binary payloads can legitimately contain 0xAA, 0x55 and 0x0A bytes,
    so sync detection alone is not proof of a frame — the length and CRC
    have to agree too. A candidate that fails CRC is not discarded
    wholesale; only its first byte is consumed, so a real frame starting
    one byte later is still found.
"""

import struct
from typing import List, Optional, Tuple

SYNC0 = 0xAA
SYNC1 = 0x55

FRAME_TYPE_TELEMETRY = 0x01

TELEMETRY_HEADER_LEN = 24
# dt_us is u32, not u16: DEFAULT mode decimates 833 Hz by 167, giving a
# 200,400 us period that does not fit in 16 bits (see the .ino).
_HEADER_STRUCT = struct.Struct("<HIIIHHHBBBB")
assert _HEADER_STRUCT.size == TELEMETRY_HEADER_LEN

# Frame overhead: 2 sync + 1 type + 1 len + 2 crc
FRAME_OVERHEAD = 6

FLAG_FIFO_OVERRUN = 0x01
FLAG_TX_DROP      = 0x02
FLAG_TAG_FALLBACK = 0x04

# LSM6DSO accelerometer sensitivity, mg per LSB, by full-scale range.
# Matches the values in the SparkFun driver's calcAccel().
_MG_PER_LSB = {2: 0.061, 4: 0.122, 8: 0.244, 16: 0.488}


def crc16_ccitt(data: bytes, crc: int = 0xFFFF) -> int:
    """CRC16-CCITT (poly 0x1021, init 0xFFFF), bitwise.

    Mirrors crc16Update() in the firmware exactly. Bitwise rather than
    table-driven on both sides so the two implementations are visibly
    the same algorithm rather than a table someone has to trust.
    """
    for b in data:
        crc ^= b << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if (crc & 0x8000) else ((crc << 1) & 0xFFFF)
    return crc & 0xFFFF


def g_per_lsb(scale_code: int) -> float:
    """Convert an accel full-scale code (in g) to g per LSB."""
    return _MG_PER_LSB.get(scale_code, _MG_PER_LSB[4]) / 1000.0


def encode_telemetry(
    seq: int,
    sample_index: int,
    t_us: int,
    dt_us: int,
    rpm_count: int,
    rpm_period: int,
    throttle_us: int,
    samples: List[Tuple[int, int, int]],
    flags: int = 0,
    scale_code: int = 4,
    odr_code: int = 83,
) -> bytes:
    """Build a telemetry frame.

    Exists mainly so the decoder can be tested against a known-good
    encoder without a board attached — the firmware is flashed by hand
    from the Arduino IDE, so a round-trip test here is the only
    automated check this protocol can have.
    """
    n = len(samples)
    payload = bytearray(
        _HEADER_STRUCT.pack(
            seq & 0xFFFF,
            sample_index & 0xFFFFFFFF,
            t_us & 0xFFFFFFFF,
            dt_us & 0xFFFFFFFF,
            rpm_count & 0xFFFF,
            rpm_period & 0xFFFF,
            throttle_us & 0xFFFF,
            n & 0xFF,
            flags & 0xFF,
            scale_code & 0xFF,
            odr_code & 0xFF,
        )
    )
    for ax, ay, az in samples:
        payload += struct.pack("<hhh", ax, ay, az)

    body = bytes([FRAME_TYPE_TELEMETRY, len(payload)]) + bytes(payload)
    crc = crc16_ccitt(body)
    return bytes([SYNC0, SYNC1]) + body + struct.pack("<H", crc)


def decode_telemetry_payload(payload: bytes) -> Optional[dict]:
    """Decode a telemetry payload into a dict, or None if malformed."""
    if len(payload) < TELEMETRY_HEADER_LEN:
        return None
    (
        seq, sample_index, t_us, dt_us,
        rpm_count, rpm_period, throttle_us,
        n, flags, scale_code, odr_code,
    ) = _HEADER_STRUCT.unpack_from(payload, 0)

    expected = TELEMETRY_HEADER_LEN + n * 6
    if len(payload) != expected:
        return None

    raw: List[Tuple[int, int, int]] = []
    off = TELEMETRY_HEADER_LEN
    for _ in range(n):
        raw.append(struct.unpack_from("<hhh", payload, off))
        off += 6

    return {
        "seq": seq,
        "sample_index": sample_index,
        "t_us": t_us,
        "dt_us": dt_us,
        "rpm_count": rpm_count,
        "rpm_period": rpm_period,
        "throttle": throttle_us,
        "flags": flags,
        "scale_code": scale_code,
        "odr_code": odr_code,
        "n": n,
        "raw": raw,
    }


class FrameDecoder:
    """Byte-stream demultiplexer: binary frames + ASCII lines off one port.

    feed() returns a list of ("telemetry", dict) and ("line", str) tuples
    in the order they appeared on the wire. Partial input is retained
    between calls, so the caller can hand it whatever read() returned
    without worrying about frame or line boundaries.

    Counters are exposed rather than logged-and-forgotten because silent
    loss is the thing this rewrite is trying to eliminate: RESEARCH.md
    §12 flagged `except queue.Full: pass` in the logger as a silent
    discard, and the same reasoning applies to the wire.
    """

    MAX_PAYLOAD = 255

    def __init__(self) -> None:
        self._buf = bytearray()
        self._text = bytearray()
        self.crc_errors = 0
        self.frames_decoded = 0
        self.bad_length = 0
        self.resync_bytes = 0

    def feed(self, data: bytes) -> List[Tuple[str, object]]:
        out: List[Tuple[str, object]] = []
        if data:
            self._buf.extend(data)

        while self._buf:
            b0 = self._buf[0]

            if b0 == SYNC0:
                if len(self._buf) < 2:
                    break                       # need the second sync byte
                if self._buf[1] != SYNC1:
                    self._consume_text(1)
                    continue
                if len(self._buf) < 4:
                    break                       # need type + len
                payload_len = self._buf[3]
                if payload_len > self.MAX_PAYLOAD:
                    self.bad_length += 1
                    self._consume_text(1)
                    continue
                total = FRAME_OVERHEAD + payload_len
                if len(self._buf) < total:
                    break                       # wait for the rest

                body = bytes(self._buf[2:4 + payload_len])
                crc_recv = self._buf[4 + payload_len] | (self._buf[5 + payload_len] << 8)
                if crc16_ccitt(body) != crc_recv:
                    self.crc_errors += 1
                    self._consume_text(1)
                    continue

                # Any accumulated text ends here, even without a newline.
                out.extend(self._flush_text(force=True))

                frame_type = self._buf[2]
                payload = bytes(self._buf[4:4 + payload_len])
                del self._buf[:total]

                if frame_type == FRAME_TYPE_TELEMETRY:
                    decoded = decode_telemetry_payload(payload)
                    if decoded is not None:
                        self.frames_decoded += 1
                        out.append(("telemetry", decoded))
                    else:
                        self.bad_length += 1
                continue

            idx = self._buf.find(bytes([SYNC0]))
            take = len(self._buf) if idx == -1 else idx
            self._consume_text(take)
            out.extend(self._flush_text())

        out.extend(self._flush_text())
        return out

    # ── internals ────────────────────────────────────────────────────
    def _consume_text(self, count: int) -> None:
        if count <= 0:
            return
        self._text.extend(self._buf[:count])
        del self._buf[:count]
        self.resync_bytes += count

    def _flush_text(self, force: bool = False) -> List[Tuple[str, object]]:
        """Emit complete ASCII lines from the text accumulator."""
        out: List[Tuple[str, object]] = []
        while True:
            nl = self._text.find(b"\n")
            if nl == -1:
                break
            line = bytes(self._text[:nl]).decode("utf-8", errors="replace").strip()
            del self._text[:nl + 1]
            if line:
                out.append(("line", line))

        if force and self._text:
            line = bytes(self._text).decode("utf-8", errors="replace").strip()
            self._text.clear()
            if line:
                out.append(("line", line))

        if len(self._text) > 4096:
            del self._text[:-1024]

        return out
