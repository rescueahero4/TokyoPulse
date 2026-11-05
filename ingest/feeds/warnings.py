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
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from ingest.common import (backoff_delay, get_env, get_env_int, get_logger,
                           jma_area_label, jma_code_to_ward, make_event, stable_hash,
                           ward_centroid, ward_ja)
from ingest.sink import upsert

FEED_NAME = "warnings"
log = get_logger("ingest.warnings")

# Human request (provenance links): the JMA warning map for Tokyo (130000),
# not the raw JSON endpoint, so a viewer lands on a page that reads.
SOURCE_URL = "https://www.jma.go.jp/bosai/warning/#area_type=class20s&area_code=130000"
FEED_URL_DEFAULT = "https://www.jma.go.jp/bosai/warning/data/r8/130000.json"

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


# ── JMA's r8 format (29 May 2026 onward) ─────────────────────────────────────
# JMA froze the old data/warning/130000.json on 28 May 2026 and renumbered the
# codes (19 was fog, now storm tide), so WARNING_CODES above only describes old
# payloads. Taken from the code table in JMA's own bosai/warning page script.
# code -> (nameJa, nameEn, JMA level: 50 special, 40 danger, 30 warning, 20 advisory)
R8_CODES: dict[str, tuple[str, str, int]] = {
    "33": ("レベル５大雨特別警報", "Level 5 Heavy Rain Special Warning", 50),
    "43": ("レベル４大雨危険警報", "Level 4 Heavy Rain Danger Warning", 40),
    "03": ("レベル３大雨警報", "Level 3 Heavy Rain Warning", 30),
    "10": ("レベル２大雨注意報", "Level 2 Heavy Rain Advisory", 20),
    "39": ("レベル５土砂災害特別警報", "Level 5 Landslide Special Warning", 50),
    "49": ("レベル４土砂災害危険警報", "Level 4 Landslide Danger Warning", 40),
    "09": ("レベル３土砂災害警報", "Level 3 Landslide Warning", 30),
    "29": ("レベル２土砂災害注意報", "Level 2 Landslide Advisory", 20),
    "38": ("レベル５高潮特別警報", "Level 5 Storm Surge Special Warning", 50),
    "48": ("レベル４高潮危険警報", "Level 4 Storm Surge Danger Warning", 40),
    "08": ("レベル３高潮警報", "Level 3 Storm Surge Warning", 30),
    "19": ("レベル２高潮注意報", "Level 2 Storm Surge Advisory", 20),
    "35": ("暴風特別警報", "Gale Special Warning", 50),
    "05": ("暴風警報", "Gale Warning", 30),
    "15": ("強風注意報", "Strong Wind Advisory", 20),
    "32": ("暴風雪特別警報", "Snowstorm Special Warning", 50),
    "02": ("暴風雪警報", "Snowstorm Warning", 30),
    "13": ("風雪注意報", "Wind/Snow Advisory", 20),
    "36": ("大雪特別警報", "Heavy Snow Special Warning", 50),
    "06": ("大雪警報", "Heavy Snow Warning", 30),
    "12": ("大雪注意報", "Heavy Snow Advisory", 20),
    "37": ("波浪特別警報", "Wave Special Warning", 50),
    "07": ("波浪警報", "Wave Warning", 30),
    "16": ("波浪注意報", "Wave Advisory", 20),
    "14": ("雷注意報", "Thunderstorm Advisory", 20),
    "17": ("融雪注意報", "Snowmelt Advisory", 20),
    "20": ("濃霧注意報", "Dense Fog Advisory", 20),
    "21": ("乾燥注意報", "Dry Air Advisory", 20),
    "22": ("なだれ注意報", "Avalanche Advisory", 20),
    "23": ("低温注意報", "Low Temperature Advisory", 20),
    "24": ("霜注意報", "Frost Advisory", 20),
    "25": ("着氷注意報", "Ice Accretion Advisory", 20),
    "26": ("着雪注意報", "Snow Accretion Advisory", 20),
}
STATUS_EN = {"発表": "issued", "継続": "continuing"}
# 東京地方 covers the 23 wards plus Tama, which class20Items reports more precisely.
TOKYO_MAINLAND_CLASS10 = "130010"
# A report this old is a dead feed, not a current warning.
R8_MAX_REPORT_AGE = timedelta(days=14)


def _r8_scope(area_code: str) -> Optional[tuple[Optional[str], str, str]]:
    """(ward, scope_en, scope_ja), or None when another item already covers the area."""
    ward = jma_code_to_ward(area_code)
    if ward:
        return ward, ward, (ward_ja(ward) or f"{ward}区")
    region = jma_area_label(area_code)
    if not region:
        return None, f"unmapped area {area_code}", f"未対応エリア（コード{area_code}）"
    if len(area_code) == 7 and region[1] != "Tama area":
        return None  # islands: the class10 items separate north, south and Ogasawara
    return None, f"{region[1]} (outside 23-ward scope)", f"{region[0]}（23区外）"


def normalize_r8(reports: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """One event per ward+code, and per non-ward region+code."""
    now = datetime.now(timezone.utc)
    out: dict[str, dict[str, Any]] = {}
    for report in reports:
        report_time = report.get("reportDatetime")
        try:
            if now - datetime.fromisoformat(report_time) > R8_MAX_REPORT_AGE:
                log.warning("skipping JMA report dated %s: too old to be current", report_time)
                continue
        except (TypeError, ValueError):
            continue
        warning = report.get("warning") or {}
        items = (warning.get("class20Items") or []) + (warning.get("class10Items") or [])
        for item in items:
            area_code = item.get("areaCode")
            if not area_code or area_code == TOKYO_MAINLAND_CLASS10:
                continue
            scope = _r8_scope(area_code)
            if scope is None:
                continue
            ward, scope_en, scope_ja = scope
            for kind in item.get("kinds") or []:
                code, status = kind.get("code"), kind.get("status")
                if not code or not _is_active(status):
                    continue
                # An unknown code stays generic: never guess a hazard for a public warning.
                name_ja, name_en, level = R8_CODES.get(
                    code, (f"気象警報等（コード{code}）", f"JMA warning or advisory (code {code})", 20))
                key = f"ward-{ward}" if ward else scope_en
                event_id = f"jma-{area_code if ward else stable_hash(key)}-{code}"
                lat = lon = None
                if ward:
                    centroid = ward_centroid(ward)
                    if centroid:
                        lat, lon = centroid
                # Several Tama municipalities can share one "Tama area" event.
                codes = set((out.get(event_id) or {}).get("areaCodes") or [])
                codes.add(area_code)
                out[event_id] = make_event(
                    id=event_id,
                    type="warning",
                    severity="critical" if level >= 30 else "warning",
                    time=report_time,
                    title=f"{name_en} ({STATUS_EN.get(status, status)}) — {scope_en}",
                    titleJa=f"{name_ja}（{status}）— {scope_ja}",
                    affects=[f"ward:{ward}"] if ward else [],
                    source="jma",
                    url=SOURCE_URL,
                    lat=lat,
                    lon=lon,
                    areaCodes=sorted(codes),
                )
    return list(out.values())


def prune_lifted(active_ids: list[str]) -> Optional[int]:
    """Remove warnings JMA no longer lists. The feed only names what is active, and
    the graph's "now" view keeps a ward's latest warning, so nothing else clears them."""
    try:
        from api.graph import run
        rows = run("MATCH (e:Event {type: 'warning', source: 'jma'}) WHERE NOT e.id IN $ids "
                   "DETACH DELETE e RETURN count(e) AS n", ids=active_ids)
        return int(rows[0]["n"]) if rows else 0
    except Exception as e:
        log.warning("could not prune lifted warnings: %s", e)
        return None


def normalize(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return normalize_r8(payload)
    report_time = payload.get("reportDatetime")
    events: list[dict[str, Any]] = []
    unmapped_codes: set[str] = set()
    for area_type in payload.get("areaTypes") or []:
        for area in area_type.get("areas") or []:
            area_code = area.get("code")
            ward = jma_code_to_ward(area_code) if area_code else None
            lat = lon = None
            if ward:
                centroid = ward_centroid(ward)
                if centroid:
                    lat, lon = centroid
            else:
                # Honest labelling for the genuinely-not-a-ward case (Tama
                # mainland cities, Izu/Ogasawara islands) instead of a vague
                # "Tokyo area" default -- see ingest/common.py jma_area_label.
                region = jma_area_label(area_code) if area_code else None
                if not region and area_code:
                    unmapped_codes.add(area_code)
            for w in area.get("warnings") or []:
                status = w.get("status")
                if not _is_active(status):
                    continue
                code = w.get("code")
                name_ja, name_en, level = WARNING_CODES.get(
                    code, (f"警報コード{code}", f"Warning code {code}", "注意報")
                )
                severity = _severity_for_level(level)
                if ward:
                    affects = [f"ward:{ward}"]
                    scope_en, scope_ja = ward, (ward_ja(ward) or f"{ward}区")
                elif region:
                    affects = []
                    scope_en = f"{region[1]} (outside 23-ward scope)"
                    scope_ja = f"{region[0]}（23区外）"
                else:
                    affects = []
                    scope_en = f"unmapped area {area_code}"
                    scope_ja = f"未対応エリア（コード{area_code}）"
                title = f"{name_en} ({status}) — {scope_en}"
                title_ja = f"{name_ja}（{status}）— {scope_ja}"
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
                        url=SOURCE_URL,
                        lat=lat,
                        lon=lon,
                        areaCodes=[area_code] if area_code else None,
                    )
                )
    if unmapped_codes:
        log.warning("JMA area codes with no ward/region label (affects:[] by "
                    "necessity, not a bug): %s", sorted(unmapped_codes))
    return events


def fetch_once() -> list[dict[str, Any]]:
    import httpx  # lazy: normalize() (the --push sandbox path) needs no HTTP client

    url = get_env("FEED_JMA_WARNING", FEED_URL_DEFAULT)
    if "/data/warning/" in url:
        log.warning("FEED_JMA_WARNING points at the feed JMA froze on 2026-05-28 -- using data/r8/")
        url = url.replace("/data/warning/", "/data/r8/")
    resp = httpx.get(url, timeout=15.0)
    resp.raise_for_status()
    data = resp.json()
    if not isinstance(data, list):
        raise ValueError(f"unexpected JMA warning payload shape: {type(data)}")
    return data


def run_cycle() -> dict[str, Any]:
    payload = fetch_once()
    events = normalize(payload)
    result = upsert(FEED_NAME, events)
    # Only after a successful fetch: a failed one raises above and clears nothing.
    pruned = prune_lifted([e["id"] for e in events]) if result.get("neo4j_ok") else None
    log.info(
        "cycle ok: %d active warning events, neo4j_ok=%s written=%s pruned=%s",
        len(events),
        result.get("neo4j_ok"),
        result.get("written"),
        pruned,
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
