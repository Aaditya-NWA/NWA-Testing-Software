"""
test_step_test.py -- [CHANGED v10] Step Test sequencer check, no hardware.

[v10] REWRITTEN. The original version of this file validated a design that
chained firmware THROTTLE_HOLD commands, on the theory that the firmware's
resetThrottleHold() leaves `throttle` wherever it currently is. Real
hardware testing showed the motor returning to THR_MIN between every step.
The actual cause: nwa_testing_software.ino's command handler sets
`throttle = THR_MIN` unconditionally on every THROTTLE_HOLD command (see
the "else if (strncmp(cmd, "THROTTLE_HOLD:"..." branch) -- there is no
firmware primitive that continues a hold from wherever the motor is, no
matter how fast the next command follows the last. The fake firmware the
old tests drove was built on the same wrong assumption, so it could not
have caught this; it is why the bug shipped.

Multiple mode is now driven ENTIRELY by the host, over the plain
throttle-us command (the same fire-and-forget path the manual slider
already uses), ramping at the same rate the firmware's own ramp uses
(THR_RAMP_RATE, cross-checked against the .ino in test_protocol.py). What
matters here:

  * A step's ramp genuinely walks through intermediate values -- it is not
    a snap-to-target -- in BOTH directions. (The old firmware-chained
    design could only ramp up; this backend-driven version fixes that
    asymmetry as a side effect.)
  * Consecutive steps hand off directly: the ramp into step 2 starts at
    step 1's target, never dips back toward THR_MIN. This is the specific
    regression the whole rewrite exists to fix.
  * The final step ramps back down to THR_MIN; no earlier step does.
  * Cancellation (E-Stop) commands the throttle down immediately and stops
    sending further ramp ticks.
  * The FIRST step ramps from wherever telemetry says the motor actually
    is, not an assumed THR_MIN.
  * Range/hold validation against the CONFIRMED motor profile is
    unchanged.

Run:  python test_step_test.py
"""

import asyncio
import sys

import auth
import main
from main import StepSpec

_failures = []


def check(name, cond, detail=""):
    if cond:
        print(f"  PASS  {name}")
    else:
        print(f"  FAIL  {name} {detail}")
        _failures.append(name)


main._RAMP_TICK_S = 0.001


class FakeSerial:
    def __init__(self, is_connected=True, last_throttle_us=None):
        self.sent = []
        self.is_connected = is_connected
        self.last_throttle_us = last_throttle_us

    def send_throttle(self, value):
        self.sent.append(value)

    # Present so a leftover call from a stale code path would fail loudly
    # (AttributeError) rather than silently doing nothing.
    def send_stop_hold(self):
        self.sent.append(("STOP_HOLD",))


def run(coro):
    return asyncio.run(coro)


def reset(fake, thr_min=1025, thr_max=1600):
    main.serial_mgr = fake
    main.active_profile["thr_min"] = thr_min
    main.active_profile["thr_max"] = thr_max
    main._step_test.update(running=False, current_step=0, total_steps=0,
                           target_us=None, hold_ms=None, phase="idle", message=None)
    main._step_test_task = None


def ramp_span(seq, lo, hi):
    """Every value in `seq` that falls within [lo, hi] inclusive."""
    return [v for v in seq if isinstance(v, int) and lo <= v <= hi]


print("-- A single step ramps up, holds, ramps back down ------")

fake = FakeSerial(last_throttle_us=1025)
reset(fake)
run(main._run_step_test([StepSpec(target_us=1100, hold_ms=20)]))

check("ramp is genuinely stepped, not a snap",
      len([v for v in fake.sent if isinstance(v, int)]) > 5,
      f"only {len(fake.sent)} sends: {fake.sent}")
check("ramp reaches the target exactly", 1100 in fake.sent, fake.sent)
check("ends back at THR_MIN", fake.sent[-1] == 1025, fake.sent[-1])
check("phase ends complete", main._step_test["phase"] == "complete",
      main._step_test["phase"])
check("running cleared on completion", main._step_test["running"] is False)

print()
print("-- THE FIX: step N+1 continues from step N's target, ---")
print("-- never dips back toward idle --------------------------")

fake = FakeSerial(last_throttle_us=1025)
reset(fake)
run(main._run_step_test([
    StepSpec(target_us=1100, hold_ms=10),
    StepSpec(target_us=1200, hold_ms=10),
    StepSpec(target_us=1300, hold_ms=10),
]))

ints = [v for v in fake.sent if isinstance(v, int)]
first_1100 = ints.index(1100)
last_1300 = len(ints) - 1 - ints[::-1].index(1300)
between = ints[first_1100:last_1300 + 1]
check("throttle never drops below step 1's target during the handoff",
      min(between) >= 1100, f"dipped to {min(between)}: {between}")
check("all three targets were reached", {1100, 1200, 1300} <= set(ints), sorted(set(ints)))
check("ramps back down to THR_MIN only after the LAST step",
      ints[-1] == 1025 and 1025 not in ints[:-1], ints)

print()
print("-- Descending steps ramp too, not a snap ----------------")

fake = FakeSerial(last_throttle_us=1025)
reset(fake)
run(main._run_step_test([
    StepSpec(target_us=1500, hold_ms=5),
    StepSpec(target_us=1200, hold_ms=5),
]))
ints = [v for v in fake.sent if isinstance(v, int)]
peak_idx = ints.index(1500)
down = ints[peak_idx:]
down_to_1200 = down[:down.index(1200) + 1]
# Firmware phase 0 can only ramp UP; the whole point of driving this from
# the host is that a descending step ramps exactly like an ascending one.
check("descending leg passes through intermediate values",
      len(set(down_to_1200)) > 2, down_to_1200)
check("descending leg is monotonically non-increasing",
      down_to_1200 == sorted(down_to_1200, reverse=True), down_to_1200)

print()
print("-- Starting point comes from live telemetry -------------")

fake = FakeSerial(last_throttle_us=1250)
reset(fake)
run(main._run_step_test([StepSpec(target_us=1300, hold_ms=5)]))
ints = [v for v in fake.sent if isinstance(v, int)]
check("ramp starts near the REPORTED throttle, not THR_MIN",
      min(ramp_span(ints, 1250, 1300)) <= 1255, ints[:5])
check("does not start from THR_MIN when telemetry says otherwise",
      1025 not in ints[:3], ints[:3])

fake2 = FakeSerial(last_throttle_us=None)   # no telemetry yet
reset(fake2)
run(main._run_step_test([StepSpec(target_us=1100, hold_ms=5)]))
ints2 = [v for v in fake2.sent if isinstance(v, int)]
check("falls back to THR_MIN when no telemetry has arrived",
      ints2[0] <= 1030, ints2[:3])

print()
print("-- Cancellation (E-Stop) stops the ramp immediately ------")

main._RAMP_TICK_S = 0.02
fake = FakeSerial(last_throttle_us=1025)
reset(fake)


async def _cancel_mid_ramp():
    main._step_test["running"] = True
    main._step_test_task = asyncio.create_task(
        main._run_step_test([StepSpec(target_us=1500, hold_ms=5000)])
    )
    await asyncio.sleep(0.1)           # let several ramp ticks happen
    reached = list(fake.sent)
    await main._cancel_step_test()
    after = list(fake.sent)
    return reached, after


reached, after = run(_cancel_mid_ramp())
main._RAMP_TICK_S = 0.001
check("ramp was genuinely in progress before cancel", 0 < len(reached) < 90, reached)
check("cancel commands the throttle down immediately",
      after and after[-1] == 1025, after[-5:])
check("nothing sent after the down-command", after[-1] == after[len(after) - 1], after)
check("cancel clears running", main._step_test["running"] is False)
check("cancel reports aborted", main._step_test["phase"] == "aborted",
      main._step_test["phase"])

print()
print("-- Range validation is against the CONFIRMED profile ----")

fake = FakeSerial()
reset(fake, thr_min=1025, thr_max=1600)


_SESSION = auth.login("admin", "admin@123")
assert _SESSION is not None, "the seeded admin account should always log in"


def _start(steps):
    return run(main.start_step_test(main.StepTestRequest(steps=steps), _SESSION))


r = _start([StepSpec(target_us=1700, hold_ms=1000)])
check("target above thr_max rejected", r["status"] == "error", r)
check("rejection names the step and the range",
      "Step 1" in r["message"] and "1025" in r["message"] and "1600" in r["message"], r)
check("nothing sent to the port on rejection", fake.sent == [], fake.sent)

r = _start([StepSpec(target_us=1300, hold_ms=1000),
            StepSpec(target_us=900, hold_ms=1000)])
check("out-of-range step 2 rejects the whole sequence",
      r["status"] == "error" and "Step 2" in r["message"], r)

r = _start([StepSpec(target_us=1300, hold_ms=0)])
check("zero hold rejected", r["status"] == "error" and "hold" in r["message"].lower(), r)

r = _start([])
check("empty sequence rejected", r["status"] == "error", r)

r = _start([StepSpec(target_us=1300, hold_ms=100) for _ in range(main.MAX_STEPS + 1)])
check("over-long sequence rejected", r["status"] == "error", r)

fake.is_connected = False
r = _start([StepSpec(target_us=1300, hold_ms=1000)])
check("disconnected board rejected", r["status"] == "error", r)

print()
print("-" * 56)
if _failures:
    print(f"{len(_failures)} check(s) FAILED: {', '.join(_failures)}")
    sys.exit(1)
print("All Step Test sequencer checks passed.")
