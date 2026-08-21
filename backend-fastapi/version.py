"""version.py — the application version, in one place.

[NEW v14] Three files have to agree on this string or the updater misbehaves
in ways that look like nothing at all:

    backend-fastapi/version.py   ← this file, the source of truth
    src-tauri/tauri.conf.json    ← what the updater compares against a release
    frontend-react/package.json  ← what the About/info panels display

The Tauri updater asks GitHub for the latest release and compares it to the
version baked into the installed binary. If tauri.conf.json says 0.1.0 while
the release is tagged v1.0.0, every install nags forever; if it says 9.9.9,
no update is ever offered. Neither state raises an error anywhere.

`test_deployment.py` reads all three and fails when they drift.
The git tag is this string with a leading "v".
"""

APP_VERSION = "1.0.0"
