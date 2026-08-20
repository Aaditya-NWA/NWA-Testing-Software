"""test_auth.py — accounts, roles, and the multi-select delete. [NEW v13]

    python test_auth.py

Two things are pinned here, and neither is testable through the UI:

  1. **Roles actually gate.** The tab table in auth.ROLE_TABS is what the UI
     renders from AND what the backend refuses on. If those two ever
     disagreed, the UI would hide a tab the API still served — which is the
     failure mode role checks exist to prevent. Checking the table directly
     is the only place that catches a drift before it ships.

  2. **The delete guards hold.** Deleting the configuration currently loaded
     on the Arduino, or the last remaining one, both leave the Control tab
     computing throttle percentages against something that no longer exists.
     The dialog disables those boxes, but the dialog is not the gate.

Never touches the operator's real store or user file — both are redirected
to temporary paths before anything is imported that would read them.
"""

import json
import os
import sys
import tempfile
from pathlib import Path

_TMP = Path(tempfile.mkdtemp(prefix="nwa-auth-test-"))

import app_paths
app_paths.app_root = lambda: _TMP          # type: ignore[assignment]
app_paths.logs_dir = lambda: _TMP          # type: ignore[assignment]

import auth
import motor_profiles as mp

mp.STORE_PATH = _TMP / "motor_profiles.json"

_failures = 0


def check(name, ok, detail=None):
    global _failures
    if ok:
        print(f"  PASS  {name}")
    else:
        _failures += 1
        print(f"  FAIL  {name}")
        if detail is not None:
            print(f"        {detail!r}")


print("-- Accounts seed and authenticate ----------------------")

users = auth.load_users()
check("three accounts seeded", len(users) == 3, [u["username"] for u in users])
check("store written to disk", auth.store_path().exists())

for username, password, role in [
    ("admin", "admin@123", "Admin"),
    ("tester", "tester@123", "Tester"),
    ("analysis", "analysis@123", "Analysis"),
]:
    s = auth.login(username, password)
    check(f"{username} signs in as {role}", s is not None and s.role == role, s)
    check(f"{username} gets a session key", s is not None and s.key.startswith("S-"), s.key if s else None)

check("wrong password refused", auth.login("admin", "admin@1234") is None)
check("unknown user refused", auth.login("nobody", "admin@123") is None)
check("empty password refused", auth.login("admin", "") is None)

# The whole point of hashing rather than encrypting: nothing on disk can be
# turned back into the password, not even by this process.
raw = json.loads(auth.store_path().read_text(encoding="utf-8"))
stored = [u["password"] for u in raw["users"]]
check("no plaintext password on disk",
      all("@123" not in p for p in stored), stored[:1])
check("hashes are salted (no two identical)",
      len(set(stored)) == 3)
check("hash format is self-describing",
      all(p.startswith("pbkdf2$") and len(p.split("$")) == 4 for p in stored), stored[:1])

print()
print("-- Roles gate the right tabs ---------------------------")

admin = auth.login("admin", "admin@123")
tester = auth.login("tester", "tester@123")
analysis = auth.login("analysis", "analysis@123")

check("admin reaches all four tabs", len(admin.tabs) == 4, admin.tabs)
check("tester: control + motor_config",
      set(tester.tabs) == {auth.TAB_CONTROL, auth.TAB_MOTOR_CONFIG}, tester.tabs)
check("analysis: analyses + correction_mass",
      set(analysis.tabs) == {auth.TAB_ANALYSES, auth.TAB_CORRECTION_MASS}, analysis.tabs)

check("tester may drive hardware", tester.may_any(auth.HARDWARE_TABS))
check("admin may drive hardware", admin.may_any(auth.HARDWARE_TABS))
# This is the one that matters: an Analysis user must not be able to reach a
# motor, and every hardware endpoint is gated on exactly this call.
check("analysis may NOT drive hardware", not analysis.may_any(auth.HARDWARE_TABS))
check("analysis may not open the control tab", not analysis.may(auth.TAB_CONTROL))
check("tester may not open analyses", not tester.may(auth.TAB_ANALYSES))

# Every role's tabs must be a subset of TAB_ORDER, or the UI would be asked to
# render a tab it has no component for.
for role, tabs in auth.ROLE_TABS.items():
    check(f"{role}'s tabs all exist in TAB_ORDER",
          all(t in auth.TAB_ORDER for t in tabs), tabs)

print()
print("-- Sessions ---------------------------------------------")

check("token resolves to its session", auth.session_for(admin.token) is admin)
check("unknown token resolves to nothing", auth.session_for("not-a-token") is None)
check("no token resolves to nothing", auth.session_for(None) is None)
check("two logins get different keys", admin.key != tester.key)
check("two logins get different tokens", admin.token != tester.token)

gone = auth.login("admin", "admin@123")
auth.logout(gone.token)
check("logout invalidates the token", auth.session_for(gone.token) is None)

print()
print("-- Motor configurations: seeding ------------------------")

check("store seeds on first run", mp.ensure_seeded() is True)
seeded = mp.list_profiles()
check("three shipped configurations seeded", len(seeded) == 3, len(seeded))
check("seeded ids match the frontend built-ins",
      {p["id"] for p in seeded} == {"u15ii_kv100", "u7_v2", "v605_kv210"},
      [p["id"] for p in seeded])
check("seeding is idempotent", mp.ensure_seeded() is False)
check("every seeded configuration validates",
      all(mp.validate(p) is None for p in seeded),
      [mp.validate(p) for p in seeded])

print()
print("-- Multi-select delete ----------------------------------")

ok, res = mp.save_profile({"label": "Bench A", "thr_min": 1100,
                           "thr_max": 1500, "rpm_gauge_max": 5000})
check("a calibrated configuration saves", ok, res)
ok, res = mp.save_profile({"label": "Bench B", "thr_min": 1200,
                           "thr_max": 1600, "rpm_gauge_max": 5000})
check("a second one saves", ok, res)
bench_b = res["id"]

before = len(mp.list_profiles())
ok, res = mp.delete_profiles(["u7_v2", bench_b])
check("two configurations delete in one call", ok, res)
check("both are gone", len(mp.list_profiles()) == before - 2, len(mp.list_profiles()))
check("the delete reports what it removed",
      ok and {p["id"] for p in res["removed"]} == {"u7_v2", bench_b})

# A partial delete would leave the operator unsure which half went, so an
# unknown id has to reject the WHOLE request rather than doing its best.
before = len(mp.list_profiles())
ok, res = mp.delete_profiles(["u15ii_kv100", "does-not-exist"])
check("an unknown id rejects the whole request", not ok, res)
check("nothing was deleted on rejection", len(mp.list_profiles()) == before)

ok, res = mp.delete_profiles([])
check("an empty selection is refused", not ok, res)

print()
print("-- Delete guards ----------------------------------------")

# The configuration loaded on the Arduino: the backend validates throttle
# against its range and the Control tab computes percentages from it.
before = len(mp.list_profiles())
ok, res = mp.delete_profiles(["u15ii_kv100"], protected_ids=["u15ii_kv100"])
check("the loaded configuration cannot be deleted", not ok, res)
check("the refusal names it", not ok and "Arduino" in res, res)
check("nothing was deleted", len(mp.list_profiles()) == before)

# Deleting it alongside others must still refuse the whole batch — a guard
# that only worked on single deletes would be no guard at all.
ok, res = mp.delete_profiles(["u15ii_kv100", "v605_kv210"], protected_ids=["u15ii_kv100"])
check("a batch containing the loaded one refuses entirely", not ok, res)
check("nothing was deleted", len(mp.list_profiles()) == before)

# The last remaining one: an empty store leaves the Control tab with no range.
remaining = [p["id"] for p in mp.list_profiles()]
ok, res = mp.delete_profiles(remaining)
check("the store cannot be emptied", not ok, res)
check("the refusal explains why", not ok and "must remain" in res, res)
check("nothing was deleted", len(mp.list_profiles()) == len(remaining))

# Down to one, deleting it is still refused.
if len(remaining) > 1:
    mp.delete_profiles(remaining[:-1])
check("exactly one configuration remains", len(mp.list_profiles()) == 1, mp.list_profiles())
ok, res = mp.delete_profiles([mp.list_profiles()[0]["id"]])
check("the final configuration cannot be deleted", not ok, res)

print()
if _failures:
    print(f"{_failures} CHECK(S) FAILED")
    sys.exit(1)
print("--------------------------------------------------------")
print("All auth and configuration-store checks passed.")
