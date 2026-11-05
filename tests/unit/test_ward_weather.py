"""Ward forecasts, forecast events and warning areas. No database or network needed.

Run from the repo root: python -m unittest tests.unit.test_ward_weather
"""

import json
import unittest
from datetime import timedelta
from pathlib import Path
from unittest import mock

from api import wardweather
from ingest.common import JMA_AREA_CODE_TO_WARD, now_jst
from ingest.feeds import warnings as warnings_feed
from ingest.feeds import weather

ROOT = Path(__file__).resolve().parents[2]
AREAS = json.loads((ROOT / "web" / "public" / "geo" / "tokyo-areas.geojson").read_text(encoding="utf-8"))


def identity(t):
    return t


class WardAggregation(unittest.TestCase):
    CELLS = [(35.6, 139.7), (35.7, 139.8)]
    WARDS = [
        {"ward": "Split", "wardJa": "分", "code": "1", "cells": [
            {"lat": 35.6, "lon": 139.7, "weight": 0.75}, {"lat": 35.7, "lon": 139.8, "weight": 0.25}]},
        {"ward": "Whole", "wardJa": "全", "code": "2", "cells": [{"lat": 35.7, "lon": 139.8, "weight": 1.0}]},
    ]

    @staticmethod
    def point(temps, rain):
        return {"hourly": {"time": ["t0", "t1"], "temperature_2m": temps, "precipitation": rain}}

    def test_values_are_weighted_by_share_of_the_ward(self):
        out = wardweather.aggregate(
            [self.point([10.0, 12.0], [0.0, 4.0]), self.point([20.0, 22.0], [8.0, 0.0])],
            self.CELLS, self.WARDS, identity)
        split, whole = out["wards"]
        self.assertEqual(split["temperature"], [12.5, 14.5])
        self.assertEqual(split["precipitation"], [2.0, 3.0])
        self.assertEqual(whole["temperature"], [20.0, 22.0])
        self.assertEqual(out["time"], ["t0", "t1"])

    def test_a_missing_cell_value_does_not_drag_the_average_to_zero(self):
        out = wardweather.aggregate(
            [self.point([None, 12.0], [0.0, 0.0]), self.point([20.0, 22.0], [0.0, 0.0])],
            self.CELLS, self.WARDS, identity)
        self.assertEqual(out["wards"][0]["temperature"][0], 20.0)

    def test_no_data_at_all_is_null_not_zero(self):
        out = wardweather.aggregate(
            [self.point([None, 12.0], [None, 0.0]), self.point([None, 22.0], [None, 0.0])],
            self.CELLS, self.WARDS, identity)
        self.assertIsNone(out["wards"][1]["temperature"][0])
        self.assertIsNone(out["wards"][1]["precipitation"][0])

    def test_a_short_response_is_rejected_rather_than_misassigned(self):
        with self.assertRaises(ValueError):
            wardweather.aggregate([self.point([1, 2], [0, 0])], self.CELLS, self.WARDS, identity)

    def test_no_series_means_no_payload(self):
        self.assertIsNone(wardweather.aggregate([{}, {}], self.CELLS, self.WARDS, identity))


class GeneratedData(unittest.TestCase):
    def test_every_ward_has_cells_that_add_up(self):
        wards = wardweather.load_wards()
        self.assertEqual({w["code"] for w in wards}, set(JMA_AREA_CODE_TO_WARD))
        for w in wards:
            self.assertAlmostEqual(sum(c["weight"] for c in w["cells"]), 1.0, places=2, msg=w["ward"])

    def test_every_ward_has_its_own_mix_of_cells(self):
        mixes = [tuple(sorted((c["lat"], c["lon"], c["weight"]) for c in w["cells"]))
                 for w in wardweather.load_wards()]
        self.assertEqual(len(set(mixes)), len(mixes))

    def test_every_ward_and_island_region_has_a_boundary(self):
        codes = {f["properties"]["code"] for f in AREAS["features"]}
        self.assertTrue(set(JMA_AREA_CODE_TO_WARD) <= codes)
        self.assertTrue({"130020", "130030", "130040"} <= codes)

    def test_island_regions_are_labelled_on_their_inhabited_islands(self):
        labels = {f["properties"]["code"]: f["properties"]["label"] for f in AREAS["features"]}
        lon, lat = labels["130040"]  # Chichijima, not remote Minamitorishima at 154E
        self.assertAlmostEqual(lon, 142.2, delta=0.3)
        self.assertAlmostEqual(lat, 27.1, delta=0.3)


class ForecastEvents(unittest.TestCase):
    @staticmethod
    def payload(rain):
        start = now_jst().replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
        times = [(start + timedelta(hours=i)).strftime("%Y-%m-%dT%H:%M") for i in range(len(rain))]
        return {"latitude": 35.7, "longitude": 139.75,
                "hourly": {"time": times, "temperature_2m": [15.0] * len(rain), "precipitation": rain}}

    def test_a_dry_forecast_makes_no_rain_event(self):
        ids = [e["id"] for e in weather.normalize(self.payload([0.0] * 48))]
        self.assertFalse([i for i in ids if "precip" in i])

    def test_a_trace_of_rain_makes_no_rain_event(self):
        ids = [e["id"] for e in weather.normalize(self.payload([0.1, 0.4] + [0.0] * 46))]
        self.assertFalse([i for i in ids if "precip" in i])

    def test_real_rain_reports_the_peak(self):
        rain = [e for e in weather.normalize(self.payload([0.0, 0.6, 3.2, 1.0] + [0.0] * 44))
                if "precip" in e["id"]]
        self.assertEqual(len(rain), 1)
        self.assertIn("3.2mm", rain[0]["title"])

    def test_forecast_events_have_no_map_position(self):
        for e in weather.normalize(self.payload([2.0] * 48)):
            self.assertIsNone(e["lat"])
            self.assertIsNone(e["lon"])

    def test_superseded_forecasts_are_pruned_after_a_good_write(self):
        with mock.patch.object(weather, "fetch_once", return_value=self.payload([0.0] * 48)), \
                mock.patch.object(weather, "upsert", return_value={"neo4j_ok": True, "written": 1}), \
                mock.patch.object(weather, "prune_superseded", return_value=0) as prune:
            weather.run_cycle()
        self.assertEqual(len(prune.call_args[0][0]), 1)

    def test_nothing_is_pruned_when_the_write_failed(self):
        with mock.patch.object(weather, "fetch_once", return_value=self.payload([0.0] * 48)), \
                mock.patch.object(weather, "upsert", return_value={"neo4j_ok": False, "written": 0}), \
                mock.patch.object(weather, "prune_superseded") as prune:
            weather.run_cycle()
        prune.assert_not_called()


class WarningAreas(unittest.TestCase):
    @staticmethod
    def reports(*items, klass="class20Items"):
        return [{
            "reportDatetime": now_jst().isoformat(),
            "warning": {klass: [
                {"areaCode": code, "kinds": [{"code": kind, "status": "継続"}]} for code, kind in items
            ]},
        }]

    def test_a_ward_warning_names_its_area(self):
        event = warnings_feed.normalize(self.reports(("1310300", "14")))[0]
        self.assertEqual(event["areaCodes"], ["1310300"])
        self.assertEqual(event["affects"], ["ward:Minato"])

    def test_tama_cities_with_the_same_warning_share_one_event_and_keep_every_area(self):
        events = warnings_feed.normalize(self.reports(("1320100", "14"), ("1320200", "14")))
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["areaCodes"], ["1320100", "1320200"])

    def test_an_island_region_names_its_area(self):
        event = warnings_feed.normalize(self.reports(("130040", "16"), klass="class10Items"))[0]
        self.assertEqual(event["areaCodes"], ["130040"])
        self.assertEqual(event["affects"], [])


if __name__ == "__main__":
    unittest.main()
