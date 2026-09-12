"""
mock/_tools/gen_wards_geojson.py — builds mock/wards.geojson (A12 scope).

One-off offline generator (NOT run by the API or ingest at request time).
Reads the Overpass multipolygon response for the 23 Tokyo special wards
(saved at mock/raw/overpass-wards.json), assembles each relation's "outer"
ways into closed ring(s), Douglas-Peucker simplifies them, and writes a lean
FeatureCollection keyed by the same `ward` id contracts/wards.csv uses, so
A6 can shade an affected ward instead of dropping a pin for a JMA warning.

Query used (POST from a UTF-8 file, per contracts/feeds.json's Overpass note;
Overpass also 406s on httpx's default headers -- send an explicit
User-Agent/Accept/Content-Type):

    [out:json][timeout:90];
    rel(1543125);                 // 東京都 (Tokyo prefecture) relation
    map_to_area->.tokyo;
    rel["admin_level"="7"]["name"~"区$"](area.tokyo);
    out geom;

Re-run with: .venv\\Scripts\\python.exe mock\\_tools\\gen_wards_geojson.py
"""

from __future__ import annotations

import csv
import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "mock" / "raw" / "overpass-wards.json"
OUT = ROOT / "mock" / "wards.geojson"
WARDS_CSV = ROOT / "contracts" / "wards.csv"

# OSM name:en -> our contracts/wards.csv `ward` id (identical except the
# macron OSM uses for Bunkyo).
NAME_FIXUPS = {"Bunkyō": "Bunkyo"}

SIMPLIFY_TOLERANCE_DEG = 0.0006   # ~65m at this latitude — visibly simplified,
                                  # still recognisably each ward's shape


def load_ward_rows() -> dict[str, dict[str, str]]:
    with WARDS_CSV.open(encoding="utf-8-sig", newline="") as fh:
        return {r["ward"]: r for r in csv.DictReader(fh)}


def _pt(node: dict[str, Any]) -> tuple[float, float]:
    return (round(node["lon"], 6), round(node["lat"], 6))


def assemble_rings(way_coords: list[list[tuple[float, float]]]) -> list[list[tuple[float, float]]]:
    """Join way segments sharing endpoints into closed ring(s)."""
    ways = [list(w) for w in way_coords if len(w) >= 2]
    rings: list[list[tuple[float, float]]] = []
    while ways:
        ring = ways.pop(0)
        changed = True
        while changed and ways:
            changed = False
            for i, w in enumerate(ways):
                if ring[-1] == w[0]:
                    ring.extend(w[1:]); ways.pop(i); changed = True; break
                if ring[-1] == w[-1]:
                    ring.extend(list(reversed(w))[1:]); ways.pop(i); changed = True; break
                if ring[0] == w[-1]:
                    ring = w[:-1] + ring; ways.pop(i); changed = True; break
                if ring[0] == w[0]:
                    ring = list(reversed(w))[:-1] + ring; ways.pop(i); changed = True; break
        if ring[0] != ring[-1]:
            ring.append(ring[0])
        rings.append(ring)
    return rings


def _perp_dist(pt, a, b) -> float:
    (x, y), (x1, y1), (x2, y2) = pt, a, b
    if (x1, y1) == (x2, y2):
        return ((x - x1) ** 2 + (y - y1) ** 2) ** 0.5
    num = abs((x2 - x1) * (y - y1) - (x - x1) * (y2 - y1))
    den = ((x2 - x1) ** 2 + (y2 - y1) ** 2) ** 0.5
    return num / den


def douglas_peucker(points: list[tuple[float, float]], tol: float) -> list[tuple[float, float]]:
    if len(points) < 3:
        return points
    a, b = points[0], points[-1]
    idx, dmax = -1, 0.0
    for i in range(1, len(points) - 1):
        d = _perp_dist(points[i], a, b)
        if d > dmax:
            idx, dmax = i, d
    if dmax > tol:
        left = douglas_peucker(points[:idx + 1], tol)
        right = douglas_peucker(points[idx:], tol)
        return left[:-1] + right
    return [a, b]


def build() -> dict[str, Any]:
    raw = json.loads(RAW.read_text(encoding="utf-8"))
    ward_rows = load_ward_rows()
    features = []
    total_raw_vertices = 0
    total_simplified_vertices = 0
    seen: set[str] = set()

    for el in raw.get("elements", []):
        if el.get("type") != "relation":
            continue
        tags = el.get("tags") or {}
        name_en = NAME_FIXUPS.get(tags.get("name:en"), tags.get("name:en"))
        if not name_en or name_en not in ward_rows:
            continue
        outer_ways = [
            [_pt(n) for n in m.get("geometry") or []]
            for m in el.get("members") or []
            if m.get("type") == "way" and m.get("role") == "outer"
        ]
        total_raw_vertices += sum(len(w) for w in outer_ways)
        rings = assemble_rings(outer_ways)
        simplified = [douglas_peucker(r, SIMPLIFY_TOLERANCE_DEG) for r in rings]
        simplified = [r for r in simplified if len(r) >= 4]
        if not simplified:
            continue
        total_simplified_vertices += sum(len(r) for r in simplified)
        geom = ({"type": "Polygon", "coordinates": [[list(p) for p in simplified[0]]]}
               if len(simplified) == 1 else
               {"type": "MultiPolygon",
                "coordinates": [[[list(p) for p in r]] for r in simplified]})
        row = ward_rows[name_en]
        features.append({
            "type": "Feature",
            "geometry": geom,
            "properties": {
                "ward": name_en, "wardJa": row.get("wardJa"),
                "centroidLat": float(row["lat"]), "centroidLon": float(row["lon"]),
            },
        })
        seen.add(name_en)

    missing = sorted(set(ward_rows) - seen)
    return {
        "type": "FeatureCollection",
        "features": features,
        "_gen_note": (f"{len(features)}/{len(ward_rows)} wards; "
                      f"{total_raw_vertices} raw vertices simplified to "
                      f"{total_simplified_vertices} (tolerance {SIMPLIFY_TOLERANCE_DEG} deg); "
                      f"missing: {missing or 'none'}; source: OpenStreetMap via Overpass, "
                      f"relation admin_level=7 boundaries, ODbL"),
    }


if __name__ == "__main__":
    payload = build()
    note = payload.pop("_gen_note")
    OUT.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    print(note)
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")
