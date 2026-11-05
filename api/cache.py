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
so staleness is visible rather than implied. Locally `Age: <seconds>` says how old
it is; on the hosted site the CDN sets its own `Age`.

Hosted, this memory belongs to a single function instance, so the CDN does the
sharing: fresh payloads carry a CDN lifetime, and every viewer gets the same copy
without reaching a function. Stale or degraded payloads are never put on the CDN.
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
KEEP_GOOD_MAX = 300.0                  # how long a good payload outlives failed refreshes
CDN_ENABLED = False                    # api.main turns this on for the hosted site
CDN_MIN_TTL = 15.0                     # viewers poll every 15s or slower, so no gain below this
REFRESH_MIN_GAP = 5.0                  # a client-supplied `v` can't force reads faster than this


def _dump(payload: dict[str, Any]) -> bytes:
    return json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8")


def _degraded(payload: Any) -> bool:
    return bool(isinstance(payload, dict) and (payload.get("meta") or {}).get("degraded"))


def _store(key: str, payload: dict[str, Any]) -> dict[str, Any]:
    entry = {"payload": payload, "raw": _dump(payload), "at": time.monotonic(),
             "wall": time.time()}
    with _lock:
        _entries[key] = entry
    return entry


def _keep_previous(old: dict[str, Any] | None, payload: Any) -> bool:
    """Producers report data problems as a degraded payload rather than raising, so
    a transient timeout must not replace good data with it."""
    return (old is not None and _degraded(payload) and not _degraded(old["payload"])
            and time.monotonic() - old["at"] < KEEP_GOOD_MAX)


def _respond(entry: dict[str, Any], state: str, cdn_ttl: float = 0.0) -> Response:
    age = time.monotonic() - entry["at"]
    headers = {"X-Cache": state, "Cache-Control": "no-cache"}
    if not CDN_ENABLED:
        headers["Age"] = str(int(age))
    elif cdn_ttl - age >= 1 and not _degraded(entry["payload"]):
        # Counted from the fetch, so the CDN can't extend a payload's life.
        headers["Vercel-CDN-Cache-Control"] = f"public, max-age={int(cdn_ttl - age)}"
    return Response(content=entry["raw"], media_type="application/json", headers=headers)


def _refresh_async(key: str, producer: Callable[[], dict], label: str) -> None:
    with _lock:
        if key in _refreshing:
            return
        _refreshing.add(key)

    def work():
        try:
            payload = producer()
            if _keep_previous(_entries.get(key), payload):
                log.warning("[%s] refresh degraded, keeping the last good payload", label)
                return
            _store(key, payload)
        except Exception:
            # Keep the stale entry: a failed refresh must never blank a layer.
            log.exception("[%s] cache refresh failed — keeping stale payload", label)
        finally:
            with _lock:
                _refreshing.discard(key)

    threading.Thread(target=work, name=f"refresh:{key}", daemon=True).start()


def _reread(key: str, entry: dict[str, Any], producer: Callable[[], dict], label: str,
            cdn_ttl: float) -> Response:
    """Refresh inline, so the result can go on the CDN. The old payload survives a failure."""
    try:
        payload = producer()
    except Exception:
        log.exception("[%s] re-read failed — keeping stale payload", label)
        return _respond(entry, "stale")
    if _keep_previous(entry, payload):
        log.warning("[%s] re-read degraded, keeping the last good payload", label)
        return _respond(entry, "stale")
    return _respond(_store(key, payload), "miss", cdn_ttl)


def serve(key: str, ttl: float, producer: Callable[[], dict], label: str,
          empty: Callable[[], dict] | None = None,
          fresh_after: float | None = None) -> Response:
    """Serve `key` from memory, refreshing in the background when stale.

    `producer` must already be three-tier safe (it returns a payload with a
    `meta` envelope and does not raise for data problems).

    `fresh_after` is the ingest time the caller already knows about: a payload
    fetched before it predates that ingest, so it is re-read now instead of waiting
    out its TTL. This is what shows new data seconds after a cold start.
    """
    _registry[key] = (ttl, producer, label)
    _touch[key] = time.monotonic()
    entry = _entries.get(key)
    cdn_ttl = max(ttl, CDN_MIN_TTL)

    if entry is not None:
        age = time.monotonic() - entry["at"]
        if fresh_after is not None and entry["wall"] < fresh_after:
            if age < REFRESH_MIN_GAP:
                return _respond(entry, "stale")
            return _reread(key, entry, producer, label, cdn_ttl)
        if CDN_ENABLED:
            # A stale reply can't be shared, and viewers poll slower than the shorter
            # TTLs, so serving stale would keep almost every poll off the CDN.
            if age >= cdn_ttl:
                return _reread(key, entry, producer, label, cdn_ttl)
            return _respond(entry, "hit", cdn_ttl)
        if age >= ttl:
            _refresh_async(key, producer, label)
            return _respond(entry, "stale")
        return _respond(entry, "hit", cdn_ttl)

    # Cold: pay for it once.
    try:
        return _respond(_store(key, producer()), "miss", cdn_ttl)
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
