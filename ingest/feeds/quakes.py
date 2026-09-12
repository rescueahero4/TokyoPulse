"""
ingest/feeds/quakes.py — P2PQuake ingestor (A2 scope).

History backfill on start (FEED_P2PQUAKE_HISTORY, code=551 only), then a
persistent WS subscription (FEED_P2PQUAKE_WS) for live quakes. Same
normalization path for both so history and live events are indistinguishable
downstream.

code 551 = JMA earthquake information. lat/lon/magnitude come from
earthquake.hypocenter; maxScale is JMA shindo*10, native on the P2PQuake
payload. Severity: maxScale>=40 critical, >=30 warning, else info.
"""

from __future__ import annotations

import asyncio
import json
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from ingest.common import JST, backoff_delay, get_env, get_logger, make_event, now_jst_iso
from ingest.sink import upsert

FEED_NAME = "quakes"
log = get_logger("ingest.quakes")

QUAKE_CODE = 551


def _parse_p2p_time(raw: Optional[str]) -> str:
    """P2PQuake times look like '2026/09/11 20:42:08.524', naive, Asia/Tokyo."""
    if not raw:
        return now_jst_iso()
    for fmt in ("%Y/%m/%d %H:%M:%S.%f", "%Y/%m/%d %H:%M:%S"):
        try:
            dt = datetime.strptime(raw, fmt)
            return dt.replace(tzinfo=JST).isoformat()
        except ValueError:
            continue
    log.warning("unparseable p2pquake time %r; using now()", raw)
    return now_jst_iso()


def classify_severity(max_scale: Optional[float]) -> str:
    if max_scale is None:
        return "info"
    if max_scale >= 40:
        return "critical"
    if max_scale >= 30:
        return "warning"
    return "info"


def normalize_one(item: dict[str, Any]) -> Optional[dict[str, Any]]:
    if item.get("code") != QUAKE_CODE:
        return None
    eq = item.get("earthquake") or {}
    hypo = eq.get("hypocenter") or {}
    max_scale = eq.get("maxScale")
    if isinstance(max_scale, (int, float)) and max_scale < 0:
        max_scale = None  # P2PQuake uses -1 for "unknown"
    severity = classify_severity(max_scale)
    name = hypo.get("name") or "unknown epicenter"
    magnitude = hypo.get("magnitude")
    mag_str = f"M{magnitude}" if isinstance(magnitude, (int, float)) and magnitude > 0 else "M?"
    time_iso = _parse_p2p_time(item.get("time") or eq.get("time"))
    quake_id = item.get("id") or item.get("time") or time_iso
    return make_event(
        id=f"p2p-{quake_id}",
        type="quake",
        severity=severity,
        time=time_iso,
        title=f"{mag_str} earthquake near {name}",
        titleJa=f"{name}で地震（{mag_str}）",
        lat=hypo.get("latitude"),
        lon=hypo.get("longitude"),
        affects=[],
        source="p2pquake",
        url=None,
        magnitude=magnitude if isinstance(magnitude, (int, float)) else None,
        maxScale=max_scale,
    )


def normalize(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out = []
    for item in items:
        ev = normalize_one(item)
        if ev is not None:
            out.append(ev)
    return out


def fetch_history() -> list[dict[str, Any]]:
    import httpx  # lazy: normalize() (the --push sandbox path) needs no HTTP client

    url = get_env(
        "FEED_P2PQUAKE_HISTORY", "https://api.p2pquake.net/v2/history?codes=551&limit=20"
    )
    resp = httpx.get(url, timeout=15.0)
    resp.raise_for_status()
    data = resp.json()
    if not isinstance(data, list):
        raise ValueError(f"unexpected p2pquake history payload shape: {type(data)}")
    return data


def run_history_backfill() -> dict[str, Any]:
    items = fetch_history()
    events = normalize(items)
    result = upsert(FEED_NAME, events)
    log.info(
        "history backfill: %d raw -> %d quake events, neo4j_ok=%s written=%s",
        len(items),
        len(events),
        result.get("neo4j_ok"),
        result.get("written"),
    )
    return result


async def _ws_loop(stop_event) -> None:
    import websockets

    url = get_env("FEED_P2PQUAKE_WS", "wss://api.p2pquake.net/v2/ws")
    fail_streak = 0
    while not (stop_event is not None and stop_event.is_set()):
        try:
            log.info("connecting to p2pquake WS %s", url)
            async with websockets.connect(url, open_timeout=15, ping_interval=20) as ws:
                fail_streak = 0
                while not (stop_event is not None and stop_event.is_set()):
                    try:
                        raw = await asyncio.wait_for(ws.recv(), timeout=5.0)
                    except asyncio.TimeoutError:
                        continue
                    try:
                        item = json.loads(raw)
                    except json.JSONDecodeError:
                        log.warning("p2pquake WS sent non-JSON; skipping frame")
                        continue
                    ev = normalize_one(item)
                    if ev is None:
                        continue
                    result = upsert(FEED_NAME, [ev])
                    log.info(
                        "WS quake event id=%s neo4j_ok=%s", ev["id"], result.get("neo4j_ok")
                    )
        except Exception as e:  # WS may be silent for hours or drop -- never fatal
            fail_streak += 1
            delay = backoff_delay(min(fail_streak, 6))
            log.warning("p2pquake WS error (%d in a row): %s -- retrying in %.0fs", fail_streak, e, delay)
            if stop_event is not None:
                await asyncio.get_event_loop().run_in_executor(None, stop_event.wait, delay)
            else:
                await asyncio.sleep(delay)


def main(stop_event=None, poll_seconds: Optional[int] = None) -> None:
    log.info("quakes ingestor starting: history backfill then WS subscription")
    fail_streak = 0
    while True:
        try:
            run_history_backfill()
            break
        except Exception as e:
            fail_streak += 1
            log.error("history backfill failed (%d in a row): %s", fail_streak, e)
            if fail_streak >= 3:
                log.error("giving up on history backfill after 3 attempts; proceeding to WS")
                break
            time.sleep(backoff_delay(fail_streak))
    try:
        asyncio.run(_ws_loop(stop_event))
    except Exception as e:
        log.error("quakes WS loop exited unexpectedly: %s", e)


if __name__ == "__main__":
    if "--once" in sys.argv:
        items = fetch_history()
        events = normalize(items)
        print(json.dumps(events, ensure_ascii=False, indent=2))
    else:
        main()
