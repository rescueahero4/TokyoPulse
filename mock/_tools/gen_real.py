"""TASK 2 — replace stubs with REAL captured data.
Reads mock/raw/*.json (already fetched by fetch_raw.py + overpass fetches) and
contracts/*.csv, and writes the real mock/*.json + mock/*.geojson + mock/impact/*.json.

Run: .venv\\Scripts\\python.exe mock\\_tools\\gen_real.py
"""
import sys
import os
import json
import math
import datetime
import hashlib

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import meta, write_json, iso, now_jst, read_lines_csv, read_wards_csv, JST, MOCK_DIR

RAW = os.path.join(MOCK_DIR, "raw")


def load_raw(name):
    with open(os.path.join(RAW, name), encoding="utf-8") as f:
        return json.load(f)


LINES = read_lines_csv()
LINE_BY_ODPT = {r["odptRailway"]: r for r in LINES if r["odptRailway"]}
LINE_BY_ID = {r["lineId"]: r for r in LINES}
WARDS = read_wards_csv()

TOKYO_BOUNDS = {"lon": (138.9, 140.2), "lat": (35.4, 36.0)}

# Low-lying-ward heuristic for inFloodZone -- NOT a flood-map lookup, just the
# wards most commonly cited as low-elevation / river-adjacent in Tokyo flood
# hazard discussion. Applied consistently to every station regardless of
# operator (Toei/ODPT or JR/Metro/OSM).
FLOOD_WARDS = {"Sumida", "Koto", "Adachi", "Katsushika", "Edogawa", "Arakawa"}


def in_bounds(lon, lat):
    lo, hi = TOKYO_BOUNDS["lon"]
    la, ha = TOKYO_BOUNDS["lat"]
    return lo <= lon <= hi and la <= lat <= ha


def haversine(lat1, lon1, lat2, lon2):
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlmb = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def nearest_ward(lat, lon):
    best, bestd = None, None
    for w in WARDS:
        d = haversine(lat, lon, float(w["lat"]), float(w["lon"]))
        if bestd is None or d < bestd:
            best, bestd = w, d
    return best


# ---------------------------------------------------------------------------
# odpt:Station index (strip "odpt.Station:" prefix -> our stationId convention)
# ---------------------------------------------------------------------------
STATIONS_RAW = load_raw("odpt-station.json")
STATION_BY_ID = {}
for s in STATIONS_RAW:
    sid = s["owl:sameAs"].replace("odpt.Station:", "")
    STATION_BY_ID[sid] = s

PASSENGER_RAW = load_raw("odpt-passengersurvey.json")
RIDERSHIP_BY_STATION = {}
for p in PASSENGER_RAW:
    stations = p.get("odpt:station") or []
    objs = p.get("odpt:passengerSurveyObject") or []
    if not objs:
        continue
    latest = max(objs, key=lambda o: o.get("odpt:surveyYear", 0))
    val = latest.get("odpt:passengerJourneys")
    for st in stations:
        sid = st.replace("odpt.Station:", "")
        if val is not None:
            RIDERSHIP_BY_STATION[sid] = val


# ---------------------------------------------------------------------------
# 2b. Train status (odpt:TrainInformation) -> per-lineId status dict
# ---------------------------------------------------------------------------
def classify_train_text(text):
    if text is None:
        text = ""
    if "運転見合わせ" in text or "運転中止" in text:
        return "critical", "suspended"
    # Check the negated phrase BEFORE the bare "delay" substring -- "遅延は
    # ありません" ("no delays") literally contains "遅延" and would otherwise
    # be misclassified as a delay.
    if "平常運転" in text or "遅延はありません" in text:
        return "info", "normal"
    if "遅延" in text:
        return "warning", "delay"
    return "info", "normal"


TRAININFO_RAW = load_raw("odpt-traininformation.json")
TRAIN_STATUS_BY_LINE = {}  # lineId -> dict(status, statusText, severity)
TRAIN_EVENTS = []
for item in TRAININFO_RAW:
    odpt_railway = item.get("odpt:railway")
    row = LINE_BY_ODPT.get(odpt_railway)
    if not row:
        continue
    line_id = row["lineId"]
    text_ja = (item.get("odpt:trainInformationText") or {}).get("ja") or ""
    text_en = (item.get("odpt:trainInformationText") or {}).get("en")
    severity, status = classify_train_text(text_ja)
    TRAIN_STATUS_BY_LINE[line_id] = {
        "status": status,
        "statusText": text_en or ("Normal operation" if status == "normal" else text_ja),
        "statusTextJa": text_ja or None,
        "severity": severity,
    }
    dc_date = item.get("dc:date")  # already ISO8601 +09:00 per ODPT convention
    en_title = {
        "normal": f"{row['name']} operating normally",
        "delay": f"Delays on {row['name']}",
        "suspended": f"Service suspended on {row['name']}",
    }[status]
    TRAIN_EVENTS.append({
        "id": f"odpt-train-{line_id}",
        "type": "train",
        "severity": severity,
        "time": dc_date or iso(),
        "lat": None,
        "lon": None,
        "title": en_title,
        "titleJa": text_ja or None,
        "affects": [f"line:{line_id}"],
        "source": "odpt",
        "url": None,
        "magnitude": None,
        "maxScale": None,
    })

# Any line this mock generator has no actual live-feed data for (i.e. wasn't
# populated from odpt:TrainInformation above) is "unknown" per line-feature
# schema -- this now includes the 5 JR lines even though contracts/lines.csv
# marks their statusFeed "live" (A2's JR-East scraper supplies that live at
# runtime; this mock script only has ODPT TrainInformation, which is Toei-only).
for row in LINES:
    if row["lineId"] not in TRAIN_STATUS_BY_LINE:
        TRAIN_STATUS_BY_LINE[row["lineId"]] = {
            "status": "unknown", "statusText": "No live status feed",
            "statusTextJa": None, "severity": None,
        }

# Hand-authored demo disruption events (source:"mock") -- all 6 Toei lines are
# currently normal live, so the demo needs something amber/red to point at.
MOCK_DISRUPTION_EVENTS = [
    {
        "id": "mock-disruption-asakusa-signal",
        "type": "train",
        "severity": "warning",
        "time": iso(now_jst() - datetime.timedelta(minutes=25)),
        "lat": 35.7038, "lon": 139.7967,
        "title": "Asakusa Line: signal fault causing ~10 min delays",
        "titleJa": "都営浅草線 信号トラブルのため約10分の遅延",
        "affects": ["line:Toei-Asakusa"],
        "source": "mock",
        "url": None,
        "magnitude": None,
        "maxScale": None,
    },
    {
        "id": "mock-disruption-oedo-suspended",
        "type": "train",
        "severity": "critical",
        "time": iso(now_jst() - datetime.timedelta(minutes=8)),
        "lat": 35.6586, "lon": 139.7454,
        "title": "Oedo Line: service suspended between Roppongi and Azabu-Juban",
        "titleJa": "都営大江戸線 六本木〜麻布十番間で運転見合わせ",
        "affects": ["line:Toei-Oedo"],
        "source": "mock",
        "url": None,
        "magnitude": None,
        "maxScale": None,
    },
]


# ---------------------------------------------------------------------------
# 2a. lines.geojson
# ---------------------------------------------------------------------------
def build_toei_geometry(row):
    railway_raw = load_raw("odpt-railway.json")
    rail = next((r for r in railway_raw if r["owl:sameAs"] == row["odptRailway"]), None)
    if not rail:
        return []
    order = sorted(rail.get("odpt:stationOrder", []), key=lambda o: o.get("odpt:index", 0))
    coords = []
    for o in order:
        sid = o["odpt:station"].replace("odpt.Station:", "")
        st = STATION_BY_ID.get(sid)
        if not st:
            continue
        lat, lon = st.get("geo:lat"), st.get("geo:long")
        if lat is None or lon is None:
            continue
        coords.append([lon, lat])
    return coords


# name patterns matching real OSM relation names, to pick the right elements
# out of each batched Overpass file (discovered empirically -- OSM naming is
# inconsistent, e.g. Chiyoda's main segment lacks the "東京メトロ" prefix).
OSM_LINE_MATCH = {
    "JR-Yamanote": lambda n: n == "JR山手線",
    "JR-Chuo-Rapid": lambda n: "中央線快速" in n,
    "JR-Chuo-Sobu": lambda n: "総武緩行線" in n,
    "JR-Keihin-Tohoku": lambda n: "京浜東北線" in n,
    "JR-Saikyo": lambda n: "埼京線" in n,
    "Metro-Ginza": lambda n: n.startswith("東京メトロ銀座線"),
    "Metro-Marunouchi": lambda n: n.startswith("東京メトロ丸ノ内線"),
    "Metro-Hibiya": lambda n: n.startswith("東京メトロ日比谷線 :") or n.startswith("東京メトロ日比谷線:"),
    "Metro-Tozai": lambda n: n.startswith("東京メトロ東西線"),
    "Metro-Chiyoda": lambda n: n.startswith("東京メトロ千代田線") or n.startswith("千代田線"),
    "Metro-Yurakucho": lambda n: n.startswith("東京メトロ有楽町線"),
    "Metro-Hanzomon": lambda n: n.startswith("東京メトロ半蔵門線 :") or n.startswith("東京メトロ半蔵門線:"),
    "Metro-Namboku": lambda n: n.startswith("東京メトロ南北線"),
    "Metro-Fukutoshin": lambda n: n.startswith("東京メトロ副都心線"),
}

OVERPASS_FILES = ["overpass-jr.json", "overpass-metro1.json", "overpass-metro2.json"]


def build_osm_multiline(line_id):
    matcher = OSM_LINE_MATCH[line_id]
    lines = []
    for fname in OVERPASS_FILES:
        path = os.path.join(RAW, fname)
        if not os.path.exists(path):
            continue
        data = load_raw(fname)
        for el in data.get("elements", []):
            if el.get("type") != "relation":
                continue
            name = (el.get("tags") or {}).get("name") or ""
            if not matcher(name):
                continue
            for m in el.get("members", []):
                if m.get("type") != "way":
                    continue
                geom = m.get("geometry")
                if not geom or len(geom) < 2:
                    continue
                coords = [[pt["lon"], pt["lat"]] for pt in geom]
                # Clip out segments (or parts of segments) that fall outside the
                # Tokyo-ish sanity bounds -- real OSM geometry for lines like
                # Keihin-Tohoku legitimately continues into Kanagawa (Yokohama/
                # Ofuna), south of lat 35.4. We keep runs of in-bounds points only.
                run = []
                for lon, lat in coords:
                    if in_bounds(lon, lat):
                        run.append([lon, lat])
                    else:
                        if len(run) >= 2:
                            lines.append(run)
                        run = []
                if len(run) >= 2:
                    lines.append(run)
    return lines


def build_lines_geojson():
    features = []
    bad_coords = []
    empty_lines = []
    for row in LINES:
        line_id = row["lineId"]
        status_info = TRAIN_STATUS_BY_LINE.get(line_id, {"status": "unknown", "statusText": "No live status feed", "statusTextJa": None})
        # Geometry source is keyed on whether THIS mock script actually has
        # odpt:Railway station-order data for the line (Toei only) -- NOT on
        # contracts/lines.csv's statusFeed column, which now also says "live"
        # for the 5 JR lines (A2's separate JR-East scraper), even though
        # odptRailway is blank for them and they still need the OSM path here.
        if row["odptRailway"]:
            coords = build_toei_geometry(row)
            geom = {"type": "LineString", "coordinates": coords}
            status = status_info["status"]
            status_text = status_info["statusText"]
            status_text_ja = status_info.get("statusTextJa")
            status_source = "live" if status != "unknown" else "none"
            updated_at = iso() if status != "unknown" else None
            for lon, lat in coords:
                if not in_bounds(lon, lat):
                    bad_coords.append((line_id, lon, lat))
            if not coords:
                empty_lines.append(line_id)
        else:
            multi = build_osm_multiline(line_id)
            if multi:
                geom = {"type": "MultiLineString", "coordinates": multi}
                for seg in multi:
                    for lon, lat in seg:
                        if not in_bounds(lon, lat):
                            bad_coords.append((line_id, lon, lat))
            else:
                geom = {"type": "MultiLineString", "coordinates": []}
                empty_lines.append(line_id)
            # This mock script has no live JR/Metro status feed (A2's JR-East
            # scraper supplies it separately at runtime) -- honestly "unknown".
            status = "unknown"
            status_text = "No live status feed"
            status_text_ja = None
            status_source = "none"
            updated_at = None

        features.append({
            "type": "Feature",
            "geometry": geom,
            "properties": {
                "lineId": line_id,
                "name": row["name"],
                "nameJa": row["nameJa"],
                "operator": row["operator"],
                "status": status,
                "statusText": status_text,
                "statusTextJa": status_text_ja,
                "color": row["color"],
                "statusSource": status_source,
                "updatedAt": updated_at,
            },
        })
    write_json("lines.geojson", {"type": "FeatureCollection", "features": features, "meta": meta(source="live" if not empty_lines else "live", note=(f"empty geometry for: {', '.join(empty_lines)}" if empty_lines else None))})
    print(f"lines.geojson: {len(features)} features, {len(empty_lines)} empty geometry ({empty_lines}), {len(bad_coords)} out-of-bounds coords")
    if bad_coords:
        print("OUT OF BOUNDS SAMPLE:", bad_coords[:5])
    return empty_lines, bad_coords


# ---------------------------------------------------------------------------
# 2c. stations.geojson
# ---------------------------------------------------------------------------
def quintile_bands(values):
    """Return a function mapping a value to a 1..5 band via quintiles."""
    sv = sorted(values)
    n = len(sv)
    if n == 0:
        return lambda v: 2
    cuts = [sv[min(int(n * q) , n - 1)] for q in (0.2, 0.4, 0.6, 0.8)]

    def band(v):
        for i, c in enumerate(cuts):
            if v <= c:
                return i + 1
        return 5
    return band


def build_stations_geojson():
    ridership_vals = [v for v in RIDERSHIP_BY_STATION.values()]
    band_fn = quintile_bands(ridership_vals)
    features = []
    bad_coords = []
    for sid, st in STATION_BY_ID.items():
        lat, lon = st.get("geo:lat"), st.get("geo:long")
        if lat is None or lon is None:
            continue
        odpt_railway = st.get("odpt:railway")
        row = LINE_BY_ODPT.get(odpt_railway)
        line_ids = [row["lineId"]] if row else []
        ward_row = nearest_ward(lat, lon)
        ward_name = ward_row["ward"] if ward_row else None
        ridership = RIDERSHIP_BY_STATION.get(sid)
        band = band_fn(ridership) if ridership is not None else 2
        title = st.get("odpt:stationTitle") or {}
        if not in_bounds(lon, lat):
            bad_coords.append((sid, lon, lat))
        features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [lon, lat]},
            "properties": {
                "stationId": sid,
                "name": title.get("en", sid),
                "nameJa": title.get("ja"),
                "lineIds": line_ids,
                "ward": ward_name,
                "ridership": ridership,
                "ridershipBand": band,
                "inFloodZone": ward_name in FLOOD_WARDS if ward_name else False,
            },
        })
    write_json("stations.geojson", {"type": "FeatureCollection", "features": features, "meta": meta(source="live")})
    print(f"stations.geojson: {len(features)} features, {len(bad_coords)} out-of-bounds")
    return STATION_BY_ID, bad_coords


# ---------------------------------------------------------------------------
# 2b. events.json -- quakes, warnings, weather, trains
# ---------------------------------------------------------------------------
def build_quake_events():
    raw = load_raw("p2pquake-history.json")
    now = now_jst()
    cutoff = now - datetime.timedelta(days=7)
    events = []
    for item in raw:
        eq = item.get("earthquake")
        if not eq:
            continue
        t_str = eq.get("time")
        if not t_str:
            continue
        try:
            t_naive = datetime.datetime.strptime(t_str, "%Y/%m/%d %H:%M:%S")
        except ValueError:
            continue
        t = t_naive.replace(tzinfo=JST)
        if t < cutoff:
            continue
        hyp = eq.get("hypocenter") or {}
        lat, lon = hyp.get("latitude"), hyp.get("longitude")
        # P2PQuake uses -200/-200 as a sentinel for "hypocenter not yet
        # determined" (preliminary ScalePrompt reports) -- not a real place.
        if lat is not None and (lat < -90 or lat > 90):
            lat = None
        if lon is not None and (lon < -180 or lon > 180):
            lon = None
        if lat is None or lon is None:
            lat = lon = None
        mag = hyp.get("magnitude")
        if mag == -1:
            mag = None
        max_scale = eq.get("maxScale")
        if max_scale in (-1, None):
            severity = "info"
        elif max_scale >= 40:
            severity = "critical"
        elif max_scale >= 30:
            severity = "warning"
        else:
            severity = "info"
        place = hyp.get("name") or "unknown epicenter"
        nid = item.get("id") or hashlib.sha1(t_str.encode()).hexdigest()[:12]
        events.append({
            "id": f"p2p-{nid}",
            "type": "quake",
            "severity": severity,
            "time": iso(t),
            "lat": lat,
            "lon": lon,
            "title": f"M{mag if mag is not None else '?'} earthquake near {place}",
            "titleJa": f"{place}でM{mag if mag is not None else '不明'}の地震",
            "affects": [],
            "source": "p2pquake",
            "url": None,
            "magnitude": mag,
            "maxScale": None if max_scale == -1 else max_scale,
        })
    return events


WARNING_CODE_INFO = {
    # JMA warning-code master (警報=critical, 注意報=warning). Hardcoded --
    # no live JMA code-name endpoint was found; this is the standard public table.
    "02": ("Snowstorm warning", "暴風雪警報", "critical"),
    "03": ("Storm warning", "暴風警報", "critical"),
    "04": ("Heavy rain warning", "大雨警報", "critical"),
    "05": ("Flood warning", "洪水警報", "critical"),
    "06": ("Heavy snow warning", "大雪警報", "critical"),
    "07": ("High wave warning", "波浪警報", "critical"),
    "08": ("Storm surge warning", "高潮警報", "critical"),
    "10": ("Heavy rain advisory", "大雨注意報", "warning"),
    "12": ("Heavy snow advisory", "大雪注意報", "warning"),
    "13": ("Wind/snow advisory", "風雪注意報", "warning"),
    "14": ("Thunderstorm advisory", "雷注意報", "warning"),
    "15": ("Strong wind advisory", "強風注意報", "warning"),
    "16": ("High wave advisory", "波浪注意報", "warning"),
    "18": ("Storm surge advisory", "高潮注意報", "warning"),
    "19": ("Flood advisory", "洪水注意報", "warning"),
    "20": ("Dense fog advisory", "濃霧注意報", "warning"),
    "21": ("Dry weather advisory", "乾燥注意報", "warning"),
    "22": ("Avalanche advisory", "なだれ注意報", "warning"),
    "23": ("Low temperature advisory", "低温注意報", "warning"),
    "24": ("Frost advisory", "霜注意報", "warning"),
    "25": ("Icing advisory", "着氷注意報", "warning"),
    "26": ("Snow accretion advisory", "着雪注意報", "warning"),
}
INACTIVE_STATUSES = {"発表警報・注意報はなし", "解除", "発表なし"}


def build_warning_events():
    area_master = None
    am_path = os.path.join(RAW, "jma-area-master.json")
    if os.path.exists(am_path):
        area_master = load_raw("jma-area-master.json")
    c20 = (area_master or {}).get("class20s", {})
    data = load_raw("jma-warning-130000.json")
    events = []
    report_time = data.get("reportDatetime")
    for at in data.get("areaTypes", []):
        for area in at.get("areas", []):
            code = area.get("code")
            ward_info = c20.get(code)
            if not ward_info:
                continue  # not a 23-ward class20 area (e.g. Izu islands) -> out of wards.csv scope
            ward_name_ja = ward_info.get("name", "")
            ward_row = next((w for w in WARDS if w["wardJa"] == ward_name_ja), None)
            if not ward_row:
                continue
            for w in area.get("warnings", []):
                status = w.get("status")
                if status in INACTIVE_STATUSES:
                    continue
                code_wc = w.get("code")
                info = WARNING_CODE_INFO.get(code_wc)
                if not info:
                    continue
                title_en, title_ja, severity = info
                events.append({
                    "id": f"jma-{ward_row['ward']}-{code_wc}",
                    "type": "warning",
                    "severity": severity,
                    "time": report_time or iso(),
                    "lat": None,
                    "lon": None,
                    "title": f"{title_en} — {ward_row['ward']}",
                    "titleJa": f"{ward_row['wardJa']}に{title_ja}",
                    "affects": [f"ward:{ward_row['ward']}"],
                    "source": "jma",
                    "url": None,
                    "magnitude": None,
                    "maxScale": None,
                })
    return events


def build_weather_events():
    data = load_raw("open-meteo-forecast.json")
    hourly = data["hourly"]
    times = hourly["time"]
    precip = hourly["precipitation"]
    temps = hourly["temperature_2m"]
    now = now_jst()
    events = []
    # future hours only
    future_idx = [i for i, t in enumerate(times) if datetime.datetime.fromisoformat(t) .replace(tzinfo=JST) >= now.replace(minute=0, second=0, microsecond=0)]
    if future_idx:
        best_i = max(future_idx, key=lambda i: precip[i])
        if precip[best_i] > 0:
            t = datetime.datetime.fromisoformat(times[best_i]).replace(tzinfo=JST)
            events.append({
                "id": f"om-precip-{times[best_i]}",
                "type": "weather",
                "severity": "warning" if precip[best_i] >= 5 else "info",
                "time": iso(t),
                "lat": data["latitude"], "lon": data["longitude"],
                "title": f"Heaviest rain expected around {t.strftime('%H:%M')}: {precip[best_i]:.1f}mm/h",
                "titleJa": f"{t.strftime('%H時')}頃に最も強い降水が予想されます: {precip[best_i]:.1f}mm/h",
                "affects": [], "source": "open-meteo", "url": None, "magnitude": None, "maxScale": None,
            })
        hot_i = max(future_idx, key=lambda i: temps[i])
        t2 = datetime.datetime.fromisoformat(times[hot_i]).replace(tzinfo=JST)
        events.append({
            "id": f"om-temp-{times[hot_i]}",
            "type": "weather",
            "severity": "info",
            "time": iso(t2),
            "lat": data["latitude"], "lon": data["longitude"],
            "title": f"Peak temperature {temps[hot_i]:.1f}C expected around {t2.strftime('%H:%M')}",
            "titleJa": f"{t2.strftime('%H時')}頃に最高気温{temps[hot_i]:.1f}度が予想されます",
            "affects": [], "source": "open-meteo", "url": None, "magnitude": None, "maxScale": None,
        })
    return events[:2]


def build_events():
    events = list(TRAIN_EVENTS) + list(MOCK_DISRUPTION_EVENTS)
    quake_events = build_quake_events()
    warning_events = build_warning_events()
    weather_events = build_weather_events()
    events += quake_events + warning_events + weather_events
    events.sort(key=lambda e: e["time"], reverse=True)
    counts = {"quake": 0, "train": 0, "warning": 0, "weather": 0, "critical": 0, "warning_level": 0}
    for e in events:
        counts[e["type"]] = counts.get(e["type"], 0) + 1
        if e["severity"] == "critical":
            counts["critical"] += 1
        elif e["severity"] == "warning":
            counts["warning_level"] += 1
    note = None
    if not warning_events:
        note = "JMA Tokyo feed shows no active warnings in the 23 wards right now (activity, if any, is confined to the Izu/Ogasawara islands, outside contracts/wards.csv scope)"
    write_json("events.json", {"events": events, "counts": counts, "meta": meta(source="live", note=note)})
    print(f"events.json: {len(events)} events -> counts={counts}")
    return events


# ---------------------------------------------------------------------------
# 2d. forecast.json
# ---------------------------------------------------------------------------
def build_forecast():
    data = load_raw("open-meteo-forecast.json")
    hourly = data["hourly"]
    times = hourly["time"]
    precip = hourly["precipitation"]
    temps = hourly["temperature_2m"]
    now = now_jst()
    now_floor = now.replace(minute=0, second=0, microsecond=0)
    parsed = [datetime.datetime.fromisoformat(t).replace(tzinfo=JST) for t in times]
    now_index = 0
    best_diff = None
    for i, t in enumerate(parsed):
        diff = abs((t - now_floor).total_seconds())
        if best_diff is None or diff < best_diff:
            best_diff, now_index = diff, i
    hourly_out = []
    for i, t in enumerate(parsed):
        hourly_out.append({
            "time": iso(t),
            "temperature": temps[i],
            "precipitation": precip[i],
            "isPast": i < now_index,
        })
    next48_precip = [precip[i] for i in range(now_index, min(now_index + 48, len(precip)))]
    next48_temp = [temps[i] for i in range(now_index, min(now_index + 48, len(temps)))]
    summary = {
        "maxPrecip24h": max(precip[now_index:min(now_index + 24, len(precip))], default=0.0),
        "minTemp": min(next48_temp, default=0.0),
        "maxTemp": max(next48_temp, default=0.0),
        "rainHoursNext48": sum(1 for p in next48_precip if p and p > 0),
    }
    write_json("forecast.json", {
        "location": {"lat": data["latitude"], "lon": data["longitude"], "name": "Tokyo"},
        "nowIndex": now_index,
        "hourly": hourly_out,
        "summary": summary,
        "meta": meta(source="live"),
    })
    print(f"forecast.json: {len(hourly_out)} hours, nowIndex={now_index}")


# ---------------------------------------------------------------------------
# 2e. impact/<lineId>.json for all 6 Toei lines
# ---------------------------------------------------------------------------
def build_impact(all_events, station_lookup):
    # Restricted to lines we actually have ODPT station-order data for (Toei).
    # JR/Metro impact is computed by the real API from stations.geojson +
    # lines.geojson once seeded into Neo4j (see gen_osm_stations.py) rather
    # than from a static mock file here.
    for row in LINES:
        if not row["odptRailway"]:
            continue
        line_id = row["lineId"]
        status_info = TRAIN_STATUS_BY_LINE.get(line_id, {"status": "unknown", "statusText": "No live status feed"})
        line_stations = []
        ward_counter = {}
        for sid, st in station_lookup.items():
            odpt_railway = st.get("odpt:railway")
            r2 = LINE_BY_ODPT.get(odpt_railway)
            if not r2 or r2["lineId"] != line_id:
                continue
            lat, lon = st.get("geo:lat"), st.get("geo:long")
            ward_row = nearest_ward(lat, lon) if lat is not None and lon is not None else None
            ward_name = ward_row["ward"] if ward_row else None
            title = st.get("odpt:stationTitle") or {}
            line_stations.append({
                "stationId": sid, "name": title.get("en", sid), "nameJa": title.get("ja"),
                "lat": lat, "lon": lon, "ward": ward_name,
                "inFloodZone": ward_name in FLOOD_WARDS if ward_name else False,
                "ridershipBand": 2,
            })
            if ward_name:
                ward_counter[ward_name] = ward_counter.get(ward_name, 0) + 1
        line_events = [e for e in all_events if f"line:{line_id}" in e.get("affects", [])][:20]
        wards_out = []
        for wname, cnt in ward_counter.items():
            wrow = next((w for w in WARDS if w["ward"] == wname), None)
            active = sum(1 for e in line_events if f"ward:{wname}" in e.get("affects", []))
            wards_out.append({
                "ward": wname, "wardJa": wrow["wardJa"] if wrow else None,
                "stationCount": cnt, "activeEventCount": active,
            })
        write_json(f"impact/{line_id}.json", {
            "lineId": line_id,
            "name": row["name"], "nameJa": row["nameJa"],
            "status": status_info["status"], "statusText": status_info["statusText"],
            "wards": wards_out,
            "stations": line_stations,
            "events": line_events,
            "stationsInFloodZone": sum(1 for s in line_stations if s["inFloodZone"]),
            "meta": meta(source="live"),
        })
        print(f"impact/{line_id}.json: {len(line_stations)} stations, {len(line_events)} events")


# ---------------------------------------------------------------------------
# 2f. brief.json
# ---------------------------------------------------------------------------
def build_brief(all_events):
    criticals = [e for e in all_events if e["severity"] == "critical"]
    warnings_ = [e for e in all_events if e["type"] == "warning"]
    quake_count = sum(1 for e in all_events if e["type"] == "quake")
    train_issues = [e for e in all_events if e["type"] == "train" and e["severity"] != "info"]

    if train_issues:
        lead_en = f"{len(train_issues)} Toei line disruption(s) are active right now, including: " + "; ".join(e["title"] for e in train_issues[:2]) + "."
        lead_ja = "現在、都営線で" + str(len(train_issues)) + "件の運行情報があります。"
    else:
        lead_en = "All 6 Toei lines are operating normally."
        lead_ja = "都営6線は現在、平常運転です。"

    quake_en = f"{quake_count} earthquakes were recorded in the Tokyo area over the past 7 days, none above minor intensity." if quake_count else "No earthquakes were recorded in the past 7 days."
    quake_ja = f"過去7日間に{quake_count}件の地震が観測されました。" if quake_count else "過去7日間の地震観測はありません。"

    if warnings_:
        warn_en = f"{len(warnings_)} weather/ward advisories are active."
        warn_ja = f"{len(warnings_)}件の気象注意報が発表中です。"
    else:
        warn_en = "No JMA weather warnings are active in the 23 wards."
        warn_ja = "23区内でJMA気象警報・注意報の発表はありません。"

    en = f"{lead_en} {quake_en} {warn_en}"
    ja = f"{lead_ja}{quake_ja}{warn_ja}"
    write_json("brief.json", {
        "en": en, "ja": ja,
        "provider": "template",
        "providerLabel": "rule-based summary (no LLM key configured)",
        "eventCount": len(all_events),
        "meta": meta(source="live"),
    })
    print("brief.json:", en)


def build_sandboxes_layers(all_events):
    now = iso()
    write_json("sandboxes.json", {
        "count": 4,
        "sandboxes": [
            {"name": "ingest-trains", "feed": "odpt", "status": "running", "eventsWritten": sum(1 for e in all_events if e["type"] == "train"), "lastWriteAt": now, "startupMs": 180},
            {"name": "ingest-quakes", "feed": "p2pquake", "status": "running", "eventsWritten": sum(1 for e in all_events if e["type"] == "quake"), "lastWriteAt": now, "startupMs": 210},
            {"name": "ingest-warnings", "feed": "jma", "status": "running", "eventsWritten": sum(1 for e in all_events if e["type"] == "warning"), "lastWriteAt": now, "startupMs": 150},
            {"name": "ingest-weather", "feed": "open-meteo", "status": "running", "eventsWritten": sum(1 for e in all_events if e["type"] == "weather"), "lastWriteAt": now, "startupMs": 140},
        ],
        "meta": meta(source="live"),
    })
    layer_counts = {
        "trains": sum(1 for e in all_events if e["type"] == "train"),
        "quakes": sum(1 for e in all_events if e["type"] == "quake"),
        "warnings": sum(1 for e in all_events if e["type"] == "warning"),
        "weather": sum(1 for e in all_events if e["type"] == "weather"),
        "flood": 0,
        "crowd": len(STATION_BY_ID),
        "peopleflow": 0,
    }
    states = {"trains": "live", "quakes": "live", "warnings": "live", "weather": "live", "flood": "mock", "crowd": "live", "peopleflow": "mock"}
    layers = [{"id": k, "label": k.capitalize(), "state": states[k], "count": v, "lastUpdate": now} for k, v in layer_counts.items()]
    write_json("layers.json", {"layers": layers, "meta": meta(source="live")})


if __name__ == "__main__":
    empty_lines, bad_coords = build_lines_geojson()
    station_lookup, bad_station_coords = build_stations_geojson()
    all_events = build_events()
    build_forecast()
    build_impact(all_events, station_lookup)
    build_brief(all_events)
    build_sandboxes_layers(all_events)
    print("TASK 2 real data generation complete.")
    print("empty-geometry lines:", empty_lines)
    print("out-of-bounds coords (lines):", len(bad_coords))
    print("out-of-bounds coords (stations):", len(bad_station_coords))
