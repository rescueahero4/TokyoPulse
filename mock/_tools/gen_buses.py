"""A11 — BUSES. Builds the static Toei bus geometry that the map layer draws.

Recovers the stretch goal `doc/prd.md` §3.5 cut ("needs a free ODPT token"):
the KEYLESS public mirror carries Toei bus data after all. See the three
`odpt_bus*` rows in contracts/feeds.json.

Run (from the project root):
    .venv\\Scripts\\python.exe mock\\_tools\\gen_buses.py --fetch      # refresh mock/raw/odpt-bus*.json
    .venv\\Scripts\\python.exe mock\\_tools\\gen_buses.py               # build the geojson
    .venv\\Scripts\\python.exe mock\\_tools\\gen_buses.py --calibrate   # re-derive BUS_SPEED_KMH

Writes:
    mock/busroutes.geojson    LineString per DISTINCT route pattern
    mock/busstops.geojson     Point per bus stop pole
    mock/busvehicles.geojson  a live-vehicle SNAPSHOT -> tier-2 cache for GET /buses.geojson

## Two corrections to what the brief assumed

1. **`odpt:BusroutePattern` DOES carry geometry.** `contracts/feeds.json` says
   "No geometry field of its own; polylines are stop-to-stop straight lines".
   That is wrong: 748 of the 757 patterns carry a `ug:region` GeoJSON LineString
   that follows the actual ROAD (45,378 vertices in total). We use it. Only the
   9 patterns without one fall back to stop-to-stop straight lines, and those
   features are tagged `"geometrySource": "stop-to-stop"` so the UI can say so.
2. `odpt:frequency` is the feed's UPDATE frequency in seconds (30 on every one
   of the 376 live vehicles), NOT a headway and NOT a leg duration. It cannot be
   used to derive a leg duration. See the calibration note below.

## Scope control (the map was just cut from 5,651 rail polylines to 415)

Toei bus reaches far west Tokyo (there is a stop at lon 139.286, near Ome), so
everything here is filtered to the 23-ward bounding box, deduplicated by stop
sequence, Douglas-Peucker simplified and coordinate-rounded. Counts are printed.
"""
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import MOCK_DIR, iso, meta  # noqa: E402

RAW = os.path.join(MOCK_DIR, "raw")

BUS_URL = "https://api-public.odpt.org/api/v4/odpt:Bus"
POLE_URL = "https://api-public.odpt.org/api/v4/odpt:BusstopPole"
PATTERN_URL = "https://api-public.odpt.org/api/v4/odpt:BusroutePattern"
TIMETABLE_URL = "https://api-public.odpt.org/api/v4/odpt:BusTimetable"

# 23-ward bounding box (brief). Everything outside is dropped.
BBOX = {"lon": (139.55, 139.95), "lat": (35.52, 35.82)}

SIMPLIFY_TOL = 0.00012      # degrees, ~13 m — below a bus-lane's width at z15
COORD_DP = 5                # ~1.1 m; more precision than a derived position earns
MIN_IN_BOX_RATIO = 0.5      # a pattern needs half its shape inside the 23 wards

# Average Toei bus speed, road-distance / scheduled-leg-duration. MEASURED, not
# guessed: median of 416 real scheduled legs across 21 odpt:BusTimetable rows
# (mean 13.8, p25 8.7, p75 16.6). Used ONLY to estimate how long a leg should
# take; never presented as a measurement. Re-derive with `--calibrate`.
BUS_SPEED_KMH = 12.3


# ─────────────────────────────── geometry helpers ────────────────────────────

def in_bbox(lon, lat):
    lo, hi = BBOX["lon"]
    la, ha = BBOX["lat"]
    return lo <= lon <= hi and la <= lat <= ha


def haversine_m(lon1, lat1, lon2, lat2):
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlmb = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def _perp(p, a, b):
    """Perpendicular distance of p from segment a-b, in degrees (planar is fine
    at this scale — we only use it to rank vertices for removal)."""
    (px, py), (ax, ay), (bx, by) = p, a, b
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def simplify(coords, tol=SIMPLIFY_TOL):
    """Iterative Douglas-Peucker (no recursion: some patterns are 300+ vertices)."""
    if len(coords) < 3:
        return list(coords)
    keep = [False] * len(coords)
    keep[0] = keep[-1] = True
    stack = [(0, len(coords) - 1)]
    while stack:
        i, j = stack.pop()
        if j <= i + 1:
            continue
        worst, wi = -1.0, -1
        for k in range(i + 1, j):
            d = _perp(coords[k], coords[i], coords[j])
            if d > worst:
                worst, wi = d, k
        if worst > tol:
            keep[wi] = True
            stack.append((i, wi))
            stack.append((wi, j))
    return [c for c, k in zip(coords, keep) if k]


def clip_to_bbox(coords):
    """Keep the LONGEST contiguous in-bbox run of vertices.

    Deliberately not a true Sutherland-Hodgman clip: a bus route that leaves and
    re-enters the 23 wards would otherwise come back as a MultiLineString, and
    joining the pieces would draw a straight line across the gap — a lie. One
    honest contiguous run beats a stitched-together fiction.
    """
    best, cur = [], []
    for c in coords:
        if in_bbox(c[0], c[1]):
            cur.append(c)
        else:
            if len(cur) > len(best):
                best = cur
            cur = []
    if len(cur) > len(best):
        best = cur
    return best


def round_coords(coords, dp=COORD_DP):
    return [[round(c[0], dp), round(c[1], dp)] for c in coords]


def dedupe_consecutive(coords):
    out = []
    for c in coords:
        if not out or c != out[-1]:
            out.append(c)
    return out


# ───────────────────────────────── raw loading ───────────────────────────────

def load_raw(name):
    with open(os.path.join(RAW, name), encoding="utf-8") as f:
        return json.load(f)


def write_compact(relpath, obj):
    """Like common.write_json but WITHOUT indent=2.

    Pretty-printing a coordinate array puts every number on its own line: the
    same 12,684 bus-route vertices are 1.23 MB indented and 0.30 MB compact.
    Nobody reads a 659-polyline geojson by eye, and the map has to fetch it.
    """
    path = os.path.join(MOCK_DIR, relpath)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
    print(f"wrote {path} ({os.path.getsize(path)} bytes)")


def fetch_raw():
    """--fetch: refresh the three ODPT bus payloads under mock/raw/."""
    import httpx
    os.makedirs(RAW, exist_ok=True)
    targets = {
        "odpt-bus.json": BUS_URL,
        "odpt-busstoppole.json": POLE_URL,
        "odpt-busroutepattern.json": PATTERN_URL,
    }
    headers = {"User-Agent": "TokyoPulse-hackathon/1.0"}
    for fname, url in targets.items():
        path = os.path.join(RAW, fname)
        with httpx.Client(timeout=90, headers=headers, follow_redirects=True) as c:
            r = c.get(url)
        r.raise_for_status()
        data = r.json()
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
        print(f"OK {fname}: {r.status_code}, {len(data)} items, {os.path.getsize(path)} bytes")


def short_id(uri, prefix):
    return (uri or "").replace(prefix, "")


def pole_index():
    """poleId -> {lon, lat, name, nameJa}. All 3,690 poles have coordinates."""
    idx = {}
    for p in load_raw("odpt-busstoppole.json"):
        lat, lon = p.get("geo:lat"), p.get("geo:long")
        if lat is None or lon is None:
            continue
        title = p.get("title") or {}
        idx[p["owl:sameAs"]] = {
            "lon": float(lon), "lat": float(lat),
            "name": title.get("en") or p.get("dc:title") or "",
            "nameJa": title.get("ja") or p.get("dc:title") or "",
            "routes": len(p.get("odpt:busroutePattern") or []),
        }
    return idx


# ─────────────────────── speed calibration (--calibrate) ─────────────────────

def calibrate():
    """Derive BUS_SPEED_KMH from REAL scheduled timetables, not a guess.

    odpt:BusTimetable can only be filtered one id at a time (a comma-joined
    `owl:sameAs` matches nothing, and filtering by pattern returns 351 rows /
    1.6 MB for a single pattern), so fetching one per live bus is not viable on
    a 5-second endpoint. Instead we sample a handful of real timetables ONCE,
    here, offline, and bake the median road-distance / scheduled-duration into
    the constant above. Every derived position is then labelled as an estimate.
    """
    import statistics

    import httpx
    sys.path.insert(0, os.path.dirname(MOCK_DIR))
    from ingest.feeds import buses as buses_feed
    static = buses_feed.load_static()

    def road_km(from_id, to_id, pattern_id):
        """Road distance for the same leg the runtime will interpolate along —
        calibrating against straight-line distance would bake in a systematic
        under-estimate of speed (road > straight, always)."""
        pat = static["patterns"].get(pattern_id)
        seg = buses_feed._leg_slice(pat, static["stops"], from_id, to_id) if pat else None
        if not seg:
            return None
        return sum(haversine_m(seg[i][0], seg[i][1], seg[i + 1][0], seg[i + 1][1])
                   for i in range(len(seg) - 1)) / 1000.0

    poles = pole_index()
    buses = load_raw("odpt-bus.json")
    seen, samples, legs, straight = set(), [], 0, []
    headers = {"User-Agent": "TokyoPulse-hackathon/1.0"}
    with httpx.Client(timeout=30, headers=headers, follow_redirects=True) as c:
        for b in buses:
            tt = b.get("odpt:busTimetable")
            if not tt or tt in seen:
                continue
            seen.add(tt)
            if len(seen) > 20:
                break
            try:
                r = c.get(TIMETABLE_URL, params={"owl:sameAs": tt})
                rows = r.json()
            except Exception as e:
                print(f"  skip {tt}: {type(e).__name__}")
                continue
            if not rows:
                continue
            pattern_id = (rows[0].get("odpt:busroutePattern") or "").replace(
                "odpt.BusroutePattern:", "")
            objs = sorted(rows[0].get("odpt:busTimetableObject") or [],
                          key=lambda o: o.get("odpt:index", 0))
            for a, z in zip(objs, objs[1:]):
                pa = poles.get(a.get("odpt:busstopPole"))
                pz = poles.get(z.get("odpt:busstopPole"))
                ta = a.get("odpt:departureTime") or a.get("odpt:arrivalTime")
                tz = z.get("odpt:arrivalTime") or z.get("odpt:departureTime")
                if not (pa and pz and ta and tz):
                    continue
                try:
                    ma = int(ta[:2]) * 60 + int(ta[3:5])
                    mz = int(tz[:2]) * 60 + int(tz[3:5])
                except (ValueError, IndexError):
                    continue
                mins = mz - ma
                if mins <= 0 or mins > 30:
                    continue          # timetables round to the minute; 0 is unusable
                straight_km = haversine_m(pa["lon"], pa["lat"], pz["lon"], pz["lat"]) / 1000.0
                dist_km = road_km(a.get("odpt:busstopPole"), z.get("odpt:busstopPole"),
                                  pattern_id) or straight_km
                if dist_km < 0.05:
                    continue
                samples.append(dist_km / (mins / 60.0))
                straight.append(straight_km / (mins / 60.0))
                legs += 1
    if not samples:
        print("calibration produced no samples — keeping BUS_SPEED_KMH as-is")
        return
    med = statistics.median(samples)
    print(f"calibration: {len(seen)} timetables, {legs} usable legs")
    print(f"  ROAD distance   median {med:.2f} km/h, mean {statistics.mean(samples):.2f}, "
          f"p25 {statistics.quantiles(samples, n=4)[0]:.2f}, "
          f"p75 {statistics.quantiles(samples, n=4)[2]:.2f}")
    print(f"  straight line   median {statistics.median(straight):.2f} km/h "
          f"(for reference only — the runtime walks the road polyline)")
    print(f"  -> set BUS_SPEED_KMH = {med:.1f}")


# ──────────────────────────────── build: routes ──────────────────────────────

def build_routes(poles):
    patterns = load_raw("odpt-busroutepattern.json")
    stats = {"total": len(patterns), "no_geometry": 0, "straight_line": 0,
             "dropped_outside": 0, "dropped_dupe": 0, "kept": 0,
             "vertices_in": 0, "vertices_out": 0}
    by_key = {}

    for p in patterns:
        pid = short_id(p.get("owl:sameAs"), "odpt.BusroutePattern:")
        order = sorted(p.get("odpt:busstopPoleOrder") or [],
                       key=lambda o: o.get("odpt:index", 0))
        stop_ids = [o.get("odpt:busstopPole") for o in order if o.get("odpt:busstopPole")]

        region = p.get("ug:region") or {}
        coords = region.get("coordinates") if region.get("type") == "LineString" else None
        geom_source = "odpt-road-shape"
        if not coords or len(coords) < 2:
            # 9 of 757 patterns have no ug:region -> fall back to the technique
            # the brief described: straight lines between consecutive stops.
            coords = [[poles[s]["lon"], poles[s]["lat"]] for s in stop_ids if s in poles]
            geom_source = "stop-to-stop"
            stats["no_geometry"] += 1
            if len(coords) < 2:
                continue
        stats["vertices_in"] += len(coords)

        clipped = clip_to_bbox(coords)
        if len(clipped) < 2 or (len(clipped) / len(coords)) < MIN_IN_BOX_RATIO:
            stats["dropped_outside"] += 1
            continue

        simple = dedupe_consecutive(round_coords(simplify(clipped)))
        if len(simple) < 2:
            stats["dropped_outside"] += 1
            continue

        # Dedupe on the stop sequence: Toei registers one pattern per direction
        # per variant, and many share an identical stop list (and therefore an
        # identical drawn line). Draw it once, name the duplicates in a property.
        key = "|".join(stop_ids) or f"geom:{simple[0]}{simple[-1]}{len(simple)}"
        title = p.get("dc:title") or ""
        route = short_id(p.get("odpt:busroute"), "odpt.Busroute:")
        if key in by_key:
            stats["dropped_dupe"] += 1
            f = by_key[key]
            f["properties"]["patternCount"] += 1
            if len(simple) > len(f["geometry"]["coordinates"]):
                f["geometry"]["coordinates"] = simple   # keep the richest shape
            continue

        if geom_source == "stop-to-stop":
            stats["straight_line"] += 1
        by_key[key] = {
            "type": "Feature",
            "geometry": {"type": "LineString", "coordinates": simple},
            "properties": {
                "patternId": pid,
                "routeId": route,
                "routeLabelJa": title or None,
                "routeCode": (p.get("odpt:note") or "").split(":")[0] or None,
                "direction": p.get("odpt:direction"),
                "stopCount": len(stop_ids),
                "geometrySource": geom_source,
                "operator": short_id(p.get("odpt:operator"), "odpt.Operator:") or "Toei",
                "patternCount": 1,
            },
        }

    # Second dedupe pass, on the DRAWN shape. Toei registers separate patterns
    # for variants that differ only in which stops are served (express/local,
    # or a different terminus stop pole) but run the identical road. Those pass
    # the stop-sequence test and would stack invisible duplicate polylines.
    by_geom = {}
    for f in by_key.values():
        c = f["geometry"]["coordinates"]
        gkey = (len(c), tuple(c[0]), tuple(c[len(c) // 2]), tuple(c[-1]))
        if gkey in by_geom:
            stats["dropped_dupe"] += 1
            by_geom[gkey]["properties"]["patternCount"] += f["properties"]["patternCount"]
            continue
        by_geom[gkey] = f

    feats = list(by_geom.values())
    stats["kept"] = len(feats)
    stats["vertices_out"] = sum(len(f["geometry"]["coordinates"]) for f in feats)
    return feats, stats


# ──────────────────────────────── build: stops ───────────────────────────────

def build_stops(poles):
    feats, dropped = [], 0
    for pole_id, p in poles.items():
        if not in_bbox(p["lon"], p["lat"]):
            dropped += 1
            continue
        feats.append({
            "type": "Feature",
            "geometry": {"type": "Point",
                         "coordinates": [round(p["lon"], COORD_DP), round(p["lat"], COORD_DP)]},
            "properties": {
                "stopId": short_id(pole_id, "odpt.BusstopPole:"),
                "name": p["name"], "nameJa": p["nameJa"],
                "routeCount": p["routes"], "operator": "Toei",
            },
        })
    feats.sort(key=lambda f: -f["properties"]["routeCount"])
    return feats, dropped


# ────────────────────────── build: live vehicle snapshot ─────────────────────

def build_vehicles():
    """Snapshot the live fleet through the SAME normalize() the API calls, so
    the tier-2 mock payload and the tier-1 live payload cannot drift apart."""
    sys.path.insert(0, os.path.dirname(MOCK_DIR))
    from ingest.feeds import buses as buses_feed
    payload = buses_feed.build_input(load_raw("odpt-bus.json"))
    return buses_feed.normalize(payload)


# ──────────────────────────────────── main ───────────────────────────────────

def main():
    if "--fetch" in sys.argv:
        fetch_raw()
        return
    if "--calibrate" in sys.argv:
        calibrate()
        return

    poles = pole_index()
    print(f"poles: {len(poles)} with coordinates")

    routes, rs = build_routes(poles)
    stops, stops_dropped = build_stops(poles)

    write_compact("busroutes.geojson", {
        "type": "FeatureCollection", "features": routes,
        "meta": meta("cache", False,
                     f"Toei bus route patterns, 23-ward bbox, "
                     f"{rs['kept']} of {rs['total']} patterns"),
    })
    write_compact("busstops.geojson", {
        "type": "FeatureCollection", "features": stops,
        "meta": meta("cache", False, f"Toei bus stop poles inside the 23-ward bbox"),
    })

    try:
        veh = build_vehicles()
        veh["meta"] = meta("cache", True,
                           f"snapshot of {veh.get('busCount', 0)} live vehicles at {iso()}")
        write_compact("busvehicles.geojson", veh)
    except Exception as e:
        print(f"vehicle snapshot skipped: {type(e).__name__}: {e}")

    print("\n--- bus geometry report ---")
    print(f"patterns total           {rs['total']}")
    print(f"  no ug:region shape     {rs['no_geometry']} (fell back to stop-to-stop)")
    print(f"  dropped, outside bbox  {rs['dropped_outside']}")
    print(f"  dropped, duplicate     {rs['dropped_dupe']}")
    print(f"  KEPT                   {rs['kept']}  "
          f"({rs['straight_line']} of them stop-to-stop straight lines)")
    print(f"vertices  {rs['vertices_in']} -> {rs['vertices_out']} "
          f"(clip + Douglas-Peucker {SIMPLIFY_TOL} deg + round {COORD_DP} dp)")
    print(f"stops     {len(stops)} kept, {stops_dropped} dropped outside the bbox")
    for f in ("busroutes.geojson", "busstops.geojson", "busvehicles.geojson"):
        p = os.path.join(MOCK_DIR, f)
        if os.path.exists(p):
            print(f"  {f:22s} {os.path.getsize(p)/1024:8.1f} KB")


if __name__ == "__main__":
    main()
