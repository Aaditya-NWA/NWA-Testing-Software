"""auth.py — local accounts, roles, and what each role may reach.

[NEW v13] Three accounts ship with the application and are identical on all
three machines. There is no auth server, no central directory, and therefore
no network dependency and no offline-login problem.

    admin     Admin      all four tabs
    tester    Tester     Control, Configure New Motor
    analysis  Analysis   Analyses, Correction Mass Validation

**Hashed, not encrypted.** Encryption is reversible and implies a key
shipping alongside the data, which would be no protection at all. Nothing
ever needs to recover these passwords, so nothing here can: PBKDF2-HMAC-
SHA256 with a per-user salt, from the standard library — no new dependency
to freeze into the PyInstaller bundle.

**What this does and does not defend against.** The backend is a localhost
sidecar on the operator's own machine, so anyone with the machine can reach
the API directly no matter what the UI shows, and the shipped passwords are
predictable from the usernames. This is not a secret and must not be
described as one. What role enforcement genuinely buys — and the reason it
lives on the backend rather than in the UI alone — is that it stops
accidental misuse, out-of-role automation, and a second browser tab reaching
past the interface. Those are the real failure modes at this scale.

**Why permissions are expressed as tabs.** The UI restriction and the API
restriction then derive from one table (ROLE_TABS) instead of drifting
apart, and adding a role later is one entry rather than an audit of every
endpoint.
"""

import hashlib
import json
import os
import secrets
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Dict, List, Optional

import app_paths

TAB_CONTROL         = "control"
TAB_MOTOR_CONFIG    = "motor_config"
TAB_ANALYSES        = "analyses"
TAB_CORRECTION_MASS = "correction_mass"

TAB_ORDER: List[str] = [
    TAB_CONTROL,
    TAB_MOTOR_CONFIG,
    TAB_ANALYSES,
    TAB_CORRECTION_MASS,
]

ROLE_TABS: Dict[str, List[str]] = {
    "Admin":    [TAB_CONTROL, TAB_MOTOR_CONFIG, TAB_ANALYSES, TAB_CORRECTION_MASS],
    "Tester":   [TAB_CONTROL, TAB_MOTOR_CONFIG],
    "Analysis": [TAB_ANALYSES, TAB_CORRECTION_MASS],
}

# The two tabs that talk to the Arduino. Every hardware endpoint requires one
# of them, so "can this user drive a motor" is answered in one place.
HARDWARE_TABS = (TAB_CONTROL, TAB_MOTOR_CONFIG)

# ── Password hashing ─────────────────────────────────────────────────────────
_PBKDF2_ROUNDS = 240_000
_SALT_BYTES = 16


def hash_password(password: str, salt: Optional[bytes] = None) -> str:
    """`pbkdf2$<rounds>$<salt_hex>$<hash_hex>` — self-describing, so the
    rounds can be raised later without invalidating existing entries."""
    if salt is None:
        salt = os.urandom(_SALT_BYTES)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, _PBKDF2_ROUNDS)
    return f"pbkdf2${_PBKDF2_ROUNDS}${salt.hex()}${dk.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        scheme, rounds, salt_hex, hash_hex = stored.split("$")
        if scheme != "pbkdf2":
            return False
        dk = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), bytes.fromhex(salt_hex), int(rounds)
        )
        # Constant-time: a timing difference here would leak how much of the
        # hash matched, which is the one thing a local attacker could measure.
        return secrets.compare_digest(dk.hex(), hash_hex)
    except Exception:
        return False


_DEFAULT_USERS = [
    ("admin",    "admin@123",    "Admin"),
    ("tester",   "tester@123",   "Tester"),
    ("analysis", "analysis@123", "Analysis"),
]

_store_lock = threading.Lock()


def store_path():
    return app_paths.app_root() / "users.json"


def _seed() -> dict:
    return {
        "version": 1,
        "users": [
            {
                "username": u,
                "role": r,
                "password": hash_password(p),
                "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            }
            for u, p, r in _DEFAULT_USERS
        ],
    }


def load_users() -> List[dict]:
    """Read the store, seeding or repairing it if needed.

    A corrupt or truncated file is replaced rather than raised on: being
    unable to log in at all is a worse failure than losing a file whose
    entire contents are reproducible from the defaults above.
    """
    path = store_path()
    with _store_lock:
        data = None
        if path.exists():
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except Exception:
                data = None
        if not isinstance(data, dict) or not isinstance(data.get("users"), list) or not data["users"]:
            data = _seed()
            try:
                path.write_text(json.dumps(data, indent=2), encoding="utf-8")
            except Exception:
                pass
        return data["users"]


def find_user(username: str) -> Optional[dict]:
    uname = (username or "").strip().lower()
    for u in load_users():
        if u.get("username", "").lower() == uname:
            return u
    return None


# ── Sessions ─────────────────────────────────────────────────────────────────
@dataclass
class Session:
    token: str
    key: str          # the quotable session key ID, e.g. S-7F3A9C21
    username: str
    role: str
    started_at: str

    @property
    def tabs(self) -> List[str]:
        return ROLE_TABS.get(self.role, [])

    def may(self, tab: str) -> bool:
        return tab in self.tabs

    def may_any(self, tabs) -> bool:
        return any(t in self.tabs for t in tabs)

    def public(self) -> dict:
        return {
            "username": self.username,
            "role": self.role,
            "session_key": self.key,
            "tabs": self.tabs,
            "started_at": self.started_at,
        }


_sessions: Dict[str, Session] = {}
_sessions_lock = threading.Lock()


def _new_session_key() -> str:
    """Short enough to read over a phone. Uppercase hex avoids the
    l/1/O/0 confusion that bites when someone reads it aloud."""
    return "S-" + secrets.token_hex(4).upper()


def login(username: str, password: str) -> Optional[Session]:
    user = find_user(username)
    if user is None:
        return None
    if not verify_password(password or "", user.get("password", "")):
        return None
    s = Session(
        token=secrets.token_urlsafe(32),
        key=_new_session_key(),
        username=user["username"],
        role=user.get("role", "Tester"),
        started_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
    )
    with _sessions_lock:
        _sessions[s.token] = s
    return s


def logout(token: str) -> Optional[Session]:
    with _sessions_lock:
        return _sessions.pop(token, None)


def session_for(token: Optional[str]) -> Optional[Session]:
    if not token:
        return None
    with _sessions_lock:
        return _sessions.get(token)


def active_sessions() -> List[Session]:
    with _sessions_lock:
        return list(_sessions.values())
