"""
ingest/sandbox_runner.py — uploaded into each Daytona sandbox in --push mode.

Pure, stdlib-only (no httpx/neo4j/dotenv needed inside the sandbox): takes a
raw feed payload already fetched by the HOST (the only place with egress)
and runs that feed's pure `normalize()` there. This is the real compute that
runs inside Daytona.

Usage inside the sandbox:  python3 sandbox_runner.py <feed_module> <payload.json>
Prints normalized Event[] as JSON on stdout.
"""
import importlib
import json
import sys


def main() -> None:
    modname, path = sys.argv[1], sys.argv[2]
    with open(path, encoding="utf-8") as f:
        raw = json.load(f)
    mod = importlib.import_module(f"ingest.feeds.{modname}")
    events = mod.normalize(raw)
    sys.stdout.write(json.dumps(events, ensure_ascii=False))


if __name__ == "__main__":
    main()
