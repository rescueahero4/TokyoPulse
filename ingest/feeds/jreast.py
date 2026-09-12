"""
ingest/feeds/jreast.py — JR East kanto.aspx per-line status scraper (A9 scope).

JR East has no public per-line live-status JSON API (contracts/feeds.json
jreast_delay_certificate_BLOCKED: the one URL that looks like one is Akamai-
blocked server-side and, even reachable, holds nothing but a dummy record).
What DOES work is an HTML scrape of https://traininfo.jreast.co.jp/train_info/
kanto.aspx, which embeds per-line status inline for 50 JR East lines. We only
care about the 5 mapped in contracts/lines.csv (jreastLineId column):
JR-Yamanote, JR-Chuo-Rapid, JR-Chuo-Sobu, JR-Keihin-Tohoku, JR-Saikyo.

THE #1 BUG RISK (same as ingest/feeds/trains.py): the id must be stable for
the same real-world status so a 30s poll never creates duplicate timeline
rows. id = "jreast-<lineId>-<hash of the status text>" — same text in, same
id out, every time.

THE HONESTY REQUIREMENT (contracts/feeds.json CRITICAL_NOTE, AGENT-BRIEF rule
5): JR East only publishes delays of 30+ minutes (30分以上の遅れ). ODPT/Toei
publishes 15+ minutes. These are DIFFERENT thresholds. Every delay title
below says so explicitly ("JR East reports 30min+") so the inspector card and
timeline never read as one uniform "delay" meaning across the two feeds.

Classification is by the Japanese TEXT, never the CSS class — the class
vocabulary (normal/info/adjust, observed) is undocumented; the text is
authoritative. Unrecognised text degrades to status='unknown', never a
guessed 'normal'. Same degrade path on a total parse failure (markup
changed): this is an HTML scrape, inherently more fragile than a JSON API, so
a parse failure logs once and degrades the 5 affected lines to unknown — it
never crashes the poll loop and never fabricates a fake 'normal'.

normalize() is pure (str in, Events out) and makes no network calls, per A2's
Daytona --push contract: it must import and run with zero third-party deps
inside the sandbox. It builds the Event dict inline rather than going through
ingest.common.make_event(), because that helper's EVENT_SOURCES set predates
the orchestrator's additive 'jreast' enum amendment to
contracts/event.schema.json and ingest/common.py is A2's shared file, not
ours to edit — see the module docstring below for the exact shape this
mirrors.
"""

from __future__ import annotations

import re
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from ingest.common import (
    JST,
    backoff_delay,
    get_env,
    get_env_int,
    get_logger,
    load_lines_csv,
    line_id_to_name,
    now_jst_iso,
    stable_hash,
)
from ingest.sink import upsert

FEED_NAME = "jreast"
log = get_logger("ingest.jreast")

FEED_URL_DEFAULT = "https://traininfo.jreast.co.jp/train_info/kanto.aspx"

# contracts/feeds.json jreast_kanto_status.parse — verified regex (50/50 JR
# East lines parsed at verification time: 47 normal / 2 info / 1 adjust CSS
# class). \s already matches newlines, so no re.DOTALL needed.
_ROW_RE = re.compile(
    r'lineid=([a-z0-9_-]+)"[^>]*class="traininfo-routes__info"\s*>\s*'
    r'<p class="traininfo-routes__status ([a-z]+)"\s*>\s*<span>([^<]+)</span>'
)

# The page's own "as-of" stamp, e.g. "2026年9月12日 16時17分 現在" (verified
# present at fetch time). Preferred over our fetch time per AGENT-BRIEF: "use
# the page's own update timestamp if you can find one".
_PAGE_TS_RE = re.compile(
    r'(20\d\d)年(\d{1,2})月(\d{1,2})日\s*(\d{1,2})時(\d{1,2})分\s*現在'
)

NORMAL_TEXT = "平常運転"
SUSPENDED_MARKERS = ("運転見合わせ", "運転中止")
DELAY_MARKERS = ("遅延", "運転状況", "ダイヤ乱れ")
NOTICE_MARKER = "お知らせ"

# JR East's own published threshold (contracts/feeds.json CRITICAL_NOTE /
# the page's own meta description: "30分以上の遅れ"). ODPT/Toei's
# TrainInformation publishes 15+ minutes -- a DIFFERENT threshold. Disclosed
# in every delay title so the two feeds are never read as one "delay".
THRESHOLD_NOTE = "JR East reports 30min+"

_STATUS_TEXT_EN = {
    "normal": "normal operation",
    "delay": f"delays reported ({THRESHOLD_NOTE})",
    "suspended": "service suspended",
    "unknown": "status unavailable (scrape parse issue)",
}

_SEVERITY_RANK = {"critical": 3, "warning": 2, "info": 1}

_PARSE_FAILURE_MARKER = "__jreast_parse_failure__"


def classify(text: str) -> tuple[str, str]:
    """-> (severity, status). Text is authoritative, never the CSS class.
    Unrecognised text MUST NOT default to 'normal' (honesty requirement)."""
    t = (text or "").strip()
    if t == NORMAL_TEXT:
        return "info", "normal"
    if any(m in t for m in SUSPENDED_MARKERS):
        return "critical", "suspended"
    if any(m in t for m in DELAY_MARKERS):
        return "warning", "delay"
    if NOTICE_MARKER in t:
        # An informational notice, not a line-status change: keep the text,
        # but don't imply a disruption that classify() cannot confirm.
        return "info", "normal"
    log.warning("jreast: unrecognised status text %r -- degrading to unknown", t)
    return "info", "unknown"


def _jreast_line_map() -> dict[str, str]:
    """contracts/lines.csv jreastLineId column -> our lineId. A9's join key."""
    mapping: dict[str, str] = {}
    for row in load_lines_csv():
        jid = (row.get("jreastLineId") or "").strip()
        if jid:
            mapping[jid] = row["lineId"]
    return mapping


def _page_timestamp(html: str) -> Optional[str]:
    """Parse JR East's own 'YYYY年M月D日 H時MM分 現在' stamp -> ISO8601 +09:00.
    None if absent (caller falls back to fetch time, and says so)."""
    m = _PAGE_TS_RE.search(html or "")
    if not m:
        return None
    y, mo, d, h, mi = (int(x) for x in m.groups())
    try:
        return datetime(y, mo, d, h, mi, tzinfo=JST).isoformat()
    except ValueError:
        return None


def _event(
    *,
    id: str,
    severity: str,
    time: str,
    title: str,
    titleJa: Optional[str],
    affects: list[str],
) -> dict[str, Any]:
    """Build an Event dict with EXACTLY the fields in
    contracts/event.schema.json (additionalProperties:false) -- mirrors
    ingest.common.make_event's shape. source='jreast' is the orchestrator's
    additive amendment to the frozen schema (re-read: contracts/event.schema.json
    now enums odpt|p2pquake|jma|open-meteo|mock|replay|jreast)."""
    return {
        "id": id,
        "type": "train",
        "severity": severity,
        "time": time,
        "lat": None,
        "lon": None,
        "title": title,
        "titleJa": titleJa,
        "affects": affects,
        "source": "jreast",
        "url": None,
        "magnitude": None,
        "maxScale": None,
    }


def normalize(raw: str) -> list[dict[str, Any]]:
    """Pure: HTML text in, Events out. No network calls -- A2's Daytona
    --push mode imports and runs this inside a sandbox with zero third-party
    deps, so only stdlib (re, datetime) is used here.

    Only emits events for the 5 JR lines mapped in contracts/lines.csv
    (jreastLineId column). The page carries 50 JR East lines; the other 45
    are outside our registry and would pollute the timeline.

    Always emits exactly 5 events (one per mapped line) so a poll cycle never
    silently drops a line's row off the timeline. Degrades to
    status='unknown' (never a faked 'normal') when: the whole page fails to
    parse (markup changed -- 0 regex matches at all), or a specific mapped
    line is simply absent from this poll's matches.
    """
    html = raw or ""
    line_map = _jreast_line_map()  # jreastLineId -> our lineId
    line_names = line_id_to_name()
    page_time = _page_timestamp(html) or now_jst_iso()

    matches = _ROW_RE.findall(html)
    if not matches:
        log.error(
            "jreast: regex found 0 rows in %d bytes of HTML -- markup likely "
            "changed; degrading all %d mapped lines to unknown",
            len(html),
            len(line_map),
        )

    # jreastLineId -> best (severity, status, text) seen this poll. The page
    # has been observed to list some lines twice (identical gid groupings
    # with identical text so far); if duplicates ever disagree, keep the more
    # severe reading rather than risk masking a real incident behind a stale
    # 'normal' duplicate.
    best: dict[str, tuple[str, str, str]] = {}
    for jid, _css_class, text in matches:
        if jid not in line_map:
            continue  # one of the other 45 JR East lines outside our registry
        severity, status = classify(text)
        prev = best.get(jid)
        if prev is None or _SEVERITY_RANK.get(severity, 1) > _SEVERITY_RANK.get(
            prev[0], 1
        ):
            best[jid] = (severity, status, text.strip())

    events: list[dict[str, Any]] = []
    for jid, line_id in line_map.items():
        line_name = line_names.get(line_id, {}).get("name", line_id)
        if jid in best:
            severity, status, text_ja = best[jid]
            title_ja: Optional[str] = text_ja
            hash_input = text_ja
        else:
            severity, status = "info", "unknown"
            title_ja = None
            hash_input = _PARSE_FAILURE_MARKER
        title = f"{line_name}: {_STATUS_TEXT_EN[status]}"
        events.append(
            _event(
                id=f"jreast-{line_id}-{stable_hash(hash_input)}",
                severity=severity,
                time=page_time,
                title=title,
                titleJa=title_ja,
                affects=[f"line:{line_id}"],
            )
        )
    return events


def fetch_once() -> str:
    import httpx  # lazy: normalize() (the --push sandbox path) needs no HTTP client

    url = get_env("FEED_JREAST_KANTO_STATUS", FEED_URL_DEFAULT)
    resp = httpx.get(
        url,
        timeout=15.0,
        headers={"User-Agent": "Mozilla/5.0 (TokyoPulse hackathon demo ingestor)"},
    )
    resp.raise_for_status()
    return resp.text


def run_cycle() -> dict[str, Any]:
    html = fetch_once()
    events = normalize(html)
    result = upsert(FEED_NAME, events)
    log.info(
        "cycle ok: %d bytes html -> %d events, neo4j_ok=%s written=%s",
        len(html),
        len(events),
        result.get("neo4j_ok"),
        result.get("written"),
    )
    return result


def main(stop_event=None, poll_seconds: Optional[int] = None) -> None:
    poll_seconds = poll_seconds or get_env_int("INGEST_POLL_SECONDS", 30)
    log.info("jreast ingestor starting (poll=%ss)", poll_seconds)
    fail_streak = 0
    while True:
        if stop_event is not None and stop_event.is_set():
            log.info("jreast ingestor stopping")
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

        html = fetch_once()
        events = normalize(html)
        print(json.dumps(events, ensure_ascii=False, indent=2))
    else:
        main()
