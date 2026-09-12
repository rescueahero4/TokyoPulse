# TokyoPulse — Adversarial QA Report

Run by QA-ADVERSARIAL against the live stack (`:5173` UI, `:8000` API, Neo4j Aura), driving
PRD §9 beat-by-beat in Chrome plus a 27-case API sweep and a controlled dead-Neo4j API on `:8002`.

**Headline:** the demo does **not** crash — zero uncaught errors across every abuse test — but before
these fixes it **contradicted itself on screen** during beat 3 and **overclaimed liveness** in two places.

Repro scripts: `tests/adversarial/probe_api.py`, `lat.py`, `lat2.py`, `dead_neo4j_api.py`.

---

## Ranked defects

| # | Sev | Area | Defect | Status |
|---|---|---|---|---|
| 1 | **P0** | `web/src/panels/LineSearch.tsx` | Status dot used operator livery, not status — a **delayed line rendered GREEN**, and "no live status feed" lines rendered red/amber | fixed (A7) |
| 2 | **P0** | `api/` replay path | `/lines.geojson` said `normal` while `/impact/{id}` said `delay` for the same line at the same instant; replay wrote Events but never updated the `Line` node | fixed (A7) |
| 3 | P1 | demo script | Beat 3 on **Mita** shows `0 stations in flood zone`; **Chuo** (named in the PRD) yields four empty sections and flies the camera to Tachikawa | fixed — runbook now uses **Toei-Shinjuku** |
| 4 | P1 | `web/src/App.tsx` | Corner chip read "API LIVE" while serving mocks (`origin==='api'` means the HTTP call succeeded, not that data is live) | fixed (A7) |
| 5 | P1 | `web/src/App.tsx` | `flood` layer hardcoded to `live` — with Neo4j dead it was the only layer still claiming LIVE, with count 0 | fixed (A7) |
| 6 | P1 | `web/src/App.tsx` | "Train lines LIVE **5651**" — Cesium polyline-entity count, not line count (API correctly returns 6) | fixed (A6/A7) |
| 7 | P1 | quake feed | 20 of 21 quakes in 7d are >150 km from Tokyo (Kyushu, Iwate, Akita) in a product called *TokyoPulse* | resolved by honest relabelling — see below |
| 8 | P1 | `web/src/App.tsx` | City Brief fetched **once, ever** (`usePolling(fetchBrief, 0)`) — 20 min stale on stage | fixed (A7) — now 60s |
| 9 | P1 | `web/src/map/layers/warnings.ts` | 13 of 23 `now` events have `lat/lon = null` and shared ONE fallback centroid; two 3px black-outlined labels stacked into a solid black smear over Shinjuku | fixed (A6) |
| 10 | P2 | `web/src/styles/panels.css` | Opening the impact panel scrolls the search box off-screen (`scrollTop 188.7`, search at `y = -133`) | open |
| 11 | P2 | panels | JA mode half-translated — layer labels and relative times stay English | open, cosmetic |
| 12 | P2 | `api/` | `/impact/<malformed>` returns FastAPI's `{detail}` shape rather than the contract's `{error, lineId}` | open, unreachable on stage |
| 13 | P2 | `api/` | `limit=0` / `limit=-5` return 1 event instead of the documented default | open, cosmetic |

### On #7 — why we relabel instead of filter

Measured over the live 7-day window: **only 1 of 21 quakes falls within 150 km of Tokyo** (M4.8 Chiba
offshore, 104 km). Filtering to a Kanto bbox would leave the earthquake layer nearly empty and destroy
PRD §9 beat 4 ("last 7 days of quakes fade in").

We therefore keep the **national** JMA/P2PQuake feed and label it honestly as Japan-wide. This is
defensible on its merits: the PRD's own validation cites the **Nankai Trough** scenario, which is not
under Tokyo. A quake anywhere on the Japanese arc is signal for Tokyo readiness. What we must not do is
*imply* the dots are Tokyo-local — hence the relabel and the runbook talking point.

---

## Verified GOOD — do not spend time here

1. **`POST /demo/replay` ×3 is idempotent** — deterministic ids; the earlier timeline-flooding risk is closed.
2. **The fallback ladder genuinely works.** Against a dead Neo4j all 10 endpoints returned **200 in 3–16 ms**
   with `source:"cache", degraded:true`; `/layers.json` downgraded all 6 data layers; `/brief` fell to
   `provider:"template"`; the UI rendered CACHED chips with no blank screen. Arch §6 rungs 3 and 7 are real.
3. **`providerLabel` is honest** — "Claude via Anthropic API", matching `provider:"anthropic"`.
   ⚠️ But PRD §9 beat 5 tells the presenter to say *"served on Nosana"*. **Say "Claude via the Anthropic
   API, Nosana on the roadmap"** — a judge reading the card would otherwise catch the contradiction.
4. **Replay is labelled** — `source:"replay"` on every replay event, REPLAY chip rendered.
5. **`three_tier` never lies** — no code path stamps `live` on a mock payload.
6. **Ingest ids are deterministic and writes are `MERGE`** — 30s polling over 20 min creates no duplicates.
7. **Zero uncaught errors under abuse** — 5 layers × 10 rapid toggles, timeline rows clicked mid-`flyTo`,
   10 rapid EN/JA toggles, 7d↔Now round-trips, three consecutive replays, search/clear/re-search.
8. **Null-geo click works** — area-wide events fly to the ward centroid via the `affects` fallback.
9. **Performance is fine** — 2.7–12.7 ms/frame, heap steady at 470 MB / 5,811 entities with no growth
   over ~25 min. Warm API 1–16 ms.

## Chased and dismissed — NOT defects

- **Language toggle flipping to JA on its own** — not reproducible; 10 rapid toggles were stable. The
  original observation was a stale screenshot taken during another agent's HMR reload.
- **Black Cesium canvas** — the known hidden-tab `visibilityState='hidden'` rAF artifact. Always pump
  frames via a MessageChannel loop before judging a screenshot.
