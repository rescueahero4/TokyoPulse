"""Fetch raw upstream payloads and save under mock/raw/. Run with .venv python + httpx."""
import httpx
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import MOCK_DIR

RAW_DIR = os.path.join(MOCK_DIR, "raw")
os.makedirs(RAW_DIR, exist_ok=True)

TARGETS = {
    "odpt-traininformation.json": "https://api-public.odpt.org/api/v4/odpt:TrainInformation",
    "odpt-railway.json": "https://api-public.odpt.org/api/v4/odpt:Railway",
    "odpt-station.json": "https://api-public.odpt.org/api/v4/odpt:Station",
    "odpt-passengersurvey.json": "https://api-public.odpt.org/api/v4/odpt:PassengerSurvey",
    "p2pquake-history.json": "https://api.p2pquake.net/v2/history?codes=551&limit=100",
    "jma-warning-130000.json": "https://www.jma.go.jp/bosai/warning/data/warning/130000.json",
    "open-meteo-forecast.json": "https://api.open-meteo.com/v1/forecast?latitude=35.68&longitude=139.76&hourly=temperature_2m,precipitation&past_days=2&forecast_days=2&timezone=Asia%2FTokyo",
}

headers = {"User-Agent": "TokyoPulse-hackathon/1.0"}

for fname, url in TARGETS.items():
    path = os.path.join(RAW_DIR, fname)
    try:
        with httpx.Client(timeout=30, headers=headers, follow_redirects=True) as client:
            r = client.get(url)
        r.raise_for_status()
        data = r.json()
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        n = len(data) if isinstance(data, list) else 1
        print(f"OK {fname}: {r.status_code}, {n} top-level items, {os.path.getsize(path)} bytes")
    except Exception as e:
        print(f"FAIL {fname}: {type(e).__name__} {e}")
