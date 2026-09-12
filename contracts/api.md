# TokyoPulse API Contract — FROZEN at 0:15

Base: `http://localhost:8000`. CORS: allow `http://localhost:5173`, `http://127.0.0.1:5173`.
**Rule:** a live-data swap changes only what fills these shapes, never the shapes. If the UI has to change to accept live data, the swap broke the contract → revert the swap.

## Universal envelope

EVERY endpoint returns a `meta` object. This is how the UI shows per-layer "cached" badges (godseye principle #2: layers fail independently).

```jsonc
"meta": {
  "source": "live" | "cache" | "mock",  // where THIS payload came from
  "generatedAt": "2026-09-12T14:32:00+09:00",
  "degraded": false,                     // true => UI shows amber "cached" badge on that layer
  "note": null                           // optional short human reason, e.g. "ODPT timeout, serving 14:02 snapshot"
}
```

**Never 500 on a dead feed.** Return the cached payload with `source:"cache", degraded:true`. A 500 blanks a layer in the demo; a degraded 200 keeps it on screen.

---

## GET /health
```jsonc
{ "ok": true, "neo4j": "up" | "down", "eventCount": 137, "meta": {...} }
```

## GET /events.json
Query params (all optional): `limit` (default 30, max 200), `type` (csv of quake,train,warning,weather), `severity` (min level: info|warning|critical), `since` (ISO8601), `window` (`now` | `7d` — `now`=last 6h, `7d`=last 7 days; default `now`).

Powers **three** UI features from one query: Timeline (all), AlertBanner (`severity>=warning`), BriefCard input (top 10).
```jsonc
{
  "events": [ /* Event objects per contracts/event.schema.json, SORTED time DESC */ ],
  "counts": { "quake": 12, "train": 6, "warning": 3, "weather": 2, "critical": 1, "warning_level": 4 },
  "meta": {...}
}
```

## GET /lines.geojson
```jsonc
{
  "type": "FeatureCollection",
  "features": [ /* LineFeature per contracts/line-feature.schema.json */ ],
  "meta": {...}
}
```
All 20 lines in `contracts/lines.csv` appear ALWAYS, even with zero geometry (`coordinates: []`) — the UI's line-search list is driven by this response. Lines whose `statusFeed=none` return `status:"unknown"`, `statusSource:"none"`, `statusText:"No live status feed"`.

## GET /stations.geojson
Crowd layer. Point features, ridership-weighted markers.
```jsonc
{
  "type": "FeatureCollection",
  "features": [{
    "type": "Feature",
    "geometry": { "type": "Point", "coordinates": [139.7671, 35.6812] },
    "properties": {
      "stationId": "Toei.Mita.Hakusan", "name": "Hakusan", "nameJa": "白山",
      "lineIds": ["Toei-Mita"], "ward": "Bunkyo" | null,
      "ridership": 23000 | null,        // daily passengers; null => use fallback radius
      "ridershipBand": 1,                // 1..5, precomputed quintile => marker size tier. ALWAYS present.
      "inFloodZone": false
    }
  }],
  "meta": {...}
}
```

## GET /impact/{lineId}
Demo beat 3 — "Neo4j answering what a table can't."
```jsonc
{
  "lineId": "Toei-Mita",
  "name": "Mita Line", "nameJa": "都営三田線",
  "status": "delay", "statusText": "Delays of approx 15 min",
  "wards":    [{ "ward": "Bunkyo", "wardJa": "文京区", "stationCount": 4, "activeEventCount": 1 }],
  "stations": [{ "stationId": "...", "name": "Hakusan", "nameJa": "白山", "lat": 35.72, "lon": 139.75, "ward": "Bunkyo", "inFloodZone": true, "ridershipBand": 3 }],
  "events":   [ /* Events AFFECTING this line, time DESC, max 20 */ ],
  "stationsInFloodZone": 2,
  "meta": {...}
}
```
Unknown lineId → HTTP 404 `{ "error": "unknown lineId", "lineId": "..." }`.

## GET /forecast.json
Past 48h + next 48h, Open-Meteo, hourly. Single flat array; `isPast` marks the split so the UI renders one strip.
```jsonc
{
  "location": { "lat": 35.68, "lon": 139.76, "name": "Tokyo" },
  "nowIndex": 48,                       // index into hourly[] of the current hour
  "hourly": [{ "time": "2026-09-10T14:00+09:00", "temperature": 27.4, "precipitation": 0.0, "isPast": true }],
  "summary": { "maxPrecip24h": 12.5, "minTemp": 21.1, "maxTemp": 31.2, "rainHoursNext48": 7 },
  "sourceUrl": "https://api.open-meteo.com/v1/forecast?latitude=35.68&...",
  "sourceName": "Open-Meteo",
  "attribution": "Weather data by Open-Meteo.com (CC BY 4.0)",
  "meta": {...}
}
```
**AMENDED post-freeze (orchestrator broadcast):** `sourceUrl`, `sourceName` and `attribution` added so the
UI can link users to the exact upstream query and let them verify the numbers themselves. Additive only —
existing consumers are unaffected. `sourceUrl` MUST be the real request URL actually used (not a homepage),
so clicking it returns the same data we rendered. When serving from cache/mock, still return the URL that
produced the cached payload and let `meta.degraded` convey the staleness.

## GET /brief
```jsonc
{
  "en": "Three sentences max.", "ja": "三文以内。",
  "provider": "nosana" | "anthropic" | "template",   // UI prints this verbatim in the card footer
  "providerLabel": "served on Nosana",
  "eventCount": 10,
  "meta": {...}
}
```
`provider:"template"` = deterministic rule-based summary from the events (no LLM reachable). Card still renders. Never blank.

## GET /sandboxes.json
The "⚡ N Daytona sandboxes ingesting" badge.
```jsonc
{
  "count": 4,
  "sandboxes": [{
    "name": "ingest-trains", "feed": "odpt",
    "status": "running" | "starting" | "stopped" | "failed" | "mock",
    "eventsWritten": 18, "lastWriteAt": "2026-09-12T14:31:55+09:00",
    "startupMs": 210
  }],
  "meta": {...}
}
```

## POST /demo/replay
Demo-control. Injects a **cached real** payload as fresh Events so a beat fires on cue (PRD §10: "no live quake during demo"). Events written carry `source:"replay"` — honest, and the UI tags them REPLAY.
```jsonc
// request:  { "scenario": "quake" | "train" | "warning" }
// response: { "injected": 3, "scenario": "quake", "events": [ /* Events */ ], "meta": {...} }
```

## GET /layers.json
One call the UI polls for layer health, so LayerPanel can grey dead layers.
```jsonc
{ "layers": [{ "id": "trains"|"quakes"|"warnings"|"weather"|"flood"|"crowd"|"peopleflow",
               "label": "Train lines", "state": "live"|"cache"|"mock"|"off", "count": 6,
               "lastUpdate": "..." }], "meta": {...} }
```
