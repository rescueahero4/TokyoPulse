"""
ingest/once.py -- one ingest pass over every event feed, then exit.

The serverless counterpart of ingest/launcher.py: Vercel functions cannot hold
polling loops or the P2PQuake WebSocket, so GET /tick runs this instead. Quakes
use the history endpoint, which also catches up on anything missed while no one
was watching. A feed failing never stops the others.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout
from typing import Any, Callable

from .common import get_logger
from .feeds import quakes, trains, weather
from .feeds import warnings as warnings_feed

log = get_logger("ingest.once")

# No JR East: traininfo.jreast.co.jp returns 403 to Vercel's servers (it works from
# a home connection), so the hosted site shows those lines as having no live feed.
FEEDS: dict[str, Callable[[], dict[str, Any]]] = {
    "trains": trains.run_cycle,
    "quakes": quakes.run_history_backfill,
    "warnings": warnings_feed.run_cycle,
    "weather": weather.run_cycle,
}


def run_once(deadline_s: float = 40.0) -> dict[str, dict[str, Any]]:
    """Run every feed in parallel. Returns {feed: {ok, written, neo4jOk?, error?}}."""
    pool = ThreadPoolExecutor(max_workers=len(FEEDS), thread_name_prefix="ingest-once")
    futures = {name: pool.submit(fn) for name, fn in FEEDS.items()}
    out: dict[str, dict[str, Any]] = {}
    for name, fut in futures.items():
        try:
            r = fut.result(timeout=deadline_s)
            neo4j_ok = bool(r.get("neo4j_ok"))
            out[name] = {"ok": neo4j_ok, "written": r.get("written", 0), "neo4jOk": neo4j_ok}
            if not neo4j_ok:
                out[name]["error"] = str(r.get("error", "neo4j upsert failed"))[:200]
        except FutureTimeout:
            out[name] = {"ok": False, "written": 0, "error": "timed out"}
        except Exception as e:  # a dead feed must not take the pass down
            log.warning("feed %s failed: %s", name, e)
            out[name] = {"ok": False, "written": 0, "error": f"{type(e).__name__}: {str(e)[:160]}"}
    pool.shutdown(wait=False)
    return out
