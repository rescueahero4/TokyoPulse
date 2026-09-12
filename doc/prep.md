# TokyoPulse — Pre-2PM Prep: what the swarm cannot do for itself

Ordered by lead time. Everything in §1 is human-only; everything in §5 should be handed to an agent instead of done by hand.

---

## 1. Accounts & keys (human-only — agents cannot sign up, pass OAuth, or accept licence terms)

| # | What | Where | Vars it fills | Blocking? | Lead time |
|---|---|---|---|---|---|
| 1 | **ODPT developer token** | developer.odpt.org | `ODPT_ACCESS_TOKEN` | No — buses only | **Days (manual approval)** → apply first or cut the bus layer |
| 2 | **Neo4j Aura Free** | console.neo4j.io | `NEO4J_URI/USERNAME/PASSWORD` | **Yes** | 5–10 min provisioning; password shown **once** |
| 3 | **Daytona API key** | app.daytona.io → Keys | `DAYTONA_API_KEY` | **Yes** | Minutes |
| 4 | **Anthropic API key** | console.anthropic.com | `ANTHROPIC_API_KEY` | **Yes** (it *is* the fallback) | Minutes |
| 5 | **Nosana** wallet + deployed inference job | nosana.io | `NOSANA_BASE_URL/MODEL` | No — ladder #1 | **Longest.** Needs SOL/NOS funding + a job that stays up. Do this the night before, not at 1:30 PM. |
| 6 | **Cesium ion token** (optional) | ion.cesium.com | `VITE_CESIUM_ION_TOKEN` | No | Minutes |

Then: `cp .env.example .env` and `cp web/.env.example web/.env.local`, fill both, and **verify each one before 2:00 PM** with §4.

## 2. The secret-flow rule the swarm must obey

Three destinations, one direction each — state this in every agent prompt:

```
.env  (root, gitignored)
  ├─→ /api            reads directly (FastAPI process)
  ├─→ /ingest         launcher reads, then FORWARDS a whitelist into each Daytona
  │                   sandbox via env_vars at create() — the sandbox never sees the file
  └─✗  /web           NEVER. Browser code reaches Neo4j/LLMs only through /api.

web/.env.local → VITE_* only → compiled into the public bundle.
```

Whitelist forwarded into ingest sandboxes: `NEO4J_URI`, `NEO4J_USERNAME`, `NEO4J_PASSWORD`, `NEO4J_DATABASE`, `FEED_*`, `INGEST_POLL_SECONDS`. Nothing else — a sandbox that dies with your Anthropic key in it is a bad demo story.

## 3. Static data & join keys (human-gated, highest hidden risk)

- [ ] **国土数値情報 rail GeoJSON** (N02) — download form + terms acceptance. → `mock/lines.raw.geojson`
- [ ] **Station passenger counts** (S12) — same portal. → `mock/ridership.csv`
- [ ] **MLIT 人流オープンデータ 1km mesh**, Tokyo extract — registration required. → `mock/peopleflow.geojson`
- [ ] **PLATEAU 3D Tiles URL**, verified rendering in a throwaway Cesium scene *before* the window
- [ ] **`contracts/line-map.csv`** ← **the single highest-risk artifact in this build.** Three naming systems must join: ODPT `odpt.Railway` URNs (`odpt.Railway:JR-East.ChuoRapid`), your internal `lineId` (`JR-Chuo`), and the N02 GeoJSON `N02_003` Japanese line name (`中央線`). ~15 major lines, hand-checked. If this CSV is wrong, A2's events never colour A1's polylines and the failure looks like "the map is broken" at 1:15 with no time to diagnose.

## 4. Five smoke tests — run all of them before 2:00 PM

Each is one command and each maps to a failure that would otherwise surface mid-demo.

1. `python -c "from daytona import Daytona; s=Daytona().create(); print(s.process.exec('echo ok').result); s.delete()"` — key + quota + region real.
2. Cypher `RETURN 1` over `neo4j+s://` — Aura awake and TLS fine from your network.
3. `curl` each of the four keyless feeds → save the response into `mock/`. A feed that 403s from Japan-only IPs must be found now.
4. One `/v1/chat/completions` POST to `NOSANA_BASE_URL` — proves the job is alive and gives you the exact model string.
5. Open GSI + flood tiles in a browser tab — confirms no CORS/hotlink block before A1 builds on them.

## 5. Give this to agents, not your prep time

They have the tools and it is not credential work: capturing mock payloads from the keyless feeds, writing the Neo4j seed loader, the repo skeleton under `contracts/ web/ ingest/ api/ mock/`, JSON Schemas for `Event` and `LineFeature`, `demo-runbook.md`, cloning godseye as reference. Reserve your own hands for accounts, licence-gated downloads, `line-map.csv`, and — per swarm rule #4 — **looking at the rendered browser**, which no agent can do for you.

## 6. Before you unfreeze the swarm at 0:00

- [ ] `.env` + `web/.env.local` filled and all 5 smoke tests green
- [ ] `contracts/` written and **frozen** (Event, LineFeature, feeds list, line-map.csv)
- [ ] Neo4j seeded with lines/stations/wards (static seed = allowed prep)
- [ ] `mock/` holds one real payload per feed
- [ ] Git repo init'd; directory ownership assigned A1–A4; branch or worktree per agent
- [ ] A1–A4 prompts drafted: scope, contract, DoD, kill criteria, "do not edit outside your directory"
- [ ] Node 20+, Python 3.11+, Docker installed (Docker = ladder #2, Neo4j-in-a-sandbox)
