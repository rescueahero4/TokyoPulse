"""TokyoPulse — FastAPI app (owner: A3). Implements contracts/api.md exactly.

Start it:  .venv\\Scripts\\python.exe scripts\\run_api.py
           (or: .venv\\Scripts\\python.exe -m uvicorn api.main:app --host 0.0.0.0 --port 8000)

Resolution order for every read endpoint:
    tier 0  api.cache   in-process TTL cache, stale-while-revalidate
    tier 1  Neo4j       meta.source = "live"
    tier 2  mock/       meta.source = "cache",  degraded = true
    tier 3  empty       meta.source = "mock",   degraded = true
The cache sits IN FRONT of the three-tier resolver and never replaces it, so the
never-500 guarantee is unchanged: a cache miss still goes through three_tier(),
and a failed refresh keeps serving the previous payload.

Two latency rules this file exists to respect:
  * Aura is in GCP Singapore, we are in Tokyo: ONE Cypher round-trip is ~0.4s.
    So endpoints are served from memory and refreshed in the background.
  * Handlers are **sync `def`**, not `async def`. The Neo4j and httpx clients here
    are blocking; in an async handler they block the whole event loop and every
    concurrent poller queues behind them (that is how a 136-byte /health reached
    5s). Sync handlers run in Starlette's threadpool and stay concurrent.
"""

from __future__ import annotations

import json
import logging
import os
import time
from datetime import datetime, timedelta
from typing import Any

from fastapi import Body, FastAPI, Query, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from . import brief as brief_mod
from . import cache
from . import graph
from .envelope import (JST, MOCK_DIR, NoLiveData, ROOT, env_str, lines_csv,
                       meta, now_iso, now_jst, read_mock, three_tier, wards_csv)

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
log = logging.getLogger("tokyopulse.api")
# The driver warns on every query naming a label/property not yet in the database
# (normal before the first ingest). Keep the demo log readable.
logging.getLogger("neo4j.notifications").setLevel(logging.ERROR)

app = FastAPI(title="TokyoPulse API", version="1.1.0",
              description="Live Tokyo city-operations graph. contracts/api.md is frozen.")

_origins = [o.strip() for o in
            (env_str("CORS_ORIGINS") or "http://localhost:5173,http://127.0.0.1:5173").split(",")
            if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_origin_regex=r"http://(localhost|127\.0\.0\.1):\d+",
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Cache", "Age"],
)

SEV_RANK = {"info": 0, "warning": 1, "critical": 2}
TYPES = ("quake", "train", "warning", "weather")
EMPTY_COUNTS = {"quake": 0, "train": 0, "warning": 0, "weather": 0,
                "critical": 0, "warning_level": 0}

# TTLs (seconds). Geometry is static; events churn; /health is a liveness poll.
TTL_EVENTS = 5.0
TTL_LINES = 60.0
TTL_STATIONS = 60.0
TTL_IMPACT = 20.0
TTL_LAYERS = 10.0
TTL_HEALTH = 10.0
TTL_BRIEF = 15.0
TTL_FORECAST = 60.0
TTL_WEATHERGRID = 600.0     # "the field barely moves" — A10/orchestrator spec
TTL_SANDBOXES = 5.0
# odpt:Bus republishes every 30s (odpt:frequency), so refreshing faster than
# that just burns the mirror for an identical payload.
TTL_BUSES = 15.0
TTL_BUSROUTES = 900.0        # static geometry off disk

# Replayed events survive a dead Neo4j: /events.json always merges these in.
REPLAY: list[dict[str, Any]] = []
REPLAY_CAP = 200

# lineIds whose (:Line) node /demo/replay stamped with a replay status (P0-2).
# /demo/reset reverts exactly these back to their real ingested status.
REPLAY_STAMPED_LINES: set[str] = set()

_forecast_cache: dict[str, Any] = {"at": 0.0, "value": None}


# ───────────────────────────────── helpers ───────────────────────────────────

def _clamp_limit(raw: Any, default: int = 30, lo: int = 1, hi: int = 200) -> int:
    try:
        n = int(str(raw))
    except (TypeError, ValueError):
        return default
    return max(lo, min(hi, n))


def _csv_list(raw: str | None, allowed: tuple[str, ...] | None = None) -> list[str] | None:
    if not raw:
        return None
    items = [x.strip().lower() for x in str(raw).split(",") if x.strip()]
    if allowed:
        items = [x for x in items if x in allowed]
    return items or None


def _severities_at_least(minimum: str | None) -> list[str] | None:
    if not minimum:
        return None
    floor = SEV_RANK.get(str(minimum).strip().lower())
    if floor is None:
        return None
    return [s for s, r in SEV_RANK.items() if r >= floor]


# `window=now` is a STATE view (see EVENTS_NOW_CYPHER): incidents from the last
# 48h, plus the latest status per train line and every active warning regardless
# of age. `window=7d` stays a pure 7-day history — the time-travel beat.
NOW_INCIDENT_HOURS = 48


def _window_hours(window: str | None) -> int:
    return 24 * 7 if (window or "now").lower() == "7d" else NOW_INCIDENT_HOURS


def _since_iso(window: str | None, since: str | None) -> str:
    if since:
        iso = graph.normalise_time(since)
        if iso:
            return iso
    return (now_jst() - timedelta(hours=_window_hours(window))).isoformat()


def _counts(events: list[dict]) -> dict[str, int]:
    c = dict(EMPTY_COUNTS)
    for ev in events:
        t = ev.get("type")
        if t in c:
            c[t] += 1
        if ev.get("severity") == "critical":
            c["critical"] += 1
        if SEV_RANK.get(ev.get("severity"), 0) >= 1:
            c["warning_level"] += 1
    return c


def _filter_events(events: list[dict], since_iso: str, types: list[str] | None,
                   severities: list[str] | None, limit: int) -> list[dict]:
    out = []
    for ev in events:
        if not isinstance(ev, dict):
            continue
        t = graph.normalise_time(ev.get("time"))
        if not t or t < since_iso:
            continue
        if types and ev.get("type") not in types:
            continue
        if severities and ev.get("severity") not in severities:
            continue
        e = dict(ev)
        e["time"] = t
        e.setdefault("affects", [])
        out.append(e)
    out.sort(key=lambda e: e.get("time") or "", reverse=True)
    return out[:limit]


def _select_now(events: list[dict]) -> list[dict]:
    """Tier 2/3 equivalent of EVENTS_NOW_CYPHER: the same "currently in effect"
    union applied to a cached payload, so a degraded timeline is shaped like a
    live one."""
    cutoff = (now_jst() - timedelta(hours=NOW_INCIDENT_HOURS)).isoformat()
    picked: dict[str, dict] = {}

    def keep(ev: dict) -> None:
        if ev.get("id"):
            picked[ev["id"]] = ev

    latest_line: dict[str, dict] = {}
    latest_ward: dict[str, dict] = {}
    for ev in events:
        if not isinstance(ev, dict):
            continue
        t = graph.normalise_time(ev.get("time"))
        if not t:
            continue
        ev = dict(ev, time=t)
        ev.setdefault("affects", [])
        if t >= cutoff:                                   # A: recent (incl. future)
            keep(ev)
        refs = [str(x) for x in ev.get("affects") or []]
        if ev.get("type") == "train":                     # B: latest per line
            for r in refs:
                if r.startswith("line:"):
                    cur = latest_line.get(r)
                    if not cur or t > cur["time"]:
                        latest_line[r] = ev
        elif ev.get("type") == "warning":                 # C: active warnings
            # ward when known, else title — see EVENTS_NOW_CYPHER subquery C.
            scopes = [r for r in refs if r.startswith("ward:")] or [
                f"title:{ev.get('title')}"]
            for sc in scopes:
                cur = latest_ward.get(sc)
                if not cur or t > cur["time"]:
                    latest_ward[sc] = ev
    for ev in list(latest_line.values()) + list(latest_ward.values()):
        keep(ev)
    out = list(picked.values())
    out.sort(key=lambda e: e.get("time") or "", reverse=True)
    return out


def _merge_replay(events: list[dict], since_iso: str, types, severities, limit) -> list[dict]:
    """Replayed events are merged into every events view, graph up or down."""
    if not REPLAY:
        return events[:limit]
    have = {e.get("id") for e in events}
    extra = [e for e in _filter_events(REPLAY, since_iso, types, severities, limit)
             if e.get("id") not in have]
    merged = events + extra
    merged.sort(key=lambda e: e.get("time") or "", reverse=True)
    return merged[:limit]


def _cached_payload(key: str) -> dict[str, Any] | None:
    """Read another endpoint's cached payload (tier 0, free) — used by /layers."""
    entry = cache._entries.get(key)
    return entry["payload"] if entry else None


# ─────────────────────── producers (three-tier, cacheable) ───────────────────

def _events_key(limit: int, types, severities, since_iso: str, window: str | None) -> str:
    return (f"events:{window or 'now'}|{limit}|{','.join(types or [])}"
            f"|{','.join(severities or [])}|{since_iso[:16]}")


def _empty_events() -> dict[str, Any]:
    return {"events": [], "counts": dict(EMPTY_COUNTS)}


def _produce_events(limit: int, types: list[str] | None,
                    severities: list[str] | None, since_iso: str,
                    now_window: bool = False) -> dict[str, Any]:
    def live():
        try:
            evs = graph.fetch_events(since_iso, limit=limit, types=types,
                                     severities=severities,
                                     now_window=now_window)
        except graph.NoGraphData:
            # A live graph that simply has nothing matching this filter is a
            # legitimate empty answer, not a degradation.
            if graph.event_count() <= 0:
                raise
            evs = []
        evs = _merge_replay(evs, since_iso, types, severities, limit)
        return {"events": evs, "counts": _counts(evs)}

    def cache_tier():
        raw = read_mock("events.json")
        if not raw:
            return None
        pool = raw.get("events") or []
        if now_window:
            pool = _select_now(pool)
            evs = [e for e in pool
                   if (not types or e.get("type") in types)
                   and (not severities or e.get("severity") in severities)][:limit]
        else:
            evs = _filter_events(pool, since_iso, types, severities, limit)
        evs = _merge_replay(evs, since_iso, types, severities, limit)
        if not evs:
            return None
        return {"events": evs, "counts": _counts(evs)}

    def empty():
        evs = _merge_replay([], since_iso, types, severities, limit)
        return {"events": evs, "counts": _counts(evs)}

    return three_tier(live, cache_tier, empty, "events.json")


def _produce_health() -> dict[str, Any]:
    """No query on the hot path: the cached liveness probe + one cheap count."""
    up, note = graph.neo4j_status()
    count, src, degraded, meta_note = 0, "mock", True, note
    if up:
        try:
            count = graph.event_count()
            src, degraded = "live", False
            if not count:
                degraded, meta_note = True, "graph reachable but empty — run scripts/seed.py"
            else:
                meta_note = None
        except Exception as exc:
            up = False
            meta_note = f"{type(exc).__name__}: {str(exc)[:90]}"
    if not up:
        raw = read_mock("events.json") or {}
        count = len(raw.get("events") or []) + len(REPLAY)
        src, degraded = "cache", True
    return {"ok": True, "neo4j": "up" if up else "down", "eventCount": count,
            "meta": meta(src, degraded, meta_note)}


def _mock_line_props() -> dict[str, dict[str, Any]]:
    raw = read_mock("lines.geojson") or {}
    out = {}
    for f in raw.get("features") or []:
        p = (f or {}).get("properties") or {}
        if p.get("lineId"):
            out[p["lineId"]] = {"geometry": (f or {}).get("geometry"), "props": p}
    return out


# contracts/line-feature.schema.json freezes statusSource to live|cache|mock|none
# — it has no 'replay' slot (unlike Event.source, which does). P0-2's replay
# stamp (api/graph.py set_line_status) tags the Neo4j field 'replay' so
# /demo/reset can find exactly what it touched; this maps that internal tag to
# the nearest honest frozen value ('cache': not live, not a faked normal) right
# at the API boundary, so the wire shape never changes. statusText still says
# "(replay)" explicitly, so nothing is hidden from a judge reading the panel.
_STATUS_SOURCE_WIRE = {"replay": "cache"}


def _line_features(status_map: dict[str, dict[str, Any]] | None,
                   geometry_src: dict[str, dict[str, Any]],
                   fallback_source: str) -> list[dict[str, Any]]:
    """All 20 contract lines, ALWAYS — the UI's line-search list depends on it."""
    feats = []
    for row in lines_csv():
        lid = row.get("lineId")
        if not lid:
            continue
        geo = (geometry_src.get(lid) or {}).get("geometry") or {
            "type": "LineString", "coordinates": []}
        mock_props = (geometry_src.get(lid) or {}).get("props") or {}
        has_feed = (row.get("statusFeed") or "none").strip().lower() == "live"
        st = (status_map or {}).get(lid) or {}
        if not has_feed:
            # Honest labelling: no live feed => unknown/grey, never a faked 'normal'.
            status, text, text_ja, source, updated = (
                "unknown", "No live status feed", None, "none", None)
        elif st:
            status = st.get("status") or "unknown"
            text = st.get("statusText") or "No live status feed"
            text_ja = st.get("statusTextJa")
            source = st.get("statusSource") or fallback_source
            updated = st.get("updatedAt")
        else:
            status = mock_props.get("status") or "unknown"
            text = mock_props.get("statusText") or "No live status feed"
            text_ja = mock_props.get("statusTextJa")
            source = mock_props.get("statusSource") or fallback_source
            updated = mock_props.get("updatedAt")
        feats.append({
            "type": "Feature",
            "geometry": geo,
            "properties": {
                "lineId": lid,
                "name": row.get("name"), "nameJa": row.get("nameJa"),
                "operator": row.get("operator"),
                "status": status, "statusText": text, "statusTextJa": text_ja,
                "color": row.get("color") or "#888888",
                "statusSource": (_STATUS_SOURCE_WIRE.get(source, source)
                                if has_feed else "none"),
                "updatedAt": updated,
            },
        })
    return feats


def _empty_lines() -> dict[str, Any]:
    return {"type": "FeatureCollection", "features": _line_features(None, {}, "mock")}


def _produce_lines() -> dict[str, Any]:
    geom = _mock_line_props()

    def live():
        status = graph.fetch_line_status()
        return {"type": "FeatureCollection",
                "features": _line_features(status, geom, "live")}

    def cache_tier():
        if not geom:
            return None
        return {"type": "FeatureCollection",
                "features": _line_features(None, geom, "cache")}

    def empty():
        return {"type": "FeatureCollection",
                "features": _line_features(None, geom, "mock")}

    payload = three_tier(live, cache_tier, empty, "lines.geojson")
    missing = sum(1 for f in payload["features"]
                  if not (f.get("geometry") or {}).get("coordinates"))
    if missing:
        m = payload["meta"]
        extra = f"geometry pending for {missing}/{len(payload['features'])} lines"
        m["note"] = f"{m['note']}; {extra}" if m.get("note") else extra
    return payload


def _station_feature(s: dict[str, Any]) -> dict[str, Any]:
    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [s.get("lon"), s.get("lat")]},
        "properties": {
            "stationId": s.get("stationId"),
            "name": s.get("name"), "nameJa": s.get("nameJa"),
            "lineIds": s.get("lineIds") or [],
            "ward": s.get("ward"),
            "ridership": s.get("ridership"),
            "ridershipBand": s.get("ridershipBand") or 1,
            "inFloodZone": bool(s.get("inFloodZone")),
        },
    }


def _empty_fc() -> dict[str, Any]:
    return {"type": "FeatureCollection", "features": []}


def _produce_stations() -> dict[str, Any]:
    def live():
        rows = graph.fetch_stations()
        feats = [_station_feature(r) for r in rows
                 if r.get("lat") is not None and r.get("lon") is not None]
        if not feats:
            raise NoLiveData("stations in graph have no coordinates")
        return {"type": "FeatureCollection", "features": feats}

    def cache_tier():
        raw = read_mock("stations.geojson")
        if not raw or not raw.get("features"):
            return None
        return {"type": "FeatureCollection", "features": raw["features"]}

    return three_tier(live, cache_tier, _empty_fc, "stations.geojson")


def _empty_impact(lineId: str, row: dict[str, str]) -> dict[str, Any]:
    return {"lineId": lineId, "name": row.get("name"), "nameJa": row.get("nameJa"),
            "status": "unknown", "statusText": "No live status feed",
            "wards": [], "stations": [], "events": [], "stationsInFloodZone": 0}


def _produce_impact(lineId: str, row: dict[str, str]) -> dict[str, Any]:
    since = (now_jst() - timedelta(hours=6)).isoformat()

    def live():
        data = graph.fetch_impact(lineId, since)      # ONE round-trip
        if not data:
            raise NoLiveData(f"Line {lineId} is not in the graph (run scripts/seed.py)")
        # NOT a NoLiveData case. A line can legitimately have live STATUS but no
        # station graph: ODPT's keyless mirror only ever supplied Toei's stations,
        # so the 5 JR East lines (live via ingest/feeds/jreast.py) and the 9 Metro
        # lines have geometry + status but no (Line)-[:SERVES]->(Station) rows.
        # Throwing to the mock tier here made /impact answer "No live status feed"
        # for JR-Chuo-Rapid while /lines.geojson said "normal / live" at the same
        # instant — the inspector card and the impact panel contradicted each other
        # on screen, on the PRD's own demo line. Serve the real status with empty
        # station/ward lists; the UI renders an honest "live status only" state.
        # P0-2: graph.fetch_impact() now resolves status with the exact same
        # logic as /lines.geojson's graph.fetch_line_status(), in the SAME
        # round-trip — no more reuse-from-another-endpoint's-cache trick here,
        # which could race with /demo/replay or /demo/reset invalidating that
        # other cache entry a moment earlier.
        data.pop("statusSource", None)
        return data

    def cache_tier():
        raw = read_mock(f"impact/{lineId}.json")
        if not raw:
            return None
        raw.pop("meta", None)
        return raw

    payload = three_tier(live, cache_tier, lambda: _empty_impact(lineId, row),
                         f"impact/{lineId}")
    payload.setdefault("stationsInFloodZone",
                       sum(1 for s in payload.get("stations") or []
                           if s.get("inFloodZone")))
    return payload


def _transform_open_meteo(raw: dict[str, Any]) -> dict[str, Any] | None:
    h = (raw or {}).get("hourly") or {}
    times = h.get("time") or []
    temps = h.get("temperature_2m") or []
    precs = h.get("precipitation") or []
    if not times:
        return None
    now = now_jst()
    hourly, now_index = [], 0
    for i, t in enumerate(times):
        iso = graph.normalise_time(t) or t
        try:
            dt = datetime.fromisoformat(iso)
        except ValueError:
            dt = now
        is_past = dt <= now
        if is_past:
            now_index = i
        hourly.append({
            "time": iso,
            "temperature": temps[i] if i < len(temps) else None,
            "precipitation": precs[i] if i < len(precs) else None,
            "isPast": is_past,
        })
    fut = hourly[now_index:]
    nums = [x["temperature"] for x in hourly if isinstance(x["temperature"], (int, float))]
    p24 = [x["precipitation"] for x in fut[:24] if isinstance(x["precipitation"], (int, float))]
    p48 = [x["precipitation"] for x in fut[:48] if isinstance(x["precipitation"], (int, float))]
    return {
        "location": {"lat": raw.get("latitude", 35.68), "lon": raw.get("longitude", 139.76),
                     "name": "Tokyo"},
        "nowIndex": now_index,
        "hourly": hourly,
        "summary": {
            "maxPrecip24h": round(max(p24), 1) if p24 else 0.0,
            "minTemp": round(min(nums), 1) if nums else None,
            "maxTemp": round(max(nums), 1) if nums else None,
            "rainHoursNext48": sum(1 for p in p48 if p and p > 0.0),
        },
    }


def _empty_forecast() -> dict[str, Any]:
    return {"location": {"lat": 35.6895, "lon": 139.6917, "name": "Tokyo"},
            "nowIndex": 0, "hourly": [],
            "summary": {"maxPrecip24h": 0.0, "minTemp": None,
                        "maxTemp": None, "rainHoursNext48": 0}}


# Open-Meteo source metadata (contracts/api.md AMENDED post-freeze). sourceUrl
# is the REAL request URL actually used — same one for every tier, since the
# live fetch, the cached mock payload, and the empty fallback all describe the
# same upstream query. Never emit null here if FEED_OPEN_METEO is set.
OPEN_METEO_SOURCE_NAME = "Open-Meteo"
OPEN_METEO_ATTRIBUTION = "Weather data by Open-Meteo.com (CC BY 4.0)"


def _attach_open_meteo_source(data: dict[str, Any]) -> dict[str, Any]:
    data["sourceUrl"] = env_str("FEED_OPEN_METEO") or None
    data["sourceName"] = OPEN_METEO_SOURCE_NAME
    data["attribution"] = OPEN_METEO_ATTRIBUTION
    return data


def _produce_forecast() -> dict[str, Any]:
    def live():
        # Weather is not a graph entity: tier 1 here is the live Open-Meteo feed,
        # cached for 10 minutes so the demo never waits on it twice.
        if _forecast_cache["value"] and (time.monotonic() - _forecast_cache["at"]) < 600:
            return dict(_forecast_cache["value"])
        url = env_str("FEED_OPEN_METEO")
        if not url:
            raise NoLiveData("FEED_OPEN_METEO not set")
        import httpx
        with httpx.Client(timeout=4.0) as client:
            r = client.get(url)
            r.raise_for_status()
            data = _transform_open_meteo(r.json())
        if not data:
            raise NoLiveData("Open-Meteo returned no hourly series")
        _forecast_cache.update(at=time.monotonic(), value=data)
        return dict(data)

    def cache_tier():
        raw = read_mock("forecast.json")
        if not raw or not raw.get("hourly"):
            raw2 = read_mock("raw/open-meteo-forecast.json")
            return _transform_open_meteo(raw2) if raw2 else None
        raw.pop("meta", None)
        return raw

    data = three_tier(live, cache_tier, _empty_forecast, "forecast.json")
    return _attach_open_meteo_source(data)


# ─────────────────── /weathergrid.json (A12) ─────────────────────────────────
# A continuous-surface weather field for the map, not the old point markers.
# Verified (contracts/api.md AMENDED post-freeze): Open-Meteo accepts many
# comma-separated coordinates in ONE request -> 63 points / 951-char URL for
# the default 7x9 lattice. Tier 1 here is that live fetch (like /forecast.json
# -- weather is not a graph entity), cached 10 minutes since the field barely
# moves and we must not re-pay for the same lattice on every poll.
WEATHERGRID_BBOX = {"latMin": 35.30, "latMax": 36.05, "lonMin": 139.20, "lonMax": 140.20}
WEATHERGRID_DEFAULT_STEP = 0.125
WEATHERGRID_ALLOWED_STEPS = (0.25, 0.125, 0.0625)
WEATHERGRID_VARS = ("temperature_2m", "precipitation")
WEATHERGRID_UNITS = {"temperature_2m": "°C", "precipitation": "mm"}
# Guard against a caller asking for a 10,000-point lattice (orchestrator's own
# wording). The finest allowed step over the fixed bbox is already only 221
# points, so this is a defensive ceiling, not the normal path.
WEATHERGRID_MAX_POINTS = 400
WEATHERGRID_RESOLUTION_NOTE = (
    "This surface is bilinearly interpolated for smooth rendering -- interpolation "
    "adds no new information, it only renders the transition between known grid "
    "points smoothly. Open-Meteo's native model resolution over Japan is ~5km; "
    "a finer ?step= re-requests the same underlying cells rather than adding real "
    "detail. Treat the temperature field as defensible continuous data and the "
    "precipitation field as a coarser, genuinely patchier approximation."
)


def _weathergrid_step(raw: Any) -> tuple[float, str | None]:
    """Snap to one of the three contracted steps; anything else degrades to the
    default with an honest note, never a 500 on a bad query param."""
    if raw is None:
        return WEATHERGRID_DEFAULT_STEP, None
    try:
        s = float(str(raw))
    except (TypeError, ValueError):
        return WEATHERGRID_DEFAULT_STEP, f"unrecognised step {raw!r}, served default {WEATHERGRID_DEFAULT_STEP}"
    for allowed in WEATHERGRID_ALLOWED_STEPS:
        if abs(s - allowed) < 1e-6:
            return allowed, None
    return WEATHERGRID_DEFAULT_STEP, f"step {s} not one of {WEATHERGRID_ALLOWED_STEPS}, served default {WEATHERGRID_DEFAULT_STEP}"


def _weathergrid_vars(raw: str | None) -> tuple[tuple[str, ...], str | None]:
    if not raw:
        return WEATHERGRID_VARS, None
    items = tuple(x for x in _csv_list(raw, WEATHERGRID_VARS) or [] if x)
    if not items:
        return WEATHERGRID_VARS, f"unrecognised ?var={raw!r}, served both variables"
    return items, None


def _weathergrid_axes(step: float) -> tuple[list[float], list[float]]:
    bbox = WEATHERGRID_BBOX
    lats, lons = [], []
    lat = bbox["latMin"]
    while lat <= bbox["latMax"] + 1e-9:
        lats.append(round(lat, 4)); lat += step
    lon = bbox["lonMin"]
    while lon <= bbox["lonMax"] + 1e-9:
        lons.append(round(lon, 4)); lon += step
    return lats, lons


def _weathergrid_source_url(flat_lat: list[float], flat_lon: list[float],
                            var_keys: tuple[str, ...]) -> str:
    return (f"https://api.open-meteo.com/v1/forecast?latitude={','.join(str(x) for x in flat_lat)}"
            f"&longitude={','.join(str(x) for x in flat_lon)}"
            f"&current={','.join(var_keys)}&timezone=Asia%2FTokyo")


def _empty_weathergrid(step: float, lats: list[float], lons: list[float],
                       var_keys: tuple[str, ...]) -> dict[str, Any]:
    n = len(lats) * len(lons)
    return {
        "bbox": dict(WEATHERGRID_BBOX), "step": step, "rows": len(lats), "cols": len(lons),
        "lats": lats, "lons": lons, "time": None,
        "units": {k: WEATHERGRID_UNITS.get(k) for k in var_keys},
        "values": {k: [None] * n for k in var_keys},
    }


# One live Open-Meteo fetch per (step, vars) combo fronts every request for
# that shape, the same pattern as _forecast_cache / _bus_live_cache.
_weathergrid_live_cache: dict[str, dict[str, Any]] = {}


def _produce_weathergrid(step: float, var_keys: tuple[str, ...]) -> dict[str, Any]:
    lats, lons = _weathergrid_axes(step)
    if len(lats) * len(lons) > WEATHERGRID_MAX_POINTS:
        # Defensive only: the three contracted steps over the fixed bbox top
        # out at 221 points, well under this ceiling. A future caller-supplied
        # bbox must not be allowed to blow this past WEATHERGRID_MAX_POINTS.
        step = WEATHERGRID_DEFAULT_STEP
        lats, lons = _weathergrid_axes(step)
    flat_lat, flat_lon = [], []
    for la in lats:
        for lo in lons:
            flat_lat.append(la); flat_lon.append(lo)
    source_url = _weathergrid_source_url(flat_lat, flat_lon, var_keys)
    cache_key = f"{step}|{','.join(var_keys)}"

    def live():
        cached = _weathergrid_live_cache.get(cache_key)
        if cached and (time.monotonic() - cached["at"]) < 600:
            return json.loads(json.dumps(cached["value"]))
        if len(source_url) > 7000:
            raise NoLiveData(f"weathergrid source URL too long ({len(source_url)} chars)")
        import httpx
        with httpx.Client(timeout=8.0, headers={"User-Agent": "TokyoPulse-hackathon/1.0"}) as client:
            r = client.get(source_url)
            r.raise_for_status()
            data = r.json()
        if not isinstance(data, list):
            data = [data]
        if len(data) != len(flat_lat):
            raise NoLiveData(f"Open-Meteo returned {len(data)} points, expected {len(flat_lat)}")
        values: dict[str, list[Any]] = {k: [] for k in var_keys}
        units: dict[str, Any] = {}
        obs_time = None
        for pt in data:
            cur = (pt or {}).get("current") or {}
            cur_units = (pt or {}).get("current_units") or {}
            obs_time = obs_time or cur.get("time")
            for k in var_keys:
                values[k].append(cur.get(k))
                units.setdefault(k, cur_units.get(k, WEATHERGRID_UNITS.get(k)))
        payload = {
            "bbox": dict(WEATHERGRID_BBOX), "step": step, "rows": len(lats), "cols": len(lons),
            "lats": lats, "lons": lons, "time": obs_time, "units": units, "values": values,
        }
        _weathergrid_live_cache[cache_key] = {"at": time.monotonic(), "value": payload}
        return json.loads(json.dumps(payload))

    def cache_tier():
        raw = read_mock("weathergrid.json")
        if not raw or not raw.get("values"):
            return None
        # The mock snapshot is only valid for the shape it was captured at —
        # never present a cached 7x9 payload as if it were a different
        # resolution's data.
        if raw.get("step") != step or raw.get("rows") != len(lats) or raw.get("cols") != len(lons):
            return None
        if not all(k in raw.get("values", {}) for k in var_keys):
            return None
        out = {
            "bbox": raw.get("bbox") or dict(WEATHERGRID_BBOX), "step": step,
            "rows": raw["rows"], "cols": raw["cols"], "lats": raw["lats"], "lons": raw["lons"],
            "time": raw.get("time"),
            "units": {k: raw["units"].get(k) for k in var_keys},
            "values": {k: raw["values"][k] for k in var_keys},
        }
        return out

    payload = three_tier(live, cache_tier, lambda: _empty_weathergrid(step, lats, lons, var_keys),
                         "weathergrid.json")
    payload["sourceUrl"] = source_url
    payload["attribution"] = OPEN_METEO_ATTRIBUTION
    payload["note"] = WEATHERGRID_RESOLUTION_NOTE
    return payload


def _empty_brief() -> dict[str, Any]:
    return {"en": "City brief unavailable.",
            "ja": "シティブリーフは現在利用できません。",
            "provider": "template",
            "providerLabel": "rule-based summary (no data)", "eventCount": 0}


def _produce_brief() -> dict[str, Any]:
    window = "now"
    since = _since_iso(window, None)
    key = _events_key(10, None, None, since, window)
    ev_payload = _cached_payload(key) or _produce_events(10, None, None, since, True)
    events = ev_payload.get("events") or []
    result = brief_mod.build_brief(events, window)
    src_meta = dict(ev_payload.get("meta") or meta("mock", True, "no event source"))
    note = result.pop("note", None)
    if note:
        src_meta["note"] = f"{src_meta['note']}; {note}" if src_meta.get("note") else note
    result["meta"] = src_meta
    return result


SANDBOX_STATE = ROOT / "ingest" / "state" / "sandboxes.json"


def _empty_sandboxes() -> dict[str, Any]:
    return {"count": 0, "sandboxes": []}


def _produce_sandboxes() -> dict[str, Any]:
    def live():
        # A2 writes ingest/state/sandboxes.json from the Daytona launcher.
        if not SANDBOX_STATE.is_file():
            raise NoLiveData("ingest/state/sandboxes.json not written yet")
        data = json.loads(SANDBOX_STATE.read_text(encoding="utf-8"))
        boxes = data.get("sandboxes") if isinstance(data, dict) else data
        if not boxes:
            raise NoLiveData("sandbox state file has no sandboxes")
        return {"count": len(boxes), "sandboxes": boxes}

    def cache_tier():
        raw = read_mock("sandboxes.json")
        if not raw or not raw.get("sandboxes"):
            return None
        boxes = raw["sandboxes"]
        return {"count": raw.get("count") or len(boxes), "sandboxes": boxes}

    return three_tier(live, cache_tier, _empty_sandboxes, "sandboxes.json")


# ─────────────────────────── buses (A11) ────────────────────────────────────
# Recovers the stretch goal doc/prd.md §3.5 cut for want of an ODPT token: the
# keyless mirror carries odpt:Bus after all. Buses are a MAP LAYER, not timeline
# rows — see the header of ingest/feeds/buses.py for why they write no Events.
#
# Tier 1 here is the live ODPT feed (like /forecast.json), not Neo4j: a derived
# vehicle position has a 30-second shelf life and has no business in the graph.

def _empty_buses() -> dict[str, Any]:
    return {"type": "FeatureCollection", "features": [], "busCount": 0,
            "interpolatedCount": 0, "atStopCount": 0, "staleCount": 0,
            "feedAgeSeconds": None, "feedStale": False, "feedTime": None,
            "sourceUrl": "https://api-public.odpt.org/api/v4/odpt:Bus",
            "sourceName": "ODPT odpt:Bus (Toei)",
            "positionMethod": None, "attribution": None}


# One live ODPT fetch feeds every filtered variant of /buses.geojson, the same
# way _forecast_cache fronts Open-Meteo. Without it, five filter combinations
# would be five hits on the mirror for a payload that only changes every 30s.
_bus_live_cache: dict[str, Any] = {"at": 0.0, "value": None}
_BUS_LIVE_TTL = 12.0


def _produce_buses() -> dict[str, Any]:
    from ingest.feeds import buses as buses_feed

    def live():
        if _bus_live_cache["value"] and (time.monotonic() - _bus_live_cache["at"]) < _BUS_LIVE_TTL:
            return json.loads(json.dumps(_bus_live_cache["value"]))
        payload = buses_feed.normalize(buses_feed.fetch_once())
        if not payload.get("features"):
            raise NoLiveData("odpt:Bus returned no placeable vehicles")
        _bus_live_cache.update(at=time.monotonic(), value=payload)
        return json.loads(json.dumps(payload))

    def cache_tier():
        raw = read_mock("busvehicles.geojson")
        if not raw or not raw.get("features"):
            return None
        raw.pop("meta", None)
        return raw

    payload = three_tier(live, cache_tier, _empty_buses, "buses.geojson")

    # Honesty pass. `dct:valid` is only 30s, so a strictly-expired payload is the
    # NORMAL case and must not cry wolf; the layer is called degraded only when
    # the feed itself has stopped moving (ingest.feeds.buses.STALE_AFTER_S).
    if payload.get("feedStale"):
        m = payload["meta"]
        m["degraded"] = True
        age = payload.get("feedAgeSeconds")
        extra = (f"ODPT bus feed is {age}s behind — positions shown are the last "
                 f"known ones, not current")
        m["note"] = f"{m['note']}; {extra}" if m.get("note") else extra
    return payload


def _produce_busroutes() -> dict[str, Any]:
    """Static route geometry, built offline by mock/_tools/gen_buses.py. There is
    no live tier: ODPT's shapes change on a multi-day cadence, and re-fetching
    3.3 MB of BusroutePattern per request would be absurd."""
    def cache_tier():
        raw = read_mock("busroutes.geojson")
        if not raw or not raw.get("features"):
            return None
        raw.pop("meta", None)
        return raw

    payload = three_tier(lambda: None, cache_tier, _empty_fc, "busroutes.geojson")
    # three_tier calls a file-backed static layer "cache"; that is accurate, but
    # it is not a FAILURE, so do not raise the UI's amber degraded badge for it.
    if (payload.get("meta") or {}).get("source") == "cache" and payload.get("features"):
        payload["meta"]["degraded"] = False
        payload["meta"]["note"] = (
            "static ODPT route geometry (road-following ug:region shapes), "
            "23-ward bbox, deduplicated and simplified")
    return payload


def _produce_busstops() -> dict[str, Any]:
    def cache_tier():
        raw = read_mock("busstops.geojson")
        if not raw or not raw.get("features"):
            return None
        raw.pop("meta", None)
        return raw

    payload = three_tier(lambda: None, cache_tier, _empty_fc, "busstops.geojson")
    if (payload.get("meta") or {}).get("source") == "cache" and payload.get("features"):
        payload["meta"]["degraded"] = False
        payload["meta"]["note"] = "static ODPT bus stop poles, 23-ward bbox"
    return payload


# ─────────────────────────── wards.geojson (A12) ─────────────────────────────
# Ward polygon boundaries, generated offline by mock/_tools/gen_wards_geojson.py
# from OpenStreetMap (Overpass, admin_level=7 relations, ODbL), Douglas-Peucker
# simplified. No live tier: ward boundaries do not change during a demo. Lets
# A6 shade an affected ward for a JMA warning instead of dropping a pin — the
# human's explicit ask ("a shaded ward is far more legible than a dot").
# Not in contracts/api.md (frozen before this existed) -- same precedent as
# A11's /busroutes.geojson and /busstops.geojson, added post-freeze.
TTL_WARDS_GEOJSON = 3600.0


def _produce_wards_geojson() -> dict[str, Any]:
    def cache_tier():
        raw = read_mock("wards.geojson")
        if not raw or not raw.get("features"):
            return None
        raw.pop("meta", None)
        return raw

    payload = three_tier(lambda: None, cache_tier, _empty_fc, "wards.geojson")
    if (payload.get("meta") or {}).get("source") == "cache" and payload.get("features"):
        payload["meta"]["degraded"] = False
        payload["meta"]["note"] = (
            f"{len(payload['features'])} ward polygons, simplified from OpenStreetMap "
            "(Overpass admin_level=7, ODbL) -- static, no live tier")
    return payload


# ───────────────── bus ENTITY BUDGET (orchestrator constraint) ───────────────
# A6 dragged this map from 5,651 rail polylines / 506ms rebuilds down to 415
# polylines / 575 entities / p95 1.2ms frame, because the human asked for "a
# simple map, not heavy on the frontend". Serving all three bus layers whole
# would add 651 + 3,322 + 368 = 4,341 entities and undo exactly that work.
#
# So the BUDGET IS ENFORCED HERE, in the API, not left to the map agent:
#   /buses.geojson       ~368 Points, cheap, the actual wow  -> served whole
#   /busroutes.geojson   651 polylines                        -> OPT-IN, scoped
#   /busstops.geojson    3,322 Points                         -> OPT-IN, scoped
# Asking either static endpoint for everything is still possible (`all=1`) but
# you have to mean it, and the response says what it cost you.
BUS_ROUTE_LIMIT = 40            # max polylines per scoped request
BUS_STOP_LIMIT = 400            # max stop points per scoped request


def _parse_bbox(raw: str | None) -> tuple[float, float, float, float] | None:
    """`minLon,minLat,maxLon,maxLat`. Returns None for anything unparseable —
    a bad bbox must degrade to "no bbox filter", never to a 500."""
    if not raw:
        return None
    try:
        parts = [float(x) for x in str(raw).split(",")]
    except ValueError:
        return None
    if len(parts) != 4:
        return None
    a, b, c, d = parts
    return (min(a, c), min(b, d), max(a, c), max(b, d))


def _pt_in_bbox(coords: list[float], box) -> bool:
    return box[0] <= coords[0] <= box[2] and box[1] <= coords[1] <= box[3]


def _line_hits_bbox(coords: list[list[float]], box) -> bool:
    return any(_pt_in_bbox(c, box) for c in coords)


def _route_prefix(route_id: str | None) -> str | None:
    """Accepts `Toei.T01`, `T01`, or a full patternId `Toei.T01.8501.1`."""
    if not route_id:
        return None
    r = route_id.strip()
    if not r:
        return None
    return r if r.startswith("Toei.") else f"Toei.{r}"


def _produce_busroutes_scoped(routeId: str | None, bbox: str | None,
                              want_all: bool, limit: int | None) -> dict[str, Any]:
    base = _produce_busroutes()
    feats = base.get("features") or []
    total = len(feats)
    route_ids = sorted({(f.get("properties") or {}).get("routeId")
                        for f in feats if (f.get("properties") or {}).get("routeId")})
    m = dict(base.get("meta") or meta("mock", True))

    if not (routeId or bbox or want_all):
        # The default is DELIBERATELY empty: 651 polylines next to the 415 rail
        # polylines would swamp the PRD's core story, visually and in frame time.
        out = {"type": "FeatureCollection", "features": [],
               "routeCount": 0, "availableFeatures": total,
               "availableRouteIds": route_ids, "scope": "none"}
        # Empty-by-choice is NOT degraded; empty-because-the-file-is-gone IS.
        # Only a layer that actually has data may clear the amber badge.
        if total == 0:
            return dict(out, meta=m)
        m["degraded"] = False
        m["note"] = (f"opt-in layer: {total} route polylines available, none served. "
                     f"Pass ?routeId=<id> (see availableRouteIds), ?bbox=minLon,"
                     f"minLat,maxLon,maxLat, or ?all=1 to accept the full cost.")
        out["meta"] = m
        return out

    scope = []
    prefix = _route_prefix(routeId)
    if prefix:
        feats = [f for f in feats
                 if str((f.get("properties") or {}).get("routeId") or "") == prefix
                 or str((f.get("properties") or {}).get("patternId") or "").startswith(prefix + ".")]
        scope.append(f"routeId={prefix}")
    box = _parse_bbox(bbox)
    if box:
        feats = [f for f in feats
                 if _line_hits_bbox((f.get("geometry") or {}).get("coordinates") or [], box)]
        scope.append("bbox")
    cap = BUS_ROUTE_LIMIT if limit is None else max(1, min(int(limit), total))
    if want_all and limit is None:
        cap = total
        scope.append("all=1")
    truncated = len(feats) > cap
    feats = feats[:cap]

    out = {"type": "FeatureCollection", "features": feats,
           "routeCount": len(feats), "availableFeatures": total,
           "availableRouteIds": route_ids, "scope": ",".join(scope) or "all",
           "truncated": truncated}
    if total == 0:
        return dict(out, meta=m)        # no geometry on disk -> stay degraded
    m["degraded"] = False
    vertices = sum(len((f.get("geometry") or {}).get("coordinates") or []) for f in feats)
    note = (f"{len(feats)} of {total} route polylines ({vertices} vertices). "
            "Road-following ODPT ug:region shapes, 23-ward bbox, deduplicated, "
            "Douglas-Peucker simplified to ~13 m.")
    if truncated:
        note += f" Truncated at {cap}; raise ?limit= or narrow the scope."
    m["note"] = note
    out["meta"] = m
    return out


def _produce_busstops_scoped(routeId: str | None, bbox: str | None,
                             want_all: bool, limit: int | None) -> dict[str, Any]:
    base = _produce_busstops()
    feats = base.get("features") or []
    total = len(feats)
    m = dict(base.get("meta") or meta("mock", True))

    if not (routeId or bbox or want_all):
        out = {"type": "FeatureCollection", "features": [], "stopCount": 0,
               "availableFeatures": total, "scope": "none"}
        if total == 0:
            return dict(out, meta=m)    # no stops on disk -> stay degraded
        m["degraded"] = False
        m["note"] = (f"opt-in layer: {total} bus stop poles available, none served. "
                     "Bus stops are noise at city zoom — pass ?routeId=<id> to get "
                     "one route's stops, ?bbox=minLon,minLat,maxLon,maxLat for a "
                     "viewport, or ?all=1 to accept the full cost.")
        out["meta"] = m
        return out

    scope = []
    prefix = _route_prefix(routeId)
    if prefix:
        # Route -> stop membership comes from the static BusroutePattern index,
        # so busstops.geojson does not have to carry a route list per pole
        # (that would have added ~200 KB to a file the map already downloads).
        wanted: set[str] = set()
        try:
            from ingest.feeds import buses as buses_feed
            patterns = buses_feed.load_static()["patterns"]
            for pid, pat in patterns.items():
                if pid == prefix or pid.startswith(prefix + "."):
                    for s in pat.get("stops") or []:
                        if s:
                            wanted.add(s.replace("odpt.BusstopPole:", ""))
        except Exception:
            log.warning("bus stop routeId filter unavailable (no static index)")
        if wanted:
            feats = [f for f in feats
                     if (f.get("properties") or {}).get("stopId") in wanted]
            scope.append(f"routeId={prefix}")
        else:
            feats = []
            scope.append(f"routeId={prefix} (no match)")
    box = _parse_bbox(bbox)
    if box:
        feats = [f for f in feats
                 if _pt_in_bbox((f.get("geometry") or {}).get("coordinates") or [0, 0], box)]
        scope.append("bbox")

    cap = BUS_STOP_LIMIT if limit is None else max(1, min(int(limit), total))
    if want_all and limit is None:
        cap = total
        scope.append("all=1")
    truncated = len(feats) > cap
    feats = feats[:cap]        # busstops.geojson is pre-sorted by routeCount DESC,
                               # so a truncated viewport keeps the busiest poles

    out = {"type": "FeatureCollection", "features": feats, "stopCount": len(feats),
           "availableFeatures": total, "scope": ",".join(scope) or "all",
           "truncated": truncated}
    if total == 0:
        return dict(out, meta=m)        # no stops on disk -> stay degraded
    m["degraded"] = False
    m["note"] = (f"{len(feats)} of {total} Toei bus stop poles"
                 + (f"; truncated at {cap} (busiest poles first)" if truncated else ""))
    out["meta"] = m
    return out


def _produce_buses_scoped(routeId: str | None, bbox: str | None,
                          limit: int | None) -> dict[str, Any]:
    base = _produce_buses()
    if not (routeId or bbox or limit):
        return base
    feats = base.get("features") or []
    total = len(feats)
    prefix = _route_prefix(routeId)
    if prefix:
        feats = [f for f in feats
                 if str((f.get("properties") or {}).get("routeId") or "") == prefix]
    box = _parse_bbox(bbox)
    if box:
        feats = [f for f in feats
                 if _pt_in_bbox((f.get("geometry") or {}).get("coordinates") or [0, 0], box)]
    if limit:
        feats = feats[:max(1, int(limit))]
    out = dict(base)
    out["features"] = feats
    out["busCount"] = len(feats)
    out["interpolatedCount"] = sum(
        1 for f in feats if (f.get("properties") or {}).get("positionSource") == "interpolated")
    out["atStopCount"] = len(feats) - out["interpolatedCount"]
    out["availableFeatures"] = total
    m = dict(base.get("meta") or meta("mock", True))
    extra = f"filtered to {len(feats)} of {total} live vehicles"
    m["note"] = f"{m['note']}; {extra}" if m.get("note") else extra
    out["meta"] = m
    return out


LAYER_LABELS = {
    "trains": "Train lines", "quakes": "Earthquakes", "warnings": "JMA warnings",
    "weather": "Weather", "flood": "Flood hazard", "crowd": "Station crowding",
    "peopleflow": "People flow (typical)", "buses": "Toei buses (derived)",
    "weathergrid": "Weather surface (gridded)",
}


def _empty_layers() -> dict[str, Any]:
    stamp = now_iso()
    return {"layers": [{"id": k, "label": v, "state": "mock", "count": 0,
                        "lastUpdate": stamp} for k, v in LAYER_LABELS.items()]}


def _produce_layers() -> dict[str, Any]:
    """Composed entirely from the other endpoints' cached payloads — zero extra
    Cypher on the hot path."""
    stamp = now_iso()
    since = _since_iso("now", None)
    ev_key = _events_key(200, None, None, since, "now")
    ev = _cached_payload(ev_key) or _produce_events(200, None, None, since, True)
    ev_state = (ev.get("meta") or {}).get("source", "mock")
    counts = ev.get("counts") or dict(EMPTY_COUNTS)

    lines = _cached_payload("lines.geojson") or _produce_lines()
    line_state = (lines.get("meta") or {}).get("source", "mock")
    live_lines = sum(1 for f in lines.get("features") or []
                     if (f.get("properties") or {}).get("statusSource") == "live")
    train_count = live_lines or sum(1 for f in lines.get("features") or []
                                    if (f.get("properties") or {}).get("status") != "unknown")

    stations = _cached_payload("stations.geojson") or _produce_stations()
    st_state = (stations.get("meta") or {}).get("source", "mock")
    st_feats = stations.get("features") or []
    flood_count = sum(1 for f in st_feats
                      if (f.get("properties") or {}).get("inFloodZone"))

    layers = [
        {"id": "trains", "label": LAYER_LABELS["trains"], "state": line_state,
         "count": train_count, "lastUpdate": stamp},
        {"id": "quakes", "label": LAYER_LABELS["quakes"], "state": ev_state,
         "count": counts.get("quake", 0), "lastUpdate": stamp},
        {"id": "warnings", "label": LAYER_LABELS["warnings"], "state": ev_state,
         "count": counts.get("warning", 0), "lastUpdate": stamp},
        {"id": "weather", "label": LAYER_LABELS["weather"], "state": ev_state,
         "count": counts.get("weather", 0), "lastUpdate": stamp},
        {"id": "flood", "label": LAYER_LABELS["flood"], "state": st_state,
         "count": flood_count, "lastUpdate": stamp},
        {"id": "crowd", "label": LAYER_LABELS["crowd"], "state": st_state,
         "count": len(st_feats), "lastUpdate": stamp},
        # Honest: no people-flow dataset is wired in this build.
        {"id": "peopleflow", "label": LAYER_LABELS["peopleflow"], "state": "off",
         "count": 0, "lastUpdate": stamp},
    ]

    # Buses: computed the same way as every other row — from the endpoint's own
    # cached payload, never hardcoded. Uses the cached copy if the poller has
    # one, and does NOT force a live ODPT fetch just to render a layer badge.
    bus = _cached_payload("buses.geojson")
    if bus is None:
        bus_state, bus_count, bus_update = "off", 0, stamp
    else:
        bus_meta = bus.get("meta") or {}
        bus_state = bus_meta.get("source", "mock")
        if bus_state == "live" and bus.get("feedStale"):
            bus_state = "cache"          # live connection, stale content
        bus_count = bus.get("busCount") or len(bus.get("features") or [])
        bus_update = bus.get("feedTime") or stamp
    layers.append({"id": "buses", "label": LAYER_LABELS["buses"],
                   "state": bus_state, "count": bus_count,
                   "lastUpdate": bus_update})

    # Weather surface: honest count = actual grid points served, from the
    # cache the endpoint itself already warms (no extra Open-Meteo call here).
    wg_key = f"weathergrid:{WEATHERGRID_DEFAULT_STEP}|{','.join(WEATHERGRID_VARS)}"
    wg = _cached_payload(wg_key)
    if wg is None:
        wg_state, wg_count, wg_update = "off", 0, stamp
    else:
        wg_meta = wg.get("meta") or {}
        wg_state = wg_meta.get("source", "mock")
        wg_count = (wg.get("rows") or 0) * (wg.get("cols") or 0)
        wg_update = wg_meta.get("generatedAt") or stamp
    layers.append({"id": "weathergrid", "label": LAYER_LABELS["weathergrid"],
                   "state": wg_state, "count": wg_count, "lastUpdate": wg_update})
    up, note = graph.neo4j_status()
    return {"layers": layers,
            "meta": meta("live" if up else "cache", not up,
                         None if up else (f"Neo4j down: {note}" if note else "Neo4j down"))}


# ──────────────────────────────── endpoints ──────────────────────────────────
# All sync `def`: blocking clients must not run on the event loop.

@app.get("/health")
def health() -> Response:
    return cache.serve("health", TTL_HEALTH, _produce_health, "health",
                       lambda: {"ok": True, "neo4j": "down", "eventCount": 0})


@app.get("/events.json")
def events_json(
    limit: str | None = Query(None, description="default 30, max 200"),
    type: str | None = Query(None, description="csv of quake,train,warning,weather"),
    severity: str | None = Query(None, description="minimum level: info|warning|critical"),
    since: str | None = Query(None, description="ISO8601"),
    window: str | None = Query(None, description="now (last 6h, default) | 7d"),
) -> Response:
    n = _clamp_limit(limit)
    types = _csv_list(type, TYPES)
    sevs = _severities_at_least(severity)
    since_iso = _since_iso(window, since)
    # An explicit ?since= is a literal request: honour it verbatim, no state union.
    now_window = (not since) and (window or "now").lower() != "7d"
    key = _events_key(n, types, sevs, since_iso, window)
    return cache.serve(key, TTL_EVENTS,
                       lambda: _produce_events(n, types, sevs, since_iso, now_window),
                       "events.json", _empty_events)


@app.get("/lines.geojson")
def lines_geojson() -> Response:
    return cache.serve("lines.geojson", TTL_LINES, _produce_lines,
                       "lines.geojson", _empty_lines)


@app.get("/stations.geojson")
def stations_geojson() -> Response:
    return cache.serve("stations.geojson", TTL_STATIONS, _produce_stations,
                       "stations.geojson", _empty_fc)


@app.get("/impact/{lineId}")
def impact(lineId: str) -> Response:
    row = next((r for r in lines_csv() if r.get("lineId") == lineId), None)
    if row is None:
        # The one legitimate non-200 in this API: a genuine client error.
        # Body is exactly as documented in contracts/api.md (no FastAPI "detail").
        return JSONResponse(status_code=404,
                            content={"error": "unknown lineId", "lineId": lineId})
    return cache.serve(f"impact:{lineId}", TTL_IMPACT,
                       lambda: _produce_impact(lineId, row), f"impact/{lineId}",
                       lambda: _empty_impact(lineId, row))


@app.get("/forecast.json")
def forecast_json() -> Response:
    return cache.serve("forecast.json", TTL_FORECAST, _produce_forecast,
                       "forecast.json", _empty_forecast)


@app.get("/weathergrid.json")
def weathergrid_json(step: str | None = Query(None, description="0.25 | 0.125 (default) | 0.0625"),
                     var: str | None = Query(None, description="csv of temperature_2m,precipitation")) -> Response:
    """Gridded weather field for a bilinear-interpolated map surface (see
    contracts/api.md). Default bbox lat 35.30-36.05 / lon 139.20-140.20,
    default step 0.125 (7x9 = 63 points, one Open-Meteo request). `?step=`
    snaps to the nearest contracted value; an unrecognised one degrades to
    the default rather than 500ing. The bbox itself is fixed (not caller
    supplied) precisely so the point-count guard cannot be bypassed."""
    step_val, step_note = _weathergrid_step(step)
    var_keys, var_note = _weathergrid_vars(var)
    key = f"weathergrid:{step_val}|{','.join(var_keys)}"
    lats, lons = _weathergrid_axes(step_val)
    payload = cache.serve(key, TTL_WEATHERGRID,
                          lambda: _produce_weathergrid(step_val, var_keys),
                          "weathergrid.json",
                          lambda: _empty_weathergrid(step_val, lats, lons, var_keys))
    extra = "; ".join(n for n in (step_note, var_note) if n)
    if extra:
        # Response is already a serialized Response object from cache.serve;
        # a bad query param is rare enough to pay the re-encode cost for an
        # honest note rather than threading this through the cache layer.
        body = json.loads(payload.body)
        m = body.get("meta") or {}
        m["note"] = f"{m['note']}; {extra}" if m.get("note") else extra
        body["meta"] = m
        # Strip content-length (and any other size-derived header) so
        # Starlette recomputes it for the new, different-length body --
        # reusing the old one truncates the response (curl exit 18).
        headers = {k: v for k, v in payload.headers.items()
                  if k.lower() not in ("content-length", "content-type")}
        return Response(content=json.dumps(body, ensure_ascii=False).encode("utf-8"),
                        media_type="application/json", headers=headers)
    return payload


@app.get("/brief")
def brief() -> Response:
    return cache.serve("brief", TTL_BRIEF, _produce_brief, "brief", _empty_brief)


@app.get("/sandboxes.json")
def sandboxes_json() -> Response:
    return cache.serve("sandboxes.json", TTL_SANDBOXES, _produce_sandboxes,
                       "sandboxes.json", _empty_sandboxes)


@app.get("/buses.geojson")
def buses_geojson(routeId: str | None = Query(None),
                  bbox: str | None = Query(None),
                  limit: int | None = Query(None)) -> Response:
    """Live Toei bus vehicles as Point features (~368 entities — the cheap,
    high-value layer, served whole by default).

    Positions are DERIVED, never GPS: odpt:Bus carries no coordinates, so each
    one is interpolated between its last and next stop. Every feature says which
    via `positionSource` ("interpolated" | "at-stop") and the collection carries
    `positionMethod`. Optional `routeId`, `bbox=minLon,minLat,maxLon,maxLat` and
    `limit` narrow it. Static geometry lives on GET /busroutes.geojson and
    GET /busstops.geojson, which are OPT-IN — see their docstrings."""
    if not (routeId or bbox or limit):
        return cache.serve("buses.geojson", TTL_BUSES, _produce_buses,
                           "buses.geojson", _empty_buses)
    key = f"buses.geojson:{routeId}|{bbox}|{limit}"
    return cache.serve(key, TTL_BUSES,
                       lambda: _produce_buses_scoped(routeId, bbox, limit),
                       "buses.geojson", _empty_buses)


@app.get("/busroutes.geojson")
def busroutes_geojson(routeId: str | None = Query(None),
                      bbox: str | None = Query(None),
                      all: int | None = Query(None),
                      limit: int | None = Query(None)) -> Response:
    """Static Toei bus route polylines — OPT-IN, and empty without a scope.

    651 polylines would sit next to the map's 415 rail polylines and swamp the
    PRD's core story, so an unscoped call returns zero features plus
    `availableRouteIds` for a picker. Pass `routeId=`, `bbox=`, or `all=1`.
    Geometry is ODPT's real road-following `ug:region` shape (NOT stop-to-stop
    straight lines) except for the 9 patterns that ship without one, which are
    tagged `geometrySource: "stop-to-stop"`."""
    key = f"busroutes.geojson:{routeId}|{bbox}|{all}|{limit}"
    return cache.serve(key, TTL_BUSROUTES,
                       lambda: _produce_busroutes_scoped(routeId, bbox, bool(all), limit),
                       "busroutes.geojson", _empty_fc)


@app.get("/busstops.geojson")
def busstops_geojson(routeId: str | None = Query(None),
                     bbox: str | None = Query(None),
                     all: int | None = Query(None),
                     limit: int | None = Query(None)) -> Response:
    """Static Toei bus stop poles — OPT-IN, and empty without a scope.

    3,322 poles are noise at city zoom and would blow the map's entity budget on
    their own. Pass `routeId=` (one route's stops), `bbox=` (a viewport, capped
    at 400 busiest-first), or `all=1`."""
    key = f"busstops.geojson:{routeId}|{bbox}|{all}|{limit}"
    return cache.serve(key, TTL_BUSROUTES,
                       lambda: _produce_busstops_scoped(routeId, bbox, bool(all), limit),
                       "busstops.geojson", _empty_fc)


@app.get("/wards.geojson")
def wards_geojson() -> Response:
    """23 ward polygon boundaries (properties.ward matches contracts/wards.csv
    `ward` + `affects: ["ward:<Ward>"]` on an Event) — so a JMA warning can
    shade the affected ward instead of a pin. Static; not in the frozen
    contracts/api.md (added post-freeze, same precedent as /busroutes.geojson)."""
    return cache.serve("wards.geojson", TTL_WARDS_GEOJSON, _produce_wards_geojson,
                       "wards.geojson", _empty_fc)


@app.get("/layers.json")
def layers_json() -> Response:
    return cache.serve("layers.json", TTL_LAYERS, _produce_layers,
                       "layers.json", _empty_layers)


# ──────────────────────────── POST /demo/replay ──────────────────────────────

def _ward_ja_map() -> list[tuple[str, str]]:
    return [(r["ward"], r.get("wardJa") or "") for r in wards_csv() if r.get("ward")]


# Replay events are re-stamped copies of CACHED REAL payloads, so they carry the
# upstream URL the original data came from. A judge clicking through on the demo's
# scripted quake must land on the real feed, not a dead end — and the REPLAY chip
# already tells them the timestamp was rewritten, so this is not overclaiming.
_REPLAY_SOURCE_URL = {
    "quake":   "https://www.p2pquake.net/",
    "train":   "https://api-public.odpt.org/api/v4/odpt:TrainInformation",
    "warning": "https://www.jma.go.jp/bosai/warning/#area_type=class20s&area_code=130000",
}


def _replay_quake(now: datetime) -> list[dict[str, Any]]:
    """Inject a real cached P2PQuake record as a fresh Event."""
    hist = read_mock("raw/p2pquake-history.json") or []
    recs = [r for r in hist if isinstance(r, dict) and r.get("earthquake")]
    if not recs:
        return []

    def tokyo_points(r):
        return [p for p in (r.get("points") or []) if p.get("pref") == "東京都"]

    tokyo = [r for r in recs if tokyo_points(r)]
    pool = tokyo or recs
    rec = max(pool, key=lambda r: (r.get("earthquake", {}).get("maxScale") or 0))
    eq = rec.get("earthquake") or {}
    hypo = eq.get("hypocenter") or {}
    scale = eq.get("maxScale") or 0
    severity = "critical" if scale >= 45 else "warning" if scale >= 30 else "info"
    shindo = round(scale / 10, 1) if scale else None
    place = hypo.get("name") or "Tokyo area"
    mag = hypo.get("magnitude")
    affects = []
    for ward, ja in _ward_ja_map():
        if ja and any(ja in (p.get("addr") or "") for p in tokyo_points(rec)):
            affects.append(f"ward:{ward}")
    title = f"M{mag} earthquake near {place}" if mag else f"Earthquake near {place}"
    if shindo:
        title += f" — max JMA intensity {shindo}"
    title_ja = f"{place}でM{mag}の地震" if mag else f"{place}で地震"
    if shindo:
        title_ja += f"（最大震度{shindo}）"
    return [{
        # Deterministic id: re-firing the quake beat MERGEs the same node with a
        # fresh timestamp instead of stacking a duplicate earthquake.
        "id": "replay-quake",
        "type": "quake", "severity": severity,
        "time": now.isoformat(),
        "lat": hypo.get("latitude"), "lon": hypo.get("longitude"),
        "title": title, "titleJa": title_ja,
        "affects": affects[:6], "source": "replay", "url": _REPLAY_SOURCE_URL["quake"],
        "magnitude": mag, "maxScale": scale or None,
    }]


def _replay_train(now: datetime) -> list[dict[str, Any]]:
    """Inject the cached ODPT TrainInformation snapshot as fresh train Events."""
    raw = read_mock("raw/odpt-traininformation.json") or []
    by_railway = {r.get("odpt:railway"): r for r in raw if isinstance(r, dict)}
    rows = [r for r in lines_csv() if (r.get("statusFeed") or "") == "live"]
    out: list[dict[str, Any]] = []
    ts = int(now.timestamp())
    for row in rows[:3]:
        rec = by_railway.get(row.get("odptRailway")) or {}
        text_ja = ((rec.get("odpt:trainInformationText") or {}) or {}).get("ja") or ""
        status_ja = ((rec.get("odpt:trainInformationStatus") or {}) or {}).get("ja") or ""
        blob = text_ja + status_ja
        # "現在、１５分以上の遅延はありません。" contains 遅延 but means NORMAL.
        normal = any(k in blob for k in ("ありません", "平常運転", "平常"))
        delayed = (not normal) and any(
            k in blob for k in ("遅延", "運転見合わせ", "運休", "見合わせ", "折り返し"))
        if delayed:
            title = f"{row['name']}: service disruption reported"
            title_ja = f"{row['nameJa']}：{status_ja or text_ja}"
            sev = "critical" if "見合わせ" in blob else "warning"
        else:
            # The cached snapshot is clean; the demo beat needs a delay, so this
            # is an explicitly REPLAY-sourced injection (contract: source=replay).
            title = f"{row['name']}: delays of approx 15 min (replay)"
            title_ja = f"{row['nameJa']}：約15分の遅れ（リプレイ）"
            sev = "warning"
        out.append({
            "id": f"replay-train-{row['lineId']}",
            "type": "train", "severity": sev, "time": now.isoformat(),
            "lat": None, "lon": None,
            "title": title, "titleJa": title_ja,
            "affects": [f"line:{row['lineId']}"],
            "source": "replay", "url": _REPLAY_SOURCE_URL["train"], "magnitude": None, "maxScale": None,
        })
        # P0-2: the Event alone is not enough — /lines.geojson and /impact/{id}
        # both read (:Line).status directly, so stamp it here too, honestly
        # tagged statusSource='replay' (never 'live' — this is not a live feed
        # read). /demo/reset reverts this via REPLAY_STAMPED_LINES.
        line_status = {"critical": "suspended", "warning": "delay"}.get(sev, "normal")
        try:
            graph.set_line_status(
                row["lineId"], line_status, title, title_ja,
                statusSource="replay", updatedAt=now.isoformat(),
            )
            REPLAY_STAMPED_LINES.add(row["lineId"])
        except Exception as exc:
            log.warning("replay: could not stamp Line %s status (%s) — "
                        "Event still written, /lines.geojson may lag until "
                        "Neo4j is back", row["lineId"], exc)
    return out


def _replay_warning(now: datetime) -> list[dict[str, Any]]:
    """Inject the cached JMA Tokyo (130000) warning payload as fresh Events."""
    raw = read_mock("raw/jma-warning-130000.json") or {}
    head = (raw.get("headlineText") or "").strip()
    out: list[dict[str, Any]] = []
    if head:
        out.append({
            "id": "replay-warning-headline",
            "type": "warning", "severity": "warning", "time": now.isoformat(),
            "lat": None, "lon": None,
            "title": "JMA advisory headline for Tokyo (see Japanese text)",
            "titleJa": head[:180],
            "affects": [], "source": "replay",
            "url": env_str("FEED_JMA_WARNING") or None,
            "magnitude": None, "maxScale": None,
        })
    wards = wards_csv()
    for at in raw.get("areaTypes") or []:
        for area in at.get("areas") or []:
            code = str(area.get("code") or "")
            if not code.startswith("131") or len(code) != 7:
                continue
            codes = [w.get("code") for w in area.get("warnings") or [] if w.get("code")]
            if not codes:
                continue
            idx = (int(code) - 1310100) // 100
            if not (0 <= idx < len(wards)):
                continue
            w = wards[idx]
            out.append({
                "id": f"replay-warning-{w['ward']}",
                "type": "warning", "severity": "warning", "time": now.isoformat(),
                "lat": float(w["lat"]), "lon": float(w["lon"]),
                "title": f"JMA weather advisory active for {w['ward']} "
                         f"(code {'/'.join(codes)})",
                "titleJa": f"{w['wardJa']}に気象注意報が発表中（コード{'/'.join(codes)}）",
                "affects": [f"ward:{w['ward']}"], "source": "replay",
                "url": env_str("FEED_JMA_WARNING") or None,
                "magnitude": None, "maxScale": None,
            })
            if len(out) >= 5:
                return out
    if len(out) <= 1:
        # Cached snapshot had no ward-level advisories: give the beat one event.
        w = next((x for x in wards if x["ward"] == "Koto"), wards[0])
        out.append({
            "id": f"replay-warning-{w['ward']}",
            "type": "warning", "severity": "warning", "time": now.isoformat(),
            "lat": float(w["lat"]), "lon": float(w["lon"]),
            "title": f"Heavy rain advisory for {w['ward']} (replay)",
            "titleJa": f"{w['wardJa']}に大雨注意報（リプレイ）",
            "affects": [f"ward:{w['ward']}"], "source": "replay",
            "url": env_str("FEED_JMA_WARNING") or None,
            "magnitude": None, "maxScale": None,
        })
    return out


SCENARIOS = {"quake": _replay_quake, "train": _replay_train, "warning": _replay_warning}


@app.post("/demo/replay")
def demo_replay(body: dict[str, Any] = Body(default=None)) -> dict[str, Any]:
    raw_scenario = str(((body or {}).get("scenario") or "quake")).strip().lower()
    scenario = raw_scenario if raw_scenario in SCENARIOS else "quake"
    note = None if scenario == raw_scenario else f"unknown scenario {raw_scenario!r}, replayed quake"

    now = now_jst().replace(microsecond=0)
    try:
        events = SCENARIOS[scenario](now) or []
    except Exception as exc:
        log.exception("replay builder failed")
        events, note = [], f"replay builder failed: {type(exc).__name__}"

    # In-memory first: the beat fires even with Neo4j down. Same-id events
    # REPLACE the previous copy, matching the graph's MERGE semantics.
    new_ids = {e.get("id") for e in events}
    kept = [e for e in REPLAY if e.get("id") not in new_ids]
    REPLAY[:] = (kept + events)[-REPLAY_CAP:]

    written = 0
    try:
        written = graph.upsert_events(events)
        src, degraded = "live", False
    except Exception as exc:
        src, degraded = "mock", True
        reason = f"Neo4j unavailable ({type(exc).__name__}) — events held in API memory"
        note = f"{note}; {reason}" if note else reason

    if not events:
        src, degraded = "mock", True
        note = note or "no cached payload in mock/raw for this scenario"

    # The injected events must show up on the very next poll, not one TTL later.
    # "lines.geojson" is included (P0-2): a replay-train beat stamps (:Line)
    # status above, and without this the polyline stays its old colour for up
    # to TTL_LINES while /impact/{id} already shows the new status — the exact
    # on-screen contradiction this fix closes.
    for prefix in ("events:", "layers.json", "brief", "impact:", "health",
                   "lines.geojson"):
        cache.invalidate(prefix)

    return {"injected": len(events), "scenario": scenario, "written": written,
            "events": events, "meta": meta(src, degraded, note)}


@app.post("/demo/reset")
def demo_reset() -> dict[str, Any]:
    """Demo-control: wipe everything `/demo/replay` injected, leaving real
    ingested events untouched. Use between a rehearsal and the live run.

        curl -X POST http://127.0.0.1:8000/demo/reset

    Returns {"deleted": <Events removed from the graph>, "cleared": <held in
    memory>, "meta": {...}}. Never 500s: if Neo4j is unreachable the in-memory
    replay list is still cleared and `meta` says so.
    """
    held = len(REPLAY)
    REPLAY.clear()
    deleted, src, degraded, note = 0, "live", False, None
    try:
        deleted = graph.delete_replay_events()
    except Exception as exc:
        src, degraded = "mock", True
        note = (f"Neo4j unavailable ({type(exc).__name__}) — cleared {held} in-memory "
                f"replay events only")
        log.warning("demo/reset: %s", note)

    # P0-2: undo _replay_train's direct Line.status stamp too, or reset leaves
    # every replayed line stuck amber after the real delay Events are gone.
    stamped = sorted(REPLAY_STAMPED_LINES)
    reverted: list[str] = []
    for lineId in stamped:
        try:
            graph.revert_line_status(lineId)
            reverted.append(lineId)
        except Exception as exc:
            src, degraded = "mock", True
            note = (f"{note}; " if note else "") + (
                f"could not revert Line {lineId} status ({type(exc).__name__})")
            log.warning("demo/reset: %s", note)
    REPLAY_STAMPED_LINES.difference_update(reverted)

    for prefix in ("events:", "layers.json", "brief", "impact:", "health",
                   "lines.geojson"):
        cache.invalidate(prefix)

    return {"deleted": deleted, "cleared": held, "linesReverted": reverted,
            "meta": meta(src, degraded, note)}


# ─────────────────────────── startup: warm everything ────────────────────────

@app.on_event("startup")
def _warm_on_startup() -> None:
    """Connect the driver and fill the cache off the request path, then keep it
    warm. Nothing here can fail the boot."""
    import threading

    def warm():
        t0 = time.monotonic()
        up, note = graph.neo4j_status(force=True)   # builds driver + routing table
        log.info("startup: neo4j %s (%.2fs) %s", "up" if up else "down",
                 time.monotonic() - t0, note or "")
        since_now = _since_iso("now", None)
        cache.prime("health", TTL_HEALTH, _produce_health, "health")
        cache.prime("lines.geojson", TTL_LINES, _produce_lines, "lines.geojson")
        cache.prime("stations.geojson", TTL_STATIONS, _produce_stations, "stations.geojson")
        cache.prime("forecast.json", TTL_FORECAST, _produce_forecast, "forecast.json")
        cache.prime(f"weathergrid:{WEATHERGRID_DEFAULT_STEP}|{','.join(WEATHERGRID_VARS)}",
                    TTL_WEATHERGRID,
                    lambda: _produce_weathergrid(WEATHERGRID_DEFAULT_STEP, WEATHERGRID_VARS),
                    "weathergrid.json")
        cache.prime("sandboxes.json", TTL_SANDBOXES, _produce_sandboxes, "sandboxes.json")
        cache.prime("wards.geojson", TTL_WARDS_GEOJSON, _produce_wards_geojson, "wards.geojson")
        cache.prime("busroutes.geojson:None|None|None|None", TTL_BUSROUTES,
                    lambda: _produce_busroutes_scoped(None, None, False, None),
                    "busroutes.geojson")
        cache.prime("busstops.geojson:None|None|None|None", TTL_BUSROUTES,
                    lambda: _produce_busstops_scoped(None, None, False, None),
                    "busstops.geojson")
        # Parse the 9 MB static stop/route index off the request path, THEN take
        # the first live fetch — otherwise the demo's first /buses.geojson pays
        # for both and looks broken.
        try:
            from ingest.feeds import buses as _buses_feed
            _buses_feed.load_static()
        except Exception:
            log.warning("startup: bus static index unavailable; /buses.geojson will use mock/")
        cache.prime("buses.geojson", TTL_BUSES, _produce_buses, "buses.geojson")
        # the query shapes the UI actually polls
        for n in (30, 60):
            k = _events_key(n, None, None, since_now, "now")
            cache.prime(k, TTL_EVENTS,
                        lambda n=n, s=since_now: _produce_events(n, None, None, s, True),
                        "events.json")
        k200 = _events_key(200, None, None, since_now, "now")
        cache.prime(k200, TTL_EVENTS,
                    lambda s=since_now: _produce_events(200, None, None, s, True),
                    "events.json")
        cache.prime("layers.json", TTL_LAYERS, _produce_layers, "layers.json")
        cache.prime("brief", TTL_BRIEF, _produce_brief, "brief")
        # demo beat 3: the six lines with a live feed are pre-warmed
        for row in lines_csv():
            if (row.get("statusFeed") or "") == "live":
                lid = row["lineId"]
                cache.prime(f"impact:{lid}", TTL_IMPACT,
                            lambda lid=lid, row=row: _produce_impact(lid, row),
                            f"impact/{lid}")
        log.info("startup: cache primed in %.2fs — %s", time.monotonic() - t0,
                 cache.stats()["keys"])
        cache.start_prefetch_loop(3.0)

    threading.Thread(target=warm, name="startup-warm", daemon=True).start()


# ─────────────────────────────────── root ────────────────────────────────────

@app.get("/")
def root() -> dict[str, Any]:
    up, _ = graph.neo4j_status()
    return {
        "service": "TokyoPulse API", "neo4j": "up" if up else "down",
        "endpoints": ["/health", "/events.json", "/lines.geojson", "/stations.geojson",
                      "/impact/{lineId}", "/forecast.json", "/weathergrid.json", "/brief",
                      "/sandboxes.json", "/layers.json", "/buses.geojson",
                      "/busroutes.geojson", "/busstops.geojson", "/wards.geojson",
                      "POST /demo/replay"],
        "meta": meta("live" if up else "cache", not up),
    }


@app.get("/debug/cache")
def debug_cache() -> dict[str, Any]:
    """Not in the frozen contract — an ops view of tier 0 for the orchestrator."""
    return {"cache": cache.stats(), "replayHeld": len(REPLAY),
            "meta": meta("live", False, None)}
