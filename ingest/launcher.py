"""
ingest/launcher.py — the Daytona sponsor centrepiece (A2 scope).

Creates ONE Daytona sandbox PER live feed (trains/quakes/warnings/weather),
launched IN PARALLEL (ThreadPoolExecutor — the fan-out is the whole point),
uploads the matching ingestor into each, runs it in the background, and
measures each sandbox's startup milliseconds.

Secret whitelist — ONLY these are forwarded into a sandbox via `env_vars` at
create(): NEO4J_URI, NEO4J_USERNAME, NEO4J_PASSWORD, NEO4J_DATABASE, FEED_*,
INGEST_POLL_SECONDS. ANTHROPIC_API_KEY, DAYTONA_API_KEY and any NOSANA_* are
NEVER forwarded — see doc/prep.md §2 and contracts/AGENT-BRIEF.md.

Writes live status to ingest/state/sandboxes.json in exactly the
GET /sandboxes.json shape from contracts/api.md.

--local runs all 4 ingestors as local threads instead of Daytona sandboxes
(status:"mock") -- the fallback that guarantees the badge is never empty and
lets everything be tested without burning Daytona quota.
"""

from __future__ import annotations

import argparse
import json
import signal
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Optional

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ingest.common import (
    INGEST_DIR,
    ROOT,
    STATE_DIR,
    get_env,
    get_env_int,
    get_logger,
    now_jst_iso,
)
from ingest.feeds import quakes, trains, warnings as warnings_feed, weather

log = get_logger("ingest.launcher")

SANDBOXES_JSON = STATE_DIR / "sandboxes.json"

# name, feed id (matches contracts/api.md sample + mock/sandboxes.json), module,
# local filename (under ingest/feeds/), state-file key (sink.py's FEED_NAME).
FEED_DEFS: list[dict[str, Any]] = [
    {"name": "ingest-trains", "feed": "odpt", "module": trains, "filename": "trains.py", "state_key": "trains"},
    {"name": "ingest-quakes", "feed": "p2pquake", "module": quakes, "filename": "quakes.py", "state_key": "quakes"},
    {"name": "ingest-warnings", "feed": "jma", "module": warnings_feed, "filename": "warnings.py", "state_key": "warnings"},
    {"name": "ingest-weather", "feed": "open-meteo", "module": weather, "filename": "weather.py", "state_key": "weather"},
]

# Secret whitelist (doc/prep.md §2 / AGENT-BRIEF). Never widen without a
# contract change — this is what stands between a dead sandbox and a leaked key.
_WHITELIST_EXACT = {"NEO4J_URI", "NEO4J_USERNAME", "NEO4J_PASSWORD", "NEO4J_DATABASE", "INGEST_POLL_SECONDS"}
_WHITELIST_PREFIX = ("FEED_",)


def build_sandbox_env() -> dict[str, str]:
    import os

    out: dict[str, str] = {}
    for k, v in os.environ.items():
        if v is None or v == "":
            continue
        if k in _WHITELIST_EXACT or k.startswith(_WHITELIST_PREFIX):
            out[k] = v
    return out


# ─────────────────────────────── status registry ───────────────────────────
_status_lock = threading.Lock()
_status: dict[str, dict[str, Any]] = {}


def _init_status(mode: str) -> None:
    with _status_lock:
        _status.clear()
        for fd in FEED_DEFS:
            _status[fd["name"]] = {
                "name": fd["name"],
                "feed": fd["feed"],
                "status": "starting",
                "eventsWritten": 0,
                "lastWriteAt": None,
                "startupMs": None,
            }


def _update_status(name: str, **kwargs: Any) -> None:
    with _status_lock:
        _status[name].update(kwargs)


def write_sandboxes_json(note: Optional[str] = None) -> dict[str, Any]:
    with _status_lock:
        sandboxes = [dict(v) for v in _status.values()]
    payload = {
        "count": len(sandboxes),
        "sandboxes": sandboxes,
        "meta": {
            "source": "live" if any(s["status"] not in ("mock", "stopped", "failed") for s in sandboxes) else "mock",
            "generatedAt": now_jst_iso(),
            "degraded": any(s["status"] == "failed" for s in sandboxes),
            "note": note,
        },
    }
    SANDBOXES_JSON.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return payload


def _state_file_stats(state_key: str) -> tuple[int, Optional[str]]:
    path = STATE_DIR / f"events-{state_key}.json"
    if not path.exists():
        return 0, None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return int(data.get("count", 0)), data.get("updatedAt")
    except Exception:
        return 0, None


def _status_monitor_loop(stop_event: threading.Event, interval: float = 3.0) -> None:
    """Keeps ingest/state/sandboxes.json fresh from each feed's state file --
    this is A3's /sandboxes.json integration point, so the shape must match
    contracts/api.md exactly."""
    while not stop_event.is_set():
        for fd in FEED_DEFS:
            n, last_write = _state_file_stats(fd["state_key"])
            _update_status(fd["name"], eventsWritten=n, lastWriteAt=last_write)
        write_sandboxes_json()
        stop_event.wait(interval)


# ─────────────────────────────────── --local ────────────────────────────────
def run_local(duration: Optional[float] = None) -> None:
    _init_status("local")
    stop_event = threading.Event()
    monitor_stop = threading.Event()
    threads: list[threading.Thread] = []

    for fd in FEED_DEFS:
        t0 = time.monotonic()

        def target(module=fd["module"], name=fd["name"]):
            try:
                module.main(stop_event=stop_event)
            except Exception as e:  # a feed dying must never take the launcher down
                log.error("local thread for %s crashed: %s", name, e)
                _update_status(name, status="failed")

        th = threading.Thread(target=target, name=fd["name"], daemon=True)
        th.start()
        startup_ms = round((time.monotonic() - t0) * 1000, 2)
        _update_status(fd["name"], status="mock", startupMs=startup_ms)
        threads.append(th)

    monitor = threading.Thread(
        target=_status_monitor_loop, args=(monitor_stop,), daemon=True
    )
    monitor.start()
    write_sandboxes_json(note="--local: 4 ingestors running as local threads, status=mock")
    log.info("local mode: 4 ingestor threads started; writing %s every 3s", SANDBOXES_JSON)

    def _shutdown(*_a):
        log.info("shutting down local ingestors...")
        stop_event.set()
        monitor_stop.set()
        for th in threads:
            th.join(timeout=5)
        write_sandboxes_json(note="--local: stopped")
        sys.exit(0)

    signal.signal(signal.SIGINT, _shutdown)
    try:
        signal.signal(signal.SIGTERM, _shutdown)
    except Exception:
        pass

    if duration is not None:
        time.sleep(duration)
        _shutdown()
    else:
        while True:
            time.sleep(1)


# ───────────────────────────────── Daytona mode ─────────────────────────────
def _sandbox_files(fd: dict[str, Any]) -> list[tuple[Path, str]]:
    """(local_path, remote_relative_path) pairs mirroring the local ingest/
    package layout under <sandbox-root>/tokyopulse/, so common.py's
    ROOT-relative lookups (contracts/lines.csv, contracts/wards.csv,
    ingest/state/) resolve identically inside the sandbox."""
    files = [
        (ROOT / "ingest" / "__init__.py", "tokyopulse/ingest/__init__.py"),
        (ROOT / "ingest" / "common.py", "tokyopulse/ingest/common.py"),
        (ROOT / "ingest" / "sink.py", "tokyopulse/ingest/sink.py"),
        (ROOT / "ingest" / "feeds" / "__init__.py", "tokyopulse/ingest/feeds/__init__.py"),
        (ROOT / "ingest" / "feeds" / fd["filename"], f"tokyopulse/ingest/feeds/{fd['filename']}"),
        (ROOT / "contracts" / "lines.csv", "tokyopulse/contracts/lines.csv"),
        (ROOT / "contracts" / "wards.csv", "tokyopulse/contracts/wards.csv"),
    ]
    return files


def _create_one_sandbox(daytona: Any, fd: dict[str, Any], env_vars: dict[str, str]) -> dict[str, Any]:
    from daytona import CreateSandboxFromSnapshotParams

    snapshot = get_env("DAYTONA_SNAPSHOT") or None
    t0 = time.monotonic()
    try:
        sandbox = daytona.create(
            CreateSandboxFromSnapshotParams(
                name=f"tokyopulse-{fd['feed']}",
                snapshot=snapshot,
                env_vars=env_vars,
                labels={"project": "tokyopulse", "feed": fd["feed"]},
            ),
            timeout=90,
        )
    except Exception as e:
        log.error("sandbox create failed for %s: %s", fd["name"], e)
        _update_status(fd["name"], status="failed")
        return {"ok": False, "error": str(e)}
    startup_ms = round((time.monotonic() - t0) * 1000, 2)
    _update_status(fd["name"], status="starting", startupMs=startup_ms)
    log.info("sandbox created for %s in %.1fms", fd["name"], startup_ms)

    try:
        root = sandbox.get_user_root_dir()
        for local_path, remote_rel in _sandbox_files(fd):
            sandbox.fs.upload_file(str(local_path), f"{root}/{remote_rel}")
        install_cmd = (
            f"cd {root}/tokyopulse && "
            "python3 -m pip install -q httpx websockets python-dotenv neo4j 2>&1 | tail -n 20"
        )
        install_res = sandbox.process.exec(install_cmd, timeout=180)
        log.info("%s: pip install exit=%s", fd["name"], install_res.exit_code)

        module_name = fd["filename"][: -len(".py")]
        session_id = f"run-{fd['feed']}"
        sandbox.process.create_session(session_id)
        from daytona import SessionExecuteRequest

        run_cmd = f"cd {root}/tokyopulse && python3 -m ingest.feeds.{module_name}"
        sandbox.process.execute_session_command(
            session_id, SessionExecuteRequest(command=run_cmd, run_async=True)
        )
        _update_status(fd["name"], status="running")
        log.info("%s: ingestor launched in background session %s", fd["name"], session_id)
    except Exception as e:
        log.error("sandbox bootstrap failed for %s: %s", fd["name"], e)
        _update_status(fd["name"], status="failed")
        return {"ok": False, "sandbox": sandbox, "error": str(e)}

    return {"ok": True, "sandbox": sandbox, "startup_ms": startup_ms}


def run_daytona() -> dict[str, Any]:
    from daytona import Daytona, DaytonaConfig

    api_key = get_env("DAYTONA_API_KEY")
    api_url = get_env("DAYTONA_API_URL")
    target = get_env("DAYTONA_TARGET")
    if not api_key:
        raise RuntimeError("DAYTONA_API_KEY not set in .env")

    daytona = Daytona(DaytonaConfig(api_key=api_key, api_url=api_url, target=target))
    env_vars = build_sandbox_env()
    log.info("forwarding %d whitelisted env vars into each sandbox: %s", len(env_vars), sorted(env_vars.keys()))

    _init_status("daytona")
    write_sandboxes_json(note="creating sandboxes...")

    sandboxes: dict[str, Any] = {}
    with ThreadPoolExecutor(max_workers=len(FEED_DEFS)) as pool:
        futures = {pool.submit(_create_one_sandbox, daytona, fd, env_vars): fd for fd in FEED_DEFS}
        for fut in futures:
            fd = futures[fut]
            result = fut.result()
            sandboxes[fd["name"]] = result
            write_sandboxes_json()

    monitor_stop = threading.Event()

    def _remote_monitor_loop(interval: float = 5.0) -> None:
        while not monitor_stop.is_set():
            for fd in FEED_DEFS:
                res = sandboxes.get(fd["name"]) or {}
                sandbox = res.get("sandbox")
                if not sandbox:
                    continue
                try:
                    root = sandbox.get_user_root_dir()
                    out = sandbox.process.exec(
                        f"cat {root}/tokyopulse/ingest/state/events-{fd['state_key']}.json 2>/dev/null || echo '{{}}'",
                        timeout=10,
                    )
                    data = json.loads(out.result or "{}")
                    _update_status(
                        fd["name"],
                        eventsWritten=int(data.get("count", 0)),
                        lastWriteAt=data.get("updatedAt"),
                    )
                except Exception as e:
                    log.debug("status poll failed for %s: %s", fd["name"], e)
            write_sandboxes_json()
            monitor_stop.wait(interval)

    monitor = threading.Thread(target=_remote_monitor_loop, daemon=True)
    monitor.start()

    def _teardown(*_a):
        log.info("tearing down %d sandboxes...", len(sandboxes))
        monitor_stop.set()
        for name, res in sandboxes.items():
            sandbox = res.get("sandbox")
            if sandbox is None:
                continue
            try:
                sandbox.delete()
                log.info("deleted sandbox for %s", name)
            except Exception as e:
                log.error("failed to delete sandbox for %s: %s -- MANUAL CLEANUP NEEDED", name, e)
        write_sandboxes_json(note="torn down")
        sys.exit(0)

    signal.signal(signal.SIGINT, _teardown)
    try:
        signal.signal(signal.SIGTERM, _teardown)
    except Exception:
        pass

    log.info("4 Daytona sandboxes launched in parallel. Ctrl+C to tear down.")
    while True:
        time.sleep(1)


def main() -> None:
    parser = argparse.ArgumentParser(description="TokyoPulse ingest launcher (A2)")
    parser.add_argument("--local", action="store_true", help="run ingestors as local threads, not Daytona sandboxes")
    parser.add_argument("--duration", type=float, default=None, help="auto-stop after N seconds (for scripted smoke tests)")
    args = parser.parse_args()

    if args.local:
        run_local(duration=args.duration)
    else:
        run_daytona()


if __name__ == "__main__":
    main()
