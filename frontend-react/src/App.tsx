/**
 * Application shell: authentication, role-based tab access, and the universal
 * connection bar.
 *
 * Three layers, in this order. AuthProvider is outermost because everything
 * below needs a token, including the module-level motor-profile store. Nothing
 * mounts until someone is signed in. ConnectionProvider wraps only roles that
 * HAVE a hardware tab — an Analysis user gets none, because polling /ports and
 * /status for a role the backend refuses produces meaningless 403s.
 *
 * Tabs are addressed by id, never by number: the order changed in v13 and
 * anything keyed to a position would silently point at the wrong tab.
 */
import { useEffect, useState } from "react";
import { api } from "./hooks/useApi";
import {
  AuthProvider, LoginScreen, SignOutDialog, useAuth, TabId, TAB_LABEL,
} from "./context/auth";
import {
  ConnectionProvider, useOptionalConnection,
} from "./context/connection";
import ConnectionBar from "./components/ConnectionBar";
import InfoPanel, { InfoButton } from "./components/InfoPanel";
import ControlTab from "./tabs/ControlTab";
import MotorConfigTab from "./tabs/MotorConfigTab";
import AnalysesTab from "./tabs/AnalysesTab";
import CorrectionMassTab from "./tabs/CorrectionMassTab";
import logoUrl from "./assets/logo.png";
import "./App.css";

export default function App() {
  return (
    <AuthProvider>
      <AppAuthGate />
    </AuthProvider>
  );
}

function AppAuthGate() {
  const { session } = useAuth();
  if (!session) return <LoginScreen logoSrc={logoUrl} />;

  const hardware = session.tabs.includes("control") || session.tabs.includes("motor_config");
  return hardware
    ? <ConnectionProvider><Dashboard /></ConnectionProvider>
    : <Dashboard />;
}

function Dashboard() {
  const { session, tabs, logout, busy } = useAuth();
  const conn = useOptionalConnection();

  const [activeTab, setActiveTab] = useState<TabId>(tabs[0] ?? "control");
  const [infoOpen, setInfoOpen] = useState(false);
  const [signOutOpen, setSignOutOpen] = useState(false);
  const [logoutMsg, setLogoutMsg] = useState<string | null>(null);

  // A role change cannot strand the user on a tab they may no longer see.
  useEffect(() => {
    if (!tabs.includes(activeTab)) setActiveTab(tabs[0] ?? "control");
  }, [tabs, activeTab]);

  const switchTab = (t: TabId) => {
    setActiveTab(t);
    void api.logActivity("TAB", `-> ${t}`).catch(() => {});
  };

  const openInfo = () => {
    setInfoOpen(true);
    void api.logActivity("INFO_PANEL", activeTab).catch(() => {});
  };

  const connected = !!conn?.connected;
  const handleLogout = async () => {
    setLogoutMsg(null);
    const err = await logout();
    if (err) {
      setLogoutMsg(err);
      setSignOutOpen(false);
    }
  };

  const [uiFullscreen, setUiFullscreen] = useState(false);

  useEffect(() => {
    const onChange = () => setUiFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      setUiFullscreen(f => !f);
    }
  };

  return (
    <div className={`app${uiFullscreen ? " app-fs" : ""}`}>
      <header className="header">
        <div className="header-brand">
          <img className="brand-logo" src={logoUrl} alt="" />
          <span className="brand-name">NWA <span>Testing Software</span></span>
        </div>
        <nav className="tab-nav">
          {tabs.map(t => (
            <button
              key={t}
              className={`tab-btn ${activeTab === t ? "tab-btn-active" : ""}`}
              onClick={() => switchTab(t)}
            >
              {TAB_LABEL[t]}
            </button>
          ))}

          <InfoButton onClick={openInfo} />

          {/* [NEW v10] Sits after the tabs, but applies to the whole app —
              it is available on every tab, not just Analyses. */}
          <button
            className={`fs-btn ${uiFullscreen ? "fs-btn-active" : ""}`}
            onClick={toggleFullscreen}
            title={uiFullscreen ? "Exit full screen (Esc)" : "Full screen"}
            aria-label={uiFullscreen ? "Exit full screen" : "Enter full screen"}
          >
            {uiFullscreen ? "⤡" : "⛶"}
          </button>
        </nav>

        <div className="header-user">
          <span className="hu-name">{session!.username}</span>
          <span className="hu-role">{session!.role}</span>
          <span className="hu-key" title="Session key — quote this when reporting a problem">
            {session!.session_key}
          </span>
          <button
            className="hu-logs"
            onClick={() => void api.openLogsFolder().catch(() => {})}
            title="Open the activity log folder"
          >
            LOGS
          </button>
          <button
            className="hu-logout"
            onClick={() => setSignOutOpen(true)}
            disabled={connected}
            title={connected
              ? "Disconnect from the Arduino before signing out"
              : "Sign out"}
          >
            SIGN OUT
          </button>
        </div>
      </header>

      {logoutMsg && <div className="logout-msg">⚠ {logoutMsg}</div>}

      {/* One connection for the whole application. Rendered above the tabs
          rather than inside one, which is the entire point of v13's
          universal connect. Absent for roles with no hardware tab. */}
      {conn && <ConnectionBar />}

      {activeTab === "control"         && <ControlTab />}
      {activeTab === "motor_config"    && <MotorConfigTab />}
      {activeTab === "analyses"        && <AnalysesTab fullscreen={uiFullscreen} />}
      {activeTab === "correction_mass" && <CorrectionMassTab />}

      {infoOpen && (
        <InfoPanel
          tab={activeTab}
          sessionKey={session!.session_key}
          onClose={() => setInfoOpen(false)}
        />
      )}

      {signOutOpen && (
        <SignOutDialog
          username={session!.username}
          role={session!.role}
          sessionKey={session!.session_key}
          busy={busy}
          onCancel={() => setSignOutOpen(false)}
          onConfirm={handleLogout}
        />
      )}
    </div>
  );
}