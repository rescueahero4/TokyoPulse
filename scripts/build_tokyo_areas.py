"""Build the boundary data behind the ward weather and warning layers.

Run from the repo root when JMA changes its areas (rarely):
    python scripts/build_tokyo_areas.py

Writes:
  web/public/geo/tokyo-areas.geojson  the 23 wards, the Tama municipalities and the
                                      three island regions, keyed by JMA area code
  contracts/ward-cells.json           which forecast cells each ward overlaps, and
                                      how much of the ward falls in each

Boundaries come from JMA itself, so an advisory's area code always matches a shape.
Island municipalities are left out because the warnings feed uses the island regions
(class10s) for them, see ingest/feeds/warnings.py.
"""

from __future__ import annotations

import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from ingest.common import JMA_AREA_CODE_TO_WARD, jma_area_label, ward_ja  # noqa: E402

JMA = "https://www.jma.go.jp/bosai/common/const"
CLASS20S_URL = f"{JMA}/geojson/class20s_3.json"  # the part of the national file holding Tokyo
CLASS10S_URL = f"{JMA}/geojson/class10s.json"
AREA_MASTER_URL = f"{JMA}/area.json"
# Island region -> the municipality whose JMA label point stands for it. A region's
# biggest shape won't do: Ogasawara's turns out to be remote Minamitorishima, 1200km
# from where anyone in the region lives.
ISLAND_REGIONS = {"130020": "1336100", "130030": "1340100", "130040": "1342100"}  # Oshima, Hachijo, Ogasawara
TOKYO_MUNICIPALITIES_EXPECTED = 62  # class20s entries for Tokyo in JMA's area master

# Open-Meteo's best model for Tokyo returns centres on this lattice (checked below).
CELL_LAT_DEG = 0.05
CELL_LON_DEG = 0.0625
# Slivers this small are boundary noise rather than part of the ward's weather.
MIN_CELL_SHARE = 0.05
SAMPLE_STEP_DEG = 0.002

AREAS_OUT = ROOT / "web" / "public" / "geo" / "tokyo-areas.geojson"
CELLS_OUT = ROOT / "contracts" / "ward-cells.json"


def fetch_json(url: str) -> Any:
    req = urllib.request.Request(url, headers={"User-Agent": "TokyoPulse-build/1.0"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.load(resp)


def polygons_of(geometry: dict[str, Any]) -> list[list[list[list[float]]]]:
    return geometry["coordinates"] if geometry["type"] == "MultiPolygon" else [geometry["coordinates"]]


def in_ring(lon: float, lat: float, ring: list[list[float]]) -> bool:
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if (yi > lat) != (yj > lat) and lon < (xj - xi) * (lat - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def in_polygons(lon: float, lat: float, polygons: list[list[list[list[float]]]]) -> bool:
    for rings in polygons:
        if in_ring(lon, lat, rings[0]) and not any(in_ring(lon, lat, hole) for hole in rings[1:]):
            return True
    return False


def ward_cells(polygons: list[list[list[list[float]]]]) -> list[dict[str, float]]:
    """Share of the ward in each forecast cell, measured on a fine sample lattice."""
    lons = [p[0] for rings in polygons for p in rings[0]]
    lats = [p[1] for rings in polygons for p in rings[0]]
    counts: dict[tuple[int, int], int] = {}
    lat = min(lats)
    while lat <= max(lats):
        lon = min(lons)
        while lon <= max(lons):
            if in_polygons(lon, lat, polygons):
                key = (round(lat / CELL_LAT_DEG), round(lon / CELL_LON_DEG))
                counts[key] = counts.get(key, 0) + 1
            lon += SAMPLE_STEP_DEG
        lat += SAMPLE_STEP_DEG
    total = sum(counts.values())
    if not total:
        raise ValueError("sample lattice missed the ward entirely")
    kept = {k: v for k, v in counts.items() if v / total >= MIN_CELL_SHARE}
    kept_total = sum(kept.values())
    cells = [
        {
            "lat": round(k[0] * CELL_LAT_DEG, 4),
            "lon": round(k[1] * CELL_LON_DEG, 4),
            "weight": round(v / kept_total, 4),
        }
        for k, v in kept.items()
    ]
    return sorted(cells, key=lambda c: -c["weight"])


def check_cells_are_model_centres(cells: list[dict[str, float]]) -> None:
    """Fail the build if Open-Meteo no longer snaps to the lattice assumed above."""
    query = urllib.parse.urlencode({
        "latitude": ",".join(str(c["lat"]) for c in cells),
        "longitude": ",".join(str(c["lon"]) for c in cells),
        "current": "temperature_2m",
    })
    points = fetch_json(f"https://api.open-meteo.com/v1/forecast?{query}")
    for cell, point in zip(cells, points):
        if abs(point["latitude"] - cell["lat"]) > 1e-3 or abs(point["longitude"] - cell["lon"]) > 1e-3:
            raise SystemExit(f"Open-Meteo moved {cell} to {point['latitude']}, {point['longitude']}")


def main() -> None:
    master = fetch_json(AREA_MASTER_URL)
    class20s = [f for f in fetch_json(CLASS20S_URL)["features"] if f["properties"]["code"].startswith("13")]
    class10s = {f["properties"]["code"]: f for f in fetch_json(CLASS10S_URL)["features"]}
    if len(class20s) != TOKYO_MUNICIPALITIES_EXPECTED:
        raise SystemExit(f"expected {TOKYO_MUNICIPALITIES_EXPECTED} Tokyo areas, got {len(class20s)}")

    features: list[dict[str, Any]] = []
    wards: list[dict[str, Any]] = []
    for feature in class20s:
        props = feature["properties"]
        code = props["code"]
        ward = JMA_AREA_CODE_TO_WARD.get(code)
        region = jma_area_label(code)
        if ward:
            level, name, name_ja = "ward", ward, ward_ja(ward) or props["name"]
            place, place_ja = name, name_ja
        elif region and region[1] == "Tama area":
            level, name, name_ja = "municipality", props.get("enName") or code, props["name"]
            place_ja, place = region
        else:
            continue  # island municipality, covered by its region below
        polygons = polygons_of(feature["geometry"])
        features.append({
            "type": "Feature",
            "properties": {
                "code": code, "level": level, "name": name, "nameJa": name_ja,
                "place": place, "placeJa": place_ja, "label": props["labelPoints"][0],
            },
            "geometry": {"type": "MultiPolygon", "coordinates": polygons},
        })
        if ward:
            wards.append({"ward": ward, "wardJa": name_ja, "code": code, "cells": ward_cells(polygons)})

    labels = {f["properties"]["code"]: f["properties"]["labelPoints"][0] for f in class20s}
    for code, main_municipality in ISLAND_REGIONS.items():
        polygons = polygons_of(class10s[code]["geometry"])
        name_ja = master["class10s"][code]["name"]
        name = master["class10s"][code]["enName"]
        features.append({
            "type": "Feature",
            "properties": {
                "code": code, "level": "region", "name": name, "nameJa": name_ja,
                "place": name, "placeJa": name_ja, "label": labels[main_municipality],
            },
            "geometry": {"type": "MultiPolygon", "coordinates": polygons},
        })

    if len(wards) != len(JMA_AREA_CODE_TO_WARD):
        raise SystemExit(f"expected {len(JMA_AREA_CODE_TO_WARD)} wards, got {len(wards)}")
    unique = {(c["lat"], c["lon"]): c for w in wards for c in w["cells"]}
    check_cells_are_model_centres(list(unique.values()))

    AREAS_OUT.parent.mkdir(parents=True, exist_ok=True)
    AREAS_OUT.write_text(
        json.dumps({
            "type": "FeatureCollection",
            "attribution": "Boundaries: Japan Meteorological Agency (気象庁)",
            "features": features,
        }, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    CELLS_OUT.write_text(
        json.dumps({
            "_comment": "Generated by scripts/build_tokyo_areas.py. weight = share of the ward in that forecast cell.",
            "cellSizeDeg": {"lat": CELL_LAT_DEG, "lon": CELL_LON_DEG},
            "wards": wards,
        }, ensure_ascii=False, indent=1) + "\n",
        encoding="utf-8",
    )
    print(f"{len(features)} areas -> {AREAS_OUT} ({AREAS_OUT.stat().st_size // 1024} KB)")
    print(f"{len(wards)} wards over {len(unique)} forecast cells -> {CELLS_OUT}")
    for w in wards:
        print(f"  {w['ward']:<11}", [(c["lat"], c["lon"], c["weight"]) for c in w["cells"]])


if __name__ == "__main__":
    main()
