# NWA Testing Software

A motor / ESC test bench. An Arduino Uno drives the ESC and reads an LSM6DSO
IMU plus a pulse-per-rev RPM sensor; a FastAPI backend owns the serial link,
logs CSV and streams telemetry over WebSocket; a React dashboard drives the
motor and does post-test balancing and vibration analysis.

```
Arduino/            firmware (flashed by hand from the Arduino IDE)
backend-fastapi/    FastAPI backend — serial, logging, auth   (port 8000)
frontend-react/     React + Vite dashboard                    (port 3000)
src-tauri/          desktop shell — bundles the two into one Windows app
```

## Requirements

- Python 3.11
- Node.js 18+
- Arduino Uno with `nwa_testing_software.ino` already flashed
  (needs the `Servo`, `Wire` and `SparkFunLSM6DSO` libraries)
- To build the desktop app as well: Rust, and MSVC C++ build tools

## Setup

### Backend

```powershell
cd backend-fastapi
python -m venv venv
.\venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --reload
```

Runs on <http://localhost:8000>.

> **Use the venv — don't run the backend from your global Python.** If that
> Python also has Streamlit installed, the backend dies at import time with
> `TypeError: Router.__init__() got an unexpected keyword argument 'on_startup'`.
> The two need incompatible versions of `starlette` and no single environment
> can satisfy both.

### Frontend

In a second terminal:

```powershell
cd frontend-react
npm install
npm run dev
```

Open <http://localhost:3000>. Both servers need to be running.

### Signing in

Three accounts are created on first run. All share the password `role@123`.

| Username | Sees |
|---|---|
| `admin` | all four tabs |
| `tester` | Control, Configure New Motor |
| `analysis` | Analyses, Correction Mass Validation |

Then plug in the Arduino, pick the COM port in the connection bar at the top,
and connect. Give it a few seconds — opening the port resets the board and it
spends ~8.5 s arming the ESC before it responds.

## Where your data goes

```
Documents/NWA Testing Software/
  ├── Motor Configuration/    saved motor configurations
  ├── CSVs/                   test logs
  ├── Logs/                   activity-YYYY-MM-DD.txt
  └── users.json
```
