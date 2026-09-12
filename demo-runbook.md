# TokyoPulse — Demo Runbook

One page. Read this while presenting. If something breaks, the **Failure Playbook** (§4) has the exact recovery keystroke — don't improvise, don't debug live.

---

## 0. Before you touch anything

- Use **`http://127.0.0.1:8000`** and **`http://127.0.0.1:5173`**, never `localhost`, anywhere.
- **CRITICAL (verified twice):** on this machine `http://localhost:5173` resolves over IPv6 to a **different project's**
  dev server (an unrelated app titled "Asset Group - Treeview v2"). TokyoPulse binds IPv4-only on purpose.
  If the browser shows the wrong app, you typed `localhost`. **Open `http://127.0.0.1:5173`.**
  Before going live, confirm no other dev server is running on port 5173 on the presenting machine. On this Windows machine `localhost` costs ~200ms extra in DNS resolution; `127.0.0.1` answers in 2-12ms.
- Three processes must be running: **API** (:8000), **web** (:5173), **ingest** (writing to Neo4j Aura in the background). All three are already up as of the last check. Don't kill or restart any of them mid-demo unless the Failure Playbook tells you to.

---

## 1. Cold-start sequence

Run these **in order**, in three separate terminals, from the repo root. Each step lists the exact expected output — if you don't see it, stop and check the Failure Playbook before moving on.

### Step 1 — API (terminal 1)

```
.venv\Scripts\python.exe scripts\run_api.py
```
Expected output:
```
TokyoPulse API -> http://0.0.0.0:8000  (docs at /docs)
```
Verify it's actually serving:
```
curl http://127.0.0.1:8000/health
```
Expected: `{"ok": true, "neo4j": "up", "eventCount": <some number>, "meta": {"source": "live", ...}}`
If `"neo4j": "down"` — see Failure Playbook row "Neo4j unreachable". The API still starts and answers; it just serves cache/mock until Aura reconnects.

### Step 2 — Ingest (terminal 2)

```
.venv\Scripts\python.exe -m ingest.launcher
```
No flag needed — `DAYTONA_API_KEY` is set in `.env`, so it auto-selects `--push` mode. Expected output (over ~2-4 seconds):
```
push: ingest-weather sandbox ready in 1890.0ms (normalize-only, no secrets, no pip install)
push: ingest-trains sandbox ready in 3390.0ms (normalize-only, no secrets, no pip install)
push: ingest-quakes sandbox ready in 3390.0ms (normalize-only, no secrets, no pip install)
push: ingest-warnings sandbox ready in 3390.0ms (normalize-only, no secrets, no pip install)
push mode running. 4/4 feeds normalizing inside real Daytona sandboxes.
```
Verify: `curl http://127.0.0.1:8000/sandboxes.json` → `"count": 4`, all four `"status": "running"`.
**Do not say "~200ms" or "5 sandboxes" — see §5. It is 4 sandboxes, 1.9-3.4 seconds each, measured.**

### Step 3 — Web (terminal 3)

```
cd web
npm install        # first time only
npm run dev
```
Expected output:
```
VITE v5.4.11  ready in <N> ms
➜  Local:   http://localhost:5173/
```
Open `http://localhost:5173` in Chrome. Expected on screen within ~5 seconds: GSI map tiles over Tokyo, 149 station crowd dots, a scrolling TIMELINE on the right, a "⚡ 4 Daytona sandboxes ingesting" badge top-left, and an `API LIVE` chip bottom-left.

*(One-time, already done, not part of cold start: `scripts/seed.py` loads the static graph — 20 lines, 23 wards, 149 stations. It's idempotent; re-running it is harmless but unnecessary.)*

---

## 2. The 2-minute script

**Correction to `doc/prd.md` §9, beat 3:** the PRD says "click a delayed line" and names **Chuo**. Chuo is JR — the keyless ODPT mirror is **Toei-only**, so Chuo has no live status and renders grey. Use **Shinjuku** (`Toei-Shinjuku`) — adversarial QA measured all six Toei lines after a train replay and Shinjuku is the strongest beat-3 payload: **6 wards, 21 stations, 11 of them in flood zones, 2 active events**. Do NOT use Mita: it has 9 wards and 27 stations but **0 stations in a flood zone**, so the promised payoff renders a literal "0". The honest one-liner if a judge asks about a grey line: *"No keyless status feed for that operator — the graph models it, the feed doesn't cover it."*

Immediately before you start, run the reset so the timeline opens clean and any earlier rehearsal replay doesn't confuse "now":
```
curl -X POST http://127.0.0.1:8000/demo/reset
```
This deletes only `source:"replay"` events — nothing live or seeded is touched.

| Clock | You say | You click | What appears on screen |
|---|---|---|---|
| 0:00 | "Every person in this room commutes through this map." | Nothing — let it sit | Populated Cesium map over Tokyo, GSI tiles, 149 crowd-weighted station dots, rail lines colored by live status, TIMELINE scrolling on the right (opens on `window=now` — ~20 current events: live train status, warnings, the past/next 48h weather edge, no clicks needed) |
| 0:15 | "Watch — I'll trigger a real earthquake report." | Nothing yet — **fire the replay now, from a second terminal, while still talking** (see §3 for exact timing) | (nothing visible yet — it's in flight) |
| 0:25 | "...and there it is." | Click the quake row / alert banner once it appears | Red-ringed alert banner flashes top-centre, a pulsing quake marker drops near Chiba, a new TIMELINE row appears at the top tagged `REPLAY`. Click either → camera flies to the epicenter. |
| 0:50 | "Now watch what happens when I ask about a specific line — this is Neo4j answering what a table can't." | Type "Shinjuku" in LINES (top-left), click the result | Camera flies to the Shinjuku Line polyline; IMPACT PANEL opens (auto-scrolls into view) showing wards affected, station count, stations-in-flood-zone count, and the events actively affecting this line |
| 1:15 | "Past, present, and what's coming — one graph." | Click the **7d** toggle (top-left, next to "Now") | Past week's quakes fade in on the map and timeline (note: repetitive same-status Toei rows auto-collapse into one "N lines: normal operation" row — click it to expand); the FORECAST strip (bottom-centre) already shows the past/next 48h precipitation + temperature with a "now" marker |
| 1:40 | "Here's the JP/EN city brief — and yes, Nosana is the roadmap sponsor here; today it's served on Anthropic." | Point at CITY BRIEF (bottom-left); toggle EN/JA (top bar) | Brief text updates; footer reads its provider verbatim (currently "Claude via Anthropic API" — falls back to a rule-based summary if the LLM call fails, never blank) |
| 1:55 | "Four Daytona sandboxes, created in parallel, each normalizing one live feed. Resident app today, ward dashboard tomorrow." | Point at the "⚡ 4 Daytona sandboxes" badge, top-left | Hover shows per-sandbox status/feed/event-count |

---

## 3. The replay cue — exact timing

```
curl -X POST http://127.0.0.1:8000/demo/replay -H "Content-Type: application/json" -d "{\"scenario\":\"quake\"}"
```

Measured: the API call itself returns in **~1-3.5 seconds** (it writes the event to Aura before responding). The browser's timeline/alert data polls **every 15 seconds** (`usePolling(..., 15_000)`), on its own phase — **not** synced to when you fire the curl. So worst case, it takes up to **~15 seconds after the curl returns** for the alert banner and timeline row to appear; on average, expect **~7-8 seconds**.

**Fire it 15-18 seconds before you want it on screen — during the sentence *before* the quake beat, not during it.** Don't fire it and then narrate immediately; you'll be describing an empty screen. If you're ahead of script, fire it, keep talking about the map for one more sentence, then point.

Other scenarios, same pattern: `{"scenario":"train"}` or `{"scenario":"warning"}`. Re-firing the same scenario updates the existing replay event in place (deterministic ids) rather than stacking duplicates, so it's safe to re-fire if you mistime it.

Reset between rehearsals: `curl -X POST http://127.0.0.1:8000/demo/reset` (deletes only replay events).

---

## 4. Failure playbook

| Breaks | Recovery | Why it's safe |
|---|---|---|
| API dies / unreachable | Keep talking. The UI's `source chip` (bottom-left) flips to `API UNREACHABLE / MOCK` and every panel silently keeps rendering from `mock/`. If you want it back: restart with `scripts\run_api.py` in a spare terminal; the web UI reconnects on its next poll, no browser reload needed. | Fallback ladder #7 (`doc/arch.md` §6): FE runs 100% on mocks, demo still tells the story. |
| Map renders blank/black | Reload the page (`F5` / `Ctrl+R`). If still blank, check the browser console isn't reporting a WebGL context loss (rare) — a second reload always recovers it. | Cesium's own render loop; unrelated to backend state. |
| Timeline empty | Check the time-window toggle isn't stuck on a window with nothing in it — click **Now**. If still empty, it's honestly empty (no events) — say so; don't panic-click. | Timeline always renders "No events", never crashes (ui-contract rule 1). |
| Brief fails / blank | It won't go blank — worst case it shows the rule-based `template` summary (footer says so) instead of the Anthropic one. If loading forever, click the ⟳ refresh icon on CITY BRIEF once. | Fallback ladder #1: Nosana stalls → Anthropic → deterministic template, never blank. |
| Neo4j (Aura) unreachable | `/health` reports `"neo4j":"down"`; every endpoint keeps answering from the in-process cache / `mock/` with `meta.degraded:true` and an amber "CACHED" chip on the affected panel. Nothing to do — talk through it, point at the CACHED chip as proof the fallback works. | Fallback ladder #2/#7: never a 500, always a degraded 200. |
| A line stays permanently grey | That's correct, not broken — JR/Metro lines have no live status feed on the keyless ODPT mirror. Say the honest line: "the graph models it, the feed doesn't cover it." | By design — `contracts/lines.csv`, `statusFeed=none` → `status:"unknown"`. |
| Replay doesn't show in time | Wait — it's the 15s poll, not a failure. If genuinely stuck (>20s), re-fire the same curl; it's idempotent. | §3 above. |

---

## 5. Honest answers to hard questions

- **"Why are most lines grey?"** The keyless ODPT mirror we're using only carries status for Toei's 6 lines. The other 14 (JR-East, Tokyo Metro) are fully modeled in the graph with real geometry — they render grey `unknown` because we have no live feed for them, not because the graph is missing data. Getting a token for the other operators is a config change, not a rebuild.
- **"Is this all live?"** Trains/quakes/warnings/weather are live, refreshed on a poll. The rail line geometry, ward boundaries, and station ridership are static (pre-loaded once, they don't change during a demo). The people-flow heatmap (if shown) is a **derived proxy from static station ridership, distance-weighted — not real-time telco people-flow**; real MLIT 人流 data is licence-gated and out of scope for a 2-hour build. Anything cached shows an amber "CACHED" badge; anything you see fire from a replay is tagged `REPLAY` — we never claim live-ness we don't have.
- **"What's Nosana doing here?"** Nosana is the intended LLM host for the brief and is roadmap for this build — the brief today runs on the Anthropic API (fallback ladder #1), with a deterministic rule-based summary as the guaranteed no-network floor. The provider actually used is printed verbatim in the CITY BRIEF card's footer, live.
- **"What does Daytona actually do here?"** Four Daytona sandboxes are created in parallel, one per feed. Sandboxes in this account have no outbound internet egress, so the **host** (which has egress) fetches each raw feed and pushes the payload into its sandbox; the sandbox runs that feed's pure `normalize()` function — real parallel compute on the critical path, inside Daytona — and hands normalized events back to the host, which writes them to Neo4j Aura. We measured real sandbox creation at **1.9-3.4 seconds each**, not the ~200ms the original plan assumed. The code path for full in-sandbox fetch-and-ingest exists and needs zero changes to flip on the moment egress is enabled on the account — it's a config change, not a rebuild.
- **"Is the earthquake real?"** The historical quake feed (P2PQuake, 7-day view) is real. The one you saw fire live is a scripted replay of a real cached P2PQuake payload — the UI tags it `REPLAY`, not a fabricated `LIVE` badge, because a live quake on cue can't be guaranteed. If one happens to fire for real during the demo, it renders identically, just without the `REPLAY` tag.

---

## 6. Sponsor talking points (one line each, tied to something on screen)

- **Daytona:** "Four sandboxes, created in parallel — point at the badge — each one normalizing a different city feed at once; that fan-out is the whole ingestion pipeline, not a mockup."
- **Neo4j:** "Click a line — point at the IMPACT PANEL — that ward/flood-zone breakdown is one Cypher query walking `(Line)-[:SERVES]->(Station)-[:IN]->(Ward)` and `(Event)-[:AFFECTS]->(Ward)` live against Aura; a table join can't answer 'which stations on this line are in a flood zone' as directly as a graph traversal does."
- **Nosana / Anthropic:** "The brief you're reading — point at CITY BRIEF — is generated fresh from the same event graph every refresh; it's on Anthropic today, with Nosana as the intended host once the roadmap item lands, and the exact provider is printed in the card so we're never pretending."

---

## 6. Late QA findings the presenter must know

- **Earthquake dots are Japan-wide, not Tokyo-only.** Measured over the live 7-day window, only **1 of 21**
  quakes falls within 150 km of Tokyo. We ingest the national JMA / P2PQuake feed deliberately and label it
  honestly. If a judge notices Kyushu or Iwate dots, the answer is: *"That's the national feed — the PRD's own
  risk case is the Nankai Trough, which isn't under Tokyo. A quake anywhere on the arc is signal for Tokyo
  readiness."* Do **not** imply the dots are Tokyo-local.
- **Do not say "served on Nosana"** (PRD §9 beat 5 says this and it is now wrong). The CITY BRIEF footer reads
  *"Claude via Anthropic API"* on screen, so a judge reading the card would catch the contradiction.
  Say: *"Claude via the Anthropic API today, Nosana on the roadmap."*
- **Click the ⟳ on CITY BRIEF before beat 5** if the demo has been open a while — the brief now refreshes on a
  60s poll, but a manual refresh guarantees it matches the timeline a judge is looking at.
- **Clicking a timeline row for an area-wide event** (one with no coordinates, e.g. a weather or ward warning)
  flies to the ward centroid, not a pin. That is intended behaviour, not a miss.

## 7. What is deliberately NOT real — say these plainly if asked

| Thing | The honest answer |
|---|---|
| Bus layer | Cut. Needs an ODPT token with multi-day manual approval. |
| People-flow heatmap | A **derived proxy** from static station ridership, distance-weighted. Not real telco people-flow; the real MLIT 人流 dataset is licence-gated. |
| JR / Tokyo Metro line status | No keyless feed exists — the mirror is Toei-only. Those lines are in the graph with real OSM geometry but render grey `unknown`. We never fake a green. |
| Daytona sandboxes | 4, created in parallel, **1.9-3.4s** each, each running a feed's `normalize()`. They have no outbound egress on this account, so the host fetches and writes. Not "5 sandboxes at 200ms". |
| The brief | Anthropic today, Nosana roadmap. The provider is printed in the card so we cannot be accused of bluffing. |

## 8. Last-minute rules (learned the hard way this build)

- **Do NOT restart the API in the final minutes before curtain.** QA caught a run where two tests
  failed on `ECONNREFUSED 127.0.0.1:8000` because the API was bouncing. If it is down when you fire
  `/demo/replay`, the scripted earthquake beat visibly fails. Run `curl http://127.0.0.1:8000/health`
  right before you go on and leave the process alone after that.
- **Check the ingest launcher is actually alive**, not just that `sandboxes.json` looks healthy.
  The file is written by the launcher, so a dead launcher leaves a stale-but-plausible file:
  `tail -3 ingest/state/launcher.log` should show cycles from the last minute.
  Ground truth for the Daytona badge is the platform itself — 5 sandboxes should be `STARTED`.
- **Open the app at `http://127.0.0.1:5173`.** `localhost` resolves via IPv6 to a different project
  on this machine (verified twice).
- **The demo opens collapsed on purpose.** Layers and the MAP cluster start collapsed, the alert is a
  chip, and Weather / Flood / Buses / People-flow layers are OFF. That is the clean opening view —
  expand deliberately as you narrate, do not pre-expand everything.
- **Fire the reset before you start:** `curl -X POST http://127.0.0.1:8000/demo/reset`.
