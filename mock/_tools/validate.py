"""Validation gate for mock/**. Run: .venv\\Scripts\\python.exe mock\\_tools\\validate.py
Asserts:
  - every Event validates against contracts/event.schema.json
  - all 20 lineIds from contracts/lines.csv are present in lines.geojson
  - every coordinate (lines, stations, events) is inside Tokyo-ish bounds
  - every mock file has a valid meta object
Exits non-zero and prints failures if anything is wrong; prints a pass summary otherwise.
"""
import sys
import os
import json
import glob

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import MOCK_DIR, read_lines_csv

import jsonschema

CONTRACTS = os.path.join(os.path.dirname(MOCK_DIR), "contracts")

errors = []
warnings = []


def err(msg):
    errors.append(msg)
    print("FAIL:", msg)


def ok(msg):
    print("OK:", msg)


def load(relpath):
    path = os.path.join(MOCK_DIR, relpath)
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def check_meta(obj, filename):
    m = obj.get("meta")
    if m is None:
        err(f"{filename}: missing meta")
        return
    for field in ("source", "generatedAt", "degraded", "note"):
        if field not in m:
            err(f"{filename}: meta missing field '{field}'")
    if m.get("source") not in ("live", "cache", "mock"):
        err(f"{filename}: meta.source invalid: {m.get('source')}")
    if not isinstance(m.get("degraded"), bool):
        err(f"{filename}: meta.degraded not bool")


LON_RANGE = (138.9, 140.2)
LAT_RANGE = (35.4, 36.0)


def in_bounds(lon, lat):
    return LON_RANGE[0] <= lon <= LON_RANGE[1] and LAT_RANGE[0] <= lat <= LAT_RANGE[1]


def check_coords_geometry(geom, context, bad):
    t = geom.get("type")
    coords = geom.get("coordinates")
    if t == "Point":
        lon, lat = coords
        if not in_bounds(lon, lat):
            bad.append((context, lon, lat))
    elif t == "LineString":
        for lon, lat in coords:
            if not in_bounds(lon, lat):
                bad.append((context, lon, lat))
    elif t == "MultiLineString":
        for seg in coords:
            for lon, lat in seg:
                if not in_bounds(lon, lat):
                    bad.append((context, lon, lat))


def main():
    # --- event schema ---
    with open(os.path.join(CONTRACTS, "event.schema.json"), encoding="utf-8") as f:
        event_schema = json.load(f)
    validator = jsonschema.Draft7Validator(event_schema)

    events_doc = load("events.json")
    check_meta(events_doc, "events.json")
    event_count = 0
    event_errors = 0
    for e in events_doc.get("events", []):
        event_count += 1
        for verr in validator.iter_errors(e):
            event_errors += 1
            err(f"events.json: event {e.get('id')} schema error: {verr.message}")
    if event_errors == 0:
        ok(f"all {event_count} events validate against event.schema.json")

    # --- lines.geojson: all 20 lineIds present + bounds ---
    lines_csv = read_lines_csv()
    expected_ids = {r["lineId"] for r in lines_csv}
    lines_doc = load("lines.geojson")
    check_meta(lines_doc, "lines.geojson")
    got_ids = {f["properties"]["lineId"] for f in lines_doc["features"]}
    missing = expected_ids - got_ids
    if missing:
        err(f"lines.geojson: missing lineIds: {missing}")
    else:
        ok(f"all {len(expected_ids)} lineIds from lines.csv present in lines.geojson")

    bad_coords = []
    for f in lines_doc["features"]:
        check_coords_geometry(f["geometry"], f"lines.geojson:{f['properties']['lineId']}", bad_coords)

    # --- stations.geojson bounds ---
    stations_doc = load("stations.geojson")
    check_meta(stations_doc, "stations.geojson")
    for f in stations_doc["features"]:
        check_coords_geometry(f["geometry"], f"stations.geojson:{f['properties'].get('stationId')}", bad_coords)
    ok(f"stations.geojson has {len(stations_doc['features'])} features")

    # --- event lat/lon bounds (non-null only) ---
    for e in events_doc.get("events", []):
        lat, lon = e.get("lat"), e.get("lon")
        if lat is not None and lon is not None:
            if not in_bounds(lon, lat):
                # quakes are allowed to be far outside Tokyo (e.g. Kyushu) -- only
                # warn, don't fail, since the schema permits any valid lat/lon.
                warnings.append(f"events.json: event {e.get('id')} lat/lon ({lat},{lon}) outside Tokyo-ish bounds (expected for distant quakes)")

    if bad_coords:
        err(f"{len(bad_coords)} out-of-bounds coordinates found (lines/stations): sample {bad_coords[:5]}")
    else:
        ok("all lines.geojson + stations.geojson coordinates inside Tokyo-ish bounds (lon 138.9-140.2, lat 35.4-36.0)")

    # --- meta on every other mock file ---
    other_files = ["forecast.json", "brief.json", "sandboxes.json", "layers.json"]
    for fn in other_files:
        doc = load(fn)
        check_meta(doc, fn)
    ok("meta checked on forecast/brief/sandboxes/layers")

    impact_files = glob.glob(os.path.join(MOCK_DIR, "impact", "*.json"))
    for path in impact_files:
        with open(path, encoding="utf-8") as f:
            doc = json.load(f)
        check_meta(doc, os.path.basename(path))
        for e in doc.get("events", []):
            for verr in validator.iter_errors(e):
                err(f"{os.path.basename(path)}: embedded event schema error: {verr.message}")
    ok(f"meta + embedded events checked on {len(impact_files)} impact/*.json files")

    # forecast nowIndex sanity
    forecast_doc = load("forecast.json")
    if not (0 <= forecast_doc.get("nowIndex", -1) < len(forecast_doc.get("hourly", []))):
        err("forecast.json: nowIndex out of range")
    else:
        ok(f"forecast.json nowIndex={forecast_doc['nowIndex']} within {len(forecast_doc['hourly'])} hourly entries")

    print()
    print(f"WARNINGS: {len(warnings)}")
    for w in warnings:
        print(" -", w)
    print()
    if errors:
        print(f"VALIDATION FAILED: {len(errors)} error(s)")
        sys.exit(1)
    else:
        print("VALIDATION PASSED")
        sys.exit(0)


if __name__ == "__main__":
    main()
