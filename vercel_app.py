"""Vercel entrypoint: serves the API under /api.

Mounting also keeps api.main's startup hook from firing. That hook starts the
cache-warming threads, which only make sense in a long-lived process; here the
cache fills on demand.
"""

from fastapi import FastAPI

from api.main import app as api_app

app = FastAPI(title="TokyoPulse", docs_url=None, redoc_url=None, openapi_url=None)
app.mount("/api", api_app)
