"""
ingest/sink.py — the one place every feed writes through.

Write order every cycle:
  1. ALWAYS persist normalized events to ingest/state/events-<feed>.json
     (merged by id) — this is the proof-of-normalization record and the
     durable fallback while Neo4j is unreachable. Nothing is ever lost here.
  2. THEN try to upsert into Neo4j:
       a. `from api.graph import upsert_events` (A3's function) if it exists.
       b. else fall back to a minimal driver-based MERGE with identical
          semantics (idempotent on Event.id, plus :AFFECTS edges to
          Line/Ward nodes parsed from `affects`).
  Neo4j failures never raise past this module — the caller's loop keeps going.
"""

from __future__ import annotations

import json
import sys
import threading
from pathlib import Path
from typing import Any, Callable, Optional

from .common import ROOT, STATE_DIR, get_env, get_logger, now_jst_iso

log = get_logger("ingest.sink")

_resolve_lock = threading.Lock()
_upsert_fn: Optional[Callable[[list[dict[str, Any]]], int]] = None
_upsert_path: Optional[str] = None

_driver_lock = threading.Lock()
_driver = None


def _resolve_upsert() -> tuple[Callable[[list[dict[str, Any]]], int], str]:
    """Import A3's api.graph.upsert_events if available; else use the local
    fallback. Resolved once, cached — never blocks waiting for A3 (either the
    import succeeds right now or it doesn't; we don't retry the import)."""
    global _upsert_fn, _upsert_path
    with _resolve_lock:
        if _upsert_fn is not None:
            return _upsert_fn, _upsert_path  # type: ignore[return-value]
        try:
            sys.path.insert(0, str(ROOT))
            from api.graph import upsert_events as fn  # type: ignore

            _upsert_fn, _upsert_path = fn, "api.graph.upsert_events"
            log.info("sink: using A3's api.graph.upsert_events")
        except Exception as e:  # ImportError or anything else in a half-written module
            log.info(
                "sink: api.graph.upsert_events unavailable (%s) -- using fallback driver upsert",
                e,
            )
            _upsert_fn, _upsert_path = (
                _fallback_upsert_events,
                "ingest.sink._fallback_upsert_events",
            )
        return _upsert_fn, _upsert_path  # type: ignore[return-value]


def _get_driver():
    global _driver
    with _driver_lock:
        if _driver is None:
            from neo4j import GraphDatabase  # local import: keep optional at module load

            uri = get_env("NEO4J_URI")
            user = get_env("NEO4J_USERNAME")
            pwd = get_env("NEO4J_PASSWORD")
            if not uri or not user or not pwd:
                raise RuntimeError("NEO4J_URI/NEO4J_USERNAME/NEO4J_PASSWORD not set in .env")
            _driver = GraphDatabase.driver(uri, auth=(user, pwd))
        return _driver


_FALLBACK_CYPHER = """
UNWIND $events AS ev
MERGE (e:Event {id: ev.id})
SET e.type = ev.type,
    e.severity = ev.severity,
    e.time = ev.time,
    e.lat = ev.lat,
    e.lon = ev.lon,
    e.title = ev.title,
    e.titleJa = ev.titleJa,
    e.source = ev.source,
    e.url = ev.url,
    e.magnitude = ev.magnitude,
    e.maxScale = ev.maxScale
WITH e, ev
UNWIND (CASE WHEN ev.affects IS NULL OR size(ev.affects) = 0 THEN [null] ELSE ev.affects END) AS ref
FOREACH (_ IN CASE WHEN ref IS NOT NULL AND ref STARTS WITH 'line:' THEN [1] ELSE [] END |
    MERGE (l:Line {lineId: substring(ref, 5)})
    MERGE (e)-[:AFFECTS]->(l)
)
FOREACH (_ IN CASE WHEN ref IS NOT NULL AND ref STARTS WITH 'ward:' THEN [1] ELSE [] END |
    MERGE (w:Ward {name: substring(ref, 5)})
    MERGE (e)-[:AFFECTS]->(w)
)
RETURN count(DISTINCT e) AS n
"""


def _fallback_upsert_events(events: list[dict[str, Any]]) -> int:
    """Minimal driver-based upsert with the semantics A3's upsert_events is
    supposed to have: idempotent MERGE on Event.id + :AFFECTS edges."""
    if not events:
        return 0
    driver = _get_driver()
    database = get_env("NEO4J_DATABASE", "neo4j")
    with driver.session(database=database) as session:
        rec = session.run(_FALLBACK_CYPHER, events=events).single()
        return int(rec["n"]) if rec else 0


def write_state_file(feed: str, events: list[dict[str, Any]]) -> Path:
    """Merge-write normalized events into ingest/state/events-<feed>.json,
    keyed by id, so re-polling never duplicates and nothing is lost while
    Neo4j is unreachable."""
    path = STATE_DIR / f"events-{feed}.json"
    existing: dict[str, Any] = {}
    if path.exists():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            for ev in data.get("events", []):
                existing[ev["id"]] = ev
        except Exception as e:
            log.warning("state file %s unreadable (%s); starting fresh", path, e)
            existing = {}
    for ev in events:
        existing[ev["id"]] = ev
    out = {
        "feed": feed,
        "updatedAt": now_jst_iso(),
        "count": len(existing),
        "events": sorted(existing.values(), key=lambda e: e.get("time", ""), reverse=True),
    }
    path.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


def upsert(feed: str, events: list[dict[str, Any]]) -> dict[str, Any]:
    """The one call every ingestor makes each cycle. Always durable (state
    file); best-effort live (Neo4j)."""
    state_path = write_state_file(feed, events)
    if not events:
        return {"written": 0, "neo4j_ok": True, "path": str(state_path), "upsert_path": None}
    fn, upsert_path = _resolve_upsert()
    try:
        n = fn(events)
        return {
            "written": int(n) if n is not None else len(events),
            "neo4j_ok": True,
            "path": str(state_path),
            "upsert_path": upsert_path,
        }
    except Exception as e:
        log.warning("neo4j upsert failed via %s: %s", upsert_path, e)
        return {
            "written": 0,
            "neo4j_ok": False,
            "error": str(e),
            "path": str(state_path),
            "upsert_path": upsert_path,
        }
