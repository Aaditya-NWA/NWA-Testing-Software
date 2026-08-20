// ── Per-tab information panels [NEW v13] ─────────────────────────────────────
//
// One "i" button per tab, opening a panel that explains THAT tab. Deliberately
// not one application-wide help blob: the questions an operator has on the
// Analyses tab (what is the difference between the two RPM filters?) have
// nothing to do with the ones they have on Configure New Motor (why is 0% not
// the spin-up point?), and a combined page makes both harder to find.
//
// The mechanism is one component driven by a content table, so adding a tab
// later means adding an entry rather than rebuilding this.
//
// Each panel also shows the session key, because the moment someone opens the
// help is often the moment they are about to report a problem, and the key is
// what makes the activity log searchable for whoever answers.

import React, { useEffect } from "react";
import { TabId } from "../context/auth";

interface Section {
  heading: string;
  body: React.ReactNode;
}

const CONTENT: Record<TabId, { title: string; sections: Section[] }> = {
  control: {
    title: "Control",
    sections: [
      {
        heading: "What this tab does",
        body: <>Drives the motor and shows live telemetry. Connect using the bar at
          the top of the window — that connection is shared with Configure New
          Motor, so you only connect once per session.</>,
      },
      {
        heading: "Throttle is entered as a percentage",
        body: <>All throttle inputs here are a percentage of the loaded motor
          configuration's range. <b>0% is the configuration's minimum and stops
          the motor; 100% is its maximum.</b> The resolved microseconds are shown
          beside each field, because the CSV log, the firmware and the Configure
          New Motor tab all still work in microseconds.</>,
      },
      {
        heading: "Auto Test vs Step Test",
        body: <><b>Auto Test</b> is run by the firmware itself: it sweeps the whole
          configured range, 0→100% over about 70 seconds with pauses, then back
          down in 15. It takes no input. <b>Step Test</b> is yours to define —
          SINGLE ramps to one throttle and holds it, MULTIPLE walks a list of
          steps in order.</>,
      },
      {
        heading: "Logging happens by itself",
        body: <>Starting a test opens a CSV log if one is not already open, and
          closes it when the run ends. If you opened a log by hand it is left
          alone in both directions — the test is a guest in your recording.</>,
      },
      {
        heading: "E-Stop",
        body: <>Drops the throttle to minimum immediately and cancels any running
          sequence on the backend, so a step test cannot spin the motor back up
          a moment later.</>,
      },
    ],
  },

  motor_config: {
    title: "Configure New Motor",
    sections: [
      {
        heading: "What this tab does",
        body: <>Measures an unknown motor: sweep the throttle, record where it
          starts spinning and how high it should be driven, then save that as a
          motor configuration you can select on the Control tab.</>,
      },
      {
        heading: "Throttle here is raw microseconds, on purpose",
        body: <>Unlike the Control tab, this one does not use percentages. The
          whole point is to <i>discover</i> the range — a percentage would be
          computed from the very range you are still measuring.</>,
      },
      {
        heading: "Why 0% is not the spin-up point",
        body: <>The measured spin-up throttle is where the motor <i>starts</i>
          turning. The configuration's 0% sits an <b>idle headroom</b> below it
          (55 µs by default), because 0% has to actually stop the motor. If 0%
          were the spin-up point the motor would idle at the bottom of every
          ramp. This is the arithmetic behind the shipped U15II configuration:
          1080 measured becomes 1025.</>,
      },
      {
        heading: "Calibration mode moves the validated range",
        body: <>A sweep has to reach throttles outside the loaded configuration,
          and two separate gates block that — the backend refuses out-of-range
          throttles, and the firmware <i>silently ignores</i> them. So START
          CALIBRATION loads the sweep range as a real configuration, and EXIT
          puts the previous one back. The amber banner is showing for as long as
          the range is moved. Leaving this tab also ends calibration.</>,
      },
      {
        heading: "Configurations can be deleted, never edited",
        body: <>To change a motor's range, calibrate it again and save. Deletion
          uses a multi-select dialog. The configuration currently loaded on the
          Arduino cannot be deleted, and neither can the last remaining one.</>,
      },
    ],
  },

  analyses: {
    title: "Analyses",
    sections: [
      {
        heading: "What this tab does",
        body: <>Compares recorded CSV files. It needs no Arduino connection — it
          works entirely from uploaded logs.</>,
      },
      {
        heading: "The four graph modes",
        body: <><b>RMS</b> is smoothed and always plots each file's full natural
          range against actual RPM. <b>WAVEFORM</b> is the raw signed
          per-sample signal. <b>SPECTRUM</b> is a genuine Fourier transform with
          order markers. <b>ALL</b> shows them together.</>,
      },
      {
        heading: "The two RPM filters are not the same thing",
        body: <><b>RPM RANGE</b> gates every chart and keeps RPM on the X axis;
          RMS binning happens after it, so narrowing the range genuinely
          increases resolution. <b>RPM WINDOW</b> (target ± tolerance) applies
          only to the waveform and spectrum charts, within that range. RMS charts
          deliberately ignore the window.</>,
      },
      {
        heading: "Peak markers and decimation",
        body: <>PEAKS marks each visible series' largest-magnitude plotted point,
          comparing absolute value because these charts are signed and the
          biggest excursion is often negative. Large files are drawn as an
          envelope (min and max per pixel column), which cannot move a peak or
          change the vertical extent — the chart states how many samples it
          drew.</>,
      },
      {
        heading: "Caveats that depend on when the file was recorded",
        body: <>Older logs are quantised to ~120 RPM steps, carry a residual DC
          offset in the Vib columns, are aliased (sampled at ~222 Hz against a
          416/833 Hz sensor rate), and timestamp rows by host arrival rather
          than sample time. Current firmware fixes all four. Acceleration RMS is
          dominated by gravity in every version — whichever Acc axis is vertical
          sits at about 1 g, so use the Vib columns for vibration.</>,
      },
    ],
  },

  correction_mass: {
    title: "Correction Mass Validation",
    sections: [
      {
        heading: "What this tab does",
        body: <>Single-plane balancing. Upload a baseline run and a trial run with
          a known mass at a known angle, and it computes the correction mass and
          the angle to place it at. No Arduino connection needed.</>,
      },
      {
        heading: "What it expects",
        body: <>Two CSV logs recorded at the same throttle and the same RPM, one
          without and one with the trial mass. Comparing runs at different
          speeds will produce a confident-looking number that is wrong.</>,
      },
      {
        heading: "Reading the result",
        body: <>The polar diagram shows the original imbalance, the effect of the
          trial mass, and the computed correction. The correction is the vector
          that cancels the original — mass and angle together, neither useful
          alone.</>,
      },
      {
        heading: "Use the Vib columns",
        body: <>Amplitude and phase are taken from vibration, not raw
          acceleration, for the gravity reason described on the Analyses tab.</>,
      },
    ],
  },
};

export function InfoButton({ onClick }: { onClick: () => void }) {
  return (
    <button className="info-btn" onClick={onClick} title="About this tab" aria-label="About this tab">
      i
    </button>
  );
}

export default function InfoPanel({
  tab, sessionKey, onClose,
}: {
  tab: TabId;
  sessionKey?: string;
  onClose: () => void;
}) {
  // Esc closes. Without this the panel is a trap for anyone who opened it by
  // accident and is looking for a way out that is not the mouse.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const c = CONTENT[tab];

  return (
    <div className="info-overlay" onClick={onClose}>
      <div className="info-modal" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="info-head">
          <h2 className="info-title">{c.title}</h2>
          <button className="info-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="info-body">
          {c.sections.map(s => (
            <section key={s.heading} className="info-section">
              <h3 className="info-heading">{s.heading}</h3>
              <p className="info-text">{s.body}</p>
            </section>
          ))}
        </div>
        {sessionKey && (
          <div className="info-foot">
            Session <b>{sessionKey}</b> — quote this when reporting a problem;
            it identifies your session in the activity log.
          </div>
        )}
      </div>
    </div>
  );
}
