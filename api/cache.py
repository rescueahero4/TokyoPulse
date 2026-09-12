"""TokyoPulse — in-process response cache (owner: A3).

Why this exists: Aura is in GCP Singapore, we are in Tokyo, so ONE Cypher
round-trip costs ~0.4s and nothing that queries per request can be under 500ms.
So the API serves every read endpoint out of memory:

    tier 0  in-process TTL cache, stale-while-revalidate   <- this file
    tier 1  Neo4j            meta.source = "live"
    tier 2  mock/            meta.source = "cache", degraded
    tier 3  empty payload    meta.source = "mock",  degraded

The cache is a tier IN FRONT of the three-tier resolver, never a replacement:
a miss still goes through `three_tier()`, and a refresh that fails leaves the
previous payload in place (stale beats blank).

Honesty: `meta.generatedAt` is stamped when the payload was actually FETCHED,
never when it was served, and every response carries `X-Cache: hit|stale|miss`
plus `Age: <seconds>` so staleness is visible rather than implied.
"""

from __future__ import annotations

import json
import logging
import threading
import time
from typing import Any, Callable

from fastapi import Response

log = logging.getLogger("tokyopulse.cache")

_lock = threading.Lock()
_entries: dict[str, dict[str, Any]] = {}
_refreshing: set[str] = set()
# key -> (ttl, producer, label) for the background prefetch loop
_registry: dict[str, tuple[float, Callable[[], dict], str]] = {}
_touch: dict[str, float] = {}          # last time a key was actually requested
IDLE_MAX = 300.0                       # stop prefetching a key nobody asks for


def _dump(payload: dict[str, Any]) -> bytes:
    return json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8")


def _store(key: str, payload: dict[str, Any]) -> dict[str, Any]:
    entry = {"payload": payload, "raw": _dump(payload), "at": time.monotonic()}
    with _lock:
        _entries[key] = entry
    return entry


def _respond(entry: dict[str, Any], state: str) -> Response:
    age = int(time.monotonic() - entry["at"])
    return Response(content=entry["raw"], media_type="application/json",
                    headers={"X-Cache": state, "Age": str(age),
                             "Cache-Control": "no-cache"})


def _refresh_async(key: str, producer: Callable[[], dict], label: str) -> None:
    with _lock:
        if key in _refreshing:
            return
        _refreshing.add(key)

    def work():
        try:
            _store(key, producer())
        except Exception:
            # Keep the stale entry: a failed refresh must never blank a layer.
            log.exception("[%s] cache refresh failed — keeping stale payload", label)
        finally:
            with _lock:
                _refreshing.discard(key)

    threading.Thread(target=work, name=f"refresh:{key}", daemon=True).start()


def serve(key: str, ttl: float, producer: Callable[[], dict], label: str,
          empty: Callable[[], dict] | None = None) -> Response:
    """Serve `key` from memory, refreshing in the background when stale.

    `producer` must already be three-tier safe (it returns a payload with a
    `meta` envelope and does not raise for data problems).
    """
    _registry[key] = (ttl, producer, label)
    _touch[key] = time.monotonic()
    entry = _entries.get(key)

    if entry is not None:
        age = time.monotonic() - entry["at"]
        if age >= ttl:
            _refresh_async(key, producer, label)
            return _respond(entry, "stale")
        return _respond(entry, "hit")

    # Cold: pay for it once.
    try:
        return _respond(_store(key, producer()), "miss")
    except Exception:
        log.exception("[%s] producer raised on a cold cache", label)
        from .envelope import meta
        payload = (empty() if empty else {})
        payload["meta"] = meta("mock", True, "producer error, empty payload served")
        return Response(content=_dump(payload), media_type="application/json",
                        headers={"X-Cache": "miss", "Age": "0"})


def prime(key: str, ttl: float, producer: Callable[[], dict], label: str) -> None:
    """Register + fetch a payload now (used at startup)."""
    _registry[key] = (ttl, producer, label)
    _touch[key] = time.monotonic()
    try:
        _store(key, producer())
    except Exception:
        log.warning("[%s] priming failed (will retry in the prefetch loop)", label)


def refresh_expired() -> int:
    """Refresh every registered key whose entry is older than its TTL."""
    n = 0
    now = time.monotonic()
    for key, (ttl, producer, label) in list(_registry.items()):
        if (now - _touch.get(key, 0.0)) > IDLE_MAX:
            continue                    # nobody is asking: stop loading Aura
        entry = _entries.get(key)
        if entry is None or (now - entry["at"]) >= ttl:
            _refresh_async(key, producer, label)
            n += 1
    return n


def invalidate(prefix: str = "") -> None:
    """Drop cached payloads (used after /demo/replay injects events)."""
    with _lock:
        for key in [k for k in _entries if k.startswith(prefix)]:
            _entries.pop(key, None)


def stats() -> dict[str, Any]:
    now = time.monotonic()
    with _lock:
        return {"keys": len(_entries), "registered": len(_registry),
                "refreshing": len(_refreshing),
                "ages": {k: round(now - e["at"], 1) for k, e in _entries.items()}}


def start_prefetch_loop(interval: float = 3.0) -> None:
    """Background loop: keeps every hot payload warm so requests never block."""
    def loop():
        while True:
            try:
                refresh_expired()
            except Exception:
                log.exception("prefetch loop iteration failed")
            time.sleep(interval)

    threading.Thread(target=loop, name="prefetch", daemon=True).start()
    log.info("prefetch loop started (every %.1fs)", interval)
