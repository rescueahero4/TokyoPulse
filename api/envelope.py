"""TokyoPulse — the universal `meta` envelope and the three-tier resolver.

THE single most important architectural rule of this API (contracts/api.md):
**never fail to serve a payload, and never return 500 for a data-path problem.**

Resolution order, applied uniformly by `three_tier()`:
  1. Neo4j           -> meta.source = "live"
  2. mock/<file>     -> meta.source = "cache", degraded = true, honest note
  3. empty-but-valid -> meta.source = "mock",  degraded = true

`@safe_endpoint` is the belt to that braces: if a handler raises for ANY reason
(a bug, a bad query param, a missing file), the client still gets a 200 with a
valid empty payload of the right shape instead of a blanked layer.
"""

from __future__ import annotations

import functools
import json
import logging
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

log = logging.getLogger("tokyopulse.api")

JST = timezone(timedelta(hours=9))
ROOT = Path(__file__).resolve().parents[1]
MOCK_DIR = ROOT / "mock"
CONTRACTS_DIR = ROOT / "contracts"


def env_str(name: str, default: str = "") -> str:
    """Read an env var, tolerating `.env` inline comments.

    `.env` here is heavily commented (`NOSANA_BASE_URL=   # e.g. https://...`),
    and python-dotenv keeps that text as the value. Without this, an "empty"
    var reads as a comment string and a provider looks configured when it isn't.
    """
    import re
    raw = os.getenv(name)
    if raw is None:
        return default
    v = raw.strip()
    if v.startswith("#"):
        return default
    v = re.split(r"\s+#", v, maxsplit=1)[0].strip()
    return v or default


def now_jst() -> datetime:
    return datetime.now(JST)


def now_iso() -> str:
    return now_jst().isoformat(timespec="seconds")


def meta(source: str, degraded: bool = False, note: str | None = None) -> dict[str, Any]:
    """The universal envelope. EVERY response carries one of these."""
    return {
        "source": source,
        "generatedAt": now_iso(),
        "degraded": bool(degraded),
        "note": (note[:200] if isinstance(note, str) and note else None),
    }


class NoLiveData(Exception):
    """Raised by a tier-1 callable that reached the source but found nothing."""


def read_mock(relpath: str) -> Any | None:
    """Read mock/<relpath>. Returns None if missing or malformed (never raises)."""
    p = MOCK_DIR / relpath
    try:
        if not p.is_file():
            log.warning("mock file missing: %s", p)
            return None
        with p.open("r", encoding="utf-8") as fh:
            return json.load(fh)
    except Exception as exc:
        log.warning("mock file unreadable (%s): %s", p, exc)
        return None


def three_tier(live: Callable[[], Any | None],
               cache: Callable[[], Any | None],
               empty: Callable[[], dict[str, Any]],
               label: str = "payload") -> dict[str, Any]:
    """Resolve a payload live -> cache -> empty and stamp `meta`. Never raises."""
    note: str | None = None

    try:
        payload = live()
        if payload:
            payload["meta"] = meta("live")
            return payload
        note = "graph returned no rows"
    except NoLiveData as exc:
        note = str(exc) or "no live data"
    except Exception as exc:
        note = f"{type(exc).__name__}: {str(exc).splitlines()[0][:110]}"
        log.warning("[%s] tier-1 (neo4j) failed: %s", label, note)

    cache_note = "mock file missing or malformed"
    try:
        payload = cache()
        if payload:
            payload["meta"] = meta("cache", True, f"{note}; serving cached mock payload")
            return payload
    except Exception as exc:
        cache_note = f"cache read failed: {type(exc).__name__}"
        log.warning("[%s] tier-2 (mock) failed: %s", label, exc)

    log.warning("[%s] tier-3: serving empty payload (%s / %s)", label, note, cache_note)
    payload = empty()
    payload["meta"] = meta("mock", True, f"{note}; {cache_note}")
    return payload


def safe_endpoint(empty_factory: Callable[[], dict[str, Any]], label: str = "endpoint"):
    """Decorator: a handler can never 500 on a data path.

    HTTPException (e.g. the documented 404 on an unknown lineId) passes through —
    that is a genuine client error, the one legitimate non-200.
    """
    def deco(fn):
        @functools.wraps(fn)
        async def wrapper(*args, **kwargs):
            try:
                return await fn(*args, **kwargs)
            except Exception as exc:
                from fastapi import HTTPException
                if isinstance(exc, HTTPException):
                    raise
                log.exception("[%s] handler raised — serving empty payload", label)
                payload = empty_factory()
                payload["meta"] = meta("mock", True,
                                       f"handler error: {type(exc).__name__}")
                return payload
        return wrapper
    return deco


# ───────────────────────── frozen static contract data ───────────────────────

_csv_cache: dict[str, list[dict[str, str]]] = {}


def read_contract_csv(name: str) -> list[dict[str, str]]:
    """Read contracts/<name>.csv (cached). contracts/ is read-only to us."""
    if name in _csv_cache:
        return _csv_cache[name]
    import csv
    rows: list[dict[str, str]] = []
    p = CONTRACTS_DIR / name
    try:
        with p.open("r", encoding="utf-8-sig", newline="") as fh:
            rows = [dict(r) for r in csv.DictReader(fh)]
    except Exception as exc:
        log.error("cannot read contract csv %s: %s", p, exc)
        rows = []
    _csv_cache[name] = rows
    return rows


def lines_csv() -> list[dict[str, str]]:
    """All 20 lines, in contract order. Drives /lines.geojson and /impact 404s."""
    return read_contract_csv("lines.csv")


def wards_csv() -> list[dict[str, str]]:
    return read_contract_csv("wards.csv")
