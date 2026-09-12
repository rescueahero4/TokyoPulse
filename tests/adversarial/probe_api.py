"""QA-ADVERSARIAL: API edge-case sweep. Read-only (except the /demo/replay beat,
which the demo itself uses). Run:
  .venv\\Scripts\\python.exe tests\\adversarial\\probe_api.py
"""
from __future__ import annotations
import json, sys, time, urllib.request, urllib.error

BASE = "http://localhost:8000"

def get(path, method="GET", body=None, timeout=30):
    url = BASE + path
    data = None
    headers = {}
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            ms = (time.time() - t0) * 1000
            return r.status, raw, ms
    except urllib.error.HTTPError as e:
        raw = e.read()
        return e.code, raw, (time.time() - t0) * 1000
    except Exception as e:
        return -1, repr(e).encode(), (time.time() - t0) * 1000

CASES = [
    ("/health", None, None),
    ("/events.json", None, None),
    ("/events.json?window=7d", None, None),
    ("/events.json?window=7d&limit=200", None, None),
    ("/events.json?limit=0", None, None),
    ("/events.json?limit=-5", None, None),
    ("/events.json?limit=99999", None, None),
    ("/events.json?limit=abc", None, None),
    ("/events.json?type=bogus", None, None),
    ("/events.json?type=quake,train,warning,weather", None, None),
    ("/events.json?severity=critical", None, None),
    ("/events.json?severity=NONSENSE", None, None),
    ("/events.json?window=99d", None, None),
    ("/events.json?since=not-a-date", None, None),
    ("/events.json?since=2026-09-12T00:00:00%2B09:00", None, None),
    ("/lines.geojson", None, None),
    ("/stations.geojson", None, None),
    ("/forecast.json", None, None),
    ("/brief", None, None),
    ("/sandboxes.json", None, None),
    ("/layers.json", None, None),
    ("/impact/Toei-Mita", None, None),
    ("/impact/JR-Chuo", None, None),
    ("/impact/NOPE", None, None),
    ("/impact/%20", None, None),
    ("/impact/..%2F..%2Fetc", None, None),
    ("/impact/<script>alert(1)</script>", None, None),
]

def main():
    out = []
    for path, method, body in CASES:
        st, raw, ms = get(path, method or "GET", body)
        try:
            j = json.loads(raw)
            if isinstance(j, dict):
                keys = sorted(j.keys())
                m = j.get("meta") or {}
                n = len(j.get("events") or j.get("features") or j.get("layers") or [])
                summary = f"keys={keys} n={n} meta.source={m.get('source')} degraded={m.get('degraded')} note={m.get('note')!r}"
            else:
                summary = f"(list len {len(j)})"
        except Exception:
            summary = "NON-JSON: " + raw[:200].decode("utf-8", "replace")
        line = f"{st:>4} {ms:8.1f}ms  {path}\n      {summary}"
        print(line)
        out.append(line)
    print()
    print("=== perf: repeat hot paths 3x ===")
    for p in ("/events.json", "/lines.geojson", "/stations.geojson", "/impact/Toei-Mita", "/brief"):
        times = []
        size = 0
        for _ in range(3):
            st, raw, ms = get(p)
            times.append(ms); size = len(raw)
        print(f"  {p:24} {size/1024:9.1f} KiB  " + " ".join(f"{t:7.1f}ms" for t in times))

if __name__ == "__main__":
    sys.exit(main())
