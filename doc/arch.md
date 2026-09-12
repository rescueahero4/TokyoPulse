# TokyoPulse — Solutions Architecture (v1)

**Build model:** Fully agentic / agent swarm · **Reference architecture:** [godseye](https://github.com/VrushankPatel/godseye) (CesiumJS + React + Vite, layered live feeds)
**Window:** 120 min hacking · Demo-grade, not production. Every decision optimizes for a working 2-minute live demo.

---

## 1. Architecture Overview

```
┌─────────────────────────── DATA PLANE ────────────────────────────┐
│ LIVE FEEDS (streamed during demo)                                 │
│  ODPT trains   P2PQuake WS+hist   JMA warnings   Open-Meteo       │
│  (keyless)     (keyless)          (keyless)      (keyless)        │
│  [stretch: ODPT GTFS-RT buses — token]                            │
│                                                                   │
│ STATIC DATASETS (pre-downloaded at prep, loaded by seed loader)   │
│  Rail line GeoJSON (国土数値情報) · Station ridership counts       │
│  People-flow 1km mesh (MLIT 人流オープンデータ) · GSI flood tiles   │
│  [stretch: PLATEAU 3D Tiles]                                      │
└───────┬───────────┬───────────────┬────────────────┬──────────────┘
        ▼           ▼               ▼                ▼
        (live feeds only — static path goes straight to A3 seed
         loader → Neo4j/files; no Daytona sandbox needed)
┌──────────────── DAYTONA SANDBOX FAN-OUT (compute plane) ──────────┐
│  ingest-trains   ingest-quakes   ingest-warnings   ingest-weather │
│  · 1 sandbox per feed, launched in parallel (Python SDK)          │
│  · poll/subscribe → normalize → Event{} → write Neo4j             │
│  · each sandbox fails independently (godseye principle #2)        │
└──────────────────────────────┬────────────────────────────────────┘
                               ▼
┌───────────────────────── GRAPH PLANE ─────────────────────────────┐
│  Neo4j Aura Free                                                  │
│  Static seed (pre-2PM): (Line)-[:SERVES]->(Station)-[:IN]->(Ward) │
│  Live: (Event{type,severity,time,lat,lon,title})-[:AFFECTS]->     │
│        (Line|Ward)                                                │
└──────────────────────────────┬────────────────────────────────────┘
                               ▼
┌───────────────────────── API PLANE ───────────────────────────────┐
│  FastAPI (single file)                                            │
│  GET /events.json      · timeline + alerts (one Cypher, 2 views)  │
│  GET /lines.geojson    · rail geometry + live status color        │
│  GET /impact/{lineId}  · affected wards / stations-in-flood-zones │
│  GET /brief            · Nosana LLM JP/EN summary of timeline     │
│  GET /forecast.json    · cached Open-Meteo past48h+next48h        │
└──────────────────────────────┬────────────────────────────────────┘
                               ▼
┌──────────────────────── PRESENTATION PLANE ───────────────────────┐
│  Vite + React + CesiumJS  (godseye layout: map + HUD side panels) │
│  · Imagery: GSI std tiles (keyless) → OSM fallback                │
│  · Overlay: GSI flood-hazard ImageryLayer (alpha 0.55, toggleable)│
│  · Rail: GeoJsonDataSource polylines, color = status              │
│  · Quakes: PointPrimitives + pulse; camera.flyTo on timeline click│
│  · [stretch] PLATEAU 3D Tiles (Cesium3DTileset) — prep-gated      │
│  · [stretch] Bus entities from GTFS-RT                            │
│  · Crowd: station markers sized by ridership (static) +           │
│    people-flow heatmap layer (MLIT 1km mesh, pre-downloaded,      │
│    labeled "typical pattern") — toggleable                        │
│  · UI: LayerPanel · LineSearch · Timeline · AlertBanner ·         │
│        ForecastStrip · BriefCard · "⚡ N Daytona sandboxes" badge  │
└───────────────────────────────────────────────────────────────────┘
```

## 2. Godseye Principles Inherited

| # | Godseye lesson | TokyoPulse application |
|---|---|---|
| 1 | Live feeds = instant wow | All 4 core feeds are real-time & keyless |
| 2 | Each layer fails independently | Per-feed sandbox + per-layer try/catch in FE; a dead feed greys its layer, never crashes |
| 3 | Keyless feeds, zero setup | ODPT mirror, P2PQuake, JMA, Open-Meteo, GSI — no auth on the critical path |
| 4 | Strong visual metaphor (globe+HUD) | Cesium camera over Tokyo + tactical side-panel HUD |
| — | Gap we exploit | godseye has no backend/DB/AI → our Daytona + Neo4j + Nosana planes are the differentiators |

## 3. Data Contracts (the swarm coordination mechanism)

Agents integrate through TWO frozen JSON shapes. Define first, never change after 0:15.

```jsonc
// Event — written by ingestors, read by timeline/alerts/brief
{
  "id": "p2p-20260912-0001",
  "type": "quake | train | warning | weather",
  "severity": "info | warning | critical",
  "time": "2026-09-12T14:32:00+09:00",
  "lat": 35.68, "lon": 139.76,          // nullable for area-wide
  "title": "Chuo Line: delays ~15min",
  "titleJa": "中央線 遅延 約15分",
  "affects": ["line:JR-Chuo", "ward:Shinjuku"],
  "source": "odpt", "url": null
}

// LineFeature — GeoJSON Feature properties
{ "lineId": "JR-Chuo", "name": "Chuo", "nameJa": "中央線",
  "status": "normal | delay | suspended | unknown", "statusText": "…" }
```

## 4. Agent Swarm Design

**Topology:** 1 orchestrator (you + a planning agent) + 4 worker agents, parallel after contract freeze. Hard cap 4 workers — a 5th adds merge conflicts faster than features. Each worker runs in its own Daytona sandbox (meta-story: the product is built by the pattern it demos).

| Agent | Scope (owns exclusively) | Inputs | Definition of Done |
|---|---|---|---|
| **A1 Frontend** | `/web` — Cesium viewer, GSI imagery, LayerPanel, Timeline, AlertBanner, LineSearch, ForecastStrip, BriefCard | Contracts + godseye repo as style/structure reference | Renders full UI against `mock/events.json` + `mock/lines.geojson` |
| **A2 Ingestion** | `/ingest` — 4 sandbox scripts + Daytona launcher | Contracts + endpoint list | Live Event nodes appearing in Neo4j; each script survives its feed being down |
| **A3 Graph+API** | `/api` — Neo4j schema, seed loader, Cypher, FastAPI | Contracts + pre-downloaded rail GeoJSON + line-name mapping CSV | All 5 endpoints return valid payloads (mock-backed until A2 lands) |
| **A4 Polish/Demo** | PLATEAU tileset, bus layer, Nosana brief, pulse animations, demo-runbook.md | Working integration from A1–A3 | Idle until 1:10 integration gate; only then touches code |

**Swarm rules:**
1. **Contract freeze at 0:15.** Any change after = orchestrator decision, broadcast to all agents.
2. **Mock-first.** A1 and A3 develop against checked-in mock payloads; A2 swaps mocks for live. Integration is a data swap, not a code merge.
3. **Directory ownership = merge safety.** No agent edits outside its directory; shared `contracts/` is read-only after freeze.
4. **Human attention budget = rendered output.** Agents can't see WebGL bugs (blank canvas, camera in the ocean, invisible polylines). You review the browser, not the diffs.
5. **Kill criteria per agent:** any task >15 min without visible progress → orchestrator reassigns a degraded scope (see fallback ladder).

## 5. Timeline (agentic)

| Clock | Orchestrator | A1 FE | A2 Ingest | A3 Graph/API | A4 Polish |
|---|---|---|---|---|---|
| 0:00–0:15 | Freeze contracts; distribute PRD+arch | Scaffold Vite+Cesium+GSI | Daytona hello-world sandbox | Aura up; seed lines/stations/wards | — |
| 0:15–0:45 | Watch renders | Layers vs mocks | ODPT+JMA ingestors live | /events /lines vs mocks | — |
| 0:45–1:10 | First integration: FE→API real | Timeline+AlertBanner+search | P2PQuake WS + replay; Open-Meteo | /impact /forecast; wire A2 data | — |
| 1:10–1:30 | Gate: e2e or cut (ladder) | Forecast strip; polish | Sandbox-count endpoint | /brief (Nosana) | PLATEAU/bus **only if gate passed** |
| 1:30–1:50 | Demo rehearsal #1 | Fix render bugs | Cache snapshots to disk | — | Pulses; brief card; runbook |
| 1:50–2:00 | Freeze + rehearsal #2 on cache | — | — | — | — |

## 6. Fallback Ladder (pre-agreed degradations)

1. Nosana stalls (15-min box) → Anthropic API for /brief; Nosana → roadmap slide.
2. Neo4j Aura slow → Neo4j Docker **inside a Daytona sandbox** (talking point, not failure).
3. A2 feed dead → FE reads `mock/` snapshots; layer badge shows "cached".
4. PLATEAU not rendering at prep → never attempted live; Cesium flat imagery (godseye mode) is the floor.
5. Bus token unapproved → cut silently.
6. Timeline shaky at 1:30 → AlertBanner only (same query, simpler render).
7. Total API failure → FE runs 100% on mocks; demo still tells the story; disclose honestly if asked.

## 7. Pre-2PM Prep Checklist (outside the window — do all of it)

- [ ] Accounts: Daytona API key · Neo4j Aura free · Nosana · ODPT token (buses) · Cesium ion token (optional, unused if GSI works)
- [ ] Pre-download: 国土数値情報 rail GeoJSON · station passenger counts · MLIT 人流オープンデータ 1km mesh (Tokyo extract) · line-name mapping CSV (~15 major lines) · PLATEAU Tokyo 3D Tiles URL verified rendering in a throwaway Cesium scene
- [ ] Cache snapshots: one good payload per feed into `mock/`
- [ ] Repo skeleton pushed: `contracts/ web/ ingest/ api/ mock/ demo-runbook.md` + godseye cloned locally as agent reference
- [ ] Agent prompts drafted per A1–A4 (scope, contract, DoD, kill criteria)
- [ ] Rehearse the 2-min script once against mocks

## 8. Security & Scope Notes

- No secrets in FE; API keys live only in Daytona sandbox env.
- CORS: API allows the Vite dev origin; demo runs on localhost or a single tunnel.
- Non-goals unchanged from PRD: no auth, no persistence guarantees, no production hardening.