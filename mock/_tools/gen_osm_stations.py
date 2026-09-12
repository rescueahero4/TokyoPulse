"""Add stations for the 14 non-Toei lines (JR + TokyoMetro, odptRailway=="" in
contracts/lines.csv) into mock/stations.geojson, sourced from OpenStreetMap via
Overpass (reusing the route relations already fetched for line geometry in
mock/raw/overpass-{jr,metro1,metro2}.json).

ODPT's keyless mirror only gives us the 149 Toei stations; this fills the gap
so clicking a JR/Metro line in the ImpactPanel (e.g. Chuo, doc/prd.md S9 beat 3)
has real stations instead of an empty panel.

stationId convention: "osm-<smallest OSM node id in the merged group>" --
guaranteed not to collide with the ODPT "Toei.<Line>.<Name>" convention.

Stations appearing on more than one of these 14 lines are MERGED into a single
feature (grouped by OSM's Japanese `name` tag) with a unioned lineIds[] list,
rather than emitted once per line.

Run AFTER gen_real.py (needs mock/stations.geojson to already contain the 149
Toei stations) and AFTER fetching mock/raw/overpass-station-tags.json (see
fetch step in this file's __main__ / the agent's session notes):
  .venv\\Scripts\\python.exe mock\\_tools\\gen_osm_stations.py
"""
import sys
import os
import json

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import meta, write_json, MOCK_DIR
from gen_real import OSM_LINE_MATCH, load_raw, LINES, in_bounds, nearest_ward, FLOOD_WARDS

OVERPASS_FILES = ["overpass-jr.json", "overpass-metro1.json", "overpass-metro2.json"]

# Tiny manual patch for the handful of stations where NO node in the merged
# group carried an OSM name:en/name:ja-Latn tag (checked by hand against the
# fetched data -- as of this run, only Kiba on the Tozai line needed this).
MANUAL_EN_NAMES = {
    "木場": "Kiba",
}
STOP_ROLES = {"stop", "stop_entry_only", "stop_exit_only"}

NON_ODPT_LINES = [r for r in LINES if not r["odptRailway"]]
VALID_LINE_IDS = {r["lineId"] for r in LINES}


def collect_line_refs():
    """lineId -> {osm_node_ref: (lat, lon)}"""
    line_refs = {}
    for row in NON_ODPT_LINES:
        line_id = row["lineId"]
        matcher = OSM_LINE_MATCH[line_id]
        refs = {}
        for fn in OVERPASS_FILES:
            data = load_raw(fn)
            for el in data.get("elements", []):
                if el.get("type") != "relation":
                    continue
                name = (el.get("tags") or {}).get("name") or ""
                if not matcher(name):
                    continue
                for m in el.get("members", []):
                    if m.get("type") == "node" and m.get("role") in STOP_ROLES:
                        lat, lon = m.get("lat"), m.get("lon")
                        if lat is not None and lon is not None:
                            refs[m["ref"]] = (lat, lon)
        line_refs[line_id] = refs
    return line_refs


def load_tags():
    data = load_raw("overpass-station-tags.json")
    return {e["id"]: (e.get("tags") or {}) for e in data.get("elements", []) if e.get("type") == "node"}


def build_groups(line_refs, tags_by_ref):
    """Group OSM stop nodes by their Japanese name -> merged station record."""
    groups = {}  # name_ja -> {refs:set, lineIds:set, lats:[], lons:[], name_en_candidates:[]}
    for line_id, refs in line_refs.items():
        for ref, (lat, lon) in refs.items():
            tags = tags_by_ref.get(ref, {})
            name_ja = tags.get("name")
            key = name_ja if name_ja else f"__unnamed_{ref}"
            g = groups.setdefault(key, {"refs": set(), "lineIds": set(), "lats": [], "lons": [], "name_en_candidates": [], "name_ja": name_ja})
            g["refs"].add(ref)
            g["lineIds"].add(line_id)
            g["lats"].append(lat)
            g["lons"].append(lon)
            name_en = tags.get("name:en") or tags.get("name:ja-Latn") or tags.get("name:ja_rm")
            if name_en:
                g["name_en_candidates"].append(name_en)
    return groups


def main():
    line_refs = collect_line_refs()
    for line_id, refs in line_refs.items():
        print(f"{line_id}: {len(refs)} stop nodes (pre-merge)")

    tags_by_ref = load_tags()
    groups = build_groups(line_refs, tags_by_ref)
    print(f"merged into {len(groups)} unique named stations")

    existing_path = os.path.join(MOCK_DIR, "stations.geojson")
    with open(existing_path, encoding="utf-8") as f:
        existing_doc = json.load(f)
    existing_ids = {f["properties"]["stationId"] for f in existing_doc["features"]}

    new_features = []
    dropped_out_of_bounds = 0
    missing_en_fallback = 0
    for key, g in groups.items():
        clat = sum(g["lats"]) / len(g["lats"])
        clon = sum(g["lons"]) / len(g["lons"])
        if not in_bounds(clon, clat):
            dropped_out_of_bounds += 1
            continue
        name_ja = g["name_ja"]
        name_en = next((n for n in g["name_en_candidates"] if n), None) or MANUAL_EN_NAMES.get(name_ja)
        if not name_en:
            name_en = name_ja or f"Station {min(g['refs'])}"
            missing_en_fallback += 1
        station_id = f"osm-{min(g['refs'])}"
        if station_id in existing_ids:
            # extremely unlikely (different id namespaces) but guard anyway
            station_id = f"osm-{min(g['refs'])}-dup"
        existing_ids.add(station_id)
        ward_row = nearest_ward(clat, clon)
        ward_name = ward_row["ward"] if ward_row else None
        line_ids_sorted = sorted(g["lineIds"])
        band = 3 if len(line_ids_sorted) >= 2 else 2
        new_features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [clon, clat]},
            "properties": {
                "stationId": station_id,
                "name": name_en,
                "nameJa": name_ja,
                "lineIds": line_ids_sorted,
                "ward": ward_name,
                "ridership": None,
                "ridershipBand": band,
                "inFloodZone": ward_name in FLOOD_WARDS if ward_name else False,
            },
        })

    # sanity: every lineId referenced must exist in contracts/lines.csv
    bad_line_refs = 0
    for f in new_features:
        for lid in f["properties"]["lineIds"]:
            if lid not in VALID_LINE_IDS:
                bad_line_refs += 1

    all_features = existing_doc["features"] + new_features
    note = (
        "Toei stations + ridership are real (odpt:Station / odpt:passengerSurvey). "
        "JR/Metro stations (lineIds for the 14 non-Toei lines) are from OpenStreetMap "
        "(no ODPT coverage) -- their ridership is null (not invented) and ridershipBand "
        "is a FALLBACK heuristic (3 = serves >=2 of our lines, else 2), not measured "
        "data. inFloodZone for all stations is a low-lying-ward heuristic "
        f"({', '.join(sorted(FLOOD_WARDS))}), not a flood-map lookup."
    )
    out_doc = {
        "type": "FeatureCollection",
        "features": all_features,
        "meta": meta(source="live", degraded=True, note=note),
    }
    write_json("stations.geojson", out_doc)
    print(f"wrote stations.geojson: {len(existing_doc['features'])} existing (Toei) + {len(new_features)} new (OSM) = {len(all_features)} total")
    print(f"dropped out-of-bounds groups: {dropped_out_of_bounds}")
    print(f"stations using name_ja/ref as English-name fallback (no name:en anywhere in group): {missing_en_fallback}")
    print(f"lineIds referencing a lineId not in contracts/lines.csv: {bad_line_refs}")

    per_line_count = {row["lineId"]: 0 for row in NON_ODPT_LINES}
    for f in new_features:
        for lid in f["properties"]["lineIds"]:
            if lid in per_line_count:
                per_line_count[lid] += 1
    print("per-line station counts (post-merge):")
    for lid, cnt in per_line_count.items():
        print(f"  {lid}: {cnt}")


if __name__ == "__main__":
    main()
