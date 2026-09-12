# TokyoPulse — Shared Agent Brief (read this first, every agent)

## The goal, in one paragraph

We are building **TokyoPulse**, a live Tokyo city-operations map, for a **2-hour hackathon** (Daytona HackSprint Tokyo). It fuses Tokyo's siloed real-time feeds — train delays, earthquakes, government weather warnings, flood hazard, crowding — into **one connected graph with a time dimension** (past 7 days → now → next 48h), and renders it as a Cesium map with a tactical HUD. A resident should be able to answer: *"what's happening around me right now, what happened earlier, and what's coming?"*

**Everything optimizes for a live 2-minute demo at the 2-hour mark.** This is demo-grade code, explicitly NOT production: no auth, no tests beyond the smoke path, no hardening, no persistence guarantees. Read `doc/prd.md` §9 for the demo script and `doc/arch.md` for the architecture. Those two documents are authoritative; where they disagree, `doc/arch.md` wins on stack details (Cesium, not MapLibre).

## The three sponsors must be visibly invoked

- **Daytona** — one sandbox per live feed, launched in parallel. The UI shows a "⚡ N Daytona sandboxes ingesting" badge. The fan-out *is* the story.
- **Neo4j** — the temporal city graph. `(Line)-[:SERVES]->(Station)-[:IN]->(Ward)` static; `(Event)-[:AFFECTS]->(Line|Ward)` live.
- **Nosana** — one LLM call producing a 3-sentence JP/EN city brief from the timeline.

## The single most important design idea

**Everything normalizes into one `Event` shape.** The timeline feed, the alert banner, and the LLM brief are three renderings of *the same* Neo4j query. Build the query once, render it three ways. See `contracts/event.schema.json`.

## The non-negotiable rules

1. **Contracts are frozen.** `contracts/` is READ-ONLY to you. Code to it exactly. If you believe a contract is wrong, do not change it — report `BLOCKED-ON:` in your final message.
2. **Directory ownership is absolute.** See `contracts/OWNERSHIP.md`. Never edit a file outside your rows. Never create a parallel copy of someone else's file.
3. **Every layer fails independently.** A dead feed greys its own layer and nothing else. Never let one failure blank the screen. Never raise an unhandled exception on a data path; never return HTTP 500 for a dead upstream — return the cached payload with `meta.degraded = true`.
4. **Mock-first.** `mock/` holds a valid payload for every endpoint. The frontend and API develop against mocks; live data is swapped in behind unchanged response shapes. A live swap must never require a UI change.
5. **Honest labelling.** Cached data says "cached". Replayed data says "replay". A line with no live status feed is `status: "unknown"` and renders grey — never a faked "normal". The historical people-flow heatmap is labelled "typical pattern". We do not claim live-ness we do not have.
6. **Kill criteria.** If any single task burns >15 minutes with no visible progress, stop, degrade it to the simplest thing that renders, and report it. Shipping a degraded layer beats shipping nothing.
7. **No secrets in the frontend, ever.** `.env` is read by `/api` and `/ingest` only. The browser reaches Neo4j and any LLM strictly through `/api`. `web/.env.local` holds `VITE_*` public values only.

## Verified environment facts (established by the orchestrator — trust these, do not re-litigate)

| Fact | Detail |
|---|---|
| Project root | `C:\Users\rbaga\Code\daytona-neo4j-ai-builders-hackathon\TokyoPulse` |
| Python | `.venv\Scripts\python.exe` at the project root. Already has `neo4j fastapi uvicorn httpx websockets python-dotenv daytona`. Use this interpreter, do not create another venv. |
| Node | v24.11.1, npm 11.6.2 |
| Shell | Windows. A Bash tool (Git Bash) and PowerShell are both available. **Japanese text gets mangled when passed as a shell argument** — write it to a UTF-8 file instead. Set `PYTHONIOENCODING=utf-8` before printing Japanese from Python. |
| **ODPT trap** | `https://api-public.odpt.org/api/v4/odpt:TrainInformation` works (200). Appending **`.json` returns a dead Azure blob redirect** — the PRD's URL is wrong. Use the extension-less path. |
| **ODPT coverage** | The keyless mirror exposes **Toei only**: 6 lines, 149 stations. There is NO JR-East and NO Tokyo Metro live status. `ODPT_ACCESS_TOKEN` is empty, so buses are CUT. |
| ODPT bonus | `odpt:Railway` gives `odpt:stationOrder`; `odpt:Station` gives `geo:lat`/`geo:long` for all 149 stations. Together these build real rail polyline geometry with **no licence-gated download** — this replaces the 国土数値情報 N02 file and removes the build's highest-risk prep artifact. |
| Other feeds | P2PQuake history, JMA warnings (Tokyo 130000), Open-Meteo, GSI std/pale/flood tiles, Overpass — all verified reachable. Exact URLs in `contracts/feeds.json`. |
| **Neo4j status** | **Aura rejects the password (AuthError) — escalated to the human.** A local Neo4j is being started in Docker. Until a database is reachable, **work mock-backed**. Read connection details from `.env` at runtime; never hardcode a URI, host, or password. |
| Aura gotcha | If Aura comes back: the username is `neo4j` and the database is `neo4j`, NOT the instance id that the downloaded credentials file suggests. |
| LLM keys | `ANTHROPIC_API_KEY` is **empty** and the `NOSANA_*` vars are **empty**. `/brief` must therefore ship a deterministic rule-based `provider:"template"` summary that always renders. Wire the LLM path behind an env check so a key appearing later needs no code change. |
| Time zone | Everything is `Asia/Tokyo (+09:00)`. Never emit a naive timestamp. |

## Definition of done, universally

Your work is done when **it runs and someone can see it** — not when the code looks complete. Before you report success: start the thing, hit the endpoint, render the page, and paste the actual output you observed. "Should work" is not done.

## Your final message to the orchestrator

Keep it under 25 lines and use exactly these headings:

```
DONE: <what now runs, with the observed evidence — real output, not a claim>
FILES: <paths you created or changed>
VERIFY: <the exact command the orchestrator can run to see it work>
DEGRADED: <anything you simplified, and what it cost>
BLOCKED-ON: <path or external thing you need, or "none">
```
