"""QA-ADVERSARIAL: run a SECOND copy of the API on port 8002 pointed at a DEAD
Neo4j, to verify arch.md section 6 rung 3/7 (feed dead -> mock/ snapshots,
layer badge 'cached') without touching the live :8000 server.
Kill only this process.
"""
import os, sys, pathlib
ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
os.environ["NEO4J_URI"] = "bolt://127.0.0.1:9999"      # nothing listens here
os.environ["NEO4J_USERNAME"] = "dead"
os.environ["NEO4J_PASSWORD"] = "dead"
os.environ["NEO4J_DATABASE"] = "dead"
os.environ["ANTHROPIC_API_KEY"] = ""                    # force template brief
os.environ["NOSANA_BASE_URL"] = ""
import uvicorn
from api.main import app
uvicorn.run(app, host="127.0.0.1", port=8002, log_level="warning")
