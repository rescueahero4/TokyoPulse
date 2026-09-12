"""
ingest/common.py — shared helpers for all four ingestors (A2 scope).

Owns: env loading (via python-dotenv, NEVER hardcoded secrets/URLs), the frozen
Event shape (contracts/event.schema.json), CSV join-key loaders for
contracts/lines.csv and contracts/wards.csv, logging, and a simple backoff helper.

Never hardcodes a URL, key, or password — every feed URL and credential is read
from the root .env at runtime. The only "hardcoded" strings here are join-key
tables derived from contracts/*.csv content (read, not guessed) and the
ODPT .json-trap workaround (contracts/feeds.json explicitly documents the trap;
defending against it is normalization logic, not a secret).
"""

from __future__ import annotations

import csv
import hashlib
import logging
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

try:
    from dotenv import load_dotenv
except ImportError:  # pragma: no cover - true inside a --push sandbox, which
    # only ever runs the pure normalize() path (no env/secrets needed there;
    # fetch+env live on the host). Never hard-fail an import over this.
    def load_dotenv(*_a, **_k):
        return False

# ── paths ────────────────────────────────────────────────────────────────────
ROOT = Path(__file__).resolve().parents[1]  # TokyoPulse/
INGEST_DIR = ROOT / "ingest"
STATE_DIR = INGEST_DIR / "state"
CONTRACTS_DIR = ROOT / "contracts"

try:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
except OSError:
    pass  # read-only / restricted sandbox fs -- normalize-only path doesn't need it

# Load .env once. Never write it, never print its values.
load_dotenv(ROOT / ".env")

JST = timezone(timedelta(hours=9))


def get_env(name: str, default: Optional[str] = None) -> Optional[str]:
    val = os.environ.get(name, default)
    if val is None:
        return default
    # Some optional .env rows are "KEY=   # trailing comment" with nothing
    # before the '#'. python-dotenv does not strip that here, so the raw
    # value we'd otherwise see is the comment text itself. Treat a value
    # that is empty, or starts with '#' once stripped, as unset.
    stripped = val.strip()
    if stripped == "" or stripped.startswith("#"):
        return default
    return val


def get_env_int(name: str, default: int) -> int:
    raw = get_env(name)
    try:
        return int(raw) if raw else default
    except (TypeError, ValueError):
        return default


# ── time helpers — everything ISO8601 with +09:00, never naive ─────────────
def now_jst() -> datetime:
    return datetime.now(JST)


def now_jst_iso() -> str:
    return now_jst().isoformat()


def to_jst_iso(dt: datetime) -> str:
    """Attach/convert to Asia/Tokyo offset and render ISO8601."""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=JST)
    else:
        dt = dt.astimezone(JST)
    return dt.isoformat()


# ── logging ──────────────────────────────────────────────────────────────────
_LOGGERS: dict[str, logging.Logger] = {}


def get_logger(name: str) -> logging.Logger:
    if name in _LOGGERS:
        return _LOGGERS[name]
    logger = logging.getLogger(name)
    if not logger.handlers:
        handler = logging.StreamHandler(sys.stdout)
        handler.setFormatter(
            logging.Formatter("%(asctime)s %(levelname)s [%(name)s] %(message)s")
        )
        logger.addHandler(handler)
        logger.setLevel(logging.INFO)
        logger.propagate = False
    _LOGGERS[name] = logger
    return logger


# ── backoff (no unbounded retry storms) ─────────────────────────────────────
def backoff_delay(attempt: int, base: float = 2.0, cap: float = 60.0) -> float:
    """Exponential backoff, capped. attempt is 0-based consecutive-failure count."""
    return min(cap, base * (2**attempt))


# ── stable id hashing ────────────────────────────────────────────────────────
def stable_hash(text: str, n: int = 8) -> str:
    return hashlib.sha1(text.encode("utf-8")).hexdigest()[:n]


# ── the frozen Event shape (contracts/event.schema.json) ───────────────────
EVENT_TYPES = {"quake", "train", "warning", "weather"}
EVENT_SEVERITIES = {"info", "warning", "critical"}
EVENT_SOURCES = {"odpt", "p2pquake", "jma", "open-meteo", "mock", "replay", "jreast"}


def make_event(
    *,
    id: str,
    type: str,
    severity: str,
    time: str,
    title: str,
    source: str,
    lat: Optional[float] = None,
    lon: Optional[float] = None,
    titleJa: Optional[str] = None,
    affects: Optional[list[str]] = None,
    url: Optional[str] = None,
    magnitude: Optional[float] = None,
    maxScale: Optional[float] = None,
) -> dict[str, Any]:
    """Build an Event dict with EXACTLY the fields in event.schema.json
    (additionalProperties:false) — never add extra keys here."""
    assert type in EVENT_TYPES, f"bad event type {type!r}"
    assert severity in EVENT_SEVERITIES, f"bad severity {severity!r}"
    assert source in EVENT_SOURCES, f"bad source {source!r}"
    return {
        "id": id,
        "type": type,
        "severity": severity,
        "time": time,
        "lat": lat,
        "lon": lon,
        "title": title,
        "titleJa": titleJa,
        "affects": affects or [],
        "source": source,
        "url": url,
        "magnitude": magnitude,
        "maxScale": maxScale,
    }


# ── join keys from contracts/ (READ-ONLY) ───────────────────────────────────
def load_lines_csv() -> list[dict[str, str]]:
    path = CONTRACTS_DIR / "lines.csv"
    with open(path, encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def odpt_railway_to_line_id() -> dict[str, str]:
    """contracts/lines.csv odptRailway column -> our lineId. This is A2's join key."""
    mapping: dict[str, str] = {}
    for row in load_lines_csv():
        rail = (row.get("odptRailway") or "").strip()
        if rail:
            mapping[rail] = row["lineId"]
    return mapping


def line_id_to_name() -> dict[str, dict[str, str]]:
    out: dict[str, dict[str, str]] = {}
    for row in load_lines_csv():
        out[row["lineId"]] = {"name": row["name"], "nameJa": row["nameJa"]}
    return out


def load_wards_csv() -> list[dict[str, str]]:
    path = CONTRACTS_DIR / "wards.csv"
    with open(path, encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


# JMA's bosai warning JSON only carries numeric area codes (no names, no CSV
# join key is provided in contracts/ for this). The 7-digit "class15" city
# codes used for the 23 special wards follow the standard JIS X0402 municipal
# code (5 digits) + "00" suffix, in the same Chiyoda->Edogawa order as
# contracts/wards.csv. Best-effort join; unmapped codes degrade to affects:[].
_WARD_ORDER = [
    "Chiyoda", "Chuo", "Minato", "Shinjuku", "Bunkyo", "Taito", "Sumida",
    "Koto", "Shinagawa", "Meguro", "Ota", "Setagaya", "Shibuya", "Nakano",
    "Suginami", "Toshima", "Kita", "Arakawa", "Itabashi", "Nerima",
    "Adachi", "Katsushika", "Edogawa",
]
JMA_AREA_CODE_TO_WARD: dict[str, str] = {
    f"131{str(i + 1).zfill(2)}00": ward for i, ward in enumerate(_WARD_ORDER)
}


def jma_code_to_ward(code: str) -> Optional[str]:
    return JMA_AREA_CODE_TO_WARD.get(code)
