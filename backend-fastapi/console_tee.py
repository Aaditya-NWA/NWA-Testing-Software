"""console_tee.py — mirrors everything printed to the backend console into
a text file, so DBG_RPM / DBG_TIMING lines (and everything else this
process prints) are captured automatically instead of requiring manual
terminal scrollback copying.

How it's wired in: install() runs once at app startup (main.py) and
replaces sys.stdout with a tee that always writes to the real console AND,
if one is open, to a capture file. CSVLogger then calls start_capture()/
stop_capture() from its own start()/stop(), using the exact same base
filename as the CSV it's about to write — so every logging session gets a
paired console capture for free, with no other code needing to change.

Every existing print() statement anywhere in the codebase is captured
automatically, because this replaces sys.stdout itself rather than
requiring call sites to be rewritten.
"""
import io
import sys
import threading
from typing import Optional


class _TeeStdout(io.TextIOBase):
    """A capture file failing to open/write must never take down console
    output or crash the app, so every capture-side operation is wrapped.

    [v14] `real_stdout` may be None. A PyInstaller windowed build has no
    stdout at all, and a sidecar whose parent closed the pipe loses it
    mid-run — either way an unguarded self._real.write() would turn every
    print() in the backend into an AttributeError.
    """

    def __init__(self, real_stdout):
        self._real = real_stdout
        self._lock = threading.Lock()
        self._capture: Optional[io.TextIOBase] = None

    def _to_real(self, fn) -> None:
        if self._real is None:
            return
        try:
            fn(self._real)
        except Exception:
            self._real = None   # broken pipe: stop trying, keep capturing

    def write(self, s: str) -> int:
        # Flushed per write, not per line: as a Tauri sidecar stdout is a pipe,
        # and Python block-buffers pipes — the shell would see nothing for 8 KB.
        self._to_real(lambda r: (r.write(s), r.flush()))
        with self._lock:
            if self._capture is not None:
                try:
                    self._capture.write(s)
                    self._capture.flush()
                except Exception:
                    pass
        return len(s)

    def flush(self):
        self._to_real(lambda r: r.flush())
        with self._lock:
            if self._capture is not None:
                try:
                    self._capture.flush()
                except Exception:
                    pass

    def set_capture(self, path: Optional[str]):
        with self._lock:
            if self._capture is not None:
                try:
                    self._capture.close()
                except Exception:
                    pass
                self._capture = None
            if path is not None:
                try:
                    self._capture = open(path, "a", encoding="utf-8", errors="replace")
                except Exception as e:
                    self._real.write(f"[ConsoleTee] Could not open capture file {path}: {e}\n")


_tee: Optional[_TeeStdout] = None


def install():
    """Replace sys.stdout with the tee. Call once, at app startup.
    Idempotent — safe to call again (e.g. under uvicorn --reload)."""
    global _tee
    if _tee is not None:
        return
    _tee = _TeeStdout(sys.stdout)
    sys.stdout = _tee


def start_capture(path: str):
    """Begin mirroring console output into `path`, appending if it exists.
    Closes any previously open capture first."""
    if _tee is None:
        install()
    _tee.set_capture(path)
    print(f"[ConsoleTee] Capturing console output -> {path}")


def stop_capture():
    """Stop mirroring; the capture file is flushed and closed."""
    if _tee is None:
        return
    print("[ConsoleTee] Capture stopped")
    _tee.set_capture(None)
