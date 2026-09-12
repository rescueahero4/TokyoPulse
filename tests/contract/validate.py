"""TokyoPulse — contract validator (owner: QA-CONTRACT).

Proves the frozen contracts in `contracts/` are honoured by `mock/`, `api/`,
and `web/`, so a live-data swap never breaks the UI.

Run it:
    .venv\\Scripts\\python.exe tests\\contract\\validate.py

Exit code 0 = every check passed. Non-zero = at least one FAIL (WARN/SKIP do
not affect the exit code). Every check prints one PASS/FAIL/WARN/SKIP line as
it runs; a summary and (if any) a defect list print at the end.
"""

from __future__ import annotations

import csv
import json
import os
import re
import subprocess
import sys
import time
import traceback
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

import httpx
from jsonschema import Draft7Validator, FormatChecker

ROOT = Path(__file__).resolve().parents[2]
CONTRACTS = ROOT / "contracts"
MOCK = ROOT / "mock"
WEB = ROOT / "web"
API_BASE = "http://localhost:8000"
JST = timezone(timedelta(hours=9))

# ───────────────────────────── tiny PASS/FAIL harness ─────────────────────────

RESULTS: list[tuple[str, str, str]] = []   # (id, status, message)
DEFECTS: list[dict[str, str]] = []


def record(check_id: str, ok: bool, msg: str, warn: bool = False) -> bool:
    status = "PASS" if ok else ("WARN" if warn else "FAIL")
    RESULTS.append((check_id, status, msg))
    print(f"[{status}] {check_id}: {msg}")
    return ok


def skip(check_id: str, msg: str) -> None:
    RESULTS.append((check_id, "SKIP", msg))
    print(f"[SKIP] {check_id}: {msg}")


def defect(file: str, owner: str, what: str, fix: str) -> None:
    DEFECTS.append({"file": file, "owner": owner, "what": what, "fix": fix})


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def read_csv_rows(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as fh:
        return [dict(r) for r in csv.DictReader(fh)]


def check_meta(obj: dict, check_id: str, label: str) -> bool:
    m = obj.get("meta") if isinstance(obj, dict) else None
    if not isinstance(m, dict):
        return record(check_id, False, f"{label}: missing/invalid 'meta' object")
    missing = [k for k in ("source", "generatedAt", "degraded", "note") if k not in m]
    if missing:
        return record(check_id, False, f"{label}: meta missing keys {missing}")
    if m["source"] not in ("live", "cache", "mock"):
        return record(check_id, False, f"{label}: meta.source invalid value {m['source']!r}")
    if not isinstance(m["degraded"], bool):
        return record(check_id, False, f"{label}: meta.degraded is not boolean ({m['degraded']!r})")
    return record(check_id, True, f"{label}: meta OK ({m['source']}, degraded={m['degraded']})")


# ═══════════════════════════════ PART A — static mock/ ════════════════════════

def part_a() -> dict[str, Any]:
    print("\n" + "=" * 70)
    print("PART A — static files in mock/")
    print("=" * 70)

    event_schema = load_json(CONTRACTS / "event.schema.json")
    line_schema = load_json(CONTRACTS / "line-feature.schema.json")
    event_validator = Draft7Validator(event_schema, format_checker=FormatChecker())
    line_validator = Draft7Validator(line_schema, format_checker=FormatChecker())

    lines_rows = read_csv_rows(CONTRACTS / "lines.csv")
    wards_rows = read_csv_rows(CONTRACTS / "wards.csv")
    line_ids = {r["lineId"] for r in lines_rows if r.get("lineId")}
    ward_names = {r["ward"] for r in wards_rows if r.get("ward")}

    ctx: dict[str, Any] = {"line_ids": line_ids, "ward_names": ward_names}

    # --- A1: events.json schema validation -----------------------------------
    events_doc = load_json(MOCK / "events.json")
    events = events_doc.get("events") or []
    bad = []
    for ev in events:
        errs = sorted(event_validator.iter_errors(ev), key=str)
        if errs:
            bad.append((ev.get("id", "<no id>"), [e.message for e in errs]))
    record("A1", not bad,
           f"{len(events)} events checked against event.schema.json, {len(bad)} invalid"
           + (f" — e.g. {bad[0][0]}: {bad[0][1][0]}" if bad else ""))
    if bad:
        for eid, errs in bad[:5]:
            defect("mock/events.json", "A5-DATA",
                   f"event '{eid}' fails schema: {errs[0]}",
                   "Fix the event to conform to contracts/event.schema.json.")

    # --- A2: time is ISO8601 with +09:00 offset -------------------------------
    naive_or_wrong = []
    for ev in events:
        t = ev.get("time")
        ok_fmt = isinstance(t, str) and bool(
            re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?\+09:00$", t))
        if not ok_fmt:
            naive_or_wrong.append((ev.get("id", "<no id>"), t))
    record("A2", not naive_or_wrong,
           f"{len(events)} event times checked, {len(naive_or_wrong)} naive/non +09:00"
           + (f" — e.g. {naive_or_wrong[0]}" if naive_or_wrong else ""))
    for eid, t in naive_or_wrong[:5]:
        defect("mock/events.json", "A5-DATA",
               f"event '{eid}' has time {t!r} — not ISO8601 with +09:00 offset",
               "Emit time as Asia/Tokyo ISO8601 with explicit +09:00 offset, never naive.")

    # --- A3: affects refs well-formed AND target exists -----------------------
    dangling = []
    malformed = []
    for ev in events:
        for ref in ev.get("affects") or []:
            m = re.match(r"^(line|ward):([A-Za-z0-9_-]+)$", ref)
            if not m:
                malformed.append((ev.get("id"), ref))
                continue
            kind, target = m.groups()
            exists = (target in line_ids) if kind == "line" else (target in ward_names)
            if not exists:
                dangling.append((ev.get("id"), ref))
    record("A3", not (dangling or malformed),
           f"{sum(len(ev.get('affects') or []) for ev in events)} affects refs checked, "
           f"{len(dangling)} dangling, {len(malformed)} malformed"
           + (f" — e.g. {dangling[0] if dangling else malformed[0]}" if (dangling or malformed) else ""))
    for eid, ref in (dangling + malformed)[:10]:
        defect("mock/events.json", "A5-DATA",
               f"event '{eid}' affects ref {ref!r} does not resolve to a known line/ward",
               "Point affects at a lineId from contracts/lines.csv or a ward name from contracts/wards.csv.")

    # --- A4: lines.geojson lineId coverage + schema + coordinate bounds -------
    lines_doc = load_json(MOCK / "lines.geojson")
    feats = lines_doc.get("features") or []
    feat_ids = [((f or {}).get("properties") or {}).get("lineId") for f in feats]
    feat_id_set = set(x for x in feat_ids if x)
    missing_ids = line_ids - feat_id_set
    extra_ids = feat_id_set - line_ids
    dup_ids = [x for x in set(feat_ids) if feat_ids.count(x) > 1]
    record("A4a", not (missing_ids or extra_ids or dup_ids),
           f"{len(feat_ids)} features; missing={sorted(missing_ids)}, "
           f"extra={sorted(extra_ids)}, dup={sorted(dup_ids)}")
    if missing_ids or extra_ids or dup_ids:
        defect("mock/lines.geojson", "A5-DATA",
               f"lineId set mismatch vs contracts/lines.csv: missing={sorted(missing_ids)} "
               f"extra={sorted(extra_ids)} dup={sorted(dup_ids)}",
               "Emit exactly the 20 lineIds from contracts/lines.csv, no more, no fewer, no dupes.")

    schema_bad = []
    for f in feats:
        errs = sorted(line_validator.iter_errors(f), key=str)
        if errs:
            lid = ((f or {}).get("properties") or {}).get("lineId", "<no lineId>")
            schema_bad.append((lid, errs[0].message))
    record("A4b", not schema_bad,
           f"{len(feats)} features checked against line-feature.schema.json, "
           f"{len(schema_bad)} invalid" + (f" — e.g. {schema_bad[0]}" if schema_bad else ""))
    for lid, msg in schema_bad[:5]:
        defect("mock/lines.geojson", "A5-DATA", f"feature '{lid}' fails schema: {msg}",
               "Fix feature to conform to contracts/line-feature.schema.json.")

    def flatten_coords(geom: dict) -> list[list[float]]:
        coords = geom.get("coordinates") or []
        t = geom.get("type")
        pts: list[list[float]] = []
        if t == "LineString":
            pts = coords
        elif t == "MultiLineString":
            for seg in coords:
                pts.extend(seg)
        return pts

    out_of_bounds = []
    swapped_guess = 0
    for f in feats:
        lid = ((f or {}).get("properties") or {}).get("lineId", "<no lineId>")
        for pt in flatten_coords((f or {}).get("geometry") or {}):
            if len(pt) < 2:
                continue
            lon, lat = pt[0], pt[1]
            if not (138.9 <= lon <= 140.2 and 35.4 <= lat <= 36.0):
                out_of_bounds.append((lid, pt))
                if 138.9 <= lat <= 140.2 and 35.4 <= lon <= 36.0:
                    swapped_guess += 1
    record("A4c", not out_of_bounds,
           f"coordinate bounds checked (lon 138.9-140.2, lat 35.4-36.0); "
           f"{len(out_of_bounds)} out-of-bounds points"
           + (f", {swapped_guess} look like [lat,lon] swaps" if swapped_guess else "")
           + (f" — e.g. {out_of_bounds[0]}" if out_of_bounds else ""))
    if out_of_bounds:
        defect("mock/lines.geojson", "A5-DATA",
               f"{len(out_of_bounds)} coordinates out of Tokyo bounds"
               + (f" ({swapped_guess} look like a [lat,lon] swap)" if swapped_guess else ""),
               "Coordinates must be [lon, lat] per GeoJSON spec; check for axis swap.")

    check_meta(lines_doc, "A7-lines.geojson", "mock/lines.geojson")

    # --- A5: stations.geojson ridershipBand + bounds ---------------------------
    stations_doc = load_json(MOCK / "stations.geojson")
    sfeats = stations_doc.get("features") or []
    bad_band = []
    bad_coord = []
    for f in sfeats:
        p = (f or {}).get("properties") or {}
        sid = p.get("stationId", "<no id>")
        band = p.get("ridershipBand")
        if not isinstance(band, int) or not (1 <= band <= 5):
            bad_band.append((sid, band))
        coords = ((f or {}).get("geometry") or {}).get("coordinates") or [None, None]
        if len(coords) >= 2:
            lon, lat = coords[0], coords[1]
            if lon is None or lat is None or not (138.9 <= lon <= 140.2 and 35.4 <= lat <= 36.0):
                bad_coord.append((sid, coords))
    record("A5a", not bad_band,
           f"{len(sfeats)} stations checked for ridershipBand in 1..5, {len(bad_band)} bad"
           + (f" — e.g. {bad_band[0]}" if bad_band else ""))
    if bad_band:
        defect("mock/stations.geojson", "A5-DATA",
               f"{len(bad_band)} stations missing/invalid ridershipBand (must ALWAYS be 1..5)",
               "Always compute a 1..5 ridershipBand, even with null ridership (fallback tier).")
    record("A5b", not bad_coord,
           f"{len(sfeats)} stations checked for in-bounds coordinates, {len(bad_coord)} bad"
           + (f" — e.g. {bad_coord[0]}" if bad_coord else ""))
    if bad_coord:
        defect("mock/stations.geojson", "A5-DATA",
               f"{len(bad_coord)} stations have out-of-bounds or null coordinates",
               "Ensure every station has in-bounds [lon,lat].")
    check_meta(stations_doc, "A7-stations.geojson", "mock/stations.geojson")

    # --- A6: forecast.json nowIndex / isPast -----------------------------------
    forecast_doc = load_json(MOCK / "forecast.json")
    hourly = forecast_doc.get("hourly") or []
    now_index = forecast_doc.get("nowIndex")
    valid_idx = isinstance(now_index, int) and 0 <= now_index < len(hourly)
    record("A6a", valid_idx, f"nowIndex={now_index!r}, len(hourly)={len(hourly)}")
    if not valid_idx:
        defect("mock/forecast.json", "A5-DATA",
               f"nowIndex={now_index!r} is not a valid index into hourly (len={len(hourly)})",
               "nowIndex must satisfy 0 <= nowIndex < len(hourly).")

    near_now = False
    now_hour_detail = "n/a"
    if valid_idx:
        try:
            now_dt = datetime.fromisoformat(hourly[now_index]["time"])
            real_now = datetime.now(JST)
            diff_hours = abs((now_dt - real_now).total_seconds()) / 3600.0
            near_now = diff_hours <= 2.0
            now_hour_detail = f"hourly[nowIndex].time={hourly[now_index]['time']}, real now={real_now.isoformat()}, diff={diff_hours:.1f}h"
        except Exception as exc:
            now_hour_detail = f"could not parse: {exc}"
    record("A6b", near_now, f"hourly[nowIndex] near current Tokyo hour: {now_hour_detail}",
           warn=not valid_idx)
    if valid_idx and not near_now:
        defect("mock/forecast.json", "A5-DATA",
               f"hourly[nowIndex] is not near the real current Tokyo hour ({now_hour_detail})",
               "Regenerate forecast.json so nowIndex points at the current Tokyo hour.")

    ispast_bad = []
    if valid_idx:
        for i, h in enumerate(hourly):
            expect = i < now_index
            if bool(h.get("isPast")) != expect:
                ispast_bad.append((i, h.get("time"), h.get("isPast"), expect))
    record("A6c", not ispast_bad,
           f"{len(hourly)} hours checked for isPast split at nowIndex, {len(ispast_bad)} wrong"
           + (f" — e.g. {ispast_bad[0]}" if ispast_bad else ""), warn=not valid_idx)
    if ispast_bad:
        defect("mock/forecast.json", "A5-DATA",
               f"{len(ispast_bad)} hours have isPast inconsistent with nowIndex split",
               "isPast must be true for index < nowIndex and false for index >= nowIndex.")
    check_meta(forecast_doc, "A7-forecast.json", "mock/forecast.json")

    # --- A7: every other mock file has valid meta ------------------------------
    other_files = ["brief.json", "sandboxes.json", "layers.json"]
    impact_dir = MOCK / "impact"
    impact_files = sorted(p.name for p in impact_dir.glob("*.json")) if impact_dir.is_dir() else []
    for name in other_files:
        p = MOCK / name
        if not p.is_file():
            record(f"A7-{name}", False, f"mock/{name} does not exist")
            defect(f"mock/{name}", "A5-DATA", "file missing", f"Create mock/{name} per contracts/api.md.")
            continue
        check_meta(load_json(p), f"A7-{name}", f"mock/{name}")
    for name in impact_files:
        p = impact_dir / name
        check_meta(load_json(p), f"A7-impact/{name}", f"mock/impact/{name}")

    return ctx


# ═══════════════════════════════ PART B — live API ═════════════════════════════

def http_get(client: httpx.Client, path: str, **kw) -> httpx.Response | None:
    try:
        return client.get(path, **kw)
    except httpx.HTTPError as exc:
        print(f"    (request error on {path}: {exc})")
        return None


def part_b(ctx: dict[str, Any], event_validator: Draft7Validator) -> None:
    print("\n" + "=" * 70)
    print("PART B — live API at " + API_BASE)
    print("=" * 70)

    try:
        with httpx.Client(base_url=API_BASE, timeout=3.0) as client:
            r = client.get("/health")
            up = r.status_code == 200
    except httpx.HTTPError:
        up = False

    if not up:
        print("API NOT UP — skipped (will retry once near the end of the run)")
        for n in range(8, 17):
            skip(f"B{n}", "API not reachable at start of run")
        return {"retry": True}

    timings: dict[str, float] = {}
    endpoints = [
        ("/health", {}), ("/events.json", {}), ("/lines.geojson", {}),
        ("/stations.geojson", {}), ("/forecast.json", {}), ("/brief", {}),
        ("/sandboxes.json", {}), ("/layers.json", {}), ("/impact/Toei-Mita", {}),
    ]

    with httpx.Client(base_url=API_BASE, timeout=10.0) as client:
        # --- B8: every endpoint 200 + valid meta --------------------------------
        all_ok = True
        for path, kw in endpoints:
            t0 = time.monotonic()
            r = http_get(client, path, **kw)
            dt = time.monotonic() - t0
            timings[path] = dt
            ok = bool(r) and r.status_code == 200
            all_ok = all_ok and ok
            detail = f"{path} -> " + (f"HTTP {r.status_code} in {dt*1000:.0f}ms" if r else "no response")
            if not ok:
                print(f"    [B8] FAIL {detail}")
                defect("api/main.py", "A3", f"{path} did not return 200", "Investigate handler / three_tier fallback.")
            else:
                body = r.json()
                check_meta(body, f"B8-{path}", path)
        record("B8", all_ok, "all documented endpoints returned HTTP 200 (see sub-lines above)")

        # --- B9: /events.json validates against Event schema --------------------
        r = http_get(client, "/events.json", params={"window": "7d", "limit": 200})
        live_events = (r.json().get("events") if r else []) or []
        bad = []
        for ev in live_events:
            errs = sorted(event_validator.iter_errors(ev), key=str)
            if errs:
                bad.append((ev.get("id"), errs[0].message))
        record("B9", not bad,
               f"{len(live_events)} live events checked against event.schema.json, {len(bad)} invalid"
               + (f" — e.g. {bad[0]}" if bad else ""))
        if bad:
            defect("api/main.py or api/graph.py", "A3",
                   f"live /events.json emits schema-invalid events, e.g. {bad[0]}",
                   "Ensure graph.fetch_events() output matches contracts/event.schema.json exactly.")

        # --- B10: query params ----------------------------------------------------
        r7 = http_get(client, "/events.json", params={"window": "7d", "limit": 200})
        evs7 = (r7.json().get("events") if r7 else []) or []
        cutoff = (datetime.now(JST) - timedelta(hours=6)).isoformat()
        older = [e for e in evs7 if e.get("time") and e["time"] < cutoff]
        record("B10-window", bool(older),
               f"window=7d returned {len(evs7)} events, {len(older)} older than 6h")
        if not older:
            defect("api/main.py", "A3", "window=7d does not surface events older than 6h",
                   "Check _since_iso()/graph.fetch_events() honours the 7d window.")

        r5 = http_get(client, "/events.json", params={"limit": 5})
        evs5 = (r5.json().get("events") if r5 else []) or []
        record("B10-limit", len(evs5) <= 5, f"limit=5 returned {len(evs5)} events")
        if len(evs5) > 5:
            defect("api/main.py", "A3", f"limit=5 returned {len(evs5)} events", "Clamp result to <= limit.")

        rq = http_get(client, "/events.json", params={"window": "7d", "type": "quake", "limit": 200})
        evsq = (rq.json().get("events") if rq else []) or []
        only_quake = all(e.get("type") == "quake" for e in evsq)
        record("B10-type", only_quake and bool(evsq),
               f"type=quake returned {len(evsq)} events, all type=quake: {only_quake}")
        if not only_quake:
            defect("api/main.py", "A3", "type=quake filter leaks other event types",
                   "Check _csv_list()/_filter_events() type filtering.")

        rs = http_get(client, "/events.json", params={"window": "7d", "severity": "warning", "limit": 200})
        evss = (rs.json().get("events") if rs else []) or []
        no_info = all(e.get("severity") != "info" for e in evss)
        record("B10-severity", no_info,
               f"severity=warning returned {len(evss)} events, none 'info': {no_info}")
        if not no_info:
            defect("api/main.py", "A3", "severity=warning filter still includes 'info' events",
                   "Check _severities_at_least() — it must exclude ranks below the floor.")

        # --- B11: /lines.geojson exactly 20 features -------------------------------
        rl = http_get(client, "/lines.geojson")
        lfeats = (rl.json().get("features") if rl else []) or []
        record("B11", len(lfeats) == 20, f"/lines.geojson returned {len(lfeats)} features (want 20)")
        if len(lfeats) != 20:
            defect("api/main.py", "A3", f"/lines.geojson returned {len(lfeats)} features, contract demands 20 always",
                   "_line_features() must emit all contracts/lines.csv rows regardless of feed state.")

        # --- B12: /impact/{lineId} ---------------------------------------------------
        ri = http_get(client, "/impact/Toei-Mita")
        ibody = ri.json() if ri else {}
        wards_ok = bool(ibody.get("wards"))
        stations_ok = bool(ibody.get("stations"))
        sifz = ibody.get("stationsInFloodZone")
        sifz_ok = isinstance(sifz, int) and not isinstance(sifz, bool)
        record("B12a", wards_ok and stations_ok and sifz_ok,
               f"/impact/Toei-Mita: wards={len(ibody.get('wards') or [])}, "
               f"stations={len(ibody.get('stations') or [])}, stationsInFloodZone={sifz!r}")
        if not (wards_ok and stations_ok and sifz_ok):
            defect("api/main.py", "A3", "/impact/Toei-Mita missing non-empty wards/stations or integer stationsInFloodZone",
                   "Check graph.fetch_impact() / mock fallback for Toei-Mita.")

        r404 = http_get(client, "/impact/NOPE-123")
        body_ok = False
        if r404 is not None and r404.status_code == 404:
            try:
                b = r404.json()
                body_ok = b.get("error") == "unknown lineId" and b.get("lineId") == "NOPE-123"
            except Exception:
                body_ok = False
        record("B12b", bool(r404 is not None and r404.status_code == 404 and body_ok),
               f"/impact/NOPE-123 -> HTTP {r404.status_code if r404 else 'none'}, "
               f"body={r404.json() if r404 else None}")
        if not (r404 is not None and r404.status_code == 404 and body_ok):
            defect("api/main.py", "A3", "/impact/NOPE-123 does not return documented 404 body",
                   'Return exactly {"error":"unknown lineId","lineId":"<id>"} with HTTP 404.')

        # --- B13: /brief --------------------------------------------------------------
        rb = http_get(client, "/brief")
        bbody = rb.json() if rb else {}
        brief_ok = bool(bbody.get("en")) and bool(bbody.get("ja")) and bool(bbody.get("providerLabel"))
        record("B13", brief_ok,
               f"/brief en={bool(bbody.get('en'))} ja={bool(bbody.get('ja'))} "
               f"providerLabel={bbody.get('providerLabel')!r}")
        if not brief_ok:
            defect("api/brief.py", "A3", "/brief missing en/ja/providerLabel", "Ensure build_brief() always fills all three.")

        # --- B14: CORS ------------------------------------------------------------------
        rc = http_get(client, "/events.json", headers={"Origin": "http://localhost:5173"})
        cors_hdr = rc.headers.get("access-control-allow-origin") if rc else None
        record("B14", bool(cors_hdr), f"Origin http://localhost:5173 -> access-control-allow-origin={cors_hdr!r}")
        if not cors_hdr:
            defect("api/main.py", "A3", "No access-control-allow-origin header for http://localhost:5173",
                   "Check CORSMiddleware allow_origins/allow_origin_regex configuration.")

        # --- B16: response times ---------------------------------------------------------
        slow = {p: dt for p, dt in timings.items() if dt >= 3.0}
        slowest = max(timings.items(), key=lambda kv: kv[1]) if timings else ("n/a", 0.0)
        record("B16", not slow,
               f"slowest endpoint: {slowest[0]} ({slowest[1]*1000:.0f}ms); "
               f"{len(slow)} endpoint(s) >= 3s")
        if slow:
            for p, dt in slow.items():
                defect("api/main.py or api/graph.py", "A3", f"{p} took {dt:.1f}s (>= 3s)",
                       "Profile the slow tier-1 call; add/shorten a timeout so it falls back faster.")

    # --- B15: degradation guarantee (own process on :8001) --------------------------
    part_b15(ctx)


def part_b15(ctx: dict[str, Any]) -> None:
    print("\n--- B15: degradation guarantee (dead Neo4j, API on :8001) ---")
    env = dict(os.environ)
    env["NEO4J_URI"] = "bolt://localhost:9999"
    env["API_PORT"] = "8001"
    env["API_HOST"] = "127.0.0.1"
    py = str(ROOT / ".venv" / "Scripts" / "python.exe")
    proc = None
    try:
        proc = subprocess.Popen(
            [py, str(ROOT / "scripts" / "run_api.py")],
            cwd=str(ROOT), env=env,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        base = "http://127.0.0.1:8001"
        up = False
        with httpx.Client(timeout=2.0) as client:
            for _ in range(20):
                try:
                    r = client.get(base + "/health")
                    if r.status_code == 200:
                        up = True
                        break
                except httpx.HTTPError:
                    pass
                time.sleep(1.0)
        if not up:
            record("B15", False, "could not bring up a degraded API instance on :8001 in time")
            defect("scripts/run_api.py", "A3", "API did not start within 20s on an alternate port",
                   "Verify run_api.py honours API_PORT/API_HOST and starts promptly even with a dead Neo4j URI.")
            return

        endpoints = ["/health", "/events.json", "/lines.geojson", "/stations.geojson",
                     "/forecast.json", "/brief", "/sandboxes.json", "/layers.json",
                     "/impact/Toei-Mita"]
        # Endpoints whose tier-1 source IS the graph: these must show degraded=true
        # when Neo4j is dead. forecast.json (Open-Meteo) and sandboxes.json
        # (ingest/state file) do not depend on Neo4j at all, so their own
        # degraded flag is independent of graph health — we only require they
        # still return 200 and never 500.
        graph_dependent = {"/health", "/events.json", "/lines.geojson", "/stations.geojson",
                           "/brief", "/layers.json", "/impact/Toei-Mita"}
        no_500 = True
        degraded_ok = True
        rows = []
        with httpx.Client(timeout=5.0) as client:
            for ep in endpoints:
                try:
                    r = client.get(base + ep)
                    code = r.status_code
                    body = r.json() if code < 500 else {}
                except Exception as exc:
                    code, body = None, {}
                    rows.append((ep, f"EXC:{exc}", None))
                    no_500 = False
                    continue
                if code >= 500:
                    no_500 = False
                degraded = (body.get("meta") or {}).get("degraded") if isinstance(body, dict) else None
                rows.append((ep, code, degraded))
                if ep in graph_dependent and degraded is not True:
                    degraded_ok = False
        for ep, code, degraded in rows:
            print(f"    {ep} -> HTTP {code}, meta.degraded={degraded}"
                  + ("" if ep in graph_dependent else "  (not graph-sourced; degraded flag independent)"))
        record("B15-no500", no_500, "no endpoint returned HTTP >= 500 with Neo4j unreachable")
        if not no_500:
            defect("api/main.py", "A3", "an endpoint returned 5xx (or errored) with Neo4j down",
                   "Wrap the failing handler in @safe_endpoint / three_tier so it degrades instead of 500ing.")
        record("B15-degraded", degraded_ok,
               "all graph-dependent endpoints (" + ", ".join(sorted(graph_dependent)) +
               ") report meta.degraded=true with Neo4j unreachable")
        if not degraded_ok:
            bad_eps = [ep for ep, code, degraded in rows if ep in graph_dependent and degraded is not True]
            defect("api/main.py", "A3", f"endpoints not reporting degraded=true with Neo4j down: {bad_eps}",
                   "Ensure three_tier() tier-2/3 fallback always sets degraded=true.")
    finally:
        if proc is not None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=5)
            print("    (killed degraded API instance on :8001)")


def part_b_retry(event_validator: Draft7Validator) -> None:
    print("\n--- retrying live API near end of run ---")
    try:
        with httpx.Client(base_url=API_BASE, timeout=3.0) as client:
            r = client.get("/health")
            up = r.status_code == 200
    except httpx.HTTPError:
        up = False
    if not up:
        print("API still not reachable — part B checks remain SKIP.")
        return
    print("API came up on retry — re-running part B.")
    part_b({}, event_validator)


# ═══════════════════════════════ PART C — UI contract cross-check ═════════════

def part_c() -> None:
    print("\n" + "=" * 70)
    print("PART C — UI contract cross-check (static reading)")
    print("=" * 70)

    exports = {
        "AlertBanner": "web/src/panels/AlertBanner.tsx",
        "Timeline": "web/src/panels/Timeline.tsx",
        "LayerPanel": "web/src/panels/LayerPanel.tsx",
        "LineSearch": "web/src/panels/LineSearch.tsx",
        "ForecastStrip": "web/src/panels/ForecastStrip.tsx",
        "BriefCard": "web/src/panels/BriefCard.tsx",
        "ImpactPanel": "web/src/panels/ImpactPanel.tsx",
        "StatusBar": "web/src/panels/StatusBar.tsx",
    }
    all_ok = True
    for name, relpath in exports.items():
        p = ROOT / relpath
        if not p.is_file():
            all_ok = False
            record(f"C17-{name}", False, f"{relpath} does not exist")
            defect(relpath, "A1b", f"file missing, expected to export {name}",
                   f"Create {relpath} exporting function {name} per contracts/ui-contract.md.")
            continue
        text = p.read_text(encoding="utf-8")
        found = bool(re.search(rf"export\s+function\s+{name}\s*\(", text)) or \
            bool(re.search(rf"export\s+const\s+{name}\s*[:=]", text))
        all_ok = all_ok and found
        record(f"C17-{name}", found, f"{relpath} exports {name}: {found}")
        if not found:
            defect(relpath, "A1b", f"does not export '{name}' with the exact contract name",
                   f"Export function {name} per contracts/ui-contract.md §A1b exports.")
    record("C17", all_ok, "all 8 panel components export their exact contract name (see sub-lines above)")

    types_path = ROOT / "web" / "src" / "lib" / "types.ts"
    required_types = ["Severity", "EventType", "LineStatus", "SourceKind", "Meta", "PulseEvent",
                       "LineProps", "ForecastHour", "Forecast", "Brief", "SandboxInfo",
                       "LayerState", "Impact", "TimeWindow", "Lang"]
    if not types_path.is_file():
        record("C18", False, "web/src/lib/types.ts does not exist")
        defect("web/src/lib/types.ts", "A1a", "file missing",
               "Create types.ts with every interface/type from contracts/ui-contract.md.")
    else:
        text = types_path.read_text(encoding="utf-8")
        missing = [t for t in required_types
                  if not re.search(rf"\b(?:export\s+)?(?:interface|type)\s+{t}\b", text)]
        record("C18", not missing,
               f"{len(required_types)} contract types checked, missing: {missing or 'none'}")
        if missing:
            defect("web/src/lib/types.ts", "A1a", f"missing type(s): {missing}",
                   "Add the missing interface/type declarations exactly as in contracts/ui-contract.md.")


# ═══════════════════════════════ main / report ═════════════════════════════════

def main() -> int:
    event_schema = load_json(CONTRACTS / "event.schema.json")
    event_validator = Draft7Validator(event_schema, format_checker=FormatChecker())

    ctx = part_a()
    b_state = part_b(ctx, event_validator)
    if isinstance(b_state, dict) and b_state.get("retry"):
        part_b_retry(event_validator)
    part_c()

    print("\n" + "=" * 70)
    print("SUMMARY")
    print("=" * 70)
    counts = {"PASS": 0, "FAIL": 0, "WARN": 0, "SKIP": 0}
    for _id, status, _msg in RESULTS:
        counts[status] += 1
    for status in ("PASS", "WARN", "SKIP", "FAIL"):
        print(f"  {status}: {counts[status]}")
    fails = [r for r in RESULTS if r[1] == "FAIL"]
    if fails:
        print("\nFAILED CHECKS:")
        for check_id, _status, msg in fails:
            print(f"  - {check_id}: {msg}")

    if DEFECTS:
        print("\nDEFECTS:")
        for d in DEFECTS:
            print(f"  - [{d['owner']}] {d['file']}: {d['what']} -> FIX: {d['fix']}")

    return 1 if fails else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        traceback.print_exc()
        sys.exit(2)
