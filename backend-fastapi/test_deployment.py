"""
test_deployment.py -- [NEW v14] the packaging contracts, checked by reading
the other side of each one.

Stage 8 introduced a second cross-file contract as unforgiving as the
firmware/backend one: the Rust shell in src-tauri/ drives this backend over
stdout markers, exit codes, a runtime file and two HTTP endpoints. Nothing
about a mismatch is loud. Change READY_MARKER in one place and the app sits on
"Starting up..." until it times out; change the runtime file's location and
graceful shutdown silently degrades to a kill, which is the case that leaves a
motor spinning.

So, like test_protocol.py reads constants straight out of the .ino, this reads
them straight out of backend.rs and tauri.conf.json.

    python test_deployment.py

Exits non-zero on failure. Hardware is not involved; the live-process section
is skipped with a notice when the frozen binary has not been built yet.
"""

import json
import os
import re
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import app_paths
import version

_failures = []


def check(name, cond, detail=""):
    if cond:
        print(f"  PASS  {name}")
    else:
        print(f"  FAIL  {name} {detail}")
        _failures.append(name)


HERE = Path(__file__).resolve().parent
REPO = HERE.parent
TAURI = REPO / "src-tauri"
BACKEND_RS = TAURI / "src" / "backend.rs"
TAURI_CONF = TAURI / "tauri.conf.json"
ROOT_PKG = REPO / "package.json"
FRONT_PKG = REPO / "frontend-react" / "package.json"


def rust_const(name: str) -> str:
    """Pull a `const NAME: &str = "value";` out of backend.rs."""
    m = re.search(rf'const\s+{name}\s*:\s*&str\s*=\s*"([^"]*)"', BACKEND_RS.read_text())
    return m.group(1) if m else ""


def rust_int(name: str) -> int:
    m = re.search(rf"const\s+{name}\s*:\s*\w+\s*=\s*(\d+)", BACKEND_RS.read_text())
    return int(m.group(1)) if m else -1


print("-- Version agreement -------------------------------")
# The updater compares the version baked into the binary against the published
# release. Drift here is invisible: too low nags forever, too high never
# updates, and neither raises anything anywhere.
conf = json.loads(TAURI_CONF.read_text())
check("tauri.conf.json matches version.py",
      conf.get("version") == version.APP_VERSION,
      f"conf={conf.get('version')} py={version.APP_VERSION}")
check("root package.json matches version.py",
      json.loads(ROOT_PKG.read_text()).get("version") == version.APP_VERSION)
check("frontend package.json matches version.py",
      json.loads(FRONT_PKG.read_text()).get("version") == version.APP_VERSION)
check("version is a plain x.y.z (the git tag is this with a leading v)",
      bool(re.fullmatch(r"\d+\.\d+\.\d+", version.APP_VERSION)),
      version.APP_VERSION)

print("\n-- Updater configuration ---------------------------")
upd = conf.get("plugins", {}).get("updater", {})
check("an update endpoint is configured", bool(upd.get("endpoints")))
pubkey = upd.get("pubkey", "")
check("a real signing pubkey is set, not the placeholder",
      bool(pubkey) and "PLACEHOLDER" not in pubkey)
check("the endpoint points at a GitHub release asset",
      any("github.com" in e and e.endswith(".json") for e in upd.get("endpoints", [])))
# Without this Tauri builds the installer but signs nothing, so every installed
# copy rejects the update it just downloaded. Nothing about it looks wrong at
# build time.
check("createUpdaterArtifacts is on, or nothing gets signed",
      conf.get("bundle", {}).get("createUpdaterArtifacts") in (True, "v1Compatible"))

print("\n-- Bundle configuration ----------------------------")
bundle = conf.get("bundle", {})
check("the backend is bundled as a resource",
      any("nwa-backend" in str(k) for k in (bundle.get("resources") or {})))
icons = bundle.get("icon", [])
check("an .ico is registered for Windows", any(str(i).endswith(".ico") for i in icons))
for rel in icons:
    check(f"icon exists: {rel}", (TAURI / rel).is_file())

print("\n-- Rust/Python contract ----------------------------")
# Each of these is read out of backend.rs rather than restated, so the test
# fails when the two sides drift instead of when someone remembers to update it.
import run_backend

check("READY_MARKER agrees",
      rust_const("READY_MARKER") == run_backend.READY_MARKER,
      f"rust={rust_const('READY_MARKER')!r} py={run_backend.READY_MARKER!r}")
check("EXIT_PORT_BUSY agrees",
      rust_int("EXIT_PORT_BUSY") == run_backend.EXIT_PORT_BUSY,
      f"rust={rust_int('EXIT_PORT_BUSY')} py={run_backend.EXIT_PORT_BUSY}")

import main as backend_main

check("HEALTH_SIGNATURE agrees",
      rust_const("HEALTH_SIGNATURE") == backend_main.HEALTH_SIGNATURE,
      f"rust={rust_const('HEALTH_SIGNATURE')!r} py={backend_main.HEALTH_SIGNATURE!r}")
check("the shell's default port is the one the frontend hardcodes",
      rust_int("PORT") == run_backend.DEFAULT_PORT == 8000,
      f"rust={rust_int('PORT')} py={run_backend.DEFAULT_PORT}")

rs = BACKEND_RS.read_text()
rt = app_paths.runtime_file()
check("the runtime file's folder name matches app_paths",
      f'"{app_paths.APP_NAME}"' in rs, app_paths.APP_NAME)
check("the runtime file's name matches app_paths",
      f'"{rt.name}"' in rs, rt.name)
check("the runtime file is NOT under Documents (a web page must not read it, "
      "and the operator opens Documents by hand)",
      app_paths.app_root() not in rt.parents)

print("\n-- The frozen binary ships no test module ----------")
spec = (HERE / "backend.spec").read_text()
tests = sorted(p.stem for p in HERE.glob("test_*.py"))
for t in tests:
    check(f"{t} is excluded from the bundle", f'"{t}"' in spec)
entry = (HERE / "run_backend.py").read_text()
check("run_backend.py imports no test module",
      not re.search(r"^\s*(import|from)\s+test_", entry, re.M))

print("\n-- Frozen backend lifecycle ------------------------")
exe = HERE / "dist" / "nwa-backend" / ("nwa-backend.exe" if os.name == "nt" else "nwa-backend")
if not exe.is_file():
    print(f"  SKIP  not built yet ({exe}) — run: npm run backend:build")
else:
    def free_port() -> int:
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            return s.getsockname()[1]

    def get(url, method="GET"):
        req = urllib.request.Request(url, method=method)
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                return r.status, r.read().decode()
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode()

    port = free_port()
    proc = subprocess.Popen(
        [str(exe), "--port", str(port)],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
    )
    ready = False
    deadline = time.time() + 45
    while time.time() < deadline:
        line = proc.stdout.readline()
        if not line:
            break
        if line.strip() == run_backend.READY_MARKER:
            ready = True
            break
    check("the frozen binary prints the ready marker", ready)

    if ready:
        status, body = get(f"http://127.0.0.1:{port}/health")
        check("/health answers 200", status == 200, str(status))
        health = json.loads(body) if status == 200 else {}
        check("/health carries the identity signature",
              health.get("app") == backend_main.HEALTH_SIGNATURE)
        check("/health reports the frozen build as frozen", health.get("frozen") is True)
        check("/health reports the shipped version",
              health.get("version") == version.APP_VERSION)

        rt_path = app_paths.runtime_file()
        info = json.loads(rt_path.read_text()) if rt_path.is_file() else {}
        check("the runtime file exists while running", bool(info))
        check("the runtime file names the right port", info.get("port") == port)
        check("the runtime file carries a token", len(info.get("token", "")) >= 16)

        # The gate that stops a stray web page from ending a running test.
        status, _ = get(f"http://127.0.0.1:{port}/shutdown?token=wrong", "POST")
        check("/shutdown refuses a bad token", status == 403, str(status))
        check("the process is still alive after a refused shutdown",
              proc.poll() is None)

        status, _ = get(
            f"http://127.0.0.1:{port}/shutdown?token={info.get('token')}", "POST"
        )
        check("/shutdown accepts the runtime token", status == 200, str(status))
        try:
            code = proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            proc.kill()
            code = None
        check("the backend exits after a graceful shutdown", code == 0, str(code))
        check("the runtime file is removed on exit", not rt_path.is_file())

        # A second instance must be distinguishable from a crash, or the shell
        # cannot offer the right recovery.
        blocker = subprocess.Popen(
            [str(exe), "--port", str(port)],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
        )
        for _ in range(450):
            line = blocker.stdout.readline()
            if not line or line.strip() == run_backend.READY_MARKER:
                break
        second = subprocess.run(
            [str(exe), "--port", str(port)],
            capture_output=True, text=True, timeout=60,
        )
        check("a busy port exits with EXIT_PORT_BUSY, not a generic failure",
              second.returncode == run_backend.EXIT_PORT_BUSY,
              f"got {second.returncode}")
        info = json.loads(app_paths.runtime_file().read_text())
        get(f"http://127.0.0.1:{port}/shutdown?token={info['token']}", "POST")
        try:
            blocker.wait(timeout=15)
        except subprocess.TimeoutExpired:
            blocker.kill()
    else:
        proc.kill()

print("\n--------------------------------------------------------")
if _failures:
    print(f"{len(_failures)} FAILED: {', '.join(_failures)}")
    sys.exit(1)
print("All deployment contract checks passed.")
