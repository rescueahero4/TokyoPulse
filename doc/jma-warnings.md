# JMA Warnings — how ward positioning actually works

Reference for the `warnings` (JMA warnings) layer. Written after verifying the live feed directly,
because the layer looked broken when it was in fact correct.

**Feed:** `https://www.jma.go.jp/bosai/warning/data/warning/130000.json` (`130000` = Tokyo prefecture)
**Human-readable equivalent:** `https://www.jma.go.jp/bosai/warning/#area_type=class20s&area_code=130000`
**Area master:** `https://www.jma.go.jp/bosai/common/const/area.json` (snapshot: `mock/raw/jma-area-master.json`, 1,805 `class20s` entries)

---

## The payload has TWO area granularities, and only one of them is ward-level

```jsonc
{
  "reportDatetime": "...", "publishingOffice": "気象庁", "headlineText": "...",
  "areaTypes": [
    { "areas": [ /* [0] class10s — 4 coarse regions */ ] },
    { "areas": [ /* [1] class20s — 62 MUNICIPALITIES, this is the ward level */ ] }
  ],
  "timeSeries": [ ... ]
}
```

### `areaTypes[0]` — class10s (一次細分区域), 4 coarse regions

| Code | Area |
|---|---|
| `130010` | 東京地方 (Tokyo mainland — covers ALL 23 wards as one blob) |
| `130020` | 伊豆諸島北部 (Northern Izu Islands) |
| `130030` | 伊豆諸島南部 (Southern Izu Islands) |
| `130040` | 小笠原諸島 (Ogasawara Islands) |

**Do not position warnings from this level.** `130010` is the entire 23-ward area as a single region —
using it would put every Tokyo warning on one pin, which is what "implemented incorrectly" looks like.

### `areaTypes[1]` — class20s (市町村等), 62 municipalities ← **use this one**

Codes are 7 digits: the 5-digit JIS municipality code + `00`.

**The 23 special wards are the contiguous range `1310100` – `1312300`** (JIS 13101–13123):

| Code | Ward | | Code | Ward |
|---|---|---|---|---|
| `1310100` | 千代田区 Chiyoda | | `1311300` | 渋谷区 Shibuya |
| `1310200` | 中央区 Chuo | | `1311400` | 中野区 Nakano |
| `1310300` | 港区 Minato | | `1311500` | 杉並区 Suginami |
| `1310400` | 新宿区 Shinjuku | | `1311600` | 豊島区 Toshima |
| `1310500` | 文京区 Bunkyo | | `1311700` | 北区 Kita |
| `1310600` | 台東区 Taito | | `1311800` | 荒川区 Arakawa |
| `1310700` | 墨田区 Sumida | | `1311900` | 板橋区 Itabashi |
| `1310800` | 江東区 Koto | | `1312000` | 練馬区 Nerima |
| `1310900` | 品川区 Shinagawa | | `1312100` | 足立区 Adachi |
| `1311000` | 目黒区 Meguro | | `1312200` | 葛飾区 Katsushika |
| `1311100` | 大田区 Ota | | `1312300` | 江戸川区 Edogawa |
| `1311200` | 世田谷区 Setagaya | | | |

Everything outside that range in the same list is Tama-area cities (`1320xxx`–`1330xxx`) or island
municipalities (`13361xx` 大島町, `13401xx` 八丈町, `13402xx` 青ヶ島村, …) — **not** wards.

## Status values — emit only the active ones

Each area carries `warnings[]`, each with a `status`:

| `status` | Meaning | Emit? |
|---|---|---|
| `発表警報・注意報はなし` | No warning issued | **No** |
| `解除` | Cancelled / lifted | **No** |
| `発表` | Newly issued | Yes |
| `継続` | Continuing | Yes |

Severity from the warning `code`: 特別警報 → `critical`, 警報 → `critical`, 注意報 → `warning`.

## What we do

`ingest/feeds/warnings.py` walks `areaTypes[].areas[].warnings[]`, keeps only active statuses, maps the
class20s code to a ward via the table in `ingest/common.py`, and sets `affects: ["ward:<Ward>"]` plus
`lat`/`lon` from the ward centroid (`contracts/wards.csv`) so the map can place it. `mock/wards.geojson`
carries ward **polygons** so an affected ward can be shaded rather than pinned.

A warning in a Tama city or an island municipality is labelled **"(outside 23-ward scope)"** and carries
no ward — we do not force a non-ward area onto a ward.

## Verified state at the time of writing

```
areaTypes[0] (class10s): 130010 東京地方 -> 0 active
                         130020/130030   -> 2 and 4 active (Izu Islands)
                         130040          -> 解除
areaTypes[1] (class20s): 62 areas, 23 of them in the ward range 1310100-1312300
                         active areas: 8 -> ALL island municipalities
                                            (1336100 大島町, 1340100 八丈町, 1340200 青ヶ島村, …)
                         wards with an active warning: 0
```

**So an empty JMA layer over the 23 wards is correct, not a bug.** The ward mechanism is implemented and
will position correctly the moment a ward-level advisory fires. The UI says so rather than showing a
misleading empty state.

## Two gotchas worth knowing

1. **`reportDatetime` can be months stale.** Observed `2026-05-28T10:16:00+09:00` while the feed was
   otherwise current — JMA retains the last report time for an area group with nothing new to announce.
   Do not use it as an "is this feed alive?" signal, and do not let it drive `Event.time` for the
   timeline ordering without a sanity check.
2. **`class15s` exists in JMA's area master but not in this payload.** Only `class10s` and `class20s`
   appear in `130000.json`. Code that assumes three tiers will index out of range.
