/**
 * UpdateManager — the 3-day update check and its prompt.
 *
 * Four rules this component exists to enforce, each of which is a real hazard
 * or a real annoyance if it lapses:
 *
 * 1. **Never while connected to the Arduino.** Installing restarts the
 *    application, and a restart mid-test orphans a spinning motor — the
 *    firmware has no serial-loss failsafe to catch it. This is the same
 *    reasoning as the sign-out gate, and it is checked again at the moment
 *    the operator clicks INSTALL, not only when the prompt was raised.
 * 2. **Never install without being asked.** The prompt is the decision point;
 *    declining leaves a fully working application.
 * 3. **Never nag twice for the same version.** A declined version is recorded
 *    and stays quiet until a newer one appears.
 * 4. **Every outcome reaches the activity log**, because "it stopped updating"
 *    is reported weeks later, by someone at another desk.
 *
 * The check cadence and the update source are both configuration, not code:
 * CHECK_INTERVAL_MS here, and `plugins.updater.endpoints` in tauri.conf.json.
 *
 * In a browser (`npm run dev`) this renders nothing at all.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { api } from "../hooks/useApi";
import { isDesktop } from "../lib/desktop";
import { useOptionalConnection } from "../context/connection";

/** Every 3 days, per the deployment spec. */
const CHECK_INTERVAL_MS = 3 * 24 * 60 * 60 * 1000;
/** How often to re-evaluate whether a check is due. Not a check itself. */
const REEVALUATE_MS = 60 * 60 * 1000;

const LS_LAST_CHECK = "nwa.update.lastCheck";
const LS_DISMISSED = "nwa.update.dismissed";

type Stage = "idle" | "prompt" | "downloading" | "installed" | "error";

function logUpdate(event: string, detail: string) {
  void api.logActivity(`UPDATE_${event}`, detail).catch(() => {});
}

function readNumber(key: string): number {
  const v = Number(localStorage.getItem(key));
  return Number.isFinite(v) ? v : 0;
}

export default function UpdateManager() {
  const conn = useOptionalConnection();
  const connected = !!conn?.connected;

  const [stage, setStage] = useState<Stage>("idle");
  const [update, setUpdate] = useState<Update | null>(null);
  const [message, setMessage] = useState("");
  const [progress, setProgress] = useState(0);
  const busy = useRef(false);

  const runCheck = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      logUpdate("CHECK", "checking for updates");
      const found = await check();
      localStorage.setItem(LS_LAST_CHECK, String(Date.now()));

      if (!found) {
        // Rule: up to date means no notification and no user action at all.
        logUpdate("NONE", "already up to date");
        return;
      }
      if (localStorage.getItem(LS_DISMISSED) === found.version) {
        logUpdate("SKIPPED", `${found.version} was previously declined`);
        return;
      }
      logUpdate("AVAILABLE", `${found.version}`);
      setUpdate(found);
      setStage("prompt");
    } catch (e) {
      // No internet, GitHub unreachable, a malformed manifest — all land here,
      // and all of them must leave the application running normally. The log
      // gets it; the operator does not, because there is nothing to act on.
      logUpdate("FAILED", `check failed: ${String(e)}`);
    } finally {
      busy.current = false;
    }
  }, []);

  useEffect(() => {
    if (!isDesktop()) return;

    const maybeCheck = () => {
      // Deferred rather than skipped: the next tick tries again, so an update
      // found during a long bench session is offered once the operator
      // disconnects.
      if (connected || busy.current || stage !== "idle") return;
      if (Date.now() - readNumber(LS_LAST_CHECK) < CHECK_INTERVAL_MS) return;
      void runCheck();
    };

    maybeCheck();
    const id = window.setInterval(maybeCheck, REEVALUATE_MS);
    return () => window.clearInterval(id);
  }, [connected, stage, runCheck]);

  const install = async () => {
    if (!update) return;
    // Re-checked here, not just when the prompt appeared: the operator may
    // have connected in between.
    if (connected) {
      setMessage("Disconnect from the Arduino before installing an update.");
      return;
    }
    setStage("downloading");
    setProgress(0);
    logUpdate("ACCEPTED", `${update.version}`);
    try {
      let total = 0;
      let got = 0;
      await update.downloadAndInstall(ev => {
        if (ev.event === "Started") total = ev.data.contentLength ?? 0;
        else if (ev.event === "Progress") {
          got += ev.data.chunkLength;
          if (total > 0) setProgress(Math.min(100, Math.round((got / total) * 100)));
        }
      });
      logUpdate("INSTALLED", `${update.version} — restarting`);
      setStage("installed");
      await relaunch();
    } catch (e) {
      logUpdate("FAILED", `install failed: ${String(e)}`);
      setMessage(
        "The update could not be downloaded or installed. " +
          "The current version is unaffected and you can carry on working.",
      );
      setStage("error");
    }
  };

  const decline = () => {
    if (update) {
      localStorage.setItem(LS_DISMISSED, update.version);
      logUpdate("DECLINED", `${update.version}`);
    }
    setStage("idle");
    setUpdate(null);
  };

  if (!isDesktop() || stage === "idle") return null;

  return (
    <div className="info-overlay">
      <div className="info-modal update-modal">
        <div className="info-head">
          <h2 className="info-title">
            {stage === "error" ? "Update failed" : "Update available"}
          </h2>
          {stage === "prompt" && (
            <button className="info-close" onClick={decline} aria-label="Close">
              ×
            </button>
          )}
        </div>

        <div className="update-body">
          {stage === "prompt" && update && (
            <>
              <p className="update-line">
                Version <strong>{update.version}</strong> is available. You are
                running {update.currentVersion}.
              </p>
              {update.body && <pre className="update-notes">{update.body}</pre>}
              <p className="update-note">
                Installing restarts the application. Your motor configurations,
                test data and logs are not affected.
              </p>
              {connected && (
                <p className="update-warn">
                  ⚠ Disconnect from the Arduino before installing.
                </p>
              )}
              {message && <p className="update-warn">⚠ {message}</p>}
            </>
          )}

          {stage === "downloading" && (
            <>
              <p className="update-line">Downloading update…</p>
              <div className="update-bar">
                <div className="update-bar-fill" style={{ width: `${progress}%` }} />
              </div>
              <p className="update-note">{progress}%</p>
            </>
          )}

          {stage === "installed" && (
            <p className="update-line">Installed. Restarting…</p>
          )}

          {stage === "error" && <p className="update-warn">⚠ {message}</p>}
        </div>

        {stage === "prompt" && (
          <div className="mc-del-actions">
            <button className="btn" type="button" onClick={decline}>
              NOT NOW
            </button>
            <button
              className="btn btn-connect"
              type="button"
              onClick={() => void install()}
              disabled={connected}
            >
              INSTALL AND RESTART
            </button>
          </div>
        )}

        {stage === "error" && (
          <div className="mc-del-actions">
            <button className="btn" type="button" onClick={() => setStage("idle")}>
              CONTINUE
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
