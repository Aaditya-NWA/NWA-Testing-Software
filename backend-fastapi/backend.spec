# backend.spec — PyInstaller recipe for the frozen backend.
#
# Build:  venv\Scripts\python -m PyInstaller backend.spec --noconfirm
# Out:    backend-fastapi/dist/nwa-backend/{nwa-backend.exe, _internal/}
#
# **onedir, not onefile** — measured on this machine, warm cache, 3 runs:
# onedir reaches "listening" in 1.02-1.16 s against onefile's 1.48-1.82 s, and
# onefile re-extracts ~50 MB into %TEMP% on every single launch, which is also
# ~50 MB for antivirus to re-scan every launch. The 32.1 MB vs 17.5 MB on disk
# is the trade, and the installer compresses it away.
#
# The whole output folder ships as a Tauri *resource*, not an externalBin:
# externalBin copies one file, and onedir is a file PLUS its _internal folder,
# which the bootloader resolves relative to the exe. See src-tauri/src/backend.rs.
#
# **hiddenimports is load-bearing.** uvicorn resolves its loop, HTTP, WebSocket
# and lifespan implementations from STRINGS at runtime (uvicorn.config's
# LOOP_SETUPS / HTTP_PROTOCOLS / WS_PROTOCOLS / LIFESPAN dicts), so PyInstaller's
# import graph cannot see them. Leave one out and the failure is at first
# request, not at build time. run_backend.py names its four explicitly; the rest
# are listed so switching any of them back to "auto" cannot break the binary.

from PyInstaller.building.api import COLLECT, EXE, PYZ
from PyInstaller.building.build_main import Analysis

hiddenimports = [
    # uvicorn, resolved from strings — see the note above
    "uvicorn.logging",
    "uvicorn.loops", "uvicorn.loops.auto", "uvicorn.loops.asyncio",
    "uvicorn.protocols",
    "uvicorn.protocols.http", "uvicorn.protocols.http.auto",
    "uvicorn.protocols.http.h11_impl", "uvicorn.protocols.http.httptools_impl",
    "uvicorn.protocols.websockets", "uvicorn.protocols.websockets.auto",
    "uvicorn.protocols.websockets.websockets_impl",
    "uvicorn.protocols.websockets.wsproto_impl",
    "uvicorn.lifespan", "uvicorn.lifespan.on", "uvicorn.lifespan.off",
    # the websockets implementation uvicorn 0.29 actually reaches for
    "websockets", "websockets.legacy", "websockets.legacy.server",
    # starlette runs on anyio, which selects its backend by name
    "anyio._backends._asyncio",
    # pyserial picks its platform backend at import time
    "serial.tools.list_ports", "serial.win32",
]

a = Analysis(
    ["run_backend.py"],
    pathex=[],
    binaries=[],
    datas=[],
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    # Nothing in the backend imports a test module, and PyInstaller follows
    # imports from run_backend.py only — these are belt-and-braces so a stray
    # import can never put a dev-time script in an operator's install.
    excludes=[
        "test_protocol", "test_ingest", "test_step_test",
        "test_motor_profiles", "test_auth", "test_deployment",
        "tkinter", "unittest", "pydoc", "doctest",
    ],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="nwa-backend",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    # console=True even though the user never sees one: the shell spawns this
    # with CREATE_NO_WINDOW, and a windowed build would leave sys.stdout as
    # None -- taking the ready marker and every DBG_ line with it.
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon="../icons/icon.ico",
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="nwa-backend",
)
