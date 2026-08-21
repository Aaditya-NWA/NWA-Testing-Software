# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A motor/ESC test bench: an Arduino Uno drives an ESC and reads an LSM6DSO IMU + a
pulse-per-rev RPM sensor; a FastAPI backend owns the serial link, logs CSV, and
fans telemetry out over WebSocket; a React/Vite dashboard drives the motor and
does post-test single-plane balancing math.

## Commands

```powershell
# Both servers at once (Windows launcher — opens two cmd windows)
.\start_dashboard.bat

# Backend (from backend-fastapi/) — port 8000
..\venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --reload

# Frontend (from frontend-react/) — port 3000
npm install
npm run dev
npm run build     # tsc (strict) && vite build — the only typecheck/lint gate
```

**[v12] The venv is not optional, and the failure mode if you skip it is
confusing.** The backend must run from `venv/` at the repo root (create with
`python -m venv venv`, then
`venv\Scripts\python -m pip install -r backend-fastapi\requirements.txt`).
Run it from the global Python on this machine and it dies at import time with
`TypeError: Router.__init__() got an unexpected keyword argument 'on_startup'`
— raised inside FastAPI's own constructor, which makes it look like a code
bug. It is not: `fastapi==0.111.0` requires `starlette>=0.37.2,<0.38` while the
globally installed `streamlit 1.61.1` requires `starlette>=0.46.0,<1.4.0`.
Those ranges do not overlap, so no single shared environment can satisfy both
— pinning starlette globally just moves the breakage to streamlit.
`start_dashboard.bat` now invokes `venv\Scripts\python.exe -m uvicorn`
explicitly and refuses to start (rather than silently falling back to a bare
`uvicorn`) if the venv is missing. `requirements.txt` pins starlette too, so
the trap is visible at install time.

There is no linter and no CI, and no test *framework* — but as of v9 there are
standalone test scripts, and they are the only things standing between a
protocol change and silently wrong measurements:

```powershell
# Backend — wire codec, sample clock, DC removal, and the cross-file
# firmware/backend contract (reads constants straight out of the .ino)
cd backend-fastapi; python test_protocol.py

# Backend — end-to-end ingestion: frames -> samples -> CSV, no hardware
cd backend-fastapi; python test_ingest.py

# Backend [v10] — Step Test sequencer: throttle continuity across step
# handoffs (the regression this file exists to catch), symmetric ramp
# direction, live-telemetry starting point, cancellation, range validation
cd backend-fastapi; python test_step_test.py

# Backend [v11] — Motor profile store: validation (including the firmware's
# own NUM_SEGS range rule, read out of the .ino), label collisions,
# overwrite-keeps-the-id, persistence, corrupt-store recovery
cd backend-fastapi; python test_motor_profiles.py

# Frontend — FFT numerical accuracy (amplitude, frequency, aliasing)
cd frontend-react; npm run test:fft     # or: npm test  (runs all three)

# Frontend [v12] — chart decimation: that decimating a series cannot move a
# peak marker or change the y extent, and the Math.min(...spread) crash
cd frontend-react; npm run test:plot

# Backend [v13] — accounts, roles, and the delete guards: that ROLE_TABS
# actually gates (an Analysis session cannot reach hardware), that no
# plaintext password reaches disk, that built-ins seed once, and that the
# two refused deletions (the loaded configuration, the last remaining one)
# reject the WHOLE batch rather than half of it
cd backend-fastapi; python test_auth.py

# Frontend [v13] — throttle %<->µs: that 0% and 100% land exactly on the
# profile bounds, that no percentage resolves outside the range after
# rounding, and that a degenerate range yields no NaN
cd frontend-react; npm run test:throttle

# Backend [v14] — packaging: the version string across all four files, the
# constants shared with src-tauri/src/backend.rs (ready marker, port-busy
# exit code, health signature, runtime file path), that no test module can
# reach the shipped binary, and — when the frozen backend has been built —
# that it really starts, answers /health, refuses a bad shutdown token,
# shuts down gracefully, and exits 3 on a busy port
cd backend-fastapi; python test_deployment.py
```

All nine exit non-zero on failure. The three frontend suites share one
runner (`run_test.mjs <name>`) — they were three copy-pasted files until v13.

**None of these ship.** No app module imports a test, they appear nowhere in
the built bundle, and PyInstaller follows imports from `run_backend.py`, which
imports no test module — `backend.spec` also excludes them by name, and
`test_deployment.py` asserts both. They are dev-time only. Run them plus
`npm run build` after touching the protocol, the signal chain, `fft.ts`, the
Step Test sequencer, the motor profile store, `plotData.ts`, `throttle.ts`,
`auth.py`, or anything under `src-tauri/`.

`npm run build` (tsc strict + vite) remains the typecheck gate for TypeScript.

**[v13] `noUnusedLocals` is ON.** It was off, which is how a refactor can leave
dead imports and write-only variables behind with a clean typecheck — the
stage-6 split did exactly that in six files, and turning this on is what
found them. Leave it on.

**The firmware cannot be compiled or tested from this repo** — there is no
`arduino-cli` and no C++ toolchain here. `test_protocol.py` compensates as far as
it can by parsing the `.ino` and asserting its `#define`s and ack strings still
match the backend, but the sketch itself must be verified by compiling it in the
Arduino IDE before flashing.

Firmware lives in `Arduino/nwa_testing_software.ino` and is flashed by hand
from the Arduino IDE (needs `Servo`, `Wire`, `SparkFunLSM6DSO`). Backend and
firmware must be kept in lockstep — see "Firmware/backend contract" below.

## Architecture

```
LSM6DSO ──FIFO──> .ino ──USB serial (BINARY frames)──> SerialManager ──queue──> WebSocketManager ──ws://──> React
 833Hz ODR        burst      + ASCII control lines          │  frame_protocol.py    (batched 25Hz)
 LPF2 208Hz       reads                                     │  signal_chain.py
                                                            └──> CSVLogger ──> backend-fastapi/Test Data/*.csv
```

**[v9] The telemetry path is binary; the control path is still ASCII.** That
split is deliberate. Commands and their acks are low-rate and benefit from being
readable in a plain serial monitor, and keeping them as text means every
confirmation regex in `serial_manager.py` still works untouched. Only the
high-rate sample stream — the thing that was costing 51.8 ASCII bytes to carry 6
bytes of information — became binary. `frame_protocol.FrameDecoder`
demultiplexes the two off one port.

**`backend-fastapi/serial_manager.py`** is where all the hard-won behaviour
lives. Three invariants to preserve:

1. **Only `_read_loop` may call `self._serial.readline()`.** Two threads reading
   one `serial.Serial` race for lines. Any non-telemetry line the parser rejects
   is pushed onto `_control_line_queue`; `send_*_and_confirm()` reads acks from
   that queue, never from the port directly.
2. **Commands are confirmed, not fired-and-forgotten.** `CONFIG:`, `SR:`, and
   `BAUD:` each block (via `asyncio.to_thread`) until the firmware echoes its own
   ack line, and the parsed value from that ack — not the requested value — is
   stored as ground truth (`confirmed_thr_min/max`, `confirmed_sampling_rate`,
   `current_baud`). Endpoints report the mismatch to the UI rather than assuming
   success, which is how old firmware silently ignoring a command gets caught.
3. **Every connection opens at `BOOT_BAUD` (115200) first**, waits for the
   firmware's `ESC Armed` line, then optionally switches baud. Opening the port
   triggers a DTR auto-reset and the sketch spends ~8.5 s arming the ESC in
   `setup()` before it reads serial at all — commands sent in that window are
   lost. A failed baud switch is non-fatal: the link stays at 115200.

**`main.py`** keeps `active_profile` (thr_min/thr_max) as the validation range
for `/set_throttle`, `/start_throttle_hold` and `/start_step_test`. It is only
updated on a *confirmed* `CONFIG`, so validation always reflects what the
Arduino is really running.

## Step Test — the multi-step sequencer lives on the host [NEW v10]

"Throttle Hold" is now **Step Test**, with two modes. **Single** is the
original feature untouched: one `/start_throttle_hold` call, one firmware
`THROTTLE_HOLD`. **Multiple** posts a list of steps to `/start_step_test`,
which the backend executes by driving the throttle itself.

The sequencer is host-side, not firmware-side: the `.ino` cannot be compiled
or tested from this repo and the 328p's 2 KB SRAM is already accounted for,
so a step array plus a sequencer there would be untestable code on the one
component that cannot be validated before it drives a motor.

**[FIXED v10] Multiple mode does not use `THROTTLE_HOLD` at all — it drives
the ramp itself over the plain throttle-µs command.** The first version
chained firmware `THROTTLE_HOLD` commands, issuing step N+1 the instant step
N's hold finished, on the theory that the firmware's `resetThrottleHold()`
leaves `throttle` wherever it currently is. Real hardware testing showed the
motor returning to `THR_MIN` between every step. The actual cause: the
`.ino`'s command handler sets `throttle = THR_MIN` **unconditionally** on
every `THROTTLE_HOLD:` command (`handleCommand()`, the
`strncmp(cmd, "THROTTLE_HOLD:", 14)` branch) — there is no firmware primitive
that continues a hold from wherever the motor currently is, no matter how
fast the next command follows the last. That branch was never read closely
enough the first time; only the ramp-down state machine further down in
`loop()` was.

So the backend now sends the same plain throttle-µs command the manual
slider already uses (`send_throttle()` — fire-and-forget, no ack, exactly
like the slider), walking it from the current value to each step's target at
`_RAMP_STEP_US` per `_RAMP_TICK_S` (`main.py`) — deliberately matching the
firmware's own `THR_RAMP_RATE` and ~100 ms tick, which `test_protocol.py`
cross-checks against the `.ino` so the two can't silently drift apart. The
ramp is symmetric in both directions, which is actually an improvement over
the firmware's own ramp: firmware phase 0 only ever climbs (a descending
`THROTTLE_HOLD` target snaps instantly), while the host-driven version ramps
down exactly like it ramps up.

The very first step ramps from wherever live telemetry says the motor
**actually** is (`SerialManager.last_throttle_us`, updated on every sample),
not an assumed `THR_MIN` — the operator may have just been using the manual
slider. It falls back to `THR_MIN` only if no telemetry has arrived yet.
`/emergency_stop`, `/stop_throttle_hold`, `/disconnect`, and shutdown all
cancel the sequencer and command the throttle down immediately — a sequence
that survived an E-Stop would otherwise keep ramping into a motor the
operator had just killed. `test_step_test.py` pins the throttle-continuity
behaviour directly (asserting the sent-value sequence never dips back toward
idle between steps), rather than trusting a fake firmware's ack wording —
the previous version's fake was built on the same wrong assumption as the
sequencer it was testing, which is why it could not have caught this.

**Logging is test-owned [v10].** Auto Test and both Step Test modes open the
CSV log if one isn't already open and close it again when the run ends —
naturally, on Stop, or on E-Stop — so a run is one button press. If a log was
already open by hand it is left alone in both directions (`autoLogRef`).
Completion is gated on `holdLiftedRef`: the throttle must be seen *above*
THR_MIN before a return to THR_MIN counts as "finished", because at the moment
Run is pressed the throttle is still at THR_MIN and the firmware's first ramp
tick is 100 ms away while the WS pushes every 40 ms.
**[FIX v10]** The "is a log already open" check queries `/status` directly
rather than trusting this tab's `logging` state — that state is only ever
set by this tab's own handlers, so anything that let it drift from the
backend's real `csv_logger.is_logging` (a second tab, an out-of-order
request, a gap the state machine didn't anticipate) would make every
subsequent test silently skip opening a log, because the stale `true` looks
identical to "already logging, leave it alone".

Targets are validated per-field in the UI against the loaded motor profile
*and* re-validated in `/start_step_test` against `active_profile`. The UI check
is convenience; `active_profile` is the gate, because it holds what the Arduino
confirmed rather than what the frontend believes it selected.

## Motor Config — measuring an unknown motor's range [NEW v11]

Tab 4 (`MotorConfigTab.tsx`). Mount a motor, sweep the throttle, record where
it starts spinning and how high it should be driven, save that as a motor
profile. Before v11 that meant editing `MOTOR_PROFILES` in the source and
rebuilding.

**The measured spin-up point is not the profile's 0%.** 0% sits an *idle
headroom* below it (default 55 µs), because 0% has to actually stop the motor —
if 0% were the spin-up point the motor would idle at the bottom of every ramp.
This is the arithmetic behind the shipped U15II profile: 1080 measured → 1025.

**Why the tab needs a calibration mode.** The sweep must reach throttles
outside the loaded profile, and *two* gates block that — both real:
`/set_throttle` refuses anything outside `active_profile`, and the firmware
**silently ignores** an out-of-range throttle (`handleCommand()`'s final
`else`: `if (val >= THR_MIN && val <= THR_MAX)` — no error, no ack, the motor
just doesn't move). So START CALIBRATION pushes the sweep range as a real
`CONFIG` through the same confirmed `/set_motor_profile` path everything else
uses, and EXIT puts the previous range back. There is no unvalidated throttle
back door; the validation range is *moved*, visibly, and an amber banner says
so the whole time it is moved.

Leaving the tab **unmounts** it, so the unmount cleanup ends calibration too. A
1000–2000 µs range left loaded is not a cosmetic leak: Tab 1's Auto Test would
then sweep all of it on a motor that may only be rated to 1515.

CONFIGURE saves the profile, then loads it onto the Arduino — so Tab 1 comes up
with it already selected, via the `/status` adoption described above.

Profiles are persisted **by the backend** (`motor_profiles.py` →
`backend-fastapi/motor_profiles.json`, gitignored), not in localStorage: a
profile is the result of a physical test, and clearing site data or moving to
the other laptop should not silently lose it. `motorProfiles.ts` merges the
three built-ins with the saved ones and is an external store (not React state)
because the tab that saves a profile and the tab that uses it are never mounted
at the same time. Its validation mirrors `motor_profiles.py`, whose `MIN_SPAN_US`
mirrors the firmware's `NUM_SEGS` — `test_motor_profiles.py` reads that constant
out of the `.ino` so a saved profile can never be one the firmware would reject
at `CONFIG` time.

The sweep slider sends the same plain throttle-µs command as Tab 1's slider,
rate-limited to 50 ms — but **with a trailing send**, so the last value of a
fast drag is never dropped. Tab 1 drops it; here the whole point is reading an
exact throttle off the slider.

**[FIX v13] The slider steps 5 µs, not 1.** It was 1, which made a sweep
unusably slow — a 1000–2000 µs range is 1000 notches and every notch is a
serial command. Measured on a real log (`2026-08-19_10-20-50.csv`): 127
changes of exactly 1 µs, one every ~190 ms, covering only 997→1123 µs in 24
seconds. 5 is the firmware's own `THR_RAMP_RATE` — the step Auto Test, the
firmware's `THROTTLE_HOLD` ramp and the host sequencer (`_RAMP_STEP_US`) all
already move in. Every log in `Test Data/` confirms it ramps in 5 µs steps at
833 Hz; the files that appear to step by 10 are the 5 Hz captures missing
every other increment — the same ramp, undersampled. The ±1 nudge button is
unchanged, so the exact spin-up microsecond is still reachable. FETCH reads the *live telemetry* throttle and
refuses if the last sample is older than 1.5 s rather than returning a stale
number as a measurement.

**Frontend connect sequence** (`Tab1.handleConnect` in `App.tsx`):
`/connect` → `/set_motor_profile` → `/set_sampling_rate`. Each step surfaces its
own unconfirmed-warning without aborting the connection.

**[v13] Tabs are addressed by NAME, not number — the order changed.** It is
now, for every role: **Control | Configure New Motor | Analyses | Correction
Mass Validation**. A restricted role sees a subset in that same order, never a
different one. The old numbering (Tab2 = correction mass, Tab3 = graph
analysis, Tab4 = motor config) is gone, so anything still keyed to a number is
pointing at the wrong tab. The ids live in `auth.tsx` (`TAB_ORDER`) and are
mirrored by `auth.py` (`ROLE_TABS`), which is also what gates the API.

The reorder was done alongside roles because it makes both role groupings
contiguous, and it puts the two backend-connected tabs (Control, Configure New
Motor) next to each other, apart from the two offline CSV tabs.

Each tab lives in `src/tabs/`; `App.tsx` is the shell. Control and Configure
New Motor are the two that talk to the backend. `lib/balancing.ts` is
dependency-free influence-coefficient math and CSV parsing, shared by Analyses
and Correction Mass Validation. **[v12] `lib/plotData.ts`** is the shared guard for
handing large arrays to a chart — decimation, and min/max without a spread —
used by every Tab 3 chart; see "Tab 3 upload cost" below.

**Only one tab is mounted at a time** (`{activeTab === id && <Tab/>}`), so all
per-tab state is destroyed on a tab switch while the serial port, CSV log and
the Arduino's loaded range carry on. **[v11, generalised v13] the connection provider adopts the
backend's state from `/status`** — connection, baud, log, sampling
rate, and the motor profile whose range matches `confirmed_thr_min/max`. A
confirmed range matching no profile is reported as a mismatch rather than
ignored, because every throttle percentage on that tab is computed from the
selected profile.

Tab3 has a GRAPH TYPE selector — **RMS / WAVEFORM / SPECTRUM / ALL** — driving
three chart families off the same uploads:

- **RMS** charts are `rmsBinnedSeries`-smoothed and always plot each file's
  full natural range against actual RPM. Deliberately *not* affected by the
  RPM window.
- **WAVEFORM** charts are the raw, unbinned, signed per-sample signal.
  **[RENAMED v9]** This mode was called "FFT" and never was one — it plots the
  time/occurrence-domain waveform. The old name left the project believing it
  had spectral analysis when the codebase contained no Fourier machinery at all.
  Behaviour is unchanged; only the label is now accurate. The RPM WINDOW
  (target ± tolerance) filter applies to these; when it's active the X axis
  becomes occurrence position (0–100%) rather than RPM, so every point carries
  `_rpm` and `FftTooltip` reports the real RPM on hover.
- **SPECTRUM** **[NEW v9]** is the genuine Fourier transform, in `fft.ts`
  (dependency-free, radix-2, Hann-windowed, Welch-averaged, 4× zero-padded).
  Three things it gets right that are easy to get wrong:
  - It transforms the **longest contiguous run** of matching samples, not every
    matching row. A ramp revisits the same RPM repeatedly, so concatenating
    matches would splice together pieces recorded seconds apart, and each splice
    is a step discontinuity that reads as broadband energy.
  - It prefers the `McuMicros` sample clock and **warns loudly** when a file
    only has host arrival stamps (pre-v9 logs), because those are also aliased.
  - Peak readouts use parabolic interpolation. Raw-bin maxima under-read a
    Hann-windowed tone by up to 15% (measured: a 0.200 g tone read 0.172 g),
    which would propagate straight into Tab 2's correction masses. Measured
    worst-case amplitude error after interpolation + zero-padding: **0.009%**.

  Order markers are drawn at N×(RPM/60) from the segment's own mean RPM, and a
  table lists the interpolated peak amplitude at each order per file per axis.

Two independent RPM filters, easily confused:

- **RPM RANGE** (`rpmMin`/`rpmMax`) gates *every* chart via `inRange`, runs
  first, and keeps RPM on the X axis. Rejected unless strictly ascending.
  RMS binning happens *after* this gate, so narrowing the range genuinely
  increases resolution instead of cropping the same coarse curve.
- **RPM WINDOW** (`targetRpm ± tolerance`) is FFT-only and applies *within*
  the range.

`hiddenSeries` legend-toggle ids are prefixed `rms-`/`fft-` so the same axis
toggles independently across the two families in BOTH mode. PDF export prints
whatever `.ga-print-area` currently contains, so it follows the selected mode;
chart titles carry the active range so it survives into the export.

`peakOf` + `peakDots` mark each visible series' largest-magnitude **plotted**
point (toggle: `showPeaks`). It compares `|value|` because the FFT charts are
signed and their biggest excursion is often negative.

Known data caveats when interpreting these charts (measured, not theoretical).
**Note which apply to pre-v9 logs only** — several were fixed at the source in
v9, so a file's caveats depend on which firmware recorded it:

- **[pre-v9] RPM is quantised to ~120 RPM steps.** RPM was recomputed once per
  500 ms from an integer pulse count, so `NS CCW.csv` has only 34 distinct RPM
  values across 5785 rows, and both RPM filters inherit that granularity.
  *v9 also computes RPM from the mean pulse interval* (continuous resolution)
  and reports it in the `RPM` column, keeping the old count-based figure in
  `RpmCount` for comparison.
- **Acceleration RMS is dominated by gravity.** Whichever Acc axis is vertical
  sits at ~1 g DC; its RMS is ~97% gravity. The Vib columns are the meaningful
  ones for vibration. *Still true in v9* — Acc is deliberately the raw measured
  acceleration.
- **[pre-v9] Vib columns carry a residual DC offset** (firmware subtracted a
  single boot-time baseline). Measured 0.03–0.16 g, inflating plotted RMS by
  25–95% versus AC-coupled RMS. *v9 derives Vib on the host with a 0.5 Hz
  one-pole high-pass that tracks drift instead of freezing one boot constant,
  so v9 logs are zero-mean.* Phase error at a 1× of 84 Hz is 0.34°, which is
  negligible for balancing.
- **[pre-v9] The data is aliased, and it is not a small effect.** Sampling ran
  at ~222 Hz against a 416/833 Hz ODR with no anti-alias filter. At 5040 RPM
  the 2× blade-pass (168 Hz) folds to ~51 Hz, where it measures *larger than
  the genuine 1×*. Folded energy is mathematically unrecoverable — no filter
  applied afterwards can undo it. *v9 captures at 833 Hz behind a 208 Hz LPF2,
  so the 1× and 2× are both in-band and honest.*
- **[pre-v9] Timestamps are host arrival stamps, not sample times.** 11–30% of
  consecutive rows share a millisecond. Any analysis assuming a uniform grid —
  a spectrum above all — is relying on something the old pipeline never
  enforced. *v9 logs carry `McuMicros`.*

A **full-screen toggle [NEW v10]** sits at the end of the tab bar. It is not a
Tab3 feature despite its position — it fullscreens the **whole dashboard** and
is available on every tab. It uses the real Fullscreen API, since the goal is
to reclaim the browser chrome and taskbar (most of the vertical space on a
laptop); `uiFullscreen` is synced from the `fullscreenchange` event so Esc
restores the layout even though it never reaches the button.

Tabs 1 and 2 need no per-tab code: the shell is height-driven end to end
(`.app` is `100vh`, then `.layout` / `.main` / `.log-table-panel` /
`.log-table-scroll` all `flex: 1`), so their panels expand on their own. Tab3
is the exception and takes a `fullscreen` prop, because recharts'
`ResponsiveContainer` wants a pixel height — `chartH` grows to
`viewportH - 300`. The header is the only fixed-height element in that chain,
so `.app-fs` trims it from 48 px to 38 px.

## Live-view rendering cost — measured, and it was the log table [v10]

The UI felt laggy at SR:416/833. It was **not** the backend: the host
ingestion path measures **5.9 µs/sample, i.e. 0.5% of one core at 833 Hz**,
with CSV logging on. The broadcast has been a fixed 25 msg/s since v9
regardless of sample rate, and one message's JSON parses in ~50 µs.

The cost was in `LogRow`. The table keyed its rows on `` `${row.ts}-${i}` `` —
the **array index** — and `history` is a sliding window, so every surviving
row's index (and key) changed on every message. React does not diff rows whose
keys changed; it unmounts and remounts them. That was ~500 row teardowns and
rebuilds, roughly 4,500 `<td>` elements, **25 times a second, to add one row**.
Passing `index` down for even/odd striping also made every row's props change,
so `React.memo` could not have helped even if it had been there.

The fix is all three together, and it only works as a set:
`useWebSocket` stamps a monotonic `__k` on each sample as it enters the
window (display-only — never logged, never on the wire, never in any maths);
`LogRow` keys on that and is `memo`'d; and striping moved to CSS
`:nth-child(even)` so no positional prop remains. Steady state is now one row
mounted and one unmounted per message instead of 500 of each.

Note: recharts shows only one series per hover on these charts (each `<Line>`
carries its own `data` array). That is pre-existing default-tooltip behaviour,
not specific to `FftTooltip`.

## Tab 3 upload cost — it was over-plotting, and it is capped now [v12]

Same complaint as v10 ("the UI is laggy"), a **different mechanism**, so they
do not share a fix — only a principle: *never hand a renderer more data than
it can display*. v10 was key churn on a sliding window; this is over-plotting
a static array. The reusable half lives in `frontend-react/src/lib/plotData.ts`
and every chart in Tab 3 now goes through it.

Measured in headless Chrome over CDP (a scratchpad script, not committed —
Chrome launched with `--remote-debugging-port` and driven through Node's
built-in `WebSocket`, since there is no Puppeteer here), against
`Test Data/2.csv`: 43,754 rows, 4.7 MB, six series, chart ~1,500 px wide.

| | before | after |
|---|---|---|
| points handed to recharts (WAVEFORM) | 6 × 43,754 = **262,524** | 6 × 4,000 |
| switch to WAVEFORM, largest single blocking task | **1,140 ms** (1 sample) | **145 ms** median of 6 (128–156) |
| switch to WAVEFORM, total blocking | 1,140 ms | 279 ms median |
| switch to ALL | 1,168 ms | ~470 ms |
| upload in the default RMS view, total blocking | 538 ms | 219–414 ms |
| hover, per mousemove | ~27 ms | ~27 ms (unchanged) |

262,524 points over ~1,500 pixel columns is **~175 samples per column**, 174
of which land on a pixel that is already painted. Recharts scales every one
and serialises them all into one `<path d="...">` per series.

Four changes, in descending order of how much they bought:

1. **`decimateEnvelope` in `plotData.ts`**, applied to the WAVEFORM series
   and the SPECTRUM series. Per-column **min *and* max**, not LTTB and not a
   stride, and that choice is load-bearing: `peakOf` marks the largest-|value|
   **plotted** point, so a decimation that could drop a one-sample spike would
   make the peak markers lie about the vibration amplitude. Keeping both
   extremes of every bucket means the marker and the y axis are *identical*
   before and after — verified on real data (all six axes of `2.csv` return
   the same peak sample) and pinned by `npm run test:plot`. In vibration data
   the outlier often *is* the measurement; smoothing it away would be
   destroying the finding. The chart says so on screen ("Envelope: 4,000 of
   43,754 samples drawn per axis"), because everything else on this tab
   states its provenance. The order-peak **table** still reads the
   full-resolution spectrum through `peakNear`, not the decimated line.
2. **`fftData` and `rmsData` are skipped when their charts are off screen.**
   `spectrumData` has had a `!showSpec` guard since v9; these two never got
   one, so an upload in the default RMS view also built all six raw WAVEFORM
   series for charts that were not rendered. This is most of the upload-path
   improvement.
3. **Axis extents, ticks and legend payloads are memoised.** They were plain
   expressions in the component body, so every render — every legend click,
   every PEAKS checkbox, every keystroke in the RPM boxes — re-walked every
   plotted point of all six series twice.
4. **`Math.min(...xs)` is gone** (`extentOf`). In `rmsBinnedSeries` that was a
   latent **crash**, not a slow path: spreading an array passes one argument
   per element and V8 throws "Maximum call stack size exceeded" past ~125,000
   (measured: 100,000 fine, 130,000 throws). The RMS charts are the default
   view, so any log past ~125,000 rows — only ~2.5 minutes at 833 Hz — would
   have thrown during render, with nothing in the message about file size.
   The largest file in `Test Data/` is 43,754 rows, which is why it never
   surfaced.

Two things deliberately **not** done, with their measured cost, so the next
person does not have to re-derive them:

- **`parseCSV` is still synchronous** — 93 ms for 4.7 MB, on the main thread,
  per file. Moving it to a Web Worker would help Tab 2 as well (its
  `CsvRunPanel` parses the same way), but it is a real architectural change
  (transferring rows, reworking the error path) for the smallest remaining
  block. It is the next thing to do if uploads still feel slow.
- **Hover is ~27 ms per mousemove and decimation did not change it** — it
  measures the same on a 16-point RMS chart as on a 43,754-point one, so it
  is recharts' own tooltip/hit-test overhead, not data volume. Do not expect
  a data-side fix to move it.

One caveat about the sort removed from `rmsData`'s pipeline (it was dead work —
`rmsBinnedSeries` bins by arithmetic and sorts bin indices, so input order
never mattered): it is worth only ~7 ms of 77, and it is **not** bit-identical.
Bin membership is unchanged, but each bin's values now accumulate in a
different order inside `rmsOf`, so the float sum differs in the last bits —
measured worst case 6.7e-16 g absolute, 2.2e-15 relative, against charts that
render 3 decimals.

## Firmware/backend contract

Changing either side without the other breaks the link silently.

- **Telemetry** (firmware → host) is a **binary frame** as of v9:
  `AA 55 | type(1) | len(1) | payload(len) | crc16_ccitt(2, LE)`.
  The 24-byte telemetry header carries `seq`, `sample_index`, `t_us`, `dt_us`,
  `rpm_count`, `rpm_period`, `throttle`, `n`, `flags`, `scale_code`, `odr_code`,
  followed by `n × {int16 ax, ay, az}` of **raw counts** — scaling to g happens
  on the host. Layout is spelled out identically in the `.ino` header and in
  `frame_protocol.py`; `test_protocol.py` asserts the two agree.
  **`TELEMETRY_HEADER_LEN` must match on both sides** — if it does not, the host
  decodes every frame at the wrong offset and produces plausible garbage rather
  than an error.
  The legacy 8-field ASCII line is still *parsed* (`parse_line()`), purely so a
  board running pre-v9 firmware degrades to compatibility mode instead of
  appearing dead.
- **Commands** (host → firmware): a bare integer (throttle µs), `AUTO_TEST`,
  `STOP_TEST`, `THROTTLE_HOLD:<us>,<hold_ms>`, `STOP_HOLD`,
  `CONFIG:<min>,<max>`, `SR:DEFAULT|416|833`, `BAUD:<rate>`,
  and **[v9]** `AA:<0-7>` (anti-alias corner) and `TIMING:ON|OFF`
  (per-section µs instrumentation).
- **Ack strings** are matched by regex/substring in `serial_manager.py`
  (`ESC Armed`, `Active profile: THR_MIN=x THR_MAX=y`, `CONFIG applied:`,
  `SR applied`, `BAUD applied`, `READY`, `AA applied`, `TIMING applied`, and the
  `* parse error` variants). Rewording a `Serial.println()` in the firmware
  silently breaks confirmation — `test_protocol.py` now asserts each of these
  strings still exists verbatim in the `.ino`.
- **[v9] The firmware reports its own identity** on boot, just before
  `ESC Armed`: `BOARD=<id> FW=v9 F_CPU=<hz> ODR=<hz> AA_CODE=<n> BURST=<n>`.
  Surfaced through `/status` as `board_info`.

## The board is an ATmega328P — 2 KB SRAM is a hard constraint

Confirmed from the compiler's own report (32,256 B flash / 2,048 B SRAM): this
is a **genuine 16 MHz Uno with a real UART**, not an Uno R4. RESEARCH.md §17.1
is resolved, and the measured baud-dependence there was real.

**Every string literal in the `.ino` must be wrapped in `F()`.** On AVR a bare
literal passed to `Serial.print()` is copied into SRAM at startup and stays
there. The v9 sketch has 54 of them totalling ~1.2 KB — left unwrapped they
consumed the majority of SRAM and produced the IDE's "Low memory available,
stability problems may occur" warning with only 448 B left for the stack.

```cpp
Serial.println("SR applied: 833Hz");     // WRONG — ~20 bytes of SRAM, forever
Serial.println(F("SR applied: 833Hz"));  // RIGHT — stays in flash
```

Forgetting `F()` is **not** a compile error. It quietly eats stack headroom, and
the failure mode is a run-time stack collision — random resets or corrupted
samples under load. Flash is only ~50% used, so this trade is always worth it.

If SRAM gets tight again, the knobs (documented beside `TX_RING_SIZE` in the
sketch) are `TX_RING_SIZE` 256 → 192 → 160 (hard floor 128: below that a single
126-byte frame no longer fits and *every* frame is dropped) and `MAX_BATCH`
16 → 12.
- `Serial.begin(115200)` in `setup()` must stay a fixed literal matching
  `SerialManager.BOOT_BAUD` — the two-phase baud handshake depends on the board
  always rebooting to a known rate.
- Motor profiles are duplicated as UI presets in `BUILTIN_MOTOR_PROFILES`
  (`motorProfiles.ts` — moved there from `App.tsx` in v11) and as the firmware's
  boot default; they are reconciled at runtime by `CONFIG`. Profiles calibrated
  in the Motor Config tab exist only on the host and reach the board the same
  way, through `CONFIG`.

## The RPM inflation bug — DIAGNOSED AND FIXED in v10

Long-standing symptom: RPM read ~1.4–1.8× high in `SR:416`/`SR:833` but was
correct in `SR:DEFAULT`. **The mode-dependence was a red herring.** Every
hypothesis chased through v6–v9 (I2C noise, baud, servo-write rate, pulseCount
atomicity, the v8 "I2C quiet zone") was chasing a correlation.

**Root cause (field data 2026-08-01, `Test Data/DBG Logs/1-4` + a handheld
tachometer):** the sensor emits one real pulse per revolution *plus spurious
satellites at roughly 0.17 of a revolution*. They scale with RPM, so they are
rotationally locked (blade/pole passing), not electrical noise — and the
tachometer agreeing at high RPM proves the fundamental really is 1/rev.

The old **fixed** 3000 µs debounce rejected those satellites only while they
were closer together than 3000 µs:

```
satellite spacing = interval x 0.17 < 3000 µs   =>   RPM > ~3400
```

Above that the guard silently worked; below it satellites slipped through. The
measured crossover sat between the 3000–3500 RPM band (42% of windows corrupt)
and 3500–4000 (0% corrupt) — exactly where the arithmetic predicts. The
high-rate modes simply happened to be the ones run at low RPM.

Measured at 1200 µs throttle, true 2000 RPM: `SR:DEFAULT` 2037 (+1.9%),
`SR:416` 3039 (+51.9%), `SR:833` 2829 (+41.5%). The *same* `SR:833` build at
1400 µs throttle (true ~3750) read 3878 (+3.4%) with a 0.3% spread.

**The v10 fix** makes the guard a fraction of the *measured* revolution instead
of a fixed time, so its protection no longer evaporates as the motor slows:

- `pulseDebounceUs` = **0.375 × the longest interval seen in the previous
  500 ms window**, clamped to 800 µs–60 ms. The *maximum* is used deliberately:
  satellites only ever shorten intervals, so a contaminated window still
  contains a full-revolution gap. Deriving the guard from a mean or median
  would let a bad window shrink the guard, admitting more satellites next
  window — a latch-up ending with the guard pinned at its floor.
- `rpm_period` now uses the **median** interval, not the mean. The v9 mean was
  algebraically near-identical to the count method, so both inflated together
  and neither could flag the other. A median is immune to a minority of short
  intervals, making the two estimators a genuine cross-check at last.
- `DBG_RPM` gained `max_us` and `debounce_us` so the guard is observable.

Validated by simulation against a model calibrated to reproduce the measured
failure (2822 sim vs 2829 measured at 2000 RPM; `min_us`/true 0.17 vs measured
0.11–0.19). On that model the fix reads **1.00× at every RPM from 600 to 8000**,
converges within one window, stays monotonic under 6%/rev acceleration, and
tolerates satellites out to 0.375 of a revolution (~2× margin over the 0.17
observed). **Confirmed on hardware** — the fix has since been verified on the
bench and the RPM inflation is resolved. (The simulation figures above are
kept because they document how the fix was derived and what margin it has,
not because the result was ever in doubt.)

Costs ~131 bytes of SRAM. If that ever matters, `RPM_LOG_SLOTS` (32) is the
knob; the median only needs enough intervals to be stable.

Related: the ~220 samples/sec plateau above 230400 baud was attributed in the
old `.ino` header to "AVR float→ASCII formatting". **That attribution was
incomplete** — float formatting accounts for at most ~1 ms of a measured 4.46 ms
per-sample budget. v9 removes the plateau's actual causes (see RESEARCH.md §6
and the "Implementation status" section there).

## Login, roles and the activity log [NEW v13]

Three local accounts ship with the application and are identical on all three
machines: `admin` / `tester` / `analysis`, password `role@123`, **hashed**
(PBKDF2-HMAC-SHA256, stdlib, per-user salt) into
`Documents/NWA Testing Software/users.json` on first run. Hashed rather than
encrypted deliberately: encryption is reversible and implies a key shipping
alongside the data, and nothing ever needs to recover these passwords.

Static by design — no user-management screen. The consequence, recorded so it
is a choice rather than a surprise: because they are hashed, **nobody can
change a password by editing the JSON**; a self-service change-password screen
is the cheap addition if that ever matters.

**Permissions are expressed as TABS, in one table**, so the tab bar and the API
gates derive from the same source and cannot drift:

| Role | Tabs |
|---|---|
| Admin | all four |
| Tester | Control, Configure New Motor |
| Analysis | Analyses, Correction Mass Validation |

`auth.ROLE_TABS` (backend) and `auth.tsx`'s `TAB_ORDER` (frontend) mirror each
other; `test_auth.py` pins the table itself, because a drift between them would
hide a tab the API still served.

**The threat model is stated honestly and must not be oversold.** The backend
is a localhost sidecar on the operator's own machine, and the shipped passwords
are predictable from the usernames. This is not a secret. What role enforcement
genuinely buys — and why it lives on the backend rather than in the UI alone —
is that it stops accidental misuse, out-of-role automation, and a second
browser tab reaching past the interface.

**The WebSocket is authorised separately** (`?token=`), because a browser
WebSocket handshake carries no Authorization header. It is refused *before*
`accept()`, so an unauthorised client gets a failed handshake rather than an
open socket that silently never delivers. Leaving `/ws` open while gating every
HTTP route would have made the gating pointless — the telemetry stream is the
bulk of what a session sees.

### Logout is gated on the connection, not on a timer

**Logout is disabled while the Arduino is connected.** The operator must
disconnect first. This is not cosmetic: `SerialManager.disconnect_async()`
writes `THR_MIN` and flushes it *before* closing the port, so disconnecting is
the action that actually spins the motor down. Gating sign-out behind it means
a session can never end with a motor still being driven, and it covers a
running test implicitly, since a test can only run while connected.

Two consequences that must survive any future change:

* **The rule applies to automatic expiry too, not just the button.** Any idle
  timeout has to be suppressed while connected, or the timeout performs exactly
  the logout the rule forbids and orphans a motor by the clock.
* **Disconnect must never be blocked.** Sign-out depends on it, so anything
  that left it disabled or unreachable would trap the user in the session.

The backend enforces the rule as well (`/logout` refuses while connected) —
the button is not the only way to reach the endpoint.

Once permitted, sign-out still goes through a **confirmation dialog with a
checkbox** (`SignOutDialog` in `auth.tsx`). The tick is the confirmation;
there is no second "are you sure?" on top of it, for the same reason the
delete dialog has none — stacking them only trains people to click through
both. The button sits beside the tab bar, so a mis-click ending a bench
session was a realistic way to lose one.

**Related hazard, pre-existing and NOT introduced here: the firmware has no
serial-loss failsafe.** There is no watchdog and no serial timeout in the
`.ino`. The graceful path is safe, but if the backend process is killed —
crash, Task Manager, sleep — nothing writes `THR_MIN` and the Arduino keeps
driving its last commanded throttle. Recovery works but is unobvious: opening
the port triggers a DTR auto-reset, the sketch re-arms in `setup()`, and the
motor stops. That is ~8.5 s and requires signing in first, so do not "fix" it
by putting an unauthenticated control on the login screen.

### The activity log

`activity_log.py` writes one line per event to
`Documents/NWA Testing Software/Logs/activity-YYYY-MM-DD.txt` — a new file per
calendar day, chosen from the timestamp rather than cached, so a session
running past midnight rolls over on its own.

```
2026-08-18 13:04:22.417 | S-7F3A9C21  | admin     | Admin     | CONNECT    | port=COM5 ...
```

Plain text so an operator can open it in Notepad and attach it to an email.
The **session key** (`S-` + 8 uppercase hex) is on every line, generated per
login, and shown in the header and every info panel — it is what makes a
report ("it broke, here is my session key") searchable.

Three rules the module exists to enforce:

1. **Append and flush per line.** Buffered writes lose exactly the lines that
   explain a crash.
2. **Never log the telemetry stream.** At 833 Hz that would be gigabytes a day
   and would bury every line that matters; sample data already has the CSVs.
   The one high-rate *action* — dragging the throttle slider, which sends every
   50 ms — is coalesced to at most one line per second with a trailing timer,
   so the value the operator settled on is the one recorded.
3. **Never log credentials.** A failed login records the attempted username and
   never the attempted password.

**Retention is deliberately absent — nothing here ever deletes a log.** Text at
this event rate costs nothing, and the record of an incident has to still be
there when someone finally asks about it weeks later.

`log()` reads the session with `getattr`, not attribute access, so a malformed
session degrades to `-` instead of raising an AttributeError out of a motor
command. That is not hypothetical: the test scripts call endpoint functions
directly, where FastAPI's `Depends` default arrives unresolved.

UI-only events (tab switches, info panels) reach the same file through
`/activity/log`, so one file holds the whole story rather than two halves.

## Universal connect — one connection, above the tabs [NEW v13]

`connection.tsx` owns connection state for the whole application and renders
through `ConnectionBar.tsx` above the tab content. Before v13 the Control tab
owned `connStatus` and the entire connect sequence inside its own render, and
Configure New Motor had no Connect control at all — it polled `/status` and,
when disconnected, told the operator to go to the Control tab. Two tabs, one
port, and only one of them able to open it.

The backend stays the source of truth: the provider mirrors `/status` on a
2.5 s poll rather than replacing it, because only the backend knows what the
firmware actually acknowledged. The v11 "adopt state on mount" behaviour is
preserved and generalised — it now runs once for the application instead of
once per Control-tab mount, and the profile is still matched by its
**confirmed range**, with a range matching nothing surfaced as a mismatch.

`ConnectionProvider` is mounted **only for roles that have a hardware tab**. An
Analysis user gets none, because polling `/ports` and `/status` for a role the
backend refuses would produce a stream of meaningless 403s. `useConnection()`
throws outside a provider; `useOptionalConnection()` is for the shell, which
renders for every role.

**What this must not break:** Configure New Motor deliberately *moves* the
validated throttle range during calibration and restores it on unmount. That
cleanup is load-bearing — a stale 1000–2000 µs range would let Auto Test sweep
a motor rated to 1515. Calibration therefore stays entirely inside that tab;
the provider owns the connection and nothing else, and the tab calls
`refreshFromBackend()` whenever it moves the range so the Control tab's
percentages never refer to a range the motor is not on.

**[NEW v13] The connect flow checks firmware identity.** `/status` already
reported `firmware_protocol`; the bar now warns when it is not `binary-v9`. A
pre-v9 board does not fail — it degrades to ASCII compatibility mode and keeps
producing plausible, aliased data at ~220 Hz with host arrival stamps. Connect
time is the only point anyone would notice.

## Throttle is a percentage on Control, microseconds on Configure New Motor [NEW v13]

`throttle.ts` is the single place percent and microseconds meet. The Control
tab's manual throttle and both Step Test modes take **0–100%** of the loaded
configuration; the wire protocol, `active_profile` validation, the CSV and the
firmware all still speak microseconds, and the conversion happens only at the
API boundary.

**Configure New Motor deliberately stays in raw µs and does not import this.**
That tab exists to *discover* a motor's range, so a percentage there would be
circular — computed from the very range being measured.

Three properties, each a quiet failure if broken, pinned by
`npm run test:throttle`:

* **Rounding happens once.** Two call sites rounding independently would
  eventually disagree about which µs a percentage means, and the disagreement
  shows up as a rejected command rather than an obviously wrong number.
* **Clamping happens AFTER rounding.** Rounding can push a value one µs past
  the bound it came from, and the backend validates inclusively — that one
  microsecond is the difference between a command and a rejection.
* **0% and 100% are exact**, by construction rather than luck. 0% has to
  actually stop the motor and 100% has to reach the top of the range.

Validation simplified as a side effect: the bound is now a flat 0–100 rather
than a µs range re-derived from whichever configuration was loaded, so changing
configuration can no longer silently invalidate a target already typed.

**Auto Test is deliberately untouched.** It has no user input at all — the
frontend calls `/start_auto_test`, the backend sends a bare `AUTO_TEST`, and
the firmware sweeps its own confirmed `THR_MIN`→`THR_MAX` in `NUM_SEGS`
segments over fixed durations. There is nothing to convert; it is already
0→100% of the loaded configuration by definition.

`App.tsx`'s old local helpers are gone. `usToPct` there was **misnamed** — it
took a percentage and returned microseconds, the exact opposite of what it
read as, which survives right up until someone reuses it in a new call site.

## Motor configurations: one store, deletable, never editable [NEW v13]

The three shipped configurations are now **seeded into the backend store**
(`motor_profiles.ensure_seeded`) instead of living only in frontend source, so
the operator sees one list that comes from one place. Seeding happens only when
the file does not exist, which is what makes deletion stick: remove one,
restart, and it stays gone.

`motorProfiles.ts` still carries its own copy of the three, but purely as an
**offline fallback** for an unreachable backend — a backend that will not start
should cost you the calibrated motors, never an empty dropdown. The merge
dedupes by id, and `custom` is decided by id rather than by where the record
arrived from, or all three shipped ones would be labelled "calibrated".

**Configurations cannot be edited at all.** To change a motor's range,
calibrate it again and save — a hand-edited range is a number no bench test
ever backed.

**Deletion is a multi-select dialog, one write.** A per-id loop could leave the
store half-deleted with no way for the operator to tell which half, so an
unknown id rejects the *whole* request. The checkbox plus a button naming what
is about to go ("DELETE 2: U15II, Bench-3") is the confirmation; a second
"are you sure?" on top of a list just trains people to click through.

Two deletions are refused, shown **disabled with the reason rather than
hidden** — hiding them leaves the operator hunting for a configuration that is
plainly listed just above:

* **the configuration loaded on the Arduino**, matched by range because
  `active_profile` holds what the firmware confirmed rather than a reference to
  a record; the backend validates throttle against it and every Control-tab
  percentage is computed from it;
* **the last remaining one**, because an empty store leaves the Control tab
  with no range and no way back except reinstalling.

## Per-tab information panels [NEW v13]

`InfoPanel.tsx` — one "i" button per tab, one component driven by a content
table, so adding a tab is an entry rather than a rebuild. Content is
tab-specific on purpose: the questions on Analyses (what is the difference
between the two RPM filters?) have nothing to do with those on Configure New
Motor (why is 0% not the spin-up point?), and combining them makes both harder
to find. Each panel also shows the session key, because opening the help is
often the moment before reporting a problem.

## Application data lives in Documents [NEW v13]

`app_paths.py` resolves every persistent path from one place:

```
Documents/NWA Testing Software/
  ├── Motor Configuration/    motor_profiles.json
  ├── CSVs/                   test logs (+ DBG Logs/)
  ├── Logs/                   activity-YYYY-MM-DD.txt
  └── users.json
```

A pre-v13 `backend-fastapi/motor_profiles.json` is **migrated** on first start
(`motor_profiles.migrate_legacy_store`, called from `ensure_seeded`) and the
original is renamed to `.json.migrated` rather than deleted. Migration runs
*before* the seeding check, or a store that had just moved into place would be
treated as "never existed" and overwritten with the shipped defaults.

The historical CSVs in `backend-fastapi/Test Data/` stay where they are: they
are the fixtures this documentation quotes measurements from (`2.csv`'s 43,754
rows, the ramp-rate survey). Only new logs go to Documents.

**Any test that starts a `CSVLogger` must redirect `logger._TEST_DATA_DIR`
first** — otherwise it writes into the operator's live test data.
`test_ingest.py` does this; `test_motor_profiles.py` and `test_auth.py` do the
equivalent for the configuration store and the user file.

Documents rather than `%APPDATA%` deliberately: the operator has to reach the
CSVs by hand, and `%APPDATA%` is hidden by default. The name is **version-free**
because the Tauri updater upgrades in place — a versioned folder would orphan
every configuration, CSV and log on the next release. Paths resolve from
`sys.executable` when frozen and `__file__` otherwise, because once PyInstaller
freezes the backend `__file__` points inside a temporary extraction directory
that is deleted on exit.

## Packaging: a Tauri shell over a frozen backend [NEW v14]

Stage 8. The operator-facing detail — building, signing, releasing, installing,
troubleshooting — lives in `docs/DEPLOYMENT.md`. This section is only the
things a *code* change could break.

```
  NWA Testing Software.exe  (Tauri/Rust)
        │  spawns, CREATE_NO_WINDOW
        ▼
  nwa-backend.exe + _internal/   (PyInstaller --onedir)
        │  localhost:8000, unchanged
        ▼
  the same React dashboard, served from the bundle
```

Nothing about the dashboard's networking changed. `useApi.ts` and
`useWebSocket.ts` still hardcode `localhost:8000`, the backend is the same
uvicorn app, and running the two by hand at :3000 and :8000 is still the
development loop. The shell adds process lifetime, not a new architecture.

**`--onedir`, not `--onefile`.** Measured on this machine, warm cache, three
runs each: onedir reaches "listening" in 1.02–1.16 s, onefile in 1.48–1.82 s,
and onefile re-extracts ~50 MB into `%TEMP%` on *every* launch — which is also
50 MB for antivirus to re-scan every launch. onedir costs 32.1 MB on disk
against 17.5 MB, which the installer compresses away. The consequence is that
the backend is a folder, not a file, so it ships as a Tauri **resource** rather
than an `externalBin` (which copies a single file). `resolve_backend_exe()`
tries several candidate layouts and names all of them on failure, because
Tauri's installed resource layout depends on how `bundle.resources` was
declared — `..` becomes `_up_` — and a wrong guess would otherwise present as
"the backend never started".

**Two path bases in `tauri.conf.json`, and they are not the same one.**
`frontendDist` and `bundle.resources` resolve relative to the config file, i.e.
`src-tauri/`. `beforeDevCommand` and `beforeBuildCommand` run in the *app*
directory — the repo root, where the Tauri CLI's `package.json` is. So
`frontendDist` is `../frontend-react/dist` while the build command is
`npm --prefix frontend-react run build`, with no `../`. Getting this wrong
resolved to a path outside the repository entirely.

### The shell/backend contract — `test_deployment.py` reads both sides

Same principle as `test_protocol.py` parsing the `.ino`. Four constants are
shared between `src-tauri/src/backend.rs` and `backend-fastapi/run_backend.py`,
and every one of them fails quietly:

| Constant | Breaks as |
|---|---|
| `READY_MARKER` | the app sits on "Starting up" until it times out |
| `EXIT_PORT_BUSY` (3) | a port conflict is reported as a crash, wrong recovery offered |
| `HEALTH_SIGNATURE` | an unrelated service on 8000 is mistaken for ours, or ours for a stranger |
| the runtime file's path | graceful shutdown silently degrades to a kill |

That last one is the dangerous one. See below.

### Shutdown is the safety property, and it has one path

`SerialManager.disconnect_async()` writes THR_MIN and flushes it *before*
closing the port, and the FastAPI lifespan teardown is what calls it. So the
only safe way to stop the backend is to let uvicorn unwind its lifespan —
`POST /shutdown` sets `SERVER.should_exit`, which does exactly that. Killing
the process skips all of it and leaves the ESC driving its last commanded
throttle, because **the firmware still has no serial-loss failsafe**.

Three consequences that must survive any future change:

* **Closing the window does not exit the app.** `WindowEvent::CloseRequested`
  is intercepted, the frontend is told (`app-closing` → "Shutting down
  safely"), and the process exits only once the backend has actually stopped.
  A `kill()` exists but only after an 8 s grace period, and it logs loudly.
* **`/shutdown` is token-gated, and the token lives in a file a web page
  cannot read** (`%LOCALAPPDATA%\NWA Testing Software\runtime.json`, from
  `app_paths.runtime_file()`). CORS is wide open and a cross-origin POST is not
  blocked, so an ungated `/shutdown` would let any page the operator had open
  end a running test. The token is generated by the *backend* and read by the
  shell, not the other way round, so there is one source for it.
* **An orphan is reclaimed by asking, not by killing.** If port 8000 is held at
  launch, `/health` decides whether it is ours. If it is, the shell sends
  `/shutdown` with the token from the runtime file — so the orphan's own
  teardown spins its motor down on the way out. A foreign service is never
  touched; the operator is told which it was.

The runtime file is deliberately **not** under Documents: it is machine-local
state with a lifetime of one run, and Documents is the folder the operator
opens by hand.

### The startup race

The window paints in well under a second; the frozen backend needs ~1.1 s to
bind. `StartupGate` holds everything — including `AuthProvider`, because
signing in is itself a backend call and a login screen shown too early reports
"not signed in" for a backend that has merely not started.

**Polling `/health` is the primary signal, not the Tauri event**, so the happy
path has one code path that works both in the packaged app and at :3000 against
a hand-started backend. It is a bounded probe — typically 2–3 requests — that
stops the moment it succeeds. The desktop events only sharpen the *failure*
case, where Rust knows the exit code, whether the port was busy, and the
backend's own last output; the HTTP probe knows none of that.

`lib/desktop.ts` is the only file that imports `@tauri-apps/*`. Everything it
exports has a browser answer, so `npm run dev` never sees Tauri.

### Updates

Driven from the frontend (`UpdateManager.tsx`) rather than Rust, because the
two rules that matter are frontend facts: the activity log goes through
`/activity/log`, and "never while connected to the Arduino" needs the
connection context. Restarting mid-test would orphan a spinning motor, so the
connection is re-checked at the moment INSTALL is clicked, not only when the
prompt was raised. A declined version is recorded and never offered again.

**The version string must match in four files** — `version.py`,
`tauri.conf.json`, both `package.json`s — and the git tag is that string with a
leading `v`. Drift is invisible: too low nags forever, too high never updates,
and neither raises anything. `test_deployment.py` fails on drift and the
release workflow runs it before building.

## Conventions

- **[CHANGED v13] Comments: one header block per file, then near-silence.**
  Each file opens with a short block saying what it is, what contract it is
  half of, and any constraint that would cause a silent bug if broken. Below
  that, comment only what the code cannot say for itself — one or two lines,
  not a paragraph. The long-form archaeology (why the RPM guard is a fraction
  of a revolution, why `LogRow` keys on `__k`, why decimation keeps both
  extremes) lives in THIS file instead, where it is searchable and does not
  cost a screenful every time someone reads the function.

  This replaced the older convention of narrating every fix inline, which had
  reached 20% of all lines. **Do not reintroduce it** — a change that needs a
  paragraph to justify belongs in a CLAUDE.md section with a one-line pointer
  from the code.

  Two things are exempt and stay verbatim in the source: the `F()` / SRAM rule
  in the `.ino`, because forgetting it is a run-time stack collision rather
  than a compile error, and the wire-protocol frame layout, because it is one
  half of a contract `test_protocol.py` checks.
- The frontend hardcodes `http://localhost:8000` and `ws://localhost:8000/ws`
  (`useApi.ts`, `useWebSocket.ts`); the `/api` proxy in `vite.config.ts` is
  unused. CORS on the backend is wide open.
- CSV logs are written to `Documents/NWA Testing Software/CSVs/` with IST
  (UTC+5:30) timestamps.

## Source layout [v14]

```
frontend-react/src/
  App.tsx          shell: providers, tab bar, role-filtered routing
  tabs/            ControlTab, MotorConfigTab, AnalysesTab, CorrectionMassTab
  components/      ConnectionBar, InfoPanel, Readouts (Gauge/ValRow/LogRow),
                   StartupGate, UpdateManager
  context/         auth.tsx, connection.tsx  (the two providers)
  lib/             balancing, fft, plotData, chartData, throttle,
                   motorProfiles, format, desktop  (+ their *.test.ts)
  hooks/           useApi, useWebSocket
  types/

src-tauri/
  src/main.rs      thin entry point; the windows_subsystem attribute
  src/lib.rs       single instance, startup, the intercepted close
  src/backend.rs   the sidecar's lifetime, /health, /shutdown, orphan reclaim
  tauri.conf.json  bundle, resources, icons, updater endpoint + pubkey
  capabilities/

backend-fastapi/
  run_backend.py   the frozen entry point (uvicorn is a dev command line)
  backend.spec     PyInstaller recipe — hiddenimports is load-bearing
  version.py       the version string all four files must agree on
```

`App.tsx` was one ~2,900-line file holding three tabs; it is now a ~200-line
shell. Tabs are addressed by id, never by index.

The backend stays flat on purpose: modules import each other by bare name
(`import auth`), which is what PyInstaller freezes most predictably at stage 8.
Splitting it into packages would buy tidiness and cost import churn plus a
spec file to maintain.
