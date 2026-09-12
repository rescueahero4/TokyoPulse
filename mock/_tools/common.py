"""Shared helpers for mock/_tools scripts. A5-DATA owns mock/**."""
import json
import datetime
import os

JST = datetime.timezone(datetime.timedelta(hours=9))
MOCK_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def now_jst():
    return datetime.datetime.now(JST)


def iso(dt=None):
    dt = dt or now_jst()
    return dt.isoformat(timespec="seconds")


def meta(source="mock", degraded=False, note=None, generated_at=None):
    return {
        "source": source,
        "generatedAt": generated_at or iso(),
        "degraded": degraded,
        "note": note,
    }


def write_json(relpath, obj):
    path = os.path.join(MOCK_DIR, relpath)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
    print(f"wrote {path} ({os.path.getsize(path)} bytes)")


def read_lines_csv():
    import csv
    path = os.path.join(os.path.dirname(MOCK_DIR), "contracts", "lines.csv")
    with open(path, encoding="utf-8") as f:
        return list(csv.DictReader(f))


def read_wards_csv():
    import csv
    path = os.path.join(os.path.dirname(MOCK_DIR), "contracts", "wards.csv")
    with open(path, encoding="utf-8") as f:
        return list(csv.DictReader(f))
