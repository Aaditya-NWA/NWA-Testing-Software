"""run_backend.py — the frozen backend's entry point.

[NEW v14] `uvicorn main:app` is a dev-time command line; a PyInstaller binary
needs a real __main__, so this is it. It is the ONLY module PyInstaller is
pointed at, which is also why backend.spec's hiddenimports list exists: every
import reachable from here is found automatically, and uvicorn's protocol
implementations are not reachable from here — they are resolved from strings
at runtime.

Three things this file owns that main.py cannot:

1. **The ready marker.** The shell must know when port 8000 is actually
   listening, and the honest moment for that is inside uvicorn's own startup,
   not a fixed sleep. Printing it lets the shell wait on an event instead of
   polling.
2. **The runtime file.** PID, port and shutdown token, written where a web
   page cannot read them (app_paths.runtime_file()). This is what lets a
   second instance find an orphaned backend and stop it *gracefully* — which
   matters, because a graceful stop is the one that writes THR_MIN.
3. **A distinct exit code for a busy port** (EXIT_PORT_BUSY). "Address already
   in use" and "the backend crashed" need opposite recovery paths, and a bare
   exit 1 cannot tell the shell which happened.

Protocol/loop implementations are named EXPLICITLY in the uvicorn Config
rather than left as "auto". Auto-detection picks a different implementation
depending on what happens to be importable, so the frozen binary would
otherwise be able to behave differently from the dev server.
"""
import argparse
import atexit
import json
import os
import secrets
import socket
import sys
from pathlib import Path

import uvicorn

import app_paths
import version

DEFAULT_PORT = 8000
DEFAULT_HOST = "127.0.0.1"

READY_MARKER = "NWA_BACKEND_READY"

EXIT_OK = 0
EXIT_PORT_BUSY = 3


def _port_is_free(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind((host, port))
        except OSError:
            return False
    return True


def _write_runtime_file(port: int, token: str) -> Path:
    path = app_paths.runtime_file()
    payload = {
        "pid": os.getpid(),
        "port": port,
        "token": token,
        "version": version.APP_VERSION,
    }
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    tmp.replace(path)   # atomic: a half-written file would read as a bad token
    return path


def _remove_runtime_file(path: Path) -> None:
    try:
        path.unlink()
    except OSError:
        pass


class _Server(uvicorn.Server):
    """Emits the ready marker at the only moment it is true."""

    async def startup(self, sockets=None):
        await super().startup(sockets=sockets)
        print(READY_MARKER, flush=True)


def main() -> int:
    ap = argparse.ArgumentParser(prog="nwa-backend")
    ap.add_argument("--host", default=DEFAULT_HOST)
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--version", action="store_true")
    args = ap.parse_args()

    if args.version:
        print(version.APP_VERSION)
        return EXIT_OK

    if not _port_is_free(args.host, args.port):
        print(
            f"[backend] port {args.port} is already in use — refusing to start",
            flush=True,
        )
        return EXIT_PORT_BUSY

    # Set before main is imported: /shutdown reads this to gate itself, and a
    # missing token is how the dev server (`uvicorn main:app`) opts out.
    token = os.environ.get("NWA_SHUTDOWN_TOKEN") or secrets.token_hex(16)
    os.environ["NWA_SHUTDOWN_TOKEN"] = token

    import main as backend_app

    runtime_path = _write_runtime_file(args.port, token)
    atexit.register(_remove_runtime_file, runtime_path)

    config = uvicorn.Config(
        backend_app.app,
        host=args.host,
        port=args.port,
        log_level="info",
        loop="asyncio",
        http="h11",
        ws="websockets",
        lifespan="on",
        access_log=False,
    )
    server = _Server(config)
    backend_app.SERVER = server   # what /shutdown flips should_exit on

    try:
        server.run()
    finally:
        _remove_runtime_file(runtime_path)
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
