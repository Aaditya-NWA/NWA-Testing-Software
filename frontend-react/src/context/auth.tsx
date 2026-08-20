// ── Login and role-based access [NEW v13] ────────────────────────────────────
//
// Three local accounts ship with the application (see backend auth.py).
// Roles are expressed as TAB permissions, and the same table drives both the
// tab bar and the backend's endpoint gates, so the two cannot drift apart.
//
// **The UI restriction is a convenience; the backend is the gate.** Hiding a
// tab stops the wrong button being pressed, which is the failure mode that
// actually happens here. It does not stop anything determined, and it is not
// described to users as if it did — the backend refuses out-of-role calls
// independently, because a second browser tab reaches the same port.
//
// The session token lives in memory only, never in localStorage. Persisting
// it would mean a session survives an application restart with nobody
// sitting at it — and in an application that can spin a motor, an
// authenticated session nobody is attending is exactly what we do not want.

import React, {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from "react";
import { api, setAuthToken } from "../hooks/useApi";

export type TabId = "control" | "motor_config" | "analyses" | "correction_mass";

/** One order, for every role. A restricted role sees a SUBSET in this same
 *  order — the order never changes per role, only which tabs are present. */
export const TAB_ORDER: TabId[] = [
  "control",
  "motor_config",
  "analyses",
  "correction_mass",
];

export const TAB_LABEL: Record<TabId, string> = {
  control:         "CONTROL",
  motor_config:    "CONFIGURE NEW MOTOR",
  analyses:        "ANALYSES",
  correction_mass: "CORRECTION MASS VALIDATION",
};

export interface SessionInfo {
  username: string;
  role: string;
  session_key: string;
  tabs: TabId[];
}

interface AuthState {
  session: SessionInfo | null;
  busy: boolean;
  error: string | null;
  login: (username: string, password: string) => Promise<boolean>;
  logout: () => Promise<string | null>;
  /** Tabs this role may see, in TAB_ORDER. Empty when signed out. */
  tabs: TabId[];
  may: (tab: TabId) => boolean;
}

const Ctx = createContext<AuthState | null>(null);

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth must be used inside <AuthProvider>");
  return v;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const login = useCallback(async (username: string, password: string) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.login(username, password);
      if (r.status !== "ok" || !r.token) {
        setError(r.message || "Incorrect username or password.");
        return false;
      }
      setAuthToken(r.token);
      setSession({
        username: r.username,
        role: r.role,
        session_key: r.session_key,
        tabs: r.tabs,
      });
      return true;
    } catch {
      setError("Could not reach the backend. Is the application still starting?");
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  const logout = useCallback(async (): Promise<string | null> => {
    setBusy(true);
    try {
      const r = await api.logout();
      if (r.status !== "ok") return r.message || "Could not sign out.";
      setAuthToken(null);
      setSession(null);
      return null;
    } catch {
      setAuthToken(null);
      setSession(null);
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  const tabs = useMemo<TabId[]>(
    () => (session ? TAB_ORDER.filter(t => session.tabs.includes(t)) : []),
    [session]
  );

  const may = useCallback((tab: TabId) => tabs.includes(tab), [tabs]);

  const value = useMemo(
    () => ({ session, busy, error, login, logout, tabs, may }),
    [session, busy, error, login, logout, tabs, may]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function SignOutDialog({
  username, role, sessionKey, busy, onCancel, onConfirm,
}: {
  username: string;
  role: string;
  sessionKey: string;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [acked, setAcked] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className="info-overlay" onClick={onCancel}>
      <div className="info-modal signout-modal" onClick={e => e.stopPropagation()}
        role="dialog" aria-modal="true">
        <div className="info-head">
          <h2 className="info-title">Sign out</h2>
          <button className="info-close" onClick={onCancel} aria-label="Close">×</button>
        </div>

        <div className="signout-body">
          <p className="signout-text">
            You are signed in as <b>{username}</b> ({role}).
            Session <b>{sessionKey}</b> will end.
          </p>
          <p className="signout-note">
            The Arduino is already disconnected — signing out will not change
            anything on the bench. Any CSV log you opened has been closed.
          </p>

          <label className="signout-check">
            <input type="checkbox" checked={acked}
              onChange={e => setAcked(e.target.checked)} disabled={busy} />
            <span>I want to end this session and sign out.</span>
          </label>
        </div>

        <div className="mc-del-actions">
          <button className="btn" type="button" onClick={onCancel} disabled={busy}>
            CANCEL
          </button>
          <button className="btn btn-stop-log" type="button"
            onClick={onConfirm} disabled={!acked || busy}>
            {busy ? "SIGNING OUT…" : "SIGN OUT"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Login screen ─────────────────────────────────────────────────────────────
export function LoginScreen({ logoSrc }: { logoSrc?: string }) {
  const { login, busy, error } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const userRef = useRef<HTMLInputElement>(null);

  useEffect(() => { userRef.current?.focus(); }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password || busy) return;
    await login(username.trim(), password);
  };

  return (
    <div className="login-shell">
      <form className="login-card" onSubmit={submit}>
        {logoSrc && <img className="login-logo" src={logoSrc} alt="" />}
        <h1 className="login-title">NWA Testing Software</h1>
        <p className="login-sub">Sign in to continue</p>

        <label className="field-label">USERNAME</label>
        <input
          ref={userRef}
          className="login-input"
          value={username}
          onChange={e => setUsername(e.target.value)}
          autoComplete="username"
          spellCheck={false}
          disabled={busy}
        />

        <label className="field-label" style={{ marginTop: 10 }}>PASSWORD</label>
        <input
          className="login-input"
          type="password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          autoComplete="current-password"
          disabled={busy}
        />

        {error && <div className="login-error">⚠ {error}</div>}

        <button
          className="btn btn-connect login-btn"
          type="submit"
          disabled={busy || !username.trim() || !password}
        >
          {busy ? "SIGNING IN…" : "SIGN IN"}
        </button>
      </form>
    </div>
  );
}
