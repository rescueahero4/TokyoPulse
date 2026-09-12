"""
ingest/feeds/trains.py — ODPT TrainInformation ingestor (A2 scope).

Poll ODPT's keyless TrainInformation mirror (Toei only on this mirror — see
contracts/feeds.json), normalize to the frozen Event shape, upsert via
ingest/sink.py, sleep INGEST_POLL_SECONDS, repeat.

THE #1 BUG RISK: the id must be stable for the same real-world status so a
30s poll never creates duplicate timeline rows. id = "odpt-<lineId>-<hash of
the status text>" — same text in -> same id out, every time.

ODPT .json trap (see AGENT-BRIEF / feeds.json): appending ".json" to the
TrainInformation URL redirects to a dead Azure blob. FEED_ODPT_TRAINS in
.env currently has a trailing ".json" baked in — we defensively strip it
here rather than hardcode a different URL, so .env stays the single source
of truth once it's fixed upstream.
"""

from __future__ import annotations

import sys
import time
from pathlib import Path
from typing import Any, Optional

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from ingest.common import (
    backoff_delay,
    get_env,
    get_env_int,
    get_logger,
    line_id_to_name,
    make_event,
    now_jst_iso,
    odpt_railway_to_line_id,
    stable_hash,
)
from ingest.sink import upsert

FEED_NAME = "trains"
log = get_logger("ingest.trains")

NORMAL_MARKERS = ("平常運転", "遅延はありません")
DELAY_MARKER = "遅延"
SUSPENDED_MARKERS = ("運転見合わせ", "運転中止")


def _feed_url() -> str:
    url = get_env("FEED_ODPT_TRAINS", "https://api-public.odpt.org/api/v4/odpt:TrainInformation")
    # Defend against the ODPT .json trap (contracts/feeds.json CRITICAL_NOTE):
    # api-public.odpt.org redirects "<url>.json" to a dead Azure blob.
    if url.endswith(".json"):
        log.warning("FEED_ODPT_TRAINS ends with .json (the documented ODPT trap) -- stripping it")
        url = url[: -len(".json")]
    return url


def classify_severity(text: str) -> str:
    if any(m in text for m in SUSPENDED_MARKERS):
        return "critical"
    if any(m in text for m in NORMAL_MARKERS):
        return "info"
    if DELAY_MARKER in text:
        return "warning"
    return "info"


_ENGLISH_BY_SEVERITY = {
    "info": "normal operation",
    "warning": "delays reported",
    "critical": "service suspended",
}


def normalize(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rail_to_line = odpt_railway_to_line_id()
    line_names = line_id_to_name()
    events: list[dict[str, Any]] = []
    for item in items:
        railway = item.get("odpt:railway")
        line_id = rail_to_line.get(railway)
        if not line_id:
            log.info("skip: no lineId mapping for odpt:railway=%s", railway)
            continue
        text_obj = item.get("odpt:trainInformationText") or {}
        text_ja = (text_obj.get("ja") or "").strip()
        if not text_ja:
            continue
        severity = classify_severity(text_ja)
        line_name = line_names.get(line_id, {}).get("name", line_id)
        title = f"{line_name}: {_ENGLISH_BY_SEVERITY[severity]}"
        # odpt:timeOfOrigin = when THIS status began (stable while unchanged).
        # dc:date is the feed's publish/poll timestamp -- it refreshes every
        # cycle even when nothing changed, which would bubble stale
        # "normal operation" rows to the top of a time-sorted timeline on
        # every 30s poll and bury real incidents. Prefer the honest time.
        time_str = item.get("odpt:timeOfOrigin") or item.get("dc:date") or now_jst_iso()
        events.append(
            make_event(
                id=f"odpt-{line_id}-{stable_hash(text_ja)}",
                type="train",
                severity=severity,
                time=time_str,
                title=title,
                titleJa=text_ja,
                affects=[f"line:{line_id}"],
                source="odpt",
                url=None,
            )
        )
    return events


def fetch_once() -> list[dict[str, Any]]:
    import httpx  # lazy: normalize() (the --push sandbox path) needs no HTTP client

    url = _feed_url()
    resp = httpx.get(url, timeout=15.0)
    resp.raise_for_status()
    data = resp.json()
    if not isinstance(data, list):
        raise ValueError(f"unexpected ODPT TrainInformation payload shape: {type(data)}")
    return data


def run_cycle() -> dict[str, Any]:
    items = fetch_once()
    events = normalize(items)
    result = upsert(FEED_NAME, events)
    log.info(
        "cycle ok: %d raw items -> %d events, neo4j_ok=%s written=%s",
        len(items),
        len(events),
        result.get("neo4j_ok"),
        result.get("written"),
    )
    return result


def main(stop_event=None, poll_seconds: Optional[int] = None) -> None:
    poll_seconds = poll_seconds or get_env_int("INGEST_POLL_SECONDS", 30)
    log.info("trains ingestor starting (poll=%ss)", poll_seconds)
    fail_streak = 0
    while True:
        if stop_event is not None and stop_event.is_set():
            log.info("trains ingestor stopping")
            return
        try:
            run_cycle()
            fail_streak = 0
        except Exception as e:  # a dead/garbage feed must never kill the process
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
        import json

        items = fetch_once()
        events = normalize(items)
        print(json.dumps(events, ensure_ascii=False, indent=2))
    else:
        main()
