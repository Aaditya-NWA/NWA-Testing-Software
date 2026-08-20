"""
Motor profile store [NEW v11]
=============================

Persistence for motor profiles the operator calibrates on the bench, i.e.
everything the Motor Config tab produces. The three original profiles stay
hardcoded in the frontend (`BUILTIN_MOTOR_PROFILES` in motorProfiles.ts);
this file owns only the ones a human measured.

WHY THE BACKEND OWNS THIS AND NOT localStorage
    A profile is the result of a physical test: someone mounted a motor,
    swept the throttle, and wrote down where it started spinning. That is
    bench configuration, not browser state — clearing site data, opening
    the dashboard in a different browser, or moving to the other laptop on
    the bench should not silently lose it and leave the operator running a
    motor against a stale range. The backend already owns everything else
    that is true of the hardware rather than of the tab.

THE VALIDATION HERE MIRRORS THE FIRMWARE, DELIBERATELY
    A saved profile's whole purpose is to be pushed to the Arduino later
    as `CONFIG:<min>,<max>`. The .ino's parseConfig() rejects a range
    outright if `newMax - newMin < NUM_SEGS` — and a rejected CONFIG is
    the silent-failure mode this codebase keeps guarding against
    (serial_manager confirms every command for exactly that reason). So a
    range the firmware would refuse is refused HERE, at the point where a
    human can still fix it, instead of at 3 am against a spinning motor.
    test_motor_profiles.py reads NUM_SEGS straight out of the .ino so the
    two cannot drift apart.
"""

import json
import os
import re
import shutil
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import app_paths

STORE_PATH = app_paths.motor_config_dir() / "motor_profiles.json"

ABS_MIN_US = 800
ABS_MAX_US = 2400

MIN_SPAN_US = 10

MAX_LABEL_LEN = 40
RPM_GAUGE_MIN = 100
RPM_GAUGE_MAX = 60000


def _slug(label: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "_", label.strip().lower()).strip("_")
    return s or "motor"


def normalise_label(label: str) -> str:
    """Collapse whitespace and case so 'U7 V2' and 'u7  v2' collide.

    Used only for duplicate detection — the stored label keeps whatever
    the operator typed.
    """
    return re.sub(r"\s+", " ", label.strip()).lower()


def validate(profile: Dict[str, Any]) -> Optional[str]:
    """Return an error string, or None if the profile is acceptable.

    Returns the FIRST problem rather than a list: these are typed into
    four fields by one person watching one motor, and a single clear
    sentence beats a paragraph.
    """
    label = str(profile.get("label", "")).strip()
    if not label:
        return "Motor name is required"
    if len(label) > MAX_LABEL_LEN:
        return f"Motor name must be at most {MAX_LABEL_LEN} characters"

    try:
        thr_min = int(profile["thr_min"])
        thr_max = int(profile["thr_max"])
        rpm_gauge_max = int(profile["rpm_gauge_max"])
    except (KeyError, TypeError, ValueError):
        return "thr_min, thr_max and rpm_gauge_max must be whole numbers"

    if not ABS_MIN_US <= thr_min <= ABS_MAX_US:
        return f"thr_min must be {ABS_MIN_US}–{ABS_MAX_US} µs (got {thr_min})"
    if not ABS_MIN_US <= thr_max <= ABS_MAX_US:
        return f"thr_max must be {ABS_MIN_US}–{ABS_MAX_US} µs (got {thr_max})"
    if thr_min >= thr_max:
        return "thr_min must be less than thr_max"
    if thr_max - thr_min < MIN_SPAN_US:
        # See the module docstring: this is the firmware's own rule.
        return (
            f"Range must span at least {MIN_SPAN_US} µs — the firmware "
            f"divides it into auto-test segments and rejects anything narrower"
        )
    if not RPM_GAUGE_MIN <= rpm_gauge_max <= RPM_GAUGE_MAX:
        return f"rpm_gauge_max must be {RPM_GAUGE_MIN}–{RPM_GAUGE_MAX} RPM"

    return None


def _read_raw() -> List[Dict[str, Any]]:
    if not STORE_PATH.exists():
        return []
    try:
        with open(STORE_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (json.JSONDecodeError, OSError):
        return []
    if not isinstance(data, list):
        return []
    return [p for p in data if isinstance(p, dict) and "id" in p]


def _write_raw(profiles: List[Dict[str, Any]]) -> None:
    # Atomic replace: a half-written JSON file would read back as an empty
    # store on the next boot and quietly lose every calibrated motor.
    tmp = STORE_PATH.with_suffix(".json.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(profiles, f, indent=2)
    os.replace(tmp, STORE_PATH)


def list_profiles() -> List[Dict[str, Any]]:
    return _read_raw()


def save_profile(
    profile: Dict[str, Any], overwrite: bool = False
) -> Tuple[bool, Any]:
    """Create or update a profile.

    Returns (True, saved_profile) or (False, error_message).

    An explicit `id` that already exists is an update. Otherwise a label
    that collides with an existing profile is refused unless `overwrite`
    is set — recalibrating the same motor is normal and should be one
    action, but silently replacing someone else's saved range is not.
    """
    err = validate(profile)
    if err:
        return False, err

    profiles = _read_raw()
    label = str(profile["label"]).strip()
    key = normalise_label(label)

    existing_idx = None
    if profile.get("id"):
        for i, p in enumerate(profiles):
            if p.get("id") == profile["id"]:
                existing_idx = i
                break
    if existing_idx is None:
        for i, p in enumerate(profiles):
            if normalise_label(str(p.get("label", ""))) == key:
                if not overwrite:
                    return False, f'A profile named "{p.get("label")}" already exists'
                existing_idx = i
                break

    record = {
        "id": (
            profiles[existing_idx]["id"]
            if existing_idx is not None
            else f"{_slug(label)}_{uuid.uuid4().hex[:6]}"
        ),
        "label": label,
        "thr_min": int(profile["thr_min"]),
        "thr_max": int(profile["thr_max"]),
        "rpm_gauge_max": int(profile["rpm_gauge_max"]),
        "spin_up_us": _opt_int(profile.get("spin_up_us")),
        "max_measured_us": _opt_int(profile.get("max_measured_us")),
        "notes": (str(profile.get("notes")).strip() or None) if profile.get("notes") else None,
        "created_at": (
            profiles[existing_idx].get("created_at")
            if existing_idx is not None
            else time.strftime("%Y-%m-%d %H:%M:%S")
        ),
        "updated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
    }

    if existing_idx is not None:
        profiles[existing_idx] = record
    else:
        profiles.append(record)

    _write_raw(profiles)
    return True, record


def _opt_int(v: Any) -> Optional[int]:
    if v is None or v == "":
        return None
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def delete_profile(profile_id: str) -> bool:
    profiles = _read_raw()
    remaining = [p for p in profiles if p.get("id") != profile_id]
    if len(remaining) == len(profiles):
        return False
    _write_raw(remaining)
    return True


BUILTIN_SEED: List[Dict[str, Any]] = [
    {"id": "u15ii_kv100", "label": "U15II KV100 (48V)",
     "thr_min": 1025, "thr_max": 1600, "rpm_gauge_max": 2800},
    {"id": "u7_v2", "label": "U7 V2.0 KV490",
     "thr_min": 1165, "thr_max": 1515, "rpm_gauge_max": 6500},
    {"id": "v605_kv210", "label": "V605 KV210 (test range)",
     "thr_min": 1000, "thr_max": 2000, "rpm_gauge_max": 9000},
]


_LEGACY_STORE = Path(__file__).parent / "motor_profiles.json"


def migrate_legacy_store() -> bool:
    """Move a pre-v13 store into the Documents folder. Returns True if moved.

    Only runs when the new location does not exist yet, so it can never
    overwrite configurations saved since the move.
    """
    if STORE_PATH.exists() or not _LEGACY_STORE.exists():
        return False
    try:
        STORE_PATH.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(_LEGACY_STORE, STORE_PATH)
        # Renamed rather than deleted: if anything about the move is wrong,
        # the original is still on disk to recover from by hand.
        _LEGACY_STORE.rename(_LEGACY_STORE.with_suffix(".json.migrated"))
        return True
    except OSError:
        return False


def ensure_seeded() -> bool:
    """Create the store with the built-ins if it has never existed.

    Returns True if seeding happened. Called once at backend startup.
    """
    # Migration first: a legacy store that moves into place must not then be
    # treated as "never existed" and overwritten with the shipped defaults.
    migrate_legacy_store()
    if STORE_PATH.exists():
        return False
    stamp = time.strftime("%Y-%m-%d %H:%M:%S")
    _write_raw([
        {**p, "spin_up_us": None, "max_measured_us": None,
         "notes": "Shipped with the application.",
         "created_at": stamp, "updated_at": stamp}
        for p in BUILTIN_SEED
    ])
    return True


def delete_profiles(
    ids: List[str], protected_ids: Optional[List[str]] = None
) -> Tuple[bool, Any]:
    """Delete several profiles in ONE write.

    The multi-select delete dialog hands over everything the operator
    ticked, and a per-id loop would leave the store half-deleted if one id
    failed partway through. Returns (True, {...}) or (False, error).

    Two deletions are refused, and the reasons are not interchangeable:

      * `protected_ids` — the configuration currently loaded on the Arduino.
        Every throttle percentage on the Control tab is computed from it and
        the backend validates throttle commands against its range, so
        deleting it out from under a live connection would leave both
        referring to something that no longer exists.

      * the last remaining profile — an empty store leaves the Control tab
        with no range to compute against and no way back except reinstalling.
    """
    protected = set(protected_ids or [])
    wanted = [i for i in dict.fromkeys(ids) if i]
    if not wanted:
        return False, "No configurations selected"

    profiles = _read_raw()
    have = {p.get("id") for p in profiles}

    missing = [i for i in wanted if i not in have]
    if missing:
        return False, f"No such configuration: {', '.join(missing)}"

    blocked = [i for i in wanted if i in protected]
    if blocked:
        labels = [p["label"] for p in profiles if p.get("id") in blocked]
        return False, (
            f"{', '.join(labels)} is loaded on the Arduino right now. "
            f"Load a different configuration before deleting it."
        )

    remaining = [p for p in profiles if p.get("id") not in set(wanted)]
    if not remaining:
        return False, (
            "At least one motor configuration must remain — the Control tab "
            "has no throttle range to work from without one."
        )

    removed = [p for p in profiles if p.get("id") in set(wanted)]
    _write_raw(remaining)
    return True, {"removed": removed, "remaining": len(remaining)}
