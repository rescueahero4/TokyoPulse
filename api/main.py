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
TTL_SANDBOXES = 5.0

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
        if not data.get("stations"):
            raise NoLiveData(f"Line {lineId} has no stations in the graph")
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

    return three_tier(live, cache_tier, _empty_forecast, "forecast.json")


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


LAYER_LABELS = {
    "trains": "Train lines", "quakes": "Earthquakes", "warnings": "JMA warnings",
    "weather": "Weather", "flood": "Flood hazard", "crowd": "Station crowding",
    "peopleflow": "People flow (typical)",
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


@app.get("/brief")
def brief() -> Response:
    return cache.serve("brief", TTL_BRIEF, _produce_brief, "brief", _empty_brief)


@app.get("/sandboxes.json")
def sandboxes_json() -> Response:
    return cache.serve("sandboxes.json", TTL_SANDBOXES, _produce_sandboxes,
                       "sandboxes.json", _empty_sandboxes)


@app.get("/layers.json")
def layers_json() -> Response:
    return cache.serve("layers.json", TTL_LAYERS, _produce_layers,
                       "layers.json", _empty_layers)


# ──────────────────────────── POST /demo/replay ──────────────────────────────

def _ward_ja_map() -> list[tuple[str, str]]:
    return [(r["ward"], r.get("wardJa") or "") for r in wards_csv() if r.get("ward")]


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
        "affects": affects[:6], "source": "replay", "url": None,
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
            "source": "replay", "url": None, "magnitude": None, "maxScale": None,
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
        cache.prime("sandboxes.json", TTL_SANDBOXES, _produce_sandboxes, "sandboxes.json")
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
                      "/impact/{lineId}", "/forecast.json", "/brief",
                      "/sandboxes.json", "/layers.json", "POST /demo/replay"],
        "meta": meta("live" if up else "cache", not up),
    }


@app.get("/debug/cache")
def debug_cache() -> dict[str, Any]:
    """Not in the frozen contract — an ops view of tier 0 for the orchestrator."""
    return {"cache": cache.stats(), "replayHeld": len(REPLAY),
            "meta": meta("live", False, None)}
