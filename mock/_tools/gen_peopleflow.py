"""mock/peopleflow.geojson -- a 1km-mesh "typical pattern" crowd density PROXY
for the 23 wards, derived from real odpt:passengerSurvey ridership already
captured in mock/stations.geojson (NOT real MLIT people-flow data -- that
dataset is registration-gated and unavailable to this build).

Run: .venv\\Scripts\\python.exe mock\\_tools\\gen_peopleflow.py
"""
import sys
import os
import math
import json

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import meta, write_json, read_wards_csv, MOCK_DIR

HONEST_NOTE = (
    "Derived proxy: static station ridership, distance-weighted. "
    "NOT real-time telco people-flow. Real MLIT 人流 data is licence-gated."
)

LON_MIN, LON_MAX = 139.55, 139.95
LAT_MIN, LAT_MAX = 35.52, 35.82
CENTER_LAT = (LAT_MIN + LAT_MAX) / 2.0
SIGMA_KM = 1.5
CUTOFF_KM = 5.0  # ~3.3 sigma; beyond this a station's contribution is negligible
DROP_FRACTION = 0.02  # drop cells below 2% of the max cell value ("near-zero")

KM_PER_DEG_LAT = 110.9
KM_PER_DEG_LON = 111.32 * math.cos(math.radians(CENTER_LAT))

CELL_KM = 1.0
CELL_DLAT = CELL_KM / KM_PER_DEG_LAT
CELL_DLON = CELL_KM / KM_PER_DEG_LON

WARDS = read_wards_csv()


def haversine_km(lat1, lon1, lat2, lon2):
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlmb = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def nearest_ward(lat, lon):
    best, bestd = None, None
    for w in WARDS:
        d = haversine_km(lat, lon, float(w["lat"]), float(w["lon"]))
        if bestd is None or d < bestd:
            best, bestd = w, d
    return best


def load_stations():
    path = os.path.join(MOCK_DIR, "stations.geojson")
    with open(path, encoding="utf-8") as f:
        doc = json.load(f)
    stations = []
    for feat in doc["features"]:
        lon, lat = feat["geometry"]["coordinates"]
        ridership = feat["properties"].get("ridership")
        if ridership is None or ridership <= 0:
            continue
        stations.append((lat, lon, float(ridership)))
    return stations


def build_grid_values(stations):
    nlat = int(math.ceil((LAT_MAX - LAT_MIN) / CELL_DLAT))
    nlon = int(math.ceil((LON_MAX - LON_MIN) / CELL_DLON))
    cells = []  # (lat0, lon0, lat1, lon1, value)
    # Pre-bucket stations isn't necessary at this small scale (149 stations x
    # ~1200 cells is trivial), so do the direct O(cells*stations) sum.
    two_sigma2 = 2.0 * SIGMA_KM * SIGMA_KM
    for i in range(nlat):
        lat0 = LAT_MIN + i * CELL_DLAT
        lat1 = min(lat0 + CELL_DLAT, LAT_MAX)
        clat = (lat0 + lat1) / 2.0
        for j in range(nlon):
            lon0 = LON_MIN + j * CELL_DLON
            lon1 = min(lon0 + CELL_DLON, LON_MAX)
            clon = (lon0 + lon1) / 2.0
            total = 0.0
            for slat, slon, ridership in stations:
                d = haversine_km(clat, clon, slat, slon)
                if d > CUTOFF_KM:
                    continue
                weight = math.exp(-(d * d) / two_sigma2)
                total += ridership * weight
            cells.append([lat0, lon0, lat1, lon1, total])
    return cells


def quintile_bands(values):
    sv = sorted(values)
    n = len(sv)
    if n == 0:
        return lambda v: 1
    cuts = [sv[min(int(n * q), n - 1)] for q in (0.2, 0.4, 0.6, 0.8)]

    def band(v):
        for idx, c in enumerate(cuts):
            if v <= c:
                return idx + 1
        return 5
    return band


def main():
    stations = load_stations()
    print(f"stations with ridership: {len(stations)}")
    cells = build_grid_values(stations)
    print(f"grid cells (pre-filter): {len(cells)}")

    max_val = max((c[4] for c in cells), default=0.0)
    threshold = max_val * DROP_FRACTION
    kept = [c for c in cells if c[4] >= threshold and c[4] > 0]
    print(f"grid cells (kept, >= {threshold:.1f}): {len(kept)}")

    values = [c[4] for c in kept]
    band_fn = quintile_bands(values)

    label = "typical pattern (derived from station ridership, not real-time people-flow)"

    features = []
    for lat0, lon0, lat1, lon1, value in kept:
        clat, clon = (lat0 + lat1) / 2.0, (lon0 + lon1) / 2.0
        ward_row = nearest_ward(clat, clon)
        poly = [[lon0, lat0], [lon1, lat0], [lon1, lat1], [lon0, lat1], [lon0, lat0]]
        features.append({
            "type": "Feature",
            "geometry": {"type": "Polygon", "coordinates": [poly]},
            "properties": {
                "value": round(value, 1),
                "band": band_fn(value),
                "ward": ward_row["ward"] if ward_row else None,
                "label": label,
            },
        })

    doc = {
        "type": "FeatureCollection",
        "_note": HONEST_NOTE,
        "features": features,
        "meta": meta(source="mock", degraded=True, note=HONEST_NOTE),
    }
    write_json("peopleflow.geojson", doc)
    path = os.path.join(MOCK_DIR, "peopleflow.geojson")
    print(f"wrote {path}: {len(features)} features, {os.path.getsize(path)} bytes ({os.path.getsize(path)/1024:.1f} KB)")


if __name__ == "__main__":
    main()
