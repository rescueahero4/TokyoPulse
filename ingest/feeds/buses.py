"""
ingest/feeds/buses.py — live Toei bus positions (A11 scope).

Recovers the stretch goal `doc/prd.md` §3.5 cut for lack of an ODPT token: the
KEYLESS mirror carries `odpt:Bus` after all (contracts/feeds.json, three
`odpt_bus*` rows).

## THE ONE THING TO UNDERSTAND: these are NOT GPS positions

`odpt:Bus` vehicles carry **no coordinates at all**. Each one says only "I left
stop A at 19:30:41 and I am heading to stop B". A position is therefore
DERIVED, never observed:

    fraction = (dc:date - odpt:fromBusstopPoleTime) / (road distance A->B / BUS_SPEED_KMH)
    clamped to [0, 1], then walked along the pattern's real road polyline.

Every feature says so in `positionSource` + `positionMethod`, and a bus we
cannot place defensibly is snapped to its NEXT stop with
`positionSource: "at-stop"` rather than floated at an invented point.
`BUS_SPEED_KMH` is not a guess: `mock/_tools/gen_buses.py --calibrate` derives
it from real `odpt:BusTimetable` scheduled leg durations.

## Buses write NO Events, by design

`contracts/event.schema.json` is frozen with `type` enum
`quake|train|warning|weather` — there is no `bus`. And 376 routine vehicle
positions in the timeline would bury the earthquake and the delays, the exact
mistake already fixed for weather and for train "normal operation" rows. Buses
are a MAP LAYER, served by `GET /buses.geojson`. `normalize_events()` exists,
returns `[]`, and documents why.

## Split of responsibilities (same as trains.py / jreast.py)

    fetch()        HOST ONLY. httpx egress + reads the static stop/route index
                   off disk, and embeds the ~400-entry subset it needs.
    normalize()    PURE. stdlib only, no network, no disk, no clock — it uses
                   the feed's own `dc:date` as the observation time, so the same
                   payload in always gives the same positions out. This is the
                   function A2's launcher runs inside a Daytona sandbox.

LAUNCHER NOTE FOR A2: `normalize()` here returns a GeoJSON-shaped dict (the map
layer), not `list[Event]` like the other five feeds. If you register a 6th
sandbox, take its Events from `normalize_events()` (always `[]`) and its
payload from `normalize()`; do not feed `normalize()`'s dict into `upsert()`.
"""

from __future__ import annotations

import json
import math
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

FEED_NAME = "buses"

BUS_URL = "https://api-public.odpt.org/api/v4/odpt:Bus"
JST = timezone(timedelta(hours=9))

# MEASURED, not guessed: median of 416 real scheduled legs across 21
# odpt:BusTimetable rows, road distance / scheduled duration (mean 13.8, p25
# 8.7, p75 16.6 km/h). Re-derive: mock/_tools/gen_buses.py --calibrate
BUS_SPEED_KMH = 12.3
BUS_SPEED_MPS = BUS_SPEED_KMH * 1000.0 / 3600.0

POSITION_METHOD = (
    "derived: elapsed since odpt:fromBusstopPoleTime / (road distance to the next "
    f"stop at a calibrated {BUS_SPEED_KMH} km/h), walked along the ODPT road "
    "polyline. NOT GPS — odpt:Bus carries no coordinates."
)
ATTRIBUTION = "Toei bus data from the Public Transportation Open Data Center (ODPT)"

# Each odpt:Bus row carries `dct:valid` = dc:date + 30s, so on a normal fetch
# EVERY vehicle is already past its stated validity by the time we serve it —
# flagging the whole fleet "stale" on that alone would be alarmist noise. The
# per-feature `stale` flag stays strictly honest (valid < fetchedAt), and the
# LAYER is only called degraded when the feed itself has genuinely stopped
# moving: feedAgeSeconds past this threshold.
STALE_AFTER_S = 120

# 23-ward bounding box — identical to mock/_tools/gen_buses.py, so the vehicle
# layer and the route layer cover exactly the same ground.
BBOX = {"lon": (139.55, 139.95), "lat": (35.52, 35.82)}

_P_POLE = "odpt.BusstopPole:"
_P_PATTERN = "odpt.BusroutePattern:"
_P_ROUTE = "odpt.Busroute:"
_P_OPERATOR = "odpt.Operator:"
_P_BUS = "odpt.Bus:"


# ───────────────────────────── pure helpers (stdlib) ─────────────────────────

def _short(uri: Any, prefix: str) -> str | None:
    if not isinstance(uri, str):
        return None
    return uri[len(prefix):] if uri.startswith(prefix) else uri


def _parse(ts: Any) -> datetime | None:
    if not isinstance(ts, str) or not ts:
        return None
    try:
        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=JST)


def _hav_m(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlmb = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def _in_bbox(lon: float, lat: float) -> bool:
    lo, hi = BBOX["lon"]
    la, ha = BBOX["lat"]
    return lo <= lon <= hi and la <= lat <= ha


def _walk(line: list[list[float]], fraction: float) -> tuple[list[float], float, float]:
    """Point at `fraction` of the way along `line`, plus (total_m, bearing_deg)."""
    if len(line) < 2:
        return (list(line[0]) if line else [0.0, 0.0]), 0.0, 0.0
    segs = [_hav_m(line[i][0], line[i][1], line[i + 1][0], line[i + 1][1])
            for i in range(len(line) - 1)]
    total = sum(segs)
    if total <= 0:
        return list(line[-1]), 0.0, 0.0
    target = max(0.0, min(1.0, fraction)) * total
    run = 0.0
    for i, seg in enumerate(segs):
        if run + seg >= target or i == len(segs) - 1:
            t = 0.0 if seg <= 0 else min(1.0, (target - run) / seg)
            (x1, y1), (x2, y2) = line[i], line[i + 1]
            bearing = (math.degrees(math.atan2(
                math.radians(x2 - x1) * math.cos(math.radians((y1 + y2) / 2)),
                math.radians(y2 - y1))) + 360.0) % 360.0
            return [round(x1 + (x2 - x1) * t, 6), round(y1 + (y2 - y1) * t, 6)], total, round(bearing, 1)
        run += seg
    return list(line[-1]), total, 0.0


# ───────────────────────────────── normalize ─────────────────────────────────

def normalize(payload: dict[str, Any]) -> dict[str, Any]:
    """PURE. `payload` is what `fetch()` (or `build_input()`) produced:

        {"fetchedAt": iso, "sourceUrl": str,
         "buses": [ raw odpt:Bus dicts ],
         "stops": { poleId: [lon, lat, nameEn, nameJa] },
         "legs":  { "patternId|fromPoleId|toPoleId": [[lon,lat], ...] } }

    Returns a GeoJSON FeatureCollection dict (plus counters). Never raises on a
    bad row — a malformed vehicle is counted in `skipped` and dropped.
    """
    payload = payload or {}
    buses = payload.get("buses") or []
    stops: dict[str, Any] = payload.get("stops") or {}
    legs: dict[str, Any] = payload.get("legs") or {}
    fetched_at = payload.get("fetchedAt")
    fetched_dt = _parse(fetched_at)

    features: list[dict[str, Any]] = []
    stale = at_stop = interpolated = outside = skipped = 0
    newest: datetime | None = None

    for b in buses:
        try:
            from_id = b.get("odpt:fromBusstopPole")
            to_id = b.get("odpt:toBusstopPole")
            frm, to = stops.get(from_id), stops.get(to_id)
            if not to:
                skipped += 1
                continue

            obs = _parse(b.get("dc:date"))
            dep = _parse(b.get("odpt:fromBusstopPoleTime"))
            if obs and (newest is None or obs > newest):
                newest = obs

            pattern_id = _short(b.get("odpt:busroutePattern"), _P_PATTERN)
            line = legs.get(f"{pattern_id}|{from_id}|{to_id}")
            if not line or len(line) < 2:
                # No road slice for this leg: the honest fallback is the straight
                # line between the two known stops (tagged below).
                line = ([[frm[0], frm[1]], [to[0], to[1]]] if frm else None)
            geom_kind = "road" if legs.get(f"{pattern_id}|{from_id}|{to_id}") else "straight"

            # ── the derivation ────────────────────────────────────────────────
            source = "at-stop"
            frac = 1.0
            reason = None
            if line and obs and dep:
                _, total_m, _ = _walk(line, 0.0)
                if total_m > 0:
                    expected_s = total_m / BUS_SPEED_MPS
                    elapsed_s = (obs - dep).total_seconds()
                    if elapsed_s < 0:
                        frac, reason = 0.0, "fromBusstopPoleTime is in the future"
                    else:
                        frac = max(0.0, min(1.0, elapsed_s / expected_s))
                        if frac >= 0.995:
                            reason = "overdue for the next stop — snapped to it"
                        else:
                            source = "interpolated"
                else:
                    reason = "zero-length leg"
            elif not line:
                reason = "from-stop coordinates unavailable"
            else:
                reason = "no fromBusstopPoleTime — cannot derive a fraction"

            if source == "at-stop" and frac >= 0.995:
                coords = [to[0], to[1]]
                _, _, bearing = _walk(line, 1.0) if line else ([], 0, 0.0)
            elif line:
                coords, _, bearing = _walk(line, frac)
            else:
                coords, bearing = [to[0], to[1]], 0.0

            if not _in_bbox(coords[0], coords[1]):
                outside += 1
                continue

            valid = _parse(b.get("dct:valid"))
            is_stale = bool(valid and fetched_dt and valid < fetched_dt)
            if is_stale:
                stale += 1
            if source == "interpolated":
                interpolated += 1
            else:
                at_stop += 1

            note_ja = b.get("odpt:note") or None
            route_id = _short(b.get("odpt:busroute"), _P_ROUTE) or ""
            route_code = route_id.split(".")[-1] if route_id else None
            start = stops.get(b.get("odpt:startingBusstopPole"))
            term = stops.get(b.get("odpt:terminalBusstopPole"))
            if route_code and start and term:
                route_label = f"{route_code} {start[2]} → {term[2]}"
            elif route_code:
                route_label = route_code
            else:
                route_label = note_ja or "Toei bus"

            features.append({
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": coords},
                "properties": {
                    "busId": _short(b.get("owl:sameAs"), _P_BUS) or b.get("@id"),
                    "busNumber": b.get("odpt:busNumber"),
                    "routeLabel": route_label,
                    "routeLabelJa": note_ja,
                    "routeId": route_id or None,
                    "patternId": pattern_id,
                    "fromStop": frm[2] if frm else None,
                    "fromStopJa": frm[3] if frm else None,
                    "toStop": to[2],
                    "nextStopName": to[2],
                    "nextStopNameJa": to[3],
                    "positionSource": source,
                    # positionMethod is on the FeatureCollection, not repeated 376x
                    "positionNote": reason,
                    "legFraction": round(frac, 3),
                    "legGeometry": geom_kind,
                    "bearing": bearing,
                    "departedAt": b.get("odpt:fromBusstopPoleTime"),
                    "updatedAt": b.get("dc:date"),
                    "validUntil": b.get("dct:valid"),
                    "stale": is_stale,
                    "operator": _short(b.get("odpt:operator"), _P_OPERATOR) or "Toei",
                },
            })
        except Exception:       # one bad vehicle must never kill the layer
            skipped += 1

    feed_age = None
    if newest and fetched_dt:
        feed_age = round((fetched_dt - newest).total_seconds(), 1)

    return {
        "type": "FeatureCollection",
        "features": features,
        "busCount": len(features),
        "feedAgeSeconds": feed_age,
        "feedStale": bool(feed_age is not None and feed_age > STALE_AFTER_S),
        "staleAfterSeconds": STALE_AFTER_S,
        "interpolatedCount": interpolated,
        "atStopCount": at_stop,
        "staleCount": stale,
        "outsideBbox": outside,
        "skipped": skipped,
        "feedTime": newest.isoformat() if newest else fetched_at,
        "fetchedAt": fetched_at,
        "sourceUrl": payload.get("sourceUrl") or BUS_URL,
        "sourceName": "ODPT odpt:Bus (Toei)",
        "positionMethod": POSITION_METHOD,
        "attribution": ATTRIBUTION,
    }


def normalize_events(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """Always `[]`, deliberately — two independent reasons:

    1. `contracts/event.schema.json` is FROZEN with no `bus` type. A bus row
       would have to masquerade as `train`, which is a lie in the timeline.
    2. 376 routine vehicle positions would bury the earthquake and the delays.
       Routine state is a map layer, not an incident. Same call already made for
       weather and for train "normal operation" rows.

    `odpt:Bus` reports no disruption field of its own (no cancellation, no delay
    minutes), so there is nothing here that would qualify as an incident even if
    the schema allowed it. If ODPT ever adds one, build the Event here.
    """
    return []


# ───────────────────────── HOST SIDE (network + disk) ────────────────────────

_STATIC: dict[str, Any] | None = None


def _root() -> Path:
    return Path(__file__).resolve().parents[2]


def load_static() -> dict[str, Any]:
    """HOST ONLY. Build (once) the stop coordinate table and the per-pattern road
    polyline + stop order, from the captured ODPT payloads under mock/raw/.

    These two feeds are effectively static (BusstopPole `dc:date` moves on a
    multi-day cadence), which is exactly why they are captured to disk instead
    of re-downloaded on a 5-second endpoint: 9 MB per request would dominate
    every /buses.geojson refresh.
    """
    global _STATIC
    if _STATIC is not None:
        return _STATIC
    raw = _root() / "mock" / "raw"
    stops: dict[str, list[Any]] = {}
    try:
        with (raw / "odpt-busstoppole.json").open(encoding="utf-8") as fh:
            for p in json.load(fh):
                lat, lon = p.get("geo:lat"), p.get("geo:long")
                if lat is None or lon is None:
                    continue
                t = p.get("title") or {}
                stops[p["owl:sameAs"]] = [
                    float(lon), float(lat),
                    t.get("en") or p.get("dc:title") or "",
                    t.get("ja") or p.get("dc:title") or "",
                ]
    except Exception:
        stops = {}

    patterns: dict[str, dict[str, Any]] = {}
    try:
        with (raw / "odpt-busroutepattern.json").open(encoding="utf-8") as fh:
            for p in json.load(fh):
                pid = _short(p.get("owl:sameAs"), _P_PATTERN)
                if not pid:
                    continue
                region = p.get("ug:region") or {}
                coords = (region.get("coordinates")
                          if region.get("type") == "LineString" else None) or []
                order = sorted(p.get("odpt:busstopPoleOrder") or [],
                               key=lambda o: o.get("odpt:index", 0))
                patterns[pid] = {
                    "line": coords,
                    "stops": [o.get("odpt:busstopPole") for o in order],
                }
    except Exception:
        patterns = {}

    _STATIC = {"stops": stops, "patterns": patterns}
    return _STATIC


def _nearest_index(line: list[list[float]], lon: float, lat: float) -> int:
    best_i, best_d = 0, float("inf")
    for i, c in enumerate(line):
        d = (c[0] - lon) ** 2 + (c[1] - lat) ** 2      # squared degrees is enough to rank
        if d < best_d:
            best_i, best_d = i, d
    return best_i


def _leg_slice(pattern: dict[str, Any], stops: dict[str, list[Any]],
               from_id: str, to_id: str) -> list[list[float]] | None:
    """The road sub-polyline between two consecutive stops.

    ODPT gives one shape per pattern and no stop->vertex mapping, so we snap
    each stop to its nearest shape vertex and take the slice between. That is an
    approximation of where along the road the stop sits (a few tens of metres),
    which is well inside the error already accepted by interpolating at an
    average speed.
    """
    line = pattern.get("line") or []
    a, b = stops.get(from_id), stops.get(to_id)
    if len(line) < 2 or not a or not b:
        return None
    i, j = _nearest_index(line, a[0], a[1]), _nearest_index(line, b[0], b[1])
    if j <= i:
        return None
    seg = [[round(c[0], 6), round(c[1], 6)] for c in line[i:j + 1]]
    return seg if len(seg) >= 2 else None


def build_input(bus_items: list[dict[str, Any]], fetched_at: str | None = None
                ) -> dict[str, Any]:
    """HOST ONLY. Wrap the live vehicle list with the small static subset that
    `normalize()` needs, so the pure function stays pure and the sandbox upload
    stays ~400 entries instead of the 9 MB full static feeds."""
    static = load_static()
    all_stops, patterns = static["stops"], static["patterns"]
    stops: dict[str, list[Any]] = {}
    legs: dict[str, list[list[float]]] = {}
    for b in bus_items:
        for key in ("odpt:fromBusstopPole", "odpt:toBusstopPole",
                    "odpt:startingBusstopPole", "odpt:terminalBusstopPole"):
            pid = b.get(key)
            if pid and pid in all_stops and pid not in stops:
                stops[pid] = all_stops[pid]
        pat = _short(b.get("odpt:busroutePattern"), _P_PATTERN)
        f, t = b.get("odpt:fromBusstopPole"), b.get("odpt:toBusstopPole")
        k = f"{pat}|{f}|{t}"
        if pat in patterns and k not in legs:
            seg = _leg_slice(patterns[pat], all_stops, f, t)
            if seg:
                legs[k] = seg
    return {
        "fetchedAt": fetched_at or datetime.now(JST).isoformat(timespec="seconds"),
        "sourceUrl": BUS_URL,
        "buses": bus_items,
        "stops": stops,
        "legs": legs,
    }


def fetch_once() -> dict[str, Any]:
    """HOST ONLY. Live odpt:Bus + the static subset. Same name/shape contract as
    the other feeds' `fetch_once()`, so the launcher can drive it unchanged."""
    import httpx  # lazy: the sandbox runs normalize() only and has no httpx

    try:
        from ingest.common import get_env
        url = get_env("FEED_ODPT_BUS", BUS_URL) or BUS_URL
    except Exception:
        url = BUS_URL
    if url.endswith(".json"):       # the documented ODPT .json trap
        url = url[: -len(".json")]
    resp = httpx.get(url, timeout=15.0, headers={"User-Agent": "TokyoPulse/1.0"})
    # Stamp the clock the INSTANT the bytes land. build_input() below may parse
    # a 9 MB static index on its first call; stamping after that would charge
    # our own startup cost to the feed's age and make a fresh feed look stale.
    at = datetime.now(JST).isoformat(timespec="seconds")
    resp.raise_for_status()
    data = resp.json()
    if not isinstance(data, list):
        raise ValueError(f"unexpected odpt:Bus payload shape: {type(data)}")
    payload = build_input(data, fetched_at=at)
    payload["sourceUrl"] = url
    return payload


# `fetch` is the name the brief uses; `fetch_once` is the house convention.
fetch = fetch_once


def run_cycle() -> dict[str, Any]:
    """One host fetch -> pure normalize. Writes NO Events (see normalize_events)."""
    result = normalize(fetch_once())
    return result


if __name__ == "__main__":
    sys.path.insert(0, str(_root()))
    out = run_cycle()
    if "--full" in sys.argv:
        print(json.dumps(out, ensure_ascii=False, indent=2))
    else:
        summary = {k: v for k, v in out.items() if k != "features"}
        summary["sampleFeature"] = out["features"][0] if out["features"] else None
        print(json.dumps(summary, ensure_ascii=False, indent=2))
