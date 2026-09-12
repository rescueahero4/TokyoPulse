"""TokyoPulse API package (owner: A3).

Public surface other agents may import:

    from api.graph import upsert_events   # A2 (ingestors) write path
    from api.graph import neo4j_status    # liveness probe

Nothing in here ever raises on a data path: see api/envelope.py.
"""
