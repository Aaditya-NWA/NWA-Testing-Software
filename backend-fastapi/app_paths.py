"""app_paths.py — where NWA Testing Software keeps its persistent data.

[NEW v13] One module resolves every persistent path, because there are now
three of them (motor configurations, CSVs, activity logs) and they have to
agree on a single root that survives a reinstall.

Everything lives under the user's Documents folder:

    Documents/NWA Testing Software/
      ├── Motor Configuration/    motor configurations JSON
      ├── CSVs/                   test data CSV logs (+ DBG Logs/)
      └── Logs/                   activity-YYYY-MM-DD.txt

Documents rather than %APPDATA% deliberately: the operator has to be able to
reach the CSVs by hand to analyse them, and %APPDATA% is hidden by default.

**Why `sys.executable` and not just `__file__`.** Once PyInstaller freezes
this backend, `__file__` points inside the temporary extraction directory,
which is read-only in spirit and deleted on exit — data written there would
silently vanish between runs. `sys.frozen` tells us which world we are in.

The APP_NAME is version-free on purpose. The Tauri updater upgrades in
place, so a versioned folder name would orphan every motor configuration,
CSV and log on the next release.
"""

import os
import sys
from pathlib import Path

APP_NAME = "NWA Testing Software"


def _documents_dir() -> Path:
    """The user's Documents folder, with fallbacks that never raise.

    Windows users can relocate Documents (OneDrive does it by default), and
    the registry is the only place that records where it went. USERPROFILE
    is the fallback; a plain home directory is the last resort so this can
    still be imported on a non-Windows machine for the test scripts.
    """
    if sys.platform == "win32":
        try:
            import winreg
            key = r"Software\Microsoft\Windows\CurrentVersion\Explorer\Shell Folders"
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key) as k:
                personal, _ = winreg.QueryValueEx(k, "Personal")
            p = Path(os.path.expandvars(personal))
            if p.parent.exists():
                return p
        except Exception:
            pass
        profile = os.environ.get("USERPROFILE")
        if profile:
            return Path(profile) / "Documents"
    return Path.home() / "Documents"


def is_frozen() -> bool:
    return bool(getattr(sys, "frozen", False))


def app_root() -> Path:
    """Documents/NWA Testing Software — created on first use."""
    root = _documents_dir() / APP_NAME
    root.mkdir(parents=True, exist_ok=True)
    return root


def _sub(name: str) -> Path:
    d = app_root() / name
    d.mkdir(parents=True, exist_ok=True)
    return d


def motor_config_dir() -> Path:
    return _sub("Motor Configuration")


def csv_dir() -> Path:
    return _sub("CSVs")


def logs_dir() -> Path:
    return _sub("Logs")


def runtime_file() -> Path:
    """Where a running backend advertises its PID, port and shutdown token.

    [NEW v14] Deliberately NOT under Documents: this is machine-local runtime
    state with a lifetime of one run, and the operator opens the Documents
    folder by hand to fetch CSVs. It also must not be readable by a web page,
    which is what lets the shutdown token gate /shutdown — see main.py.
    """
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA") or os.environ.get("TEMP") or "."
        d = Path(base) / APP_NAME
    else:
        d = Path.home() / ".cache" / APP_NAME
    d.mkdir(parents=True, exist_ok=True)
    return d / "runtime.json"


def bundle_dir() -> Path:
    """Where the code itself lives — read-only once frozen.

    For files that SHIP with the application rather than being written by
    it. Never write persistent user data here.
    """
    if is_frozen():
        return Path(sys.executable).parent
    return Path(__file__).parent
