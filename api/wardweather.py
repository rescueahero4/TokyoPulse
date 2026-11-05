"""Hourly forecast per Tokyo ward, for GET /wardweather.json.

Open-Meteo forecasts on a grid of cells roughly 5.5km across, so wards don't have
their own forecast. A ward's value here is the average of the cells it overlaps,
weighted by how much of the ward falls in each (contracts/ward-cells.json, built by
scripts/build_tokyo_areas.py). Two wards inside the same single cell will therefore
show the same numbers, which is what the data supports.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Callable, Optional

CELLS_PATH = Path(__file__).resolve().parents[1] / "contracts" / "ward-cells.json"
FORECAST_HOURS = 48
UNITS = {"temperature": "°C", "precipitation": "mm"}
ATTRIBUTION = "Weather data by Open-Meteo.com (CC BY 4.0). Ward boundaries: JMA."
NOTE = (
    "Each ward is the area-weighted average of the ~5.5km forecast cells it overlaps. "
    "Wards inside the same single cell show the same forecast."
)

_wards: Optional[list[dict[str, Any]]] = None


def load_wards() -> list[dict[str, Any]]:
    global _wards
    if _wards is None:
        _wards = json.loads(CELLS_PATH.read_text(encoding="utf-8"))["wards"]
    return _wards


def unique_cells(wards: list[dict[str, Any]]) -> list[tuple[float, float]]:
    return sorted({(c["lat"], c["lon"]) for w in wards for c in w["cells"]})


def source_url(cells: list[tuple[float, float]]) -> str:
    return (
        "https://api.open-meteo.com/v1/forecast"
        f"?latitude={','.join(str(c[0]) for c in cells)}"
        f"&longitude={','.join(str(c[1]) for c in cells)}"
        "&hourly=temperature_2m,precipitation"
        f"&forecast_hours={FORECAST_HOURS}&timezone=Asia%2FTokyo"
    )


def _weighted_mean(values: list[tuple[Optional[float], float]]) -> Optional[float]:
    """Average of the cells that reported; None only if none of them did."""
    known = [(v, w) for v, w in values if isinstance(v, (int, float))]
    weight = sum(w for _, w in known)
    if not weight:
        return None
    return round(sum(v * w for v, w in known) / weight, 1)


def aggregate(
    points: list[dict[str, Any]],
    cells: list[tuple[float, float]],
    wards: list[dict[str, Any]],
    normalise_time: Callable[[str], Optional[str]],
) -> Optional[dict[str, Any]]:
    """Turn Open-Meteo's per-cell response into per-ward hourly series.

    `points` is in the same order as `cells`. Returns None if there is no series.
    """
    if len(points) != len(cells):
        raise ValueError(f"Open-Meteo returned {len(points)} points, expected {len(cells)}")
    hourly_by_cell = {cell: (point or {}).get("hourly") or {} for cell, point in zip(cells, points)}
    times = next((h["time"] for h in hourly_by_cell.values() if h.get("time")), None)
    if not times:
        return None

    def at(cell: tuple[float, float], key: str, i: int) -> Optional[float]:
        series = hourly_by_cell[cell].get(key) or []
        return series[i] if i < len(series) else None

    out = []
    for ward in wards:
        temperature, precipitation = [], []
        for i in range(len(times)):
            weighted = [((c["lat"], c["lon"]), c["weight"]) for c in ward["cells"]]
            temperature.append(_weighted_mean([(at(cell, "temperature_2m", i), w) for cell, w in weighted]))
            precipitation.append(_weighted_mean([(at(cell, "precipitation", i), w) for cell, w in weighted]))
        out.append({
            "ward": ward["ward"], "wardJa": ward["wardJa"], "code": ward["code"],
            "cellCount": len(ward["cells"]),
            "temperature": temperature, "precipitation": precipitation,
        })
    return {
        "time": [normalise_time(t) or t for t in times],
        "nowIndex": 0,
        "units": UNITS,
        "wards": out,
    }


def empty() -> dict[str, Any]:
    return {"time": [], "nowIndex": 0, "units": UNITS, "wards": []}
