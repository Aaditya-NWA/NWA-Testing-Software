"""
Writes samples to CSV on a background thread, with a paired console capture.

Timestamps are IST and derive from the MCU sample clock (data["ts"]), not the
host clock at write time -- an arrival stamp would batch with USB and make any
uniform-grid analysis wrong.

Files land in Documents/NWA Testing Software/CSVs. Tests that start a
CSVLogger must redirect _TEST_DATA_DIR first or they write into live operator
data.
"""
import csv
import os
import queue
import threading
from datetime import datetime, timezone, timedelta
from typing import Optional

import app_paths
import console_tee

_COLUMNS = [
    "Timestamp", "SampleIndex", "McuMicros", "Throttle", "RPM", "RpmCount",
    "AccX", "AccY", "AccZ",
    "VibX", "VibY", "VibZ",
]

_SENTINEL = object()

# [NEW] IST offset: UTC+5:30
_IST = timezone(timedelta(hours=5, minutes=30))

_TEST_DATA_DIR = str(app_paths.csv_dir())
_DBG_LOGS_DIR  = os.path.join(_TEST_DATA_DIR, "DBG Logs")


def _ist_now() -> datetime:
    """Return current datetime in IST."""
    return datetime.now(_IST)


class CSVLogger:
    def __init__(self):
        self._queue: queue.Queue      = queue.Queue(maxsize=16384)
        self._thread: Optional[threading.Thread] = None
        self._file_path: Optional[str] = None
        self._lock = threading.Lock()
        self.is_logging = False
        # [NEW v9] Counts rows lost to queue overflow — see write().
        self.dropped_rows = 0

        print(f"[Logger] Test Data folder will be: {_TEST_DATA_DIR}")

    @property
    def current_file(self) -> Optional[str]:
        return self._file_path

    # ── Public API ─────────────────────────────────────────────────────────────

    def start(self, custom_name: Optional[str] = None) -> str:
        """
        Start logging. If custom_name is provided and non-empty, use it as
        the filename (without .csv extension is also fine — we add .csv).
        Otherwise defaults to YYYY-MM-DD_HH-MM-SS.csv in IST.
        """
        with self._lock:
            if self.is_logging:
                self._enqueue_sentinel()

        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=5)

        os.makedirs(_TEST_DATA_DIR, exist_ok=True)
        print(f"[Logger] Folder ready: {_TEST_DATA_DIR}")

        # [NEW] Filename logic: custom name or IST timestamp
        if custom_name and custom_name.strip():
            name = custom_name.strip()
            if not name.lower().endswith(".csv"):
                name += ".csv"
        else:
            # Default: YYYY-MM-DD_HH-MM-SS in IST
            stamp = _ist_now().strftime("%Y-%m-%d_%H-%M-%S")
            name = f"{stamp}.csv"

        self._file_path = os.path.join(_TEST_DATA_DIR, name)

        os.makedirs(_DBG_LOGS_DIR, exist_ok=True)
        dbg_name = os.path.splitext(os.path.basename(self._file_path))[0] + ".txt"
        console_tee.start_capture(os.path.join(_DBG_LOGS_DIR, dbg_name))

        # Drain stale queue
        while not self._queue.empty():
            try:
                self._queue.get_nowait()
            except queue.Empty:
                break

        with self._lock:
            self.is_logging = True
            self.dropped_rows = 0

        self._thread = threading.Thread(
            target=self._writer_loop,
            args=(self._file_path,),
            daemon=True,
            name="csv-writer",
        )
        self._thread.start()
        print(f"[Logger] Started logging -> {self._file_path}")
        return self._file_path

    def stop(self):
        with self._lock:
            if not self.is_logging:
                return
            self.is_logging = False

        self._enqueue_sentinel()

        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=10)
        self._thread = None
        print(f"[Logger] Stopped logging -> {self._file_path}")
        # [NEW] Closes and flushes the paired console capture — this print
        # line above is the last thing that lands in it.
        console_tee.stop_capture()

    def write(self, data: dict):
        if not self.is_logging:
            return

        # [CHANGED v9] THE TIMESTAMP FIX.
        #
        # This line used to call _ist_now() — i.e. it stamped the row
        # with the host's wall clock at the moment the reader thread got
        # around to writing it, AFTER USB transport and parsing. That
        # made every timestamp in this system an ARRIVAL stamp, with
        # three compounding defects (RESEARCH.md §5.3):
        #   - USB batches arrivals, so 11-30% of consecutive rows shared
        #     a millisecond and dt=0 was common;
        #   - time.time() on Windows nominally resolves to 15.625 ms and
        #     only read ~1 ms because some other process happened to have
        #     raised the global timer resolution — a latent, silent,
        #     environment-dependent failure;
        #   - true sampling jitter was therefore unobservable, not merely
        #     unmeasured.
        #
        # data["ts"] now originates from the MCU's own micros() mapped
        # into host wall-clock (signal_chain.SampleClock), so the
        # rendered timestamp is a real sample time. McuMicros carries the
        # unmapped MCU value for anyone who wants the raw grid.
        ts_ms = data.get("ts")
        if ts_ms is None:
            ts = _ist_now()
        else:
            ts = datetime.fromtimestamp(ts_ms / 1000.0, _IST)

        row = {
            "Timestamp":   ts.strftime("%Y-%m-%d %H:%M:%S.%f")[:-3],
            "SampleIndex": data.get("sampleIndex", ""),
            "McuMicros":   data.get("mcuUs", ""),
            "Throttle":    data["throttle"],
            "RPM":         data["rpm"],
            "RpmCount":    data.get("rpmCount", ""),
            "AccX":        data["accX"],
            "AccY":        data["accY"],
            "AccZ":        data["accZ"],
            "VibX":        data["vibX"],
            "VibY":        data["vibY"],
            "VibZ":        data["vibZ"],
        }
        try:
            self._queue.put_nowait(row)
        except queue.Full:
            self.dropped_rows += 1
            if self.dropped_rows == 1 or self.dropped_rows % 1000 == 0:
                print(f"[Logger] WARNING: CSV queue full — {self.dropped_rows} row(s) dropped")

    # ── Internal ───────────────────────────────────────────────────────────────

    def _enqueue_sentinel(self):
        try:
            self._queue.put_nowait(_SENTINEL)
        except queue.Full:
            try:
                self._queue.get_nowait()
            except queue.Empty:
                pass
            self._queue.put_nowait(_SENTINEL)

    def _writer_loop(self, path: str):
        print(f"[Logger] Writer thread started, writing to: {path}")
        try:
            with open(path, "w", newline="", encoding="utf-8") as f:
                writer = csv.DictWriter(f, fieldnames=_COLUMNS)
                writer.writeheader()
                f.flush()

                batch: list = []
                while True:
                    try:
                        item = self._queue.get(timeout=0.1)
                        if item is _SENTINEL:
                            if batch:
                                writer.writerows(batch)
                                f.flush()
                                batch.clear()
                            break
                        batch.append(item)
                        if len(batch) >= 200:
                            writer.writerows(batch)
                            f.flush()
                            batch.clear()
                    except queue.Empty:
                        if batch:
                            writer.writerows(batch)
                            f.flush()
                            batch.clear()

        except Exception as e:
            print(f"[Logger] Writer error: {e}")
        print(f"[Logger] Writer thread finished")
