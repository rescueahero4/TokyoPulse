"""Start the TokyoPulse API (owner: A3).

    .venv\\Scripts\\python.exe scripts\\run_api.py

Equivalent one-liner:
    .venv\\Scripts\\python.exe -m uvicorn api.main:app --host 0.0.0.0 --port 8000

Host/port come from .env (API_HOST, API_PORT); CORS from CORS_ORIGINS.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
os.chdir(ROOT)

from dotenv import load_dotenv                                  # noqa: E402

load_dotenv(ROOT / ".env")


def main() -> int:
    import uvicorn
    host = os.getenv("API_HOST") or "0.0.0.0"
    try:
        port = int(os.getenv("API_PORT") or 8000)
    except ValueError:
        port = 8000
    print(f"TokyoPulse API -> http://{host}:{port}  (docs at /docs)")
    uvicorn.run("api.main:app", host=host, port=port, reload=False,
                log_level=os.getenv("LOG_LEVEL", "info").lower())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
