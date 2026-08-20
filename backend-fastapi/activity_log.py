"""activity_log.py — who did what, when, and under which session.

[NEW v13] The application is packaged and handed to operators on other
machines. When one of them reports that something went wrong, this file is
what explains it, without anyone travelling to the bench.

Format — one line per event, in the Logs folder, a new file per calendar day:

    Documents/NWA Testing Software/Logs/activity-2026-08-18.txt

    2026-08-18 13:04:22.417 | S-7F3A9C21 | admin   | Admin    | CONNECT    | port=COM5 baud=115200 -> ok

Plain text, not JSON: an operator has to be able to open it in Notepad, read
it, and attach it to an email.

Three rules this module exists to enforce:

1. **Append and flush per line.** Buffered writes lose exactly the lines
   that explain a crash — the ones just before it.

2. **Never log the telemetry stream.** At 833 Hz, samples would be gigabytes
   a day and would bury every line that matters. Sample data already has a
   home in the CSVs. This module logs *actions*, and the only high-rate
   action — dragging the throttle slider — is coalesced (see
   `log_throttle`), because one drag would otherwise write hundreds of
   lines.

3. **Never log credentials.** No passwords, no hashes, no tokens. The
   session key is a reference, not a secret.

Retention is deliberately absent: nothing here ever deletes a log. Text at
this event rate costs nothing, and the record of an incident has to still be
there when someone finally asks about it.
"""

import threading
from datetime import datetime, timedelta, timezone
from typing import Optional

import app_paths

# CSV logs are already written with IST timestamps (see logger.py). Activity
# logs match so the two line up on one timeline when diagnosing a run.
IST = timezone(timedelta(hours=5, minutes=30))

_lock = threading.Lock()

_THROTTLE_GAP_S = 1.0
_throttle_pending: Optional[tuple] = None
_throttle_timer: Optional[threading.Timer] = None
_throttle_last_at = 0.0


def _now() -> datetime:
    return datetime.now(IST)


def _log_path(when: datetime):
    return app_paths.logs_dir() / f"activity-{when.strftime('%Y-%m-%d')}.txt"


def _write(when: datetime, line: str) -> None:
    """Append one line and flush it. Never raises into the caller.

    Logging is diagnostic: a failure to write must not take down the action
    being logged. The day's file is chosen from the timestamp rather than
    cached, so a session running past midnight rolls over on its own instead
    of writing tomorrow's events into yesterday's file.
    """
    try:
        with _lock:
            with open(_log_path(when), "a", encoding="utf-8") as f:
                f.write(line + "\n")
                f.flush()
    except Exception:
        pass


def log(event: str, detail: str = "", session=None) -> None:
    """Record one event.

    `session` is an auth.Session, or None for events that happen outside a
    login — application start, a failed login attempt, backend-initiated
    shutdown. Those still belong in the log; they just have no user.
    """
    when = _now()
    key  = getattr(session, "key", "-")
    user = getattr(session, "username", "-")
    role = getattr(session, "role", "-")
    if not isinstance(key, str):
        key, user, role = "-", "-", "-"
    line = (
        f"{when.strftime('%Y-%m-%d %H:%M:%S.%f')[:-3]} | "
        f"{key:<11} | {user:<9} | {role:<9} | {event:<16} | {detail}"
    )
    _write(when, line)


def log_throttle(value_us: int, detail: str = "", session=None) -> None:
    """Coalesced throttle logging — see the module docstring.

    One slider drag sends a command every 50 ms. Logging each one would push
    hundreds of near-identical lines between the two events anyone actually
    wants to read.
    """
    global _throttle_pending, _throttle_timer, _throttle_last_at
    import time
    now = time.monotonic()
    with _lock:
        since = now - _throttle_last_at
        if since >= _THROTTLE_GAP_S:
            _throttle_last_at = now
            fire = True
        else:
            _throttle_pending = (value_us, detail, session)
            fire = False
            if _throttle_timer is None:
                _throttle_timer = threading.Timer(
                    _THROTTLE_GAP_S - since, _flush_throttle
                )
                _throttle_timer.daemon = True
                _throttle_timer.start()
    if fire:
        log("THROTTLE", f"{value_us}us {detail}".strip(), session)


def _flush_throttle() -> None:
    global _throttle_pending, _throttle_timer, _throttle_last_at
    import time
    with _lock:
        _throttle_timer = None
        pending = _throttle_pending
        _throttle_pending = None
        if pending is None:
            return
        _throttle_last_at = time.monotonic()
    value_us, detail, session = pending
    log("THROTTLE", f"{value_us}us {detail}".strip(), session)


def current_log_file() -> str:
    """Path of today's log, for the UI's 'Open logs folder' action."""
    return str(_log_path(_now()))


def logs_folder() -> str:
    return str(app_paths.logs_dir())
