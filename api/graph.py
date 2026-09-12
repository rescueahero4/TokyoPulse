"""TokyoPulse — Neo4j graph layer (owner: A3).

Everything that talks to Neo4j lives here. Connection config comes from `.env`
(`NEO4J_URI`, `NEO4J_USERNAME`, `NEO4J_PASSWORD`, `NEO4J_DATABASE`) via
python-dotenv. Nothing is hardcoded.

Design rules (see contracts/AGENT-BRIEF.md):
  * 3 second connection timeout — a hung driver must never stall an endpoint.
  * A cached liveness probe, so a dead database costs ONE timeout, not one per
    request.
  * Every read helper raises ``GraphUnavailable`` / ``NoGraphData`` instead of
    returning junk, so the API's three-tier resolver can fall back to mock/.

Graph model (frozen — A2 writes into exactly this):
    (:Line   {lineId,name,nameJa,operator,color,status,statusText,statusSource,updatedAt})
    (:Station{stationId,name,nameJa,lat,lon,ridership,ridershipBand,inFloodZone})
    (:Ward   {name,nameJa,lat,lon})
    (:Event  {id,type,severity,time,lat,lon,title,titleJa,source,url,magnitude,maxScale})
    (Line)-[:SERVES {index}]->(Station)
    (Station)-[:IN]->(Ward)
    (Event)-[:AFFECTS]->(Line|Ward)

`Event.time` is stored as a Neo4j **datetime** (never a string).
"""

from __future__ import annotations

import logging
import os
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable, Sequence

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / ".env")

log = logging.getLogger("tokyopulse.graph")

JST = timezone(timedelta(hours=9))

CONNECT_TIMEOUT = 3.0          # hard cap: a dead DB costs 3s, once.
POOL_SIZE = 50                 # one shared pool, never per request
_PROBE_TTL_UP = 10.0
_PROBE_TTL_DOWN = 15.0


class GraphUnavailable(RuntimeError):
    """Neo4j is unreachable / misconfigured / erroring."""


class NoGraphData(RuntimeError):
    """Neo4j answered, but has no rows for this query (tier-1 miss)."""


# ───────────────────────────── driver singleton ──────────────────────────────

_lock = threading.Lock()
_driver = None
_resolved_db: str | None = None          # database name that actually works
_resolved_user: str | None = None
_probe: dict[str, Any] = {"ok": False, "ts": 0.0, "note": "not probed yet"}
# A failed connect is remembered for this long, so a dead database costs ONE
# timeout per window across every endpoint instead of one per request.
_FAIL_TTL = 15.0
_fail: dict[str, Any] = {"until": 0.0, "note": ""}


def _cfg() -> tuple[str, str, str, str | None]:
    uri = (os.getenv("NEO4J_URI") or "").strip()
    user = (os.getenv("NEO4J_USERNAME") or "neo4j").strip()
    pwd = (os.getenv("NEO4J_PASSWORD") or "").strip()
    db = (os.getenv("NEO4J_DATABASE") or "").strip() or None
    return uri, user, pwd, db


def _get_driver():
    """Lazily build (and cache) the driver. Raises GraphUnavailable."""
    global _driver, _resolved_db, _resolved_user
    if _driver is not None:
        return _driver
    if time.monotonic() < _fail["until"]:
        raise GraphUnavailable(_fail["note"] or "neo4j unreachable (cached)")
    with _lock:
        if _driver is not None:
            return _driver
        uri, user, pwd, db = _cfg()
        if not uri:
            _fail.update(until=time.monotonic() + _FAIL_TTL,
                         note="NEO4J_URI is not set in .env")
            raise GraphUnavailable("NEO4J_URI is not set in .env")
        try:
            from neo4j import GraphDatabase
            from neo4j.exceptions import AuthError
        except Exception as exc:                          # pragma: no cover
            raise GraphUnavailable(f"neo4j driver import failed: {exc}") from exc

        attempts: list[tuple[str, str]] = [(user, pwd)]
        if user != "neo4j":
            # Aura gotcha (AGENT-BRIEF): username may be 'neo4j', not instance id.
            attempts.append(("neo4j", pwd))

        last: Exception | None = None
        for u, p in attempts:
            drv = None
            try:
                drv = GraphDatabase.driver(
                    uri,
                    auth=(u, p),
                    connection_timeout=CONNECT_TIMEOUT,
                    connection_acquisition_timeout=CONNECT_TIMEOUT + 1.0,
                    max_transaction_retry_time=4.0,
                    # ONE pool for the whole process. Sized for the API's
                    # threadpool + the prefetch loop + A2's ingestors sharing Aura.
                    max_connection_pool_size=POOL_SIZE,
                    # Routing discovery happens once per driver; keep connections
                    # alive so we never re-pay it on a warm path.
                    max_connection_lifetime=3600,
                    liveness_check_timeout=30,
                )
                drv.verify_connectivity()
                _driver, _resolved_user, _resolved_db = drv, u, db
                _fail.update(until=0.0, note="")
                log.info("neo4j connected uri=%s user=%s db=%s pool=%d "
                         "(single process-wide driver)", uri, u, db, POOL_SIZE)
                return _driver
            except AuthError as exc:      # fast failure — try the next identity
                last = exc
                if drv is not None:
                    try:
                        drv.close()
                    except Exception:
                        pass
                continue
            except Exception as exc:      # timeout / DNS / TLS — do not retry
                last = exc
                if drv is not None:
                    try:
                        drv.close()
                    except Exception:
                        pass
                break
        note = f"{type(last).__name__}: {str(last).splitlines()[0][:110]}"
        _fail.update(until=time.monotonic() + _FAIL_TTL, note=note)
        raise GraphUnavailable(note)


def close() -> None:
    global _driver
    with _lock:
        if _driver is not None:
            try:
                _driver.close()
            finally:
                _driver = None


def run(cypher: str, **params: Any) -> list[dict[str, Any]]:
    """Execute Cypher, return a list of plain dicts. Raises GraphUnavailable."""
    global _resolved_db
    drv = _get_driver()
    try:
        from neo4j.exceptions import ClientError
    except Exception:                                     # pragma: no cover
        ClientError = Exception                           # type: ignore

    def _exec(db: str | None):
        if db:
            recs, _, _ = drv.execute_query(cypher, parameters_=params, database_=db)
        else:
            recs, _, _ = drv.execute_query(cypher, parameters_=params)
        return [dict(r) for r in recs]

    try:
        return _exec(_resolved_db)
    except ClientError as exc:                            # type: ignore[misc]
        code = getattr(exc, "code", "") or ""
        if "DatabaseNotFound" in code and _resolved_db is not None:
            log.warning("database %r not found — falling back to default", _resolved_db)
            _resolved_db = None
            try:
                return _exec(None)
            except Exception as exc2:
                raise GraphUnavailable(f"{type(exc2).__name__}: {str(exc2)[:120]}") from exc2
        raise GraphUnavailable(f"{type(exc).__name__}: {str(exc)[:120]}") from exc
    except GraphUnavailable:
        raise
    except Exception as exc:
        # A broken connection must not poison every later request.
        if "Defunct" in type(exc).__name__ or "ServiceUnavailable" in type(exc).__name__:
            close()
        raise GraphUnavailable(f"{type(exc).__name__}: {str(exc)[:120]}") from exc


def neo4j_status(force: bool = False) -> tuple[bool, str | None]:
    """Cached liveness probe. Returns (up, note). Never raises.

    A dead database is re-probed at most every 15s, so `/health` polling and a
    burst of endpoint hits cost one 3s timeout, not N.
    """
    now = time.monotonic()
    if force:
        _fail.update(until=0.0, note="")      # a forced probe really reconnects
    ttl = _PROBE_TTL_UP if _probe["ok"] else _PROBE_TTL_DOWN
    if not force and (now - _probe["ts"]) < ttl and _probe["ts"] > 0:
        return bool(_probe["ok"]), _probe["note"]
    try:
        run("RETURN 1 AS ok")
        _probe.update(ok=True, ts=now, note=None)
    except Exception as exc:
        _probe.update(ok=False, ts=now, note=str(exc)[:140])
    return bool(_probe["ok"]), _probe["note"]


# ────────────────────────────── value helpers ────────────────────────────────

def to_iso(value: Any) -> str | None:
    """Neo4j DateTime / python datetime / str → ISO8601 with +09:00 offset."""
    if value is None:
        return None
    if isinstance(value, str):
        return value
    native = getattr(value, "to_native", None)
    dt = native() if callable(native) else value
    if isinstance(dt, datetime):
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=JST)
        return dt.astimezone(JST).isoformat()
    return str(value)


def normalise_time(value: Any) -> str | None:
    """Accept anything timestamp-ish, return ISO8601 with an explicit offset."""
    if value is None:
        return None
    if isinstance(value, datetime):
        dt = value if value.tzinfo else value.replace(tzinfo=JST)
        return dt.astimezone(JST).isoformat()
    s = str(value).strip()
    if not s:
        return None
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=JST)
    return dt.astimezone(JST).isoformat()


EVENT_FIELDS = (
    "id", "type", "severity", "time", "lat", "lon", "title", "titleJa",
    "source", "url", "magnitude", "maxScale",
)


def event_from_node(node: dict[str, Any], affects: Sequence[str] | None = None) -> dict[str, Any]:
    """Map an Event node dict → the frozen contracts/event.schema.json shape."""
    out: dict[str, Any] = {}
    for f in EVENT_FIELDS:
        out[f] = node.get(f)
    out["time"] = to_iso(node.get("time"))
    out["affects"] = list(affects or [])
    return out


# ─────────────────────────────── schema / seed ───────────────────────────────

CONSTRAINTS = (
    "CREATE CONSTRAINT event_id IF NOT EXISTS FOR (e:Event) REQUIRE e.id IS UNIQUE",
    "CREATE CONSTRAINT station_id IF NOT EXISTS FOR (s:Station) REQUIRE s.stationId IS UNIQUE",
    "CREATE CONSTRAINT line_id IF NOT EXISTS FOR (l:Line) REQUIRE l.lineId IS UNIQUE",
    "CREATE CONSTRAINT ward_name IF NOT EXISTS FOR (w:Ward) REQUIRE w.name IS UNIQUE",
)
INDEXES = (
    "CREATE INDEX event_time IF NOT EXISTS FOR (e:Event) ON (e.time)",
    "CREATE INDEX event_type IF NOT EXISTS FOR (e:Event) ON (e.type)",
)


def ensure_schema() -> list[str]:
    """Idempotently create constraints + indexes. Returns what was applied."""
    applied: list[str] = []
    for stmt in CONSTRAINTS + INDEXES:
        run(stmt)
        applied.append(stmt.split()[2])
    return applied


def upsert_lines(lines: Iterable[dict[str, Any]]) -> int:
    """MERGE Line nodes from contracts/lines.csv rows. Never clobbers live status."""
    rows = [
        {
            "lineId": l["lineId"], "name": l.get("name"), "nameJa": l.get("nameJa"),
            "operator": l.get("operator"), "color": l.get("color"),
            "statusFeed": l.get("statusFeed") or "none",
        }
        for l in lines if l.get("lineId")
    ]
    if not rows:
        return 0
    run(
        """
        UNWIND $rows AS r
        MERGE (l:Line {lineId: r.lineId})
        SET l.name = r.name, l.nameJa = r.nameJa, l.operator = r.operator,
            l.color = r.color, l.statusFeed = r.statusFeed,
            l.status       = coalesce(l.status, 'unknown'),
            l.statusText   = coalesce(l.statusText, 'No live status feed'),
            l.statusSource = coalesce(l.statusSource, 'none')
        """,
        rows=rows,
    )
    return len(rows)


def upsert_wards(wards: Iterable[dict[str, Any]]) -> int:
    rows = [
        {"name": w["ward"], "nameJa": w.get("wardJa"),
         "lat": _f(w.get("lat")), "lon": _f(w.get("lon"))}
        for w in wards if w.get("ward")
    ]
    if not rows:
        return 0
    run(
        """
        UNWIND $rows AS r
        MERGE (w:Ward {name: r.name})
        SET w.nameJa = r.nameJa, w.lat = r.lat, w.lon = r.lon
        """,
        rows=rows,
    )
    return len(rows)


def upsert_stations(stations: Iterable[dict[str, Any]]) -> dict[str, int]:
    """MERGE Station nodes + (Line)-[:SERVES]->(Station) + (Station)-[:IN]->(Ward).

    Each station dict: stationId, name, nameJa, lat, lon, ridership,
    ridershipBand, inFloodZone, ward, lines=[{lineId, index}, ...].
    Unknown line/ward refs are skipped, never fatal.
    """
    rows: list[dict[str, Any]] = []
    serves: list[dict[str, Any]] = []
    ins: list[dict[str, Any]] = []
    for s in stations:
        sid = s.get("stationId")
        if not sid:
            continue
        rows.append({
            "stationId": sid, "name": s.get("name"), "nameJa": s.get("nameJa"),
            "lat": _f(s.get("lat")), "lon": _f(s.get("lon")),
            "ridership": _i(s.get("ridership")),
            "ridershipBand": _i(s.get("ridershipBand")) or 1,
            "inFloodZone": bool(s.get("inFloodZone")),
        })
        for ref in s.get("lines") or []:
            if ref.get("lineId"):
                serves.append({"stationId": sid, "lineId": ref["lineId"],
                               "index": _i(ref.get("index")) or 0})
        if s.get("ward"):
            ins.append({"stationId": sid, "ward": s["ward"]})
    if not rows:
        return {"stations": 0, "serves": 0, "in": 0}
    run(
        """
        UNWIND $rows AS r
        MERGE (s:Station {stationId: r.stationId})
        SET s.name = r.name, s.nameJa = r.nameJa, s.lat = r.lat, s.lon = r.lon,
            s.ridership = r.ridership, s.ridershipBand = r.ridershipBand,
            s.inFloodZone = r.inFloodZone
        """,
        rows=rows,
    )
    if serves:
        run(
            """
            UNWIND $rows AS r
            MATCH (l:Line {lineId: r.lineId}), (s:Station {stationId: r.stationId})
            MERGE (l)-[rel:SERVES]->(s)
            SET rel.index = r.index
            """,
            rows=serves,
        )
    if ins:
        run(
            """
            UNWIND $rows AS r
            MATCH (s:Station {stationId: r.stationId}), (w:Ward {name: r.ward})
            MERGE (s)-[:IN]->(w)
            """,
            rows=ins,
        )
    return {"stations": len(rows), "serves": len(serves), "in": len(ins)}


def set_line_status(lineId: str, status: str, statusText: str,
                    statusTextJa: str | None = None,
                    statusSource: str = "live",
                    updatedAt: str | None = None) -> None:
    """Used by A2's train ingestor to stamp live status onto a Line."""
    run(
        """
        MATCH (l:Line {lineId: $lineId})
        SET l.status = $status, l.statusText = $statusText,
            l.statusTextJa = $statusTextJa, l.statusSource = $statusSource,
            l.updatedAt = datetime($updatedAt)
        """,
        lineId=lineId, status=status, statusText=statusText,
        statusTextJa=statusTextJa, statusSource=statusSource,
        updatedAt=normalise_time(updatedAt) or datetime.now(JST).isoformat(),
    )


def _f(v: Any) -> float | None:
    try:
        return float(v) if v not in (None, "") else None
    except (TypeError, ValueError):
        return None


def _i(v: Any) -> int | None:
    try:
        return int(float(v)) if v not in (None, "") else None
    except (TypeError, ValueError):
        return None


# ───────────────────────────── the write path (A2) ───────────────────────────

def upsert_events(events: list[dict]) -> int:
    """Idempotently write normalized Events into the graph. **A2 calls this.**

    STABLE SIGNATURE — do not change without an orchestrator broadcast.

        from api.graph import upsert_events
        n = upsert_events([event_dict, ...])   # -> number of events written

    `events` is a list of dicts in the frozen contracts/event.schema.json shape:
    required id, type, severity, time (ISO8601 with offset), title, source;
    optional lat, lon, titleJa, url, magnitude, maxScale, affects.

    Behaviour:
      * `MERGE (e:Event {id})` — re-ingesting the same event is a no-op update,
        so you can poll every 30s without creating duplicates.
      * `time` is stored as a Neo4j datetime (naive input is assumed Asia/Tokyo).
      * `affects` entries (`"line:Toei-Mita"` / `"ward:Koto"`) become
        `(Event)-[:AFFECTS]->(Line|Ward)` edges. **Unknown refs are silently
        skipped** — a typo'd lineId never fails your ingest batch.
      * Events missing a required field are skipped (not fatal); the return
        value counts only what was actually written.

    Raises GraphUnavailable if Neo4j is unreachable — catch it and keep polling.
    """
    if not events:
        return 0
    rows: list[dict[str, Any]] = []
    line_pairs: list[dict[str, str]] = []
    ward_pairs: list[dict[str, str]] = []

    for ev in events:
        if not isinstance(ev, dict):
            continue
        eid = ev.get("id")
        t = normalise_time(ev.get("time"))
        if not eid or not t or not ev.get("type") or not ev.get("title"):
            log.warning("skipping malformed event: %r", str(ev)[:120])
            continue
        rows.append({
            "id": str(eid),
            "type": ev.get("type"),
            "severity": ev.get("severity") or "info",
            "time": t,
            "lat": _f(ev.get("lat")),
            "lon": _f(ev.get("lon")),
            "title": ev.get("title"),
            "titleJa": ev.get("titleJa"),
            "source": ev.get("source") or "mock",
            "url": ev.get("url"),
            "magnitude": _f(ev.get("magnitude")),
            "maxScale": _i(ev.get("maxScale")),
        })
        for ref in ev.get("affects") or []:
            if not isinstance(ref, str) or ":" not in ref:
                continue
            kind, _, val = ref.partition(":")
            if kind == "line":
                line_pairs.append({"id": str(eid), "ref": val})
            elif kind == "ward":
                ward_pairs.append({"id": str(eid), "ref": val})

    if not rows:
        return 0

    run(
        """
        UNWIND $rows AS r
        MERGE (e:Event {id: r.id})
        SET e.type = r.type, e.severity = r.severity, e.time = datetime(r.time),
            e.lat = r.lat, e.lon = r.lon, e.title = r.title, e.titleJa = r.titleJa,
            e.source = r.source, e.url = r.url, e.magnitude = r.magnitude,
            e.maxScale = r.maxScale, e.ingestedAt = datetime()
        """,
        rows=rows,
    )
    if line_pairs:
        run(
            """
            UNWIND $rows AS r
            MATCH (e:Event {id: r.id}), (l:Line {lineId: r.ref})
            MERGE (e)-[:AFFECTS]->(l)
            """,
            rows=line_pairs,
        )
    if ward_pairs:
        run(
            """
            UNWIND $rows AS r
            MATCH (e:Event {id: r.id}), (w:Ward {name: r.ref})
            MERGE (e)-[:AFFECTS]->(w)
            """,
            rows=ward_pairs,
        )
    return len(rows)


# ──────────────────────────────── read path ──────────────────────────────────

SEVERITY_ORDER = {"info": 0, "warning": 1, "critical": 2}


def event_count() -> int:
    rows = run("MATCH (e:Event) RETURN count(e) AS c")
    return int(rows[0]["c"]) if rows else 0


def node_counts() -> dict[str, int]:
    rows = run(
        """
        OPTIONAL MATCH (l:Line)    WITH count(l) AS lines
        OPTIONAL MATCH (s:Station) WITH lines, count(s) AS stations
        OPTIONAL MATCH (w:Ward)    WITH lines, stations, count(w) AS wards
        OPTIONAL MATCH (e:Event)   WITH lines, stations, wards, count(e) AS events
        OPTIONAL MATCH ()-[r1:SERVES]->()
          WITH lines, stations, wards, events, count(r1) AS serves
        OPTIONAL MATCH ()-[r2:IN]->()
          WITH lines, stations, wards, events, serves, count(r2) AS inWard
        OPTIONAL MATCH ()-[r3:AFFECTS]->()
          RETURN lines, stations, wards, events, serves, inWard,
                 count(r3) AS affects
        """
    )
    return {k: int(v) for k, v in (rows[0] if rows else {}).items()}


# ONE parameterised query powers the Timeline, the AlertBanner and the brief.
EVENTS_CYPHER = """
MATCH (e:Event)
WHERE e.time >= datetime($since)
  AND ($types IS NULL OR e.type IN $types)
  AND ($severities IS NULL OR e.severity IN $severities)
OPTIONAL MATCH (e)-[:AFFECTS]->(t)
WITH e, collect(DISTINCT
       CASE
         WHEN t:Line THEN 'line:' + t.lineId
         WHEN t:Ward THEN 'ward:' + t.name
         ELSE null
       END) AS refs
RETURN e AS node, [x IN refs WHERE x IS NOT NULL] AS affects
ORDER BY e.time DESC
LIMIT $limit
"""


def fetch_events(since_iso: str, limit: int = 30,
                 types: list[str] | None = None,
                 severities: list[str] | None = None) -> list[dict[str, Any]]:
    rows = run(EVENTS_CYPHER, since=since_iso, limit=int(limit),
               types=types or None, severities=severities or None)
    out = [event_from_node(dict(r["node"]), r["affects"]) for r in rows]
    if not out:
        raise NoGraphData("graph has no events in this window")
    return out


def fetch_line_status() -> dict[str, dict[str, Any]]:
    """Status for all 20 lines in ONE round-trip (Aura RTT is ~0.4s, so every
    extra query is a visible pause). Includes the fallback that derives a line's
    status from the newest train Event that AFFECTS it, for when the ingestor
    writes Events but does not stamp Line.status."""
    rows = run(
        """
        MATCH (l:Line)
        OPTIONAL MATCH (e:Event {type: 'train'})-[:AFFECTS]->(l)
        WITH l, e ORDER BY e.time DESC
        WITH l, head(collect(e)) AS latest
        RETURN l.lineId AS lineId, l.status AS status, l.statusText AS statusText,
               l.statusTextJa AS statusTextJa, l.statusSource AS statusSource,
               l.updatedAt AS updatedAt,
               latest.severity AS dSeverity, latest.title AS dTitle,
               latest.titleJa AS dTitleJa, latest.time AS dTime
        """
    )
    if not rows:
        raise NoGraphData("graph has no Line nodes (run scripts/seed.py)")
    out: dict[str, dict[str, Any]] = {}
    for r in rows:
        lid = r["lineId"]
        if not lid:
            continue
        cur = {
            "status": r["status"] or "unknown",
            "statusText": r["statusText"] or "No live status feed",
            "statusTextJa": r["statusTextJa"],
            "statusSource": r["statusSource"] or "none",
            "updatedAt": to_iso(r["updatedAt"]),
        }
        if cur["statusSource"] != "live" and r.get("dTitle"):
            sev = r.get("dSeverity") or "info"
            cur.update(
                status={"critical": "suspended", "warning": "delay"}.get(sev, "normal"),
                statusText=r["dTitle"],
                statusTextJa=r.get("dTitleJa") or cur.get("statusTextJa"),
                statusSource="live",
                updatedAt=to_iso(r.get("dTime")),
            )
        out[lid] = cur
    return out


def fetch_stations() -> list[dict[str, Any]]:
    rows = run(
        """
        MATCH (s:Station)
        OPTIONAL MATCH (l:Line)-[:SERVES]->(s)
        OPTIONAL MATCH (s)-[:IN]->(w:Ward)
        RETURN s.stationId AS stationId, s.name AS name, s.nameJa AS nameJa,
               s.lat AS lat, s.lon AS lon, s.ridership AS ridership,
               coalesce(s.ridershipBand, 1) AS ridershipBand,
               coalesce(s.inFloodZone, false) AS inFloodZone,
               collect(DISTINCT l.lineId) AS lineIds,
               head(collect(DISTINCT w.name)) AS ward
        """
    )
    if not rows:
        raise NoGraphData("graph has no Station nodes (run scripts/seed.py)")
    for r in rows:
        r["lineIds"] = [x for x in (r.get("lineIds") or []) if x]
    return rows


def fetch_impact(lineId: str, since_iso: str) -> dict[str, Any] | None:
    """The demo beat: (Line)-[:SERVES]->(Station)-[:IN]->(Ward) + AFFECTS events,
    in ONE round-trip. Returns None when the Line node is not in the graph.

    Every subquery ends in an aggregation so an empty branch yields a row rather
    than eliminating the outer one.
    """
    rows = run(
        """
        MATCH (l:Line {lineId: $lineId})
        CALL {
          WITH l
          MATCH (l)-[r:SERVES]->(s:Station)
          OPTIONAL MATCH (s)-[:IN]->(w:Ward)
          WITH s, w, coalesce(r.index, 0) AS idx ORDER BY idx
          RETURN collect({stationId: s.stationId, name: s.name, nameJa: s.nameJa,
                          lat: s.lat, lon: s.lon, ward: w.name,
                          inFloodZone: coalesce(s.inFloodZone, false),
                          ridershipBand: coalesce(s.ridershipBand, 1)}) AS stations
        }
        CALL {
          WITH l
          MATCH (l)-[:SERVES]->(s2:Station)-[:IN]->(w2:Ward)
          WITH w2, count(DISTINCT s2) AS stationCount
          OPTIONAL MATCH (e2:Event)-[:AFFECTS]->(w2)
            WHERE e2.time >= datetime($since)
          WITH w2, stationCount, count(DISTINCT e2) AS activeEventCount
          ORDER BY stationCount DESC, w2.name
          RETURN collect({ward: w2.name, wardJa: w2.nameJa,
                          stationCount: stationCount,
                          activeEventCount: activeEventCount}) AS wards
        }
        CALL {
          WITH l
          MATCH (e:Event)-[:AFFECTS]->(l)
          WITH e ORDER BY e.time DESC LIMIT 20
          OPTIONAL MATCH (e)-[:AFFECTS]->(t)
          WITH e, collect(DISTINCT
                 CASE WHEN t:Line THEN 'line:' + t.lineId
                      WHEN t:Ward THEN 'ward:' + t.name ELSE null END) AS refs
          RETURN collect({node: e {.*},
                          affects: [x IN refs WHERE x IS NOT NULL]}) AS events
        }
        RETURN l.name AS name, l.nameJa AS nameJa, l.status AS status,
               l.statusText AS statusText, l.statusSource AS statusSource,
               stations, wards, events
        """,
        lineId=lineId, since=since_iso,
    )
    if not rows:
        return None
    r = rows[0]
    stations = [dict(s) for s in (r.get("stations") or [])]
    return {
        "lineId": lineId,
        "name": r["name"], "nameJa": r["nameJa"],
        "status": r["status"] or "unknown",
        "statusText": r["statusText"] or "No live status feed",
        "statusSource": r["statusSource"] or "none",
        "wards": [dict(w) for w in (r.get("wards") or [])],
        "stations": stations,
        "events": [event_from_node(dict(x["node"]), x.get("affects"))
                   for x in (r.get("events") or [])],
        "stationsInFloodZone": sum(1 for s in stations if s.get("inFloodZone")),
    }
