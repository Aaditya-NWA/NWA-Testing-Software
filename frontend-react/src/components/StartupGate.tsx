/**
 * StartupGate — nothing else mounts until the backend answers.
 *
 * The problem it solves: the window paints in well under a second, the frozen
 * backend needs ~1.1 s to bind port 8000, and without a gate that gap is a
 * dashboard whose every request fails. Login would report "not signed in" for
 * a backend that simply has not started yet.
 *
 * **Polling /health is the primary signal, not the Tauri event.** It is the
 * one mechanism that works identically in the packaged app and in `npm run
 * dev` against a hand-started backend, so the happy path has a single code
 * path. The desktop events only sharpen the FAILURE case, where Rust knows
 * things the HTTP probe cannot — the exit code, whether port 8000 was already
 * taken, and the backend's own last words.
 *
 * Polling stops the instant it succeeds; it is a bounded readiness probe
 * (typically 2-3 requests), not a loop that keeps running behind the app.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { probeHealth } from "../hooks/useApi";
import {
  EV_CLOSING, EV_EXITED, ExitInfo, isDesktop, onDesktopEvent,
  openLogsFolderNative, shellState, startBackend,
} from "../lib/desktop";

const POLL_MS = 400;
/** Long enough for a cold start behind an antivirus scan; short enough that a
 *  backend which will never come up does not hold the operator forever. */
const GIVE_UP_MS = 45_000;

type Phase = "starting" | "ready" | "failed";

export default function StartupGate({ children }: { children: React.ReactNode }) {
  const [phase, setPhase] = useState<Phase>("starting");
  const [detail, setDetail] = useState<string>("");
  const [tail, setTail] = useState<string>("");
  const [showTail, setShowTail] = useState(false);
  const [closing, setClosing] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const attempt = useRef(0);

  const runProbe = useCallback(() => {
    attempt.current += 1;
    const mine = attempt.current;
    const started = Date.now();
    setPhase("starting");
    setDetail("");
    setTail("");
    setElapsed(0);

    let timer: number | undefined;
    const tick = async () => {
      if (mine !== attempt.current) return;
      if (await probeHealth()) {
        if (mine === attempt.current) setPhase("ready");
        return;
      }
      const waited = Date.now() - started;
      setElapsed(Math.floor(waited / 1000));
      if (waited > GIVE_UP_MS) {
        const s = await shellState();
        if (mine !== attempt.current) return;
        setDetail(
          s?.error ??
            "The backend did not start within 45 seconds.\n\n" +
              "If this keeps happening, the activity log folder has the details.",
        );
        setTail(s?.tail ?? "");
        setPhase("failed");
        return;
      }
      timer = window.setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => runProbe(), [runProbe]);

  // The desktop shell knows WHY it died; the probe only knows that it did.
  useEffect(
    () =>
      onDesktopEvent<ExitInfo>(EV_EXITED, info => {
        attempt.current += 1; // stop the in-flight probe
        setDetail(
          info.port_busy
            ? "Port 8000 is already in use, so the backend refused to start.\n\n" +
              "Another copy of NWA Testing Software may still be running. " +
              "Close it and press Retry."
            : `The backend stopped unexpectedly (exit code ${info.code ?? "unknown"}).`,
        );
        setTail(info.tail);
        setPhase("failed");
      }),
    [],
  );

  // Window close is intercepted while the backend is still up, because the
  // shutdown is what commands the motor down. Say so rather than appearing hung.
  useEffect(() => onDesktopEvent(EV_CLOSING, () => setClosing(true)), []);

  const retry = async () => {
    setPhase("starting");
    const err = await startBackend();
    if (err) {
      setDetail(err);
      setPhase("failed");
      return;
    }
    runProbe();
  };

  if (closing) {
    return (
      <div className="boot-shell">
        <div className="boot-card">
          <div className="boot-spinner" />
          <h1 className="boot-title">Shutting down safely</h1>
          <p className="boot-sub">
            Commanding the throttle to minimum and closing the serial port.
            This window will close on its own.
          </p>
        </div>
      </div>
    );
  }

  if (phase === "ready") return <>{children}</>;

  if (phase === "starting") {
    return (
      <div className="boot-shell">
        <div className="boot-card">
          <div className="boot-spinner" />
          <h1 className="boot-title">Starting up</h1>
          <p className="boot-sub">
            {elapsed < 5
              ? "Starting the measurement backend…"
              : `Still starting — ${elapsed}s. A first run after an update can take longer.`}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="boot-shell">
      <div className="boot-card boot-card-failed">
        <h1 className="boot-title boot-title-failed">Could not start</h1>
        <p className="boot-detail">{detail}</p>

        <div className="boot-actions">
          <button className="btn btn-connect" onClick={() => void retry()}>
            RETRY
          </button>
          {isDesktop() && (
            <button className="btn" onClick={() => void openLogsFolderNative()}>
              OPEN LOGS FOLDER
            </button>
          )}
          {tail && (
            <button className="btn" onClick={() => setShowTail(v => !v)}>
              {showTail ? "HIDE DETAILS" : "SHOW DETAILS"}
            </button>
          )}
        </div>

        {showTail && tail && <pre className="boot-tail">{tail}</pre>}
      </div>
    </div>
  );
}
