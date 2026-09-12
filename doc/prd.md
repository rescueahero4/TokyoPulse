# PRD — TokyoPulse: Live City Operations Map (v2)

**Event:** Daytona HackSprint Tokyo · **Build window:** 2:00–4:00 PM (120 min) · **Demo:** 2 min live
**Type:** Hackathon MVP — demo-grade, not production. Everything optimizes for the live demo.
**v2 additions:** event timeline feed, historical + forecast view, train/government alerts.

---

## 1. Problem

Tokyo's real-time state — train delays, earthquakes, weather warnings, flood risk, crowding — lives in separate silos. Residents can't answer "what's happening around me right now, what happened earlier, and what's coming?" City administrators lack a single connected view of a district.

**Validation:** Cabinet Office projects up to 298K deaths in a Nankai Trough quake with low household preparedness (NHK survey); 32% of visitors cite congestion as their top problem (JNTO 2024); INRIX quantifies congestion cost; JMA/rail delay data confirm daily disruption.

## 2. Users

- **Primary (demo persona):** Tokyo resident/commuter — "should I take the Chuo line, is anything hazardous near me, and what does the next 24h look like?"
- **Secondary (pitch only):** Ward-level city administrator — district visibility + incident timeline for shift handovers.

## 3. Goals / Non-Goals

**Goals (must ship by 4:00 PM):**
1. **Map** of Tokyo with live layers: **train lines drawn as colored polylines** (green=normal, amber=delay, red=suspended, from ODPT status), earthquakes, weather warnings, flood-hazard overlay.
2. **Line search** — type a line name (e.g., "Chuo") → highlight the line, dim others, show its status + affected stations.
3. **Layer control panel** — show/hide checkboxes per layer (trains, buses, quakes, warnings, flood) so users can isolate or combine data.
4. **Crowd layer** — station markers sized by ridership (static, 5-min build) + toggleable historical people-flow heatmap (MLIT 1km mesh, pre-downloaded). Honestly labeled "typical pattern"; real-time telco people-flow = roadmap pitch for the city-admin persona.
5. **Buses (stretch layer)** — live Toei bus positions via ODPT GTFS-RT (needs free ODPT token, registered before 2 PM). Timeboxed; cut first if behind.
5. **Event Timeline** — right-side chronological feed of every normalized event (quake, delay, warning), newest first, clickable → flies map to location.
6. **Alerts** — banner + timeline highlight for (a) train line disruptions (ODPT) and (b) government warnings (JMA). Severity color-coded.
7. **History ↔ Now ↔ Forecast** — time toggle: past 7 days of quakes (P2PQuake history) + past/next 48h weather & precipitation (Open-Meteo archive + forecast, keyless).
8. End-to-end pipeline: feeds → Daytona sandboxes → Neo4j → UI.
9. JP/EN city brief (Nosana LLM) summarizing the current timeline.

**Non-Goals:** auth, mobile app, push notifications, routing engine, ML-based prediction (forecast = official JMA/Open-Meteo data only), >4 map layers, admin CRUD, production reliability.

## 4. Judging Criteria Mapping

| Criterion | How we score |
|---|---|
| Completeness | End-to-end pipeline + timeline + fallback caches guarantee a working demo |
| Innovation | City feeds fused into a relationship graph with a time dimension (past→now→forecast) |
| Real-life problem | Every judge commutes here; disaster prep is government-validated pain |
| Sponsor usage | Daytona (parallel ingestors), Neo4j (temporal city graph), Nosana (brief) |

## 5. Architecture

```
[ODPT trains] [P2PQuake WS+history] [JMA warnings] [Open-Meteo hist+forecast] [GSI flood tiles]
      │              │                    │                │                      │(static)
      └────── Daytona: 1 sandbox per feed (parallel fan-out) ──────┐
              normalize → Event {type, severity, time, geo}         │
                              ▼                                     │
                        Neo4j Aura (free)                           │
   (Line)-[:SERVES]->(Station)-[:IN]->(Ward)                        │
   (Event {type,severity,time})-[:AFFECTS]->(Ward|Line)             │
                              ▼                                     │
     Web UI: MapLibre + GSI tiles │ Timeline panel │ Time toggle ◄──┘
                              ▼
        Nosana LLM: JP/EN status brief generated from timeline query
```

**Key design move:** everything is normalized into one `Event` shape. The timeline, the alerts banner, and the LLM brief are all just different renderings of the same Neo4j query — one pipeline, three features.

## 6. Data Sources (all keyless)

| Feature | Endpoint |
|---|---|
| Train status (live + alerts) | `https://api-public.odpt.org/api/v4/odpt:TrainInformation.json` |
| **Rail line geometry (static)** | National Land Numerical Information (国土数値情報) railway GeoJSON — **pre-download before 2 PM**; join to ODPT status by line name for coloring |
| **Crowd — historical people-flow heatmap** | MLIT 全国の人流オープンデータ (G空間情報センター), 1km mesh — **pre-download**; toggleable heatmap, labeled "typical pattern" |
| **Crowd — station ridership weighting** | 国土数値情報 station passenger counts (static, open) — station marker size = ridership |
| **Buses (stretch)** | ODPT `odpt:Bus` real-time / Toei GTFS-RT — requires **free ODPT token** (register before 2 PM; not on the keyless mirror) |
| Quakes (live) | `wss://api.p2pquake.net/v2/ws` (sandbox WS replays for demo) |
| Quakes (history, 7d) | `https://api.p2pquake.net/v2/history?codes=551&limit=100` |
| Gov warnings (alerts) | `https://www.jma.go.jp/bosai/warning/data/warning/130000.json` |
| Weather forecast 48h | `https://api.open-meteo.com/v1/forecast?latitude=35.68&longitude=139.76&hourly=temperature_2m,precipitation` |
| Weather history 48h | Open-Meteo `&past_days=2` on same call |
| Flood hazard overlay | GSI hazard XYZ tiles |
| Base map | `https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png` |

**Cache rule:** every feed gets a saved sample payload before 2:00 PM. UI reads live-first, cache-fallback. History/forecast responses are cached at prep time (they barely change in 2h).

## 7. Sponsor Integration (demo-visible)

- **Daytona:** 5 sandboxes, one per feed, launched in parallel (Python SDK). UI shows "⚡ 5 Daytona sandboxes ingesting" counter. Fan-out is the story — say it in the demo.
- **Neo4j:** Aura free. Static seed (lines/stations/wards) loaded before 2 PM. Live `Event` nodes written during demo. Timeline = `MATCH (e:Event) RETURN e ORDER BY e.time DESC LIMIT 30`. Alert = same query filtered `WHERE e.severity >= 'warning'`. Ward impact = `MATCH (e:Event)-[:AFFECTS]->(w:Ward)<-[:IN]-(s:Station)`.
- **Nosana:** one LLM call: latest 10 timeline events → 3-sentence JP/EN brief. 15-min timebox; fallback to Anthropic API + roadmap mention if setup stalls.

## 8. Build Plan — Milestone-Based, Parallel-Safe (120 min)

The plan is structured as **3 target milestones (M0→M2)** instead of a linear task list, so the agent swarm (A1 FE / A2 Ingest / A3 Graph+API / A4 Polish) can work in parallel and integrate piece-by-piece without blocking each other. Note: Cesium replaced MapLibre per the solutions architecture — that doc is authoritative for stack details.

### M0 — Scaffolding & Contract Freeze (target: 0:15)
**Goal: everything runs, nothing is real.**
- Repo skeleton live: `contracts/ web/ ingest/ api/ mock/`
- Contracts frozen: `Event` + `LineFeature` JSON shapes committed to `contracts/` (read-only after this point)
- A1: Vite + React + Cesium renders GSI tiles over Tokyo (empty map, no data)
- A3: Neo4j Aura connected; static seed loaded (lines/stations/wards/ridership); FastAPI returns **hardcoded mock payloads** for all 5 endpoints
- A2: one Daytona "hello sandbox" executes and prints
- ✅ **Exit check:** `npm run dev` shows a map; `curl /events.json` returns mock JSON. If M0 slips past 0:20, cut buses + PLATEAU immediately.

### M1 — Initial Run With Placeholders (target: 0:45)
**Goal: the full demo is watchable end-to-end on fake data.**
- A1 builds *every* UI element against `mock/`: rail polylines (mock statuses), quake markers, layer panel, timeline, alert banner, line search, forecast strip, brief card (lorem text), sandbox-count badge (hardcoded "5")
- A3 swaps hardcoded returns for real Cypher queries — still fed by **mock Event nodes** it seeds itself
- A2 independently gets ODPT + JMA ingestors writing real Event nodes to Neo4j (invisible to A1 — same schema)
- ✅ **Exit check:** the entire 2-minute demo script can be walked through on placeholder data. This is the guaranteed-demo floor — everything after M1 is upgrade, not construction.

### M2 — Piece-by-Piece Live Integration (0:45 → 1:50)
**Goal: swap placeholders for live data one feed at a time — each swap is independent and reversible.**

| Order | Swap | Owner | Blocks others? |
|---|---|---|---|
| 1 | ODPT trains: mock statuses → live line colors + alerts | A2→A3 | No — A1 unchanged (same /lines.geojson shape) |
| 2 | JMA warnings: mock → live banner/timeline entries | A2→A3 | No |
| 3 | P2PQuake: mock quakes → history + live WS/replay | A2→A3 | No |
| 4 | Open-Meteo: lorem strip → real 48h+48h data | A2→A3 | No |
| 5 | Brief: lorem → Nosana LLM call (15-min timebox) | A3 | No |
| 6 | Sandbox badge: hardcoded → live count endpoint | A2 | No |
| 7 | *(gate 1:10 passed)* PLATEAU tileset / bus dots / pulse animations | A4 | No — additive layers only |

**Integration rules (anti-blocking):**
- A swap = flipping one data source behind an unchanged endpoint. **UI code never changes during integration** — if it has to, the contract was broken, revert the swap.
- Any swap failing >10 min → revert to its mock, mark layer badge "cached," move to the next swap. Live-ness is per-layer, never all-or-nothing (godseye principle #2).
- CI-lite: after every swap, one person runs the 30-second smoke path (load map → click line → check timeline). Never batch two swaps between smoke runs.
- A4 does not touch the repo until the 1:10 gate; before that they prep assets and the demo runbook offline.

### Freeze (1:50–2:00)
- Snapshot all live payloads into `mock/` (fresh cache = tomorrow's fallback)
- Rehearse the demo twice — once live, once forced-offline on cache
- No commits after 1:52 except reverts.

**Checkpoint rules:**
- **M0 late (>0:20):** cut buses + PLATEAU.
- **M1 late (>0:55):** cut time toggle; timeline+alerts stay (same query).
- **1:30, fewer than 3 live swaps done:** stop swapping, polish what's live, rehearse early.
- **Buses are always the first cut** — wow-add, not core.

## 9. Demo Script (2 min)

1. (0:00) "Every person in this room commutes through this map." — populated map + live timeline scrolling.
2. (0:20) P2PQuake replay fires → quake pin drops, **alert banner** flashes, timeline entry appears at top. Click it → map flies to epicenter.
3. (0:50) Click a delayed line → graph panel: affected wards, stations in flood zones. "Neo4j answering what a table can't."
4. (1:15) Flip time toggle → last 7 days of quakes fade in, then 48h precipitation forecast strip. "Past, present, and what's coming — one graph."
5. (1:40) Brief card renders JP/EN summary ("served on Nosana"). Close: "Five Daytona sandboxes, spun up in ~200ms each, feed this in parallel. Resident app today, ward dashboard tomorrow."

## 10. Risks & Fallbacks

| Risk | Mitigation |
|---|---|
| Feed down / rate-limited | Cached payloads; demo runs fully offline |
| No live quake during demo | P2PQuake sandbox WS replay on demand |
| Timeline UI eats the clock | It shares the alerts query — build query once, render twice; cut fly-to animation first |
| Time toggle overruns | Pre-cached history/forecast payloads; render as static chart strip, not interactive scrubber |
| Neo4j Aura slow to provision | Neo4j in Docker inside a Daytona sandbox (bonus talking point) |
| Nosana stalls | 15-min timebox → fallback LLM, Nosana in roadmap |
| Line-name mismatch (GeoJSON ↔ ODPT IDs) | Build the name-mapping table at prep time for ~15 major lines only; unmatched lines render grey |
| ODPT token (buses) not approved in time | Buses were stretch; demo without them, mention as roadmap |

## 11. Success Criteria

- Demo runs start-to-finish, no blank screens.
- Timeline + at least one live alert render during the 2 minutes.
- All 3 (min. 2) sponsors visibly invoked.
- Judges can restate the problem in one sentence.