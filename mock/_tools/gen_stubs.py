"""TASK 1 — tiny schema-valid stub files for every endpoint so A1a/A1b/A3 are never blocked.
Run: .venv\\Scripts\\python.exe mock\\_tools\\gen_stubs.py
Real data capture happens later in gen_real_*.py which overwrite these.
"""
import sys
import os
import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import meta, write_json, iso, now_jst, read_lines_csv, JST

LINES = read_lines_csv()


def gen_events():
    events = [
        {
            "id": "mock-train-1",
            "type": "train",
            "severity": "warning",
            "time": iso(),
            "lat": 35.6586,
            "lon": 139.7454,
            "title": "Delays on Mita Line",
            "titleJa": "都営三田線に遅延が発生",
            "affects": ["line:Toei-Mita"],
            "source": "mock",
            "url": None,
            "magnitude": None,
            "maxScale": None,
        },
        {
            "id": "mock-quake-1",
            "type": "quake",
            "severity": "info",
            "time": iso(now_jst() - datetime.timedelta(hours=3)),
            "lat": 35.65,
            "lon": 139.9,
            "title": "Minor earthquake near Chiba",
            "titleJa": "千葉県付近で小規模地震",
            "affects": [],
            "source": "mock",
            "url": None,
            "magnitude": 3.2,
            "maxScale": 20,
        },
        {
            "id": "mock-warning-1",
            "type": "warning",
            "severity": "warning",
            "time": iso(now_jst() - datetime.timedelta(hours=1)),
            "lat": None,
            "lon": None,
            "title": "Heavy rain advisory for Koto",
            "titleJa": "江東区に大雨注意報",
            "affects": ["ward:Koto"],
            "source": "mock",
            "url": None,
            "magnitude": None,
            "maxScale": None,
        },
    ]
    events.sort(key=lambda e: e["time"], reverse=True)
    counts = {"quake": 1, "train": 1, "warning": 1, "weather": 0, "critical": 0, "warning_level": 2}
    write_json("events.json", {"events": events, "counts": counts, "meta": meta()})


def gen_lines():
    features = []
    for row in LINES:
        features.append({
            "type": "Feature",
            "geometry": {"type": "LineString", "coordinates": []},
            "properties": {
                "lineId": row["lineId"],
                "name": row["name"],
                "nameJa": row["nameJa"],
                "operator": row["operator"],
                "status": "unknown",
                "statusText": "No live status feed",
                "statusTextJa": None,
                "color": row["color"],
                "statusSource": "none",
                "updatedAt": None,
            },
        })
    write_json("lines.geojson", {"type": "FeatureCollection", "features": features, "meta": meta()})


def gen_stations():
    features = [
        {
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [139.7671, 35.6812]},
            "properties": {
                "stationId": "Toei.Mita.Hakusan",
                "name": "Hakusan",
                "nameJa": "白山",
                "lineIds": ["Toei-Mita"],
                "ward": "Bunkyo",
                "ridership": 23000,
                "ridershipBand": 3,
                "inFloodZone": False,
            },
        },
        {
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [139.7753, 35.6586]},
            "properties": {
                "stationId": "Toei.Oedo.Daimon",
                "name": "Daimon",
                "nameJa": "大門",
                "lineIds": ["Toei-Oedo", "Toei-Asakusa"],
                "ward": "Minato",
                "ridership": 45000,
                "ridershipBand": 4,
                "inFloodZone": False,
            },
        },
        {
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [139.7673, 35.7021]},
            "properties": {
                "stationId": "Toei.Shinjuku.Iwamotocho",
                "name": "Iwamotocho",
                "nameJa": "岩本町",
                "lineIds": ["Toei-Shinjuku"],
                "ward": "Chiyoda",
                "ridership": None,
                "ridershipBand": 2,
                "inFloodZone": False,
            },
        },
    ]
    write_json("stations.geojson", {"type": "FeatureCollection", "features": features, "meta": meta()})


def gen_forecast():
    base = now_jst().replace(minute=0, second=0, microsecond=0)
    hourly = []
    for i in range(-48, 48):
        t = base + datetime.timedelta(hours=i)
        hourly.append({
            "time": iso(t),
            "temperature": 27.0 + (i % 5) * 0.3,
            "precipitation": 0.0 if i % 7 else 1.2,
            "isPast": i < 0,
        })
    write_json("forecast.json", {
        "location": {"lat": 35.68, "lon": 139.76, "name": "Tokyo"},
        "nowIndex": 48,
        "hourly": hourly,
        "summary": {"maxPrecip24h": 1.2, "minTemp": 26.0, "maxTemp": 28.5, "rainHoursNext48": 3},
        "meta": meta(),
    })


def gen_brief():
    write_json("brief.json", {
        "en": "Toei lines are running normally this morning. A minor quake was recorded offshore with no damage reported. A heavy rain advisory is active for Koto ward.",
        "ja": "都営各線は本日朝、平常運転です。沿岸部で小規模な地震が観測されましたが被害の報告はありません。江東区には大雨注意報が発表されています。",
        "provider": "template",
        "providerLabel": "rule-based summary (no LLM key)",
        "eventCount": 3,
        "meta": meta(),
    })


def gen_sandboxes():
    write_json("sandboxes.json", {
        "count": 4,
        "sandboxes": [
            {"name": "ingest-trains", "feed": "odpt", "status": "mock", "eventsWritten": 0, "lastWriteAt": None, "startupMs": 0},
            {"name": "ingest-quakes", "feed": "p2pquake", "status": "mock", "eventsWritten": 0, "lastWriteAt": None, "startupMs": 0},
            {"name": "ingest-warnings", "feed": "jma", "status": "mock", "eventsWritten": 0, "lastWriteAt": None, "startupMs": 0},
            {"name": "ingest-weather", "feed": "open-meteo", "status": "mock", "eventsWritten": 0, "lastWriteAt": None, "startupMs": 0},
        ],
        "meta": meta(),
    })


def gen_layers():
    layer_ids = ["trains", "quakes", "warnings", "weather", "flood", "crowd", "peopleflow"]
    layers = [{"id": lid, "label": lid.capitalize(), "state": "mock", "count": 0, "lastUpdate": iso()} for lid in layer_ids]
    write_json("layers.json", {"layers": layers, "meta": meta()})


def gen_impact():
    for line_id in ["Toei-Mita", "Toei-Oedo"]:
        row = next(r for r in LINES if r["lineId"] == line_id)
        write_json(f"impact/{line_id}.json", {
            "lineId": line_id,
            "name": row["name"],
            "nameJa": row["nameJa"],
            "status": "unknown",
            "statusText": "No live status feed",
            "wards": [{"ward": "Bunkyo", "wardJa": "文京区", "stationCount": 1, "activeEventCount": 0}],
            "stations": [{
                "stationId": f"{line_id}.stub1", "name": "Stub Station", "nameJa": "スタブ駅",
                "lat": 35.70, "lon": 139.75, "ward": "Bunkyo", "inFloodZone": False, "ridershipBand": 2,
            }],
            "events": [],
            "stationsInFloodZone": 0,
            "meta": meta(),
        })


if __name__ == "__main__":
    gen_events()
    gen_lines()
    gen_stations()
    gen_forecast()
    gen_brief()
    gen_sandboxes()
    gen_layers()
    gen_impact()
    print("TASK 1 stubs written.")
