"""TokyoPulse — static seed loader (owner: A3). IDEMPOTENT, safe to re-run.

    .venv\\Scripts\\python.exe scripts\\seed.py

Loads, in this order:
  1. contracts/lines.csv  -> (:Line)      — all 20 lines, always
  2. contracts/wards.csv  -> (:Ward)      — all 23 special wards
  3. Stations + (Line)-[:SERVES]->(Station) + (Station)-[:IN]->(Ward), from
     mock/stations.geojson when A5-DATA has filled it, otherwise derived from
     the cached ODPT payloads in mock/raw/ (odpt-station + odpt-railway
     stationOrder + odpt-passengersurvey). If neither exists, lines and wards
     are still seeded and the script says so.

Then prints a node/relationship count summary.

Never writes to mock/ (A5-DATA owns it) or contracts/ (read-only).
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

from api import graph                                          # noqa: E402
from api.envelope import lines_csv, wards_csv                   # noqa: E402

MOCK = ROOT / "mock"

# Documented heuristic: Tokyo's recognised low-lying flood basin — the 江東5区
# (Sumida, Koto, Adachi, Katsushika, Edogawa) plus Arakawa ward, which sit below
# the Arakawa/Sumida river flood level. Used ONLY when the upstream dataset does
# not carry a real inFloodZone flag; labelled as a heuristic in the output.
FLOOD_WARDS = {"Sumida", "Koto", "Adachi", "Katsushika", "Edogawa", "Arakawa"}


def _load_json(path: Path):
    try:
        with path.open("r", encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return None


def _nearest_ward(lat: float, lon: float, wards: list[dict]) -> str | None:
    best, bestd = None, 1e9
    for w in wards:
        try:
            dlat = float(w["lat"]) - lat
            dlon = (float(w["lon"]) - lon) * math.cos(math.radians(lat))
        except (TypeError, ValueError, KeyError):
            continue
        d = dlat * dlat + dlon * dlon
        if d < bestd:
            best, bestd = w["ward"], d
    # ~0.18 deg ≈ 20 km: anything further out is not a Tokyo special ward.
    return best if bestd < 0.0324 else None


def _bands(values: list[int | None]) -> dict[int, int]:
    """Quintile map: ridership -> band 1..5 (precomputed for the UI)."""
    nums = sorted(v for v in values if isinstance(v, int) and v > 0)
    if not nums:
        return {}
    cuts = [nums[int(len(nums) * q) - 1] for q in (0.2, 0.4, 0.6, 0.8)]
    out = {}
    for v in set(nums):
        band = 1
        for c in cuts:
            if v > c:
                band += 1
        out[v] = min(5, band)
    return out


def stations_from_mock(wards: list[dict]) -> list[dict]:
    fc = _load_json(MOCK / "stations.geojson") or {}
    feats = fc.get("features") or []
    out = []
    for f in feats:
        p = (f or {}).get("properties") or {}
        coords = ((f or {}).get("geometry") or {}).get("coordinates") or [None, None]
        sid = p.get("stationId")
        if not sid:
            continue
        out.append({
            "stationId": sid, "name": p.get("name"), "nameJa": p.get("nameJa"),
            "lat": coords[1], "lon": coords[0],
            "ridership": p.get("ridership"),
            "ridershipBand": p.get("ridershipBand") or 1,
            "inFloodZone": bool(p.get("inFloodZone")),
            "ward": p.get("ward"),
            "lines": [{"lineId": lid, "index": i}
                      for i, lid in enumerate(p.get("lineIds") or [], start=1)],
        })
    return out


def stations_from_raw_odpt(wards: list[dict]) -> tuple[list[dict], list[str]]:
    """Build real stations from the cached keyless ODPT payloads."""
    notes: list[str] = []
    stations = _load_json(MOCK / "raw" / "odpt-station.json") or []
    railways = _load_json(MOCK / "raw" / "odpt-railway.json") or []
    survey = _load_json(MOCK / "raw" / "odpt-passengersurvey.json") or []
    if not stations:
        return [], ["mock/raw/odpt-station.json absent"]

    railway_to_line = {r.get("odptRailway"): r["lineId"] for r in lines_csv()
                       if r.get("odptRailway")}

    # station order per railway -> SERVES index
    order: dict[str, int] = {}
    for rw in railways:
        for entry in rw.get("odpt:stationOrder") or []:
            st = entry.get("odpt:station")
            if st:
                order[st] = int(entry.get("odpt:index") or 0)

    # latest passenger survey per station
    ridership: dict[str, int] = {}
    for s in survey:
        objs = s.get("odpt:passengerSurveyObject") or []
        if not objs:
            continue
        latest = max(objs, key=lambda o: o.get("odpt:surveyYear") or 0)
        j = latest.get("odpt:passengerJourneys")
        for st in s.get("odpt:station") or []:
            if isinstance(j, (int, float)):
                ridership[st] = int(j)

    merged: dict[str, dict] = {}
    for st in stations:
        same = st.get("owl:sameAs") or ""
        sid = same.replace("odpt.Station:", "")
        if not sid:
            continue
        lid = railway_to_line.get(st.get("odpt:railway"))
        lat, lon = st.get("geo:lat"), st.get("geo:long")
        titles = st.get("odpt:stationTitle") or {}
        rec = merged.get(sid)
        if rec is None:
            ward = _nearest_ward(lat, lon, wards) if lat and lon else None
            rec = {
                "stationId": sid,
                "name": titles.get("en") or st.get("dc:title"),
                "nameJa": titles.get("ja") or st.get("dc:title"),
                "lat": lat, "lon": lon,
                "ridership": ridership.get(same),
                "ridershipBand": 1,
                "inFloodZone": bool(ward in FLOOD_WARDS),
                "ward": ward,
                "lines": [],
            }
            merged[sid] = rec
        if lid and not any(x["lineId"] == lid for x in rec["lines"]):
            rec["lines"].append({"lineId": lid, "index": order.get(same, 0)})

    band_map = _bands([r.get("ridership") for r in merged.values()])
    for r in merged.values():
        r["ridershipBand"] = band_map.get(r.get("ridership") or -1, 1)
    notes.append(f"stations derived from mock/raw ODPT caches ({len(merged)} stations)")
    notes.append("ward assigned by nearest ward centroid (heuristic)")
    notes.append("inFloodZone from the low-lying ward set heuristic, not GSI raster")
    return list(merged.values()), notes


def main() -> int:
    print("TokyoPulse seed loader")
    print("-" * 62)
    up, note = graph.neo4j_status(force=True)
    if not up:
        print(f"FAIL  Neo4j is not reachable: {note}")
        print("      Fix NEO4J_* in .env, then re-run. The API keeps serving")
        print("      cached mock payloads in the meantime (degraded, never 500).")
        return 2

    applied = graph.ensure_schema()
    print(f"OK    schema: {len(applied)} constraints/indexes ensured "
          f"({', '.join(applied)})")

    lines, wards = lines_csv(), wards_csv()
    n_lines = graph.upsert_lines([
        {"lineId": r["lineId"], "name": r["name"], "nameJa": r["nameJa"],
         "operator": r["operator"], "color": r["color"],
         "statusFeed": r.get("statusFeed")} for r in lines])
    print(f"OK    lines: {n_lines} from contracts/lines.csv")
    n_wards = graph.upsert_wards(wards)
    print(f"OK    wards: {n_wards} from contracts/wards.csv")

    notes: list[str] = []
    st = stations_from_mock(wards)
    if len(st) >= 20:
        notes.append(f"stations from mock/stations.geojson ({len(st)})")
    else:
        if st:
            notes.append(f"mock/stations.geojson has only {len(st)} features "
                         f"— using the cached ODPT payloads instead")
        raw_st, raw_notes = stations_from_raw_odpt(wards)
        if raw_st:
            st, notes = raw_st, notes + raw_notes
        elif st:
            notes.append("seeded the few mock stations available")
        else:
            notes.append("NO station source found — seeded lines and wards only")

    if st and not any(s.get("inFloodZone") for s in st):
        # Upstream dataset carries no flood flag yet. Rather than ship a line-impact
        # view that says "0 stations in a flood zone" for every line in Tokyo, fall
        # back to the documented low-lying-ward heuristic — labelled as such.
        for s in st:
            s["inFloodZone"] = s.get("ward") in FLOOD_WARDS
        notes.append("inFloodZone derived from the low-lying ward set heuristic "
                     f"({', '.join(sorted(FLOOD_WARDS))}) — upstream data had none")

    if st:
        res = graph.upsert_stations(st)
        print(f"OK    stations: {res['stations']}  SERVES: {res['serves']}  "
              f"IN: {res['in']}")
    else:
        print("WARN  stations: 0 (mock/stations.geojson and mock/raw both unusable)")

    print("-" * 62)
    try:
        counts = graph.node_counts()
        print("graph now holds:")
        for k in ("lines", "stations", "wards", "events", "serves", "inWard", "affects"):
            print(f"    {k:<10} {counts.get(k, 0)}")
        flood = graph.run(
            "MATCH (s:Station) WHERE s.inFloodZone RETURN count(s) AS c")[0]["c"]
        print(f"    {'inFlood':<10} {flood}")
    except Exception as exc:
        print(f"WARN  count summary failed: {exc}")

    for n in notes:
        print(f"note: {n}")
    print("done. safe to re-run.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
