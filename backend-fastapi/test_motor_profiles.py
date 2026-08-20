"""
test_motor_profiles.py -- [NEW v11] Motor profile store, no hardware.

The Motor Config tab exists so an operator can calibrate an unknown motor
on the bench and save the result as a profile. That profile is later
pushed to the Arduino verbatim as CONFIG:<min>,<max>, so anything this
store accepts, the firmware must also accept. What matters here:

  * The store's MIN_SPAN_US really is the firmware's NUM_SEGS -- read out
    of the .ino, the same cross-file contract check test_protocol.py does
    for the wire protocol. If someone widens the firmware's segment count
    without widening this, saved profiles start being silently rejected
    by parseConfig() at CONFIG time, which is the exact class of silent
    failure serial_manager.py's confirmation logic exists to expose.
  * Ranges the firmware would refuse are refused at save time, where a
    human can still fix them.
  * A label collision is an error, not a silent replacement -- but
    recalibrating the same motor (overwrite, or an explicit id) keeps the
    id, so a profile the operator has already selected does not turn into
    a different one behind their back.
  * Persistence round-trips, and a corrupt store degrades to empty
    instead of taking the backend down.

Run:  python test_motor_profiles.py
"""

import json
import re
import sys
from pathlib import Path

import motor_profiles as store

_failures = []


def check(name, cond, detail=""):
    if cond:
        print(f"  PASS  {name}")
    else:
        print(f"  FAIL  {name} {detail}")
        _failures.append(name)


# Never touch the operator's real motor_profiles.json.
TMP_STORE = Path(__file__).parent / "motor_profiles.test.json"
store.STORE_PATH = TMP_STORE


def reset():
    if TMP_STORE.exists():
        TMP_STORE.unlink()


def base(**kw):
    p = {"label": "Test Motor", "thr_min": 1025, "thr_max": 1720, "rpm_gauge_max": 9000}
    p.update(kw)
    return p


print()
print("=" * 56)
print("  MOTOR PROFILE STORE -- v11")
print("=" * 56)

# ── The firmware contract ────────────────────────────────────────────────
print()
print("-- Cross-file contract with the .ino ----")

ino = Path(__file__).resolve().parents[1] / "Arduino" / "nwa_testing_software.ino"
src = ino.read_text(encoding="utf-8", errors="replace")

m = re.search(r"const\s+int\s+NUM_SEGS\s*=\s*(\d+)", src)
check("NUM_SEGS found in the .ino", m is not None)
if m:
    num_segs = int(m.group(1))
    check(f"store MIN_SPAN_US ({store.MIN_SPAN_US}) == firmware NUM_SEGS ({num_segs})",
          store.MIN_SPAN_US == num_segs)

# parseConfig() is the firmware code that will reject a saved profile.
check("firmware still rejects ranges narrower than NUM_SEGS",
      "if (newMax - newMin < NUM_SEGS) return false;" in src)

check("sketch still attaches the ESC with Servo's default pulse bounds",
      "esc.attach(9);" in src)
check(f"store ABS_MAX_US ({store.ABS_MAX_US}) == Servo MAX_PULSE_WIDTH (2400)",
      store.ABS_MAX_US == 2400)

# ── Validation ───────────────────────────────────────────────────────────
print()
print("-- Validation ----")

check("valid profile accepted", store.validate(base()) is None)
check("empty name rejected", store.validate(base(label="   ")) is not None)
check("over-long name rejected",
      store.validate(base(label="x" * (store.MAX_LABEL_LEN + 1))) is not None)
check("thr_min >= thr_max rejected",
      store.validate(base(thr_min=1600, thr_max=1600)) is not None)
check("inverted range rejected",
      store.validate(base(thr_min=1700, thr_max=1200)) is not None)
check("range narrower than NUM_SEGS rejected",
      store.validate(base(thr_min=1200, thr_max=1200 + store.MIN_SPAN_US - 1)) is not None)
check("range exactly NUM_SEGS wide accepted",
      store.validate(base(thr_min=1200, thr_max=1200 + store.MIN_SPAN_US)) is None)
check("thr_min below the servo floor rejected",
      store.validate(base(thr_min=100)) is not None)
check("thr_max above the servo ceiling rejected",
      store.validate(base(thr_max=9000)) is not None)
check("thr_max just past the Servo clamp rejected — it would be truncated "
      "at the ESC, not honoured",
      store.validate(base(thr_max=store.ABS_MAX_US + 1)) is not None)
check("thr_max exactly at the Servo clamp accepted",
      store.validate(base(thr_max=store.ABS_MAX_US)) is None)
# The Motor Config tab deliberately allows sweeping past 2000 us for
# motor/prop combinations that keep accelerating there.
check("a profile calibrated past 2000 us is storable",
      store.validate(base(thr_min=1050, thr_max=2200)) is None)
check("non-numeric throttle rejected",
      store.validate(base(thr_max="fast")) is not None)
check("absurd gauge max rejected",
      store.validate(base(rpm_gauge_max=999999)) is not None)

# ── Save / list / persistence ────────────────────────────────────────────
print()
print("-- Save, list, persist ----")

reset()
ok, rec = store.save_profile(base(label="U8 KV150", spin_up_us=1080, max_measured_us=1720))
check("save returns ok", ok, rec)
check("id generated from the label", ok and rec["id"].startswith("u8_kv150_"), rec)
check("measured values kept as provenance",
      ok and rec["spin_up_us"] == 1080 and rec["max_measured_us"] == 1720, rec)
check("one profile listed", len(store.list_profiles()) == 1)

on_disk = json.loads(TMP_STORE.read_text(encoding="utf-8"))
check("written to disk as a list of one", isinstance(on_disk, list) and len(on_disk) == 1)
check("disk record matches returned record", on_disk[0] == rec)

ok2, rec2 = store.save_profile(base(label="Another Motor"))
check("second profile saved", ok2, rec2)
check("ids are distinct", ok2 and rec2["id"] != rec["id"])
check("both listed", len(store.list_profiles()) == 2)

ok3, err3 = store.save_profile(base(thr_max=99999))
check("invalid profile is not persisted",
      not ok3 and len(store.list_profiles()) == 2, err3)

# ── Collisions and updates ───────────────────────────────────────────────
print()
print("-- Collisions and updates ----")

ok4, err4 = store.save_profile(base(label="U8 KV150", thr_max=1650))
check("duplicate label refused", not ok4, err4)
check("refusal names the existing profile", not ok4 and "U8 KV150" in err4, err4)
check("case/space-insensitive collision",
      not store.save_profile(base(label="  u8   kv150 "))[0])
check("refused duplicate did not modify the stored profile",
      store.list_profiles()[0]["thr_max"] == 1720)

ok5, rec5 = store.save_profile(base(label="U8 KV150", thr_max=1650), overwrite=True)
check("overwrite accepted", ok5, rec5)
check("overwrite KEEPS the original id -- a selected profile must not "
      "become a different one", ok5 and rec5["id"] == rec["id"], rec5)
check("overwrite kept created_at", ok5 and rec5["created_at"] == rec["created_at"])
check("overwrite did not add a row", len(store.list_profiles()) == 2)
check("overwritten value stored", store.list_profiles()[0]["thr_max"] == 1650)

ok6, rec6 = store.save_profile(base(id=rec["id"], label="U8 KV150 (48V)", thr_max=1600))
check("save by explicit id renames in place",
      ok6 and rec6["id"] == rec["id"] and len(store.list_profiles()) == 2, rec6)

# ── Delete ───────────────────────────────────────────────────────────────
print()
print("-- Delete ----")

check("delete removes the profile", store.delete_profile(rec["id"]))
check("one left", len(store.list_profiles()) == 1)
check("deleting a missing id reports failure", not store.delete_profile("nope"))
check("failed delete changed nothing", len(store.list_profiles()) == 1)

# ── Corrupt store ────────────────────────────────────────────────────────
print()
print("-- Corrupt store degrades, does not crash ----")

TMP_STORE.write_text("{ this is not json", encoding="utf-8")
check("corrupt file reads back as empty", store.list_profiles() == [])
ok7, rec7 = store.save_profile(base(label="After Corruption"))
check("saving over a corrupt file works", ok7, rec7)
check("store is usable again", len(store.list_profiles()) == 1)

TMP_STORE.write_text('{"not": "a list"}', encoding="utf-8")
check("non-list JSON reads back as empty", store.list_profiles() == [])

reset()

print()
print("-" * 56)
if _failures:
    print(f"{len(_failures)} check(s) FAILED: {', '.join(_failures)}")
    sys.exit(1)
print("All motor profile store checks passed.")
