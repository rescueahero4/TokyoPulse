"""
ingest/feeds/weather.py — Open-Meteo ingestor (A2 scope).

FEED_OPEN_METEO (.env) already requests past_days=2 & forecast_days=2,
hourly temperature_2m + precipitation, Asia/Tokyo local time. Polls slowly
(poll interval is still INGEST_POLL_SECONDS, but this feed changes on the
order of hours, so it's cheap to over-poll).

Emits AT MOST 2 summary events per cycle (never the full 96-hour array):
  1. heaviest forecast precipitation hour in the next 48h
  2. hottest forecast hour in the next 48h
Both ids key off the target hour, not the poll time, so re-polling with an
unchanged forecast never creates duplicate timeline rows; a revised forecast
naturally produces a new id for the new peak hour (old node goes stale --
acceptable for forecast-type data, noted as DEGRADED).
"""

from __future__ import annotations

import json
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from ingest.common import JST, backoff_delay, get_env, get_env_int, get_logger, make_event, now_jst
from ingest.sink import upsert

FEED_NAME = "weather"
log = get_logger("ingest.weather")

# Same default as fetch_once() below. Event.url needs the REAL request URL so
# a viewer can click through and verify the numbers themselves (human request,
# contracts/api.md /forecast.json amendment). normalize() stays import-safe
# for the Daytona --push sandbox (no network call here, just an env read).
FEED_URL_DEFAULT = (
    "https://api.open-meteo.com/v1/forecast?latitude=35.68&longitude=139.76"
    "&hourly=temperature_2m,precipitation&past_days=2&forecast_days=2&timezone=Asia%2FTokyo"
)


def _source_url() -> str:
    return get_env("FEED_OPEN_METEO", FEED_URL_DEFAULT)


def _parse_local(time_str: str) -> datetime:
    """Open-Meteo hourly times are naive local strings ('2026-09-10T14:00')
    because the feed URL pins timezone=Asia/Tokyo -- attach +09:00."""
    dt = datetime.fromisoformat(time_str)
    return dt.replace(tzinfo=JST)


def _precip_severity(mm: float) -> str:
    if mm >= 30:
        return "critical"
    if mm >= 10:
        return "warning"
    return "info"


def _temp_severity(c: float) -> str:
    if c >= 38 or c <= -5:
        return "critical"
    if c >= 35 or c <= 0:
        return "warning"
    return "info"


def normalize(payload: dict[str, Any]) -> list[dict[str, Any]]:
    hourly = payload.get("hourly") or {}
    times = hourly.get("time") or []
    temps = hourly.get("temperature_2m") or []
    precs = hourly.get("precipitation") or []
    lat = payload.get("latitude")
    lon = payload.get("longitude")

    if not times:
        return []

    now = now_jst()
    rows = []
    for t, temp, prec in zip(times, temps, precs):
        try:
            dt = _parse_local(t)
        except ValueError:
            continue
        rows.append((dt, temp, prec))

    future = [r for r in rows if r[0] >= now][:48]
    if not future:
        future = rows[-48:]

    source_url = _source_url()
    events: list[dict[str, Any]] = []

    precip_rows = [r for r in future if isinstance(r[2], (int, float))]
    if precip_rows:
        peak = max(precip_rows, key=lambda r: r[2])
        dt, _, mm = peak
        severity = _precip_severity(mm)
        hour_key = dt.strftime("%Y%m%dT%H")
        events.append(
            make_event(
                id=f"weather-precip-{hour_key}",
                type="weather",
                severity=severity,
                time=dt.isoformat(),
                title=f"Heaviest rain expected: {mm:.1f}mm at {dt.strftime('%H:%M')} on {dt.strftime('%b %d')}",
                titleJa=f"{dt.strftime('%m/%d %H:%M')}頃に最大{mm:.1f}mmの降水を予測",
                lat=lat,
                lon=lon,
                affects=[],
                source="open-meteo",
                url=source_url,
            )
        )

    temp_rows = [r for r in future if isinstance(r[1], (int, float))]
    if temp_rows:
        hottest = max(temp_rows, key=lambda r: r[1])
        dt, c, _ = hottest
        severity = _temp_severity(c)
        hour_key = dt.strftime("%Y%m%dT%H")
        events.append(
            make_event(
                id=f"weather-temp-{hour_key}",
                type="weather",
                severity=severity,
                time=dt.isoformat(),
                title=f"Forecast high: {c:.1f}C at {dt.strftime('%H:%M')} on {dt.strftime('%b %d')}",
                titleJa=f"{dt.strftime('%m/%d %H:%M')}頃に最高{c:.1f}度を予測",
                lat=lat,
                lon=lon,
                affects=[],
                source="open-meteo",
                url=source_url,
            )
        )

    return events[:2]


def fetch_once() -> dict[str, Any]:
    import httpx  # lazy: normalize() (the --push sandbox path) needs no HTTP client

    url = _source_url()
    resp = httpx.get(url, timeout=15.0)
    resp.raise_for_status()
    data = resp.json()
    if not isinstance(data, dict):
        raise ValueError(f"unexpected Open-Meteo payload shape: {type(data)}")
    return data


def run_cycle() -> dict[str, Any]:
    payload = fetch_once()
    events = normalize(payload)
    result = upsert(FEED_NAME, events)
    log.info(
        "cycle ok: %d weather summary events, neo4j_ok=%s written=%s",
        len(events),
        result.get("neo4j_ok"),
        result.get("written"),
    )
    return result


def main(stop_event=None, poll_seconds: Optional[int] = None) -> None:
    # Weather changes slowly; poll at ~10x the base interval, but never less
    # than the configured INGEST_POLL_SECONDS (still "slow" in relative terms).
    poll_seconds = poll_seconds or max(get_env_int("INGEST_POLL_SECONDS", 30) * 10, 300)
    log.info("weather ingestor starting (poll=%ss)", poll_seconds)
    fail_streak = 0
    while True:
        if stop_event is not None and stop_event.is_set():
            log.info("weather ingestor stopping")
            return
        try:
            run_cycle()
            fail_streak = 0
        except Exception as e:
            fail_streak += 1
            log.error("cycle failed (%d in a row): %s", fail_streak, e)
            time.sleep(backoff_delay(min(fail_streak, 6)))
            continue
        if stop_event is not None:
            stop_event.wait(poll_seconds)
        else:
            time.sleep(poll_seconds)


if __name__ == "__main__":
    if "--once" in sys.argv:
        payload = fetch_once()
        events = normalize(payload)
        print(json.dumps(events, ensure_ascii=False, indent=2))
    else:
        main()
