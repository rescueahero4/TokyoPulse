"""
ingest/feeds/warnings.py — JMA warning ingestor for Tokyo (130000), A2 scope.

Poll the nested areaTypes[].areas[].warnings[] structure. Emit ONLY active
warnings (skip status values meaning cancelled / none-issued / lifted).
特別警報 and 警報 -> critical; 注意報 -> warning.

NOTE (join-key gap): contracts/wards.csv has no JMA area-code column, so the
ward join here uses the standard JIS X0402 municipal code + "00" (the JMA
"class15" city-code convention) for the 23 special wards, in the same
Chiyoda..Edogawa order as wards.csv (see ingest/common.py
JMA_AREA_CODE_TO_WARD). Prefecture-wide area codes (6-digit, e.g. "130010")
have no single ward and degrade to affects:[] -- reported under DEGRADED.
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path
from typing import Any, Optional

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from ingest.common import backoff_delay, get_env, get_env_int, get_logger, jma_code_to_ward, make_event
from ingest.sink import upsert

FEED_NAME = "warnings"
log = get_logger("ingest.warnings")

INACTIVE_STATUSES = {"発表警報・注意報はなし", "解除"}


def _is_active(status: Optional[str]) -> bool:
    if not status:
        return False
    if status in INACTIVE_STATUSES:
        return False
    if "なし" in status:
        return False
    return True


# code -> (nameJa, nameEn, level). Standard JMA warning/advisory code table.
# level drives severity: 特別警報/警報 -> critical, 注意報 -> warning.
WARNING_CODES: dict[str, tuple[str, str, str]] = {
    "02": ("暴風雪警報", "Snowstorm Warning", "警報"),
    "03": ("大雨警報", "Heavy Rain Warning", "警報"),
    "04": ("洪水警報", "Flood Warning", "警報"),
    "05": ("暴風警報", "Gale Warning", "警報"),
    "06": ("大雪警報", "Heavy Snow Warning", "警報"),
    "07": ("波浪警報", "Wave Warning", "警報"),
    "08": ("高潮警報", "Storm Surge Warning", "警報"),
    "10": ("大雨注意報", "Heavy Rain Advisory", "注意報"),
    "12": ("大雪注意報", "Heavy Snow Advisory", "注意報"),
    "13": ("風雪注意報", "Wind/Snow Advisory", "注意報"),
    "14": ("雷注意報", "Thunderstorm Advisory", "注意報"),
    "15": ("強風注意報", "Strong Wind Advisory", "注意報"),
    "16": ("波浪注意報", "Wave Advisory", "注意報"),
    "17": ("洪水注意報", "Flood Advisory", "注意報"),
    "18": ("高潮注意報", "Storm Surge Advisory", "注意報"),
    "19": ("濃霧注意報", "Dense Fog Advisory", "注意報"),
    "20": ("乾燥注意報", "Dry Air Advisory", "注意報"),
    "21": ("なだれ注意報", "Avalanche Advisory", "注意報"),
    "22": ("低温注意報", "Low Temperature Advisory", "注意報"),
    "23": ("霜注意報", "Frost Advisory", "注意報"),
    "24": ("着氷注意報", "Ice Accretion Advisory", "注意報"),
    "25": ("着雪注意報", "Snow Accretion Advisory", "注意報"),
    "26": ("融雪注意報", "Snowmelt Advisory", "注意報"),
    "32": ("暴風特別警報", "Gale Special Warning", "特別警報"),
    "33": ("大雨特別警報", "Heavy Rain Special Warning", "特別警報"),
    "35": ("暴風雪特別警報", "Snowstorm Special Warning", "特別警報"),
    "36": ("大雪特別警報", "Heavy Snow Special Warning", "特別警報"),
    "37": ("波浪特別警報", "Wave Special Warning", "特別警報"),
    "38": ("高潮特別警報", "Storm Surge Special Warning", "特別警報"),
}


def _severity_for_level(level: str) -> str:
    return "critical" if level in ("警報", "特別警報") else "warning"


def normalize(payload: dict[str, Any]) -> list[dict[str, Any]]:
    report_time = payload.get("reportDatetime")
    events: list[dict[str, Any]] = []
    for area_type in payload.get("areaTypes") or []:
        for area in area_type.get("areas") or []:
            area_code = area.get("code")
            ward = jma_code_to_ward(area_code) if area_code else None
            for w in area.get("warnings") or []:
                status = w.get("status")
                if not _is_active(status):
                    continue
                code = w.get("code")
                name_ja, name_en, level = WARNING_CODES.get(
                    code, (f"警報コード{code}", f"Warning code {code}", "注意報")
                )
                severity = _severity_for_level(level)
                affects = [f"ward:{ward}"] if ward else []
                title = f"{name_en} ({status})" + (f" — {ward}" if ward else " — Tokyo area")
                title_ja = f"{name_ja}（{status}）" + (f" — {ward}区" if ward else "")
                events.append(
                    make_event(
                        id=f"jma-{area_code}-{code}",
                        type="warning",
                        severity=severity,
                        time=report_time,
                        title=title,
                        titleJa=title_ja,
                        affects=affects,
                        source="jma",
                        url=None,
                    )
                )
    return events


def fetch_once() -> dict[str, Any]:
    import httpx  # lazy: normalize() (the --push sandbox path) needs no HTTP client

    url = get_env(
        "FEED_JMA_WARNING", "https://www.jma.go.jp/bosai/warning/data/warning/130000.json"
    )
    resp = httpx.get(url, timeout=15.0)
    resp.raise_for_status()
    data = resp.json()
    if not isinstance(data, dict):
        raise ValueError(f"unexpected JMA warning payload shape: {type(data)}")
    return data


def run_cycle() -> dict[str, Any]:
    payload = fetch_once()
    events = normalize(payload)
    result = upsert(FEED_NAME, events)
    log.info(
        "cycle ok: %d active warning events, neo4j_ok=%s written=%s",
        len(events),
        result.get("neo4j_ok"),
        result.get("written"),
    )
    return result


def main(stop_event=None, poll_seconds: Optional[int] = None) -> None:
    poll_seconds = poll_seconds or get_env_int("INGEST_POLL_SECONDS", 30)
    log.info("warnings ingestor starting (poll=%ss)", poll_seconds)
    fail_streak = 0
    while True:
        if stop_event is not None and stop_event.is_set():
            log.info("warnings ingestor stopping")
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
