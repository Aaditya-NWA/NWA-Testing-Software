"""
signal_chain.py — [NEW v9] host-side sample clock and DC removal.

Two problems this module exists to solve, both measured rather than
theoretical (RESEARCH.md §5.3 and §11.3).

────────────────────────────────────────────────────────────────────
1. THE CSV CLOCK WAS NOT A SAMPLE CLOCK

   Every timestamp in the old system was taken by the host, on the
   reader thread, AFTER the bytes had crossed USB — an arrival stamp,
   not a sample stamp. Three defects compounded:

     a. USB batches arrivals. 11-30% of consecutive rows shared a
        millisecond and the burst structure (1-4 rows, dominated by 1
        and 2) was a transport artefact with no relationship to when
        the sensor actually converted.

     b. time.time() on Windows is GetSystemTimeAsFileTime, whose
        NOMINAL resolution is 15.625 ms. It happened to read ~1 ms
        during the analysis only because some other process had raised
        the global timer resolution via timeBeginPeriod. If that
        process exits, timestamps silently degrade to 15.6 ms
        granularity — lumping ~3.4 samples per tick at 220 Hz. A
        latent, environment-dependent failure that would corrupt data
        with no error message.

     c. Consequently the true sampling jitter was not merely unmeasured
        but UNOBSERVABLE.

   Fix: the firmware now stamps each batch with its own micros() and
   the absolute sample_index of the batch's first sample. SampleClock
   below reconstructs a uniform per-sample time base in the MCU's own
   domain and maps it to host wall-clock with a minimum-filtered
   offset. time.perf_counter() (QPC, ~100 ns) is used for all host-side
   timing; time.time() is used only once, to anchor the mapping to
   wall-clock for human-readable CSV timestamps.

────────────────────────────────────────────────────────────────────
2. THE "Vib" COLUMNS WERE NOT ZERO-MEAN

   The firmware used to emit Vib = Acc - (a single gravity sample taken
   once at boot). Any thermal drift, mounting settle or orientation
   change after boot left a DC offset in the Vib columns — measured at
   0.03-0.16 g, which inflated the plotted RMS by 25-95% versus
   AC-coupled RMS. The dashboard was faithfully plotting a number that
   was mostly offset.

   Fix: the firmware now sends raw counts and makes no assumptions.
   DCRemover applies a one-pole high-pass that TRACKS the baseline
   instead of freezing one boot-time constant.

   On the deliberately low corner frequency: RESEARCH.md §11.4 warns
   that non-linear-phase IIR filters hurt single-plane balancing, which
   depends on the phase of the 1x component. That warning is about
   filters near the signal band. At fc = 0.5 Hz the phase error at a
   1x of 84 Hz is arctan(0.5/84) = 0.34 degrees — negligible against
   the ~1 degree repeatability of the measurement itself, while still
   removing a DC pedestal that was corrupting amplitude by tens of
   percent. The trade is strongly favourable, but the corner is
   configurable so it can be raised (worse phase, faster settling) or
   set to 0 to disable entirely.
"""

import math
import time
from typing import Dict, Optional


class SampleClock:
    """Maps MCU micros() to host wall-clock time.

    The MCU's micros() and the host's clock run off different crystals,
    so they drift relative to one another. Rather than assume a rate,
    this tracks the OFFSET between the two using a minimum filter: the
    smallest observed (host_arrival - mcu_time) over a sliding window.

    Why a minimum filter rather than an average: transport delay is
    strictly non-negative and highly variable (USB frame batching, OS
    scheduling, GIL). The *minimum* observed delay is the sample that
    suffered the least buffering, so it is the closest available
    estimate of the true offset. Averaging would instead track the mean
    transport delay, which is both larger and load-dependent. This is
    the same reasoning NTP uses for its own min filter.

    The MCU's micros() wraps every ~71.6 minutes on a 32-bit counter;
    wrap is detected and unwrapped so long runs stay monotonic.
    """

    WRAP_US = 1 << 32
    # Re-baseline the offset estimate on this cadence so slow crystal
    # drift is followed instead of accumulating without bound.
    WINDOW_S = 10.0

    def __init__(self) -> None:
        self._wraps = 0
        self._last_raw_us: Optional[int] = None

        self._offset: Optional[float] = None      # host_seconds - mcu_seconds
        self._window_min: Optional[float] = None
        self._window_start: float = 0.0

        self._perf_epoch = time.perf_counter()
        self._wall_epoch = time.time()

        self.drift_ppm: float = 0.0
        self._fit_n = 0
        self._fit_sx = 0.0
        self._fit_sy = 0.0
        self._fit_sxx = 0.0
        self._fit_sxy = 0.0
        self.measured_rate_hz: float = 0.0

    def _unwrap(self, raw_us: int) -> int:
        if self._last_raw_us is not None and raw_us < self._last_raw_us - (self.WRAP_US // 2):
            self._wraps += 1
        self._last_raw_us = raw_us
        return raw_us + self._wraps * self.WRAP_US

    def update(self, mcu_us_raw: int, index_at_mcu_us: int, host_perf: float) -> float:
        """Register a batch arrival. Returns the unwrapped MCU time (s).

        index_at_mcu_us MUST be the absolute index of the sample that
        mcu_us_raw actually stamps — not the batch's first index. The
        firmware stamps at batch READ COMPLETION, so that is
        `sample_index + n - 1`.

        This is called out because getting it wrong is invisible: the
        fitted slope (the sample rate) stays perfectly correct while the
        intercept shifts by n-1 samples, so every reconstructed timestamp
        is offset by ~19 ms at 833 Hz in batches of 16. Nothing looks
        broken; the data is just quietly wrong.

        host_perf must come from time.perf_counter().
        """
        sample_index = index_at_mcu_us
        mcu_us = self._unwrap(mcu_us_raw)
        mcu_s = mcu_us / 1e6

        delta = host_perf - mcu_s
        if self._offset is None:
            self._offset = delta
            self._window_min = delta
            self._window_start = host_perf
        else:
            if self._window_min is None or delta < self._window_min:
                self._window_min = delta
            if host_perf - self._window_start >= self.WINDOW_S:
                self._offset += 0.2 * (self._window_min - self._offset)
                self._window_min = delta
                self._window_start = host_perf

        self._fit_n += 1
        self._fit_sx += mcu_s
        self._fit_sy += sample_index
        self._fit_sxx += mcu_s * mcu_s
        self._fit_sxy += mcu_s * sample_index
        if self._fit_n >= 8:
            denom = self._fit_n * self._fit_sxx - self._fit_sx * self._fit_sx
            if denom > 1e-12:
                self.measured_rate_hz = (
                    self._fit_n * self._fit_sxy - self._fit_sx * self._fit_sy
                ) / denom

        return mcu_s

    def time_for_index(self, index: int) -> Optional[float]:
        """MCU-domain time (s) for an absolute sample index, or None.

        THIS is the uniform sample clock, and it is worth being precise
        about why it is not simply "batch stamp minus k periods".

        The samples themselves are uniform: the FIFO captures at the
        sensor's crystal-derived ODR, which does not jitter. What DOES
        jitter is when the MCU gets around to reading a batch out and
        stamping it — that depends on loop timing, the I2C quiet zone,
        and command handling. So the batch stamps are jittery
        OBSERVATIONS of a uniform underlying process.

        Reconstructing from the nominal dt instead produces a sawtooth:
        uniform within each batch, with a step at every batch boundary,
        because the nominal period (1200 us) is not the true one
        (1e6/833 = 1200.48 us). That error is periodic at the batch rate
        (~52 Hz at 833 Hz in batches of 16), and periodic timing error is
        exactly what puts spurious sidebands either side of every real
        peak in an FFT. It would have looked like real spectral content.

        The least-squares fit of index against MCU time recovers both the
        true period and the phase, so this returns a genuinely uniform
        grid AND measures the real ODR rather than trusting the nominal.
        """
        if self._fit_n < 8 or self.measured_rate_hz <= 0:
            return None
        mean_t = self._fit_sx / self._fit_n
        mean_i = self._fit_sy / self._fit_n
        return mean_t + (index - mean_i) / self.measured_rate_hz

    def reset_fit(self) -> None:
        """Drop the rate fit, keeping the wall-clock offset.

        Called when the output rate changes (an SR: command): the old
        slope no longer describes the new stream, and a fit spanning two
        different rates would describe neither.
        """
        self._fit_n = 0
        self._fit_sx = self._fit_sy = self._fit_sxx = self._fit_sxy = 0.0
        self.measured_rate_hz = 0.0

    def to_wall(self, mcu_s: float) -> float:
        """Map an unwrapped MCU timestamp (s) to host wall-clock epoch seconds."""
        if self._offset is None:
            return time.time()
        perf = mcu_s + self._offset
        return self._wall_epoch + (perf - self._perf_epoch)

    def reset(self) -> None:
        self.__init__()


class DCRemover:
    """Per-axis one-pole high-pass, used to derive Vib from raw Acc.

    Difference equation (standard one-pole HPF):
        y[n] = a * (y[n-1] + x[n] - x[n-1]),  a = RC / (RC + T)
    with RC = 1 / (2*pi*fc).

    Set fc = 0 to pass the signal through unchanged (Vib == Acc), which
    is useful when comparing against pre-v9 logs.
    """

    AXES = ("x", "y", "z")

    def __init__(self, fc_hz: float = 0.5, fs_hz: float = 833.0) -> None:
        self.fc_hz = fc_hz
        self._prev_in: Dict[str, float] = {a: 0.0 for a in self.AXES}
        self._prev_out: Dict[str, float] = {a: 0.0 for a in self.AXES}
        self._primed = False
        self.set_rate(fs_hz)

    def set_rate(self, fs_hz: float) -> None:
        self.fs_hz = fs_hz if fs_hz > 0 else 833.0
        if self.fc_hz <= 0:
            self._a = 0.0
            return
        rc = 1.0 / (2.0 * math.pi * self.fc_hz)
        t = 1.0 / self.fs_hz
        self._a = rc / (rc + t)

    def process(self, ax: float, ay: float, az: float):
        if self.fc_hz <= 0:
            return ax, ay, az

        if not self._primed:
            self._prev_in = {"x": ax, "y": ay, "z": az}
            self._prev_out = {"x": 0.0, "y": 0.0, "z": 0.0}
            self._primed = True
            return 0.0, 0.0, 0.0

        out = []
        for axis, x in (("x", ax), ("y", ay), ("z", az)):
            y = self._a * (self._prev_out[axis] + x - self._prev_in[axis])
            self._prev_in[axis] = x
            self._prev_out[axis] = y
            out.append(y)
        return out[0], out[1], out[2]

    def reset(self) -> None:
        self._prev_in = {a: 0.0 for a in self.AXES}
        self._prev_out = {a: 0.0 for a in self.AXES}
        self._primed = False
