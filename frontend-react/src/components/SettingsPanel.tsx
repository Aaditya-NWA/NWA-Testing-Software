/**
 * SettingsPanel — the application-level settings dialog.
 *
 * Tabbed so that adding a second settings area is an entry in SETTINGS_TABS
 * rather than a rebuild. Today there is one: Updates.
 *
 * **Updates are checked only when the operator asks.** [CHANGED v14] There is
 * no timer and no background check. That is a deliberate consequence of how
 * releases are published here: the repository is private most of the time and
 * made public only for the window in which an update is being handed out. A
 * background check against a private repository would 404 on every run, so the
 * only honest moment to check is one the operator chose.
 *
 * What that costs, recorded so it is a choice and not a surprise: an operator
 * who never opens this dialog never updates. With three users who are told
 * directly that a release exists, that is acceptable; it would not be at any
 * larger number.
 *
 * Two rules survive from the automatic version and must not be dropped:
 *
 * 1. **Never install while connected to the Arduino.** Installing restarts the
 *    application, and a restart mid-test orphans a spinning motor — the
 *    firmware has no serial-loss failsafe. Re-checked at the moment UPDATE NOW
 *    is clicked, not only when the update was found.
 * 2. **Every outcome reaches the activity log**, because "it stopped updating"
 *    is reported weeks later, by someone at another desk.
 *
 * In a browser (`npm run dev`) the Updates tab says so rather than failing.
 */
import { useEffect, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { api, probeHealth } from "../hooks/useApi";
import { isDesktop } from "../lib/desktop";
import { useOptionalConnection } from "../context/connection";

type SettingsTabId = "updates";

const SETTINGS_TABS: { id: SettingsTabId; label: string }[] = [
  { id: "updates", label: "Updates" },
];

type Stage =
  | "idle"
  | "checking"
  | "none"
  | "available"
  | "downloading"
  | "installing"
  | "error";

function logUpdate(event: string, detail: string) {
  void api.logActivity(`UPDATE_${event}`, detail).catch(() => {});
}

function formatMB(bytes: number | undefined): string | null {
  if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return null;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Title and size ride in latest.json as fields Tauri itself ignores.
 *
 *  Verified against tauri-plugin-updater 2.x: `InnerRemoteRelease` is a plain
 *  derived Deserialize with no deny_unknown_fields, and `raw_json` is the whole
 *  parsed response handed to the frontend untouched. So the release workflow can
 *  add anything here without risking the updater's own parsing. */
function readExtra(u: Update): { title: string | null; size: number | null } {
  const raw = (u.rawJson ?? {}) as Record<string, unknown>;
  const title = typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : null;
  const size = typeof raw.size === "number" ? raw.size : null;
  return { title, size };
}

export default function SettingsPanel({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<SettingsTabId>("updates");

  return (
    <div className="info-overlay" onClick={onClose}>
      <div
        className="info-modal settings-modal"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="info-head">
          <h2 className="info-title">Settings</h2>
          <button className="info-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="settings-tabs">
          {SETTINGS_TABS.map(t => (
            <button
              key={t.id}
              className={`settings-tab ${tab === t.id ? "settings-tab-active" : ""}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="settings-body">
          {tab === "updates" && <UpdatesTab />}
        </div>
      </div>
    </div>
  );
}

function UpdatesTab() {
  const conn = useOptionalConnection();
  const connected = !!conn?.connected;

  const [stage, setStage] = useState<Stage>("idle");
  const [update, setUpdate] = useState<Update | null>(null);
  const [message, setMessage] = useState("");
  const [received, setReceived] = useState(0);
  const [total, setTotal] = useState<number | null>(null);
  const [installed, setInstalled] = useState<string | null>(null);

  // The backend's /health is the single source of truth for the version
  // (version.py). Reading it here avoids a fifth file for the version string
  // to drift out of step with.
  useEffect(() => {
    void probeHealth().then(h => setInstalled(h?.version ?? null));
  }, []);

  const runCheck = async () => {
    setStage("checking");
    setMessage("");
    logUpdate("CHECK", "manual check requested");
    try {
      const found = await check();
      if (!found) {
        logUpdate("NONE", "already up to date");
        setStage("none");
        return;
      }
      logUpdate("AVAILABLE", found.version);
      setUpdate(found);
      setTotal(readExtra(found).size);
      setStage("available");
    } catch (e) {
      // No internet, GitHub unreachable, or — the normal case here — the
      // repository is private again, so latest.json 404s. None of these are
      // distinguishable from the app's side and none are worth alarming the
      // operator about, so they read as "nothing to install".
      logUpdate("FAILED", `check failed: ${String(e)}`);
      setMessage("Could not reach the update server.");
      setStage("none");
    }
  };

  const install = async () => {
    if (!update) return;
    // Re-checked here, not only when the update was found: the operator may
    // have connected in between, and installing restarts the application.
    if (connected) {
      setMessage("Disconnect from the Arduino before installing an update.");
      return;
    }
    setStage("downloading");
    setReceived(0);
    setMessage("");
    logUpdate("ACCEPTED", update.version);
    try {
      let got = 0;
      await update.download(ev => {
        if (ev.event === "Started") {
          if (ev.data.contentLength) setTotal(ev.data.contentLength);
        } else if (ev.event === "Progress") {
          got += ev.data.chunkLength;
          setReceived(got);
        }
      });
      setStage("installing");
      await update.install();
      logUpdate("INSTALLED", `${update.version} — restarting`);
      await relaunch();
    } catch (e) {
      logUpdate("FAILED", `install failed: ${String(e)}`);
      setMessage(
        "The update could not be downloaded or installed. This version is " +
          "unaffected and you can carry on working.",
      );
      setStage("error");
    }
  };

  if (!isDesktop()) {
    return (
      <div className="set-section">
        <p className="set-note">
          Updates are only available in the installed desktop application. This
          is the development build running in a browser.
        </p>
      </div>
    );
  }

  const pct = total && total > 0
    ? Math.min(100, Math.round((received / total) * 100))
    : null;
  const extra = update ? readExtra(update) : { title: null, size: null };
  const title = extra.title ?? update?.body?.split("\n")[0]?.trim() ?? null;

  return (
    <div className="set-section">
      <div className="set-row">
        <span className="set-label">Installed version</span>
        <span className="set-value">{installed ?? "—"}</span>
      </div>

      {(stage === "idle" || stage === "none") && (
        <>
          <button
            className="btn btn-connect set-check"
            onClick={() => void runCheck()}
          >
            CHECK FOR UPDATES
          </button>
          {stage === "none" && (
            <p className="set-none">No Updates Available.</p>
          )}
          {stage === "none" && message && (
            <p className="set-note">{message}</p>
          )}
        </>
      )}

      {stage === "checking" && (
        <div className="set-checking">
          <div className="boot-spinner set-spinner" />
          <span>Checking for updates…</span>
        </div>
      )}

      {stage === "available" && update && (
        <div className="set-update">
          <div className="set-up-head">
            <span className="set-up-title">{title ?? `Version ${update.version}`}</span>
            <span className="set-up-ver">
              {update.currentVersion} → {update.version}
              {formatMB(extra.size ?? undefined) && ` · ${formatMB(extra.size ?? undefined)}`}
            </span>
          </div>

          {update.body && title !== update.body.trim() && (
            <pre className="set-up-notes">{update.body}</pre>
          )}

          <p className="set-note">
            Installing restarts the application. Your motor configurations, test
            data and logs are not affected.
          </p>

          {connected && (
            <p className="set-warn">
              ⚠ Disconnect from the Arduino before installing.
            </p>
          )}
          {message && <p className="set-warn">⚠ {message}</p>}

          <button
            className="btn btn-connect set-check"
            onClick={() => void install()}
            disabled={connected}
          >
            UPDATE NOW
          </button>
        </div>
      )}

      {(stage === "downloading" || stage === "installing") && (
        <div className="set-update">
          <p className="set-value">
            {stage === "installing" ? "Installing…" : "Downloading update…"}
          </p>
          <div className="update-bar">
            <div
              className={`update-bar-fill${pct === null ? " update-bar-indet" : ""}`}
              style={pct === null ? undefined : { width: `${pct}%` }}
            />
          </div>
          <p className="set-note">
            {stage === "installing"
              ? "The application will restart on its own."
              : pct === null
                ? formatMB(received) ?? "Starting…"
                : `${pct}% · ${formatMB(received)} of ${formatMB(total ?? undefined)}`}
          </p>
        </div>
      )}

      {stage === "error" && (
        <div className="set-update">
          <p className="set-warn">⚠ {message}</p>
          <button className="btn set-check" onClick={() => setStage("idle")}>
            BACK
          </button>
        </div>
      )}
    </div>
  );
}
