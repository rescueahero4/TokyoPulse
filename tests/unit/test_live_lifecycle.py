"""Cold/warm/hot rules on the hosted API. No database needed.

Run from the repo root: python -m unittest tests.unit.test_live_lifecycle
"""

import os
import time
import unittest
from unittest import mock

os.environ["TOKYOPULSE_PUBLIC"] = "true"
os.environ["CRON_SECRET"] = "test-secret"

from fastapi.testclient import TestClient  # noqa: E402

from api import cache, graph  # noqa: E402
from api import main as api_main  # noqa: E402

CDN = "vercel-cdn-cache-control"


def good(n: int = 1) -> dict:
    return {"n": n, "meta": {"source": "live", "degraded": False}}


def degraded() -> dict:
    return {"n": 0, "meta": {"source": "mock", "degraded": True}}


class CacheSharing(unittest.TestCase):
    def setUp(self):
        cache._entries.clear()
        self.addCleanup(cache._entries.clear)

    def test_fresh_payload_goes_on_the_cdn_without_extending_its_life(self):
        self.assertEqual(cache.serve("k", 60, good, "k").headers[CDN], "public, max-age=60")
        cache._entries["k"]["at"] -= 40
        res = cache.serve("k", 60, good, "k")
        self.assertEqual(res.headers["x-cache"], "hit")
        self.assertEqual(res.headers[CDN], "public, max-age=20")

    def test_short_ttls_still_share_for_a_polling_interval(self):
        self.assertEqual(cache.serve("k", 5, good, "k").headers[CDN], "public, max-age=15")

    def test_stale_and_degraded_stay_off_the_cdn(self):
        self.assertNotIn(CDN, cache.serve("bad", 60, degraded, "bad").headers)
        cache.serve("k", 5, good, "k")
        cache._entries["k"]["at"] -= 6
        with mock.patch.object(cache, "_refresh_async"):
            res = cache.serve("k", 5, good, "k")
        self.assertEqual(res.headers["x-cache"], "stale")
        self.assertNotIn(CDN, res.headers)

    def test_a_newer_ingest_forces_a_reread(self):
        cache.serve("k", 60, lambda: good(1), "k")
        cache._entries["k"]["at"] -= cache.REFRESH_MIN_GAP
        res = cache.serve("k", 60, lambda: good(2), "k", fresh_after=time.time() + 1)
        self.assertEqual(res.headers["x-cache"], "miss")
        self.assertIn(b'"n": 2', res.body)
        self.assertIn(CDN, res.headers)

    def test_a_version_the_entry_already_covers_is_a_plain_hit(self):
        cache.serve("k", 60, lambda: good(1), "k")
        res = cache.serve("k", 60, lambda: good(2), "k", fresh_after=time.time() - 10)
        self.assertEqual(res.headers["x-cache"], "hit")
        self.assertIn(b'"n": 1', res.body)

    def test_a_forged_version_cannot_force_rapid_rereads(self):
        cache.serve("k", 60, lambda: good(1), "k")
        producer = mock.Mock(return_value=good(2))
        res = cache.serve("k", 60, producer, "k", fresh_after=9e18)
        producer.assert_not_called()
        self.assertNotIn(CDN, res.headers)

    def test_a_degraded_reread_keeps_the_last_good_payload(self):
        cache.serve("k", 60, lambda: good(1), "k")
        cache._entries["k"]["at"] -= cache.REFRESH_MIN_GAP
        res = cache.serve("k", 60, degraded, "k", fresh_after=time.time() + 1)
        self.assertIn(b'"n": 1', res.body)
        self.assertNotIn(CDN, res.headers)


class Tick(unittest.TestCase):
    client = TestClient(api_main.app)

    def tick(self, claim, feeds=None):
        with mock.patch.object(graph, "claim_ingest", **claim), \
                mock.patch.object(graph, "mark_ingest_complete") as marked, \
                mock.patch("ingest.once.run_once", return_value=feeds or {}) as ran:
            return self.client.get("/tick"), ran, marked

    def test_winner_runs_one_pass_and_the_result_is_shared(self):
        res, ran, marked = self.tick(
            {"return_value": (True, None)},
            {"trains": {"ok": True, "written": 6}, "quakes": {"ok": False, "written": 0}})
        ran.assert_called_once()
        marked.assert_called_once()
        self.assertTrue(res.json()["ran"])
        self.assertIsNotNone(res.json()["lastIngestAt"])
        self.assertIn(CDN, res.headers)

    def test_a_pass_where_every_feed_failed_does_not_count_as_fresh(self):
        res, _, marked = self.tick({"return_value": (True, 1000.0)},
                                   {"trains": {"ok": False, "written": 0}})
        marked.assert_not_called()
        self.assertEqual(res.json()["lastIngestAt"], 1000.0)
        self.assertNotIn(CDN, res.headers)

    def test_loser_with_fresh_data_runs_nothing_and_is_shared(self):
        res, ran, _ = self.tick({"return_value": (False, time.time() - 5)})
        ran.assert_not_called()
        self.assertFalse(res.json()["ran"])
        self.assertIn(CDN, res.headers)

    def test_viewer_arriving_mid_warmup_is_not_cached_on_old_data(self):
        res, ran, _ = self.tick({"return_value": (False, time.time() - 3600)})
        ran.assert_not_called()
        self.assertNotIn(CDN, res.headers)

    def test_database_down_is_reported_and_not_cached(self):
        res, ran, _ = self.tick({"side_effect": RuntimeError("down")})
        ran.assert_not_called()
        self.assertEqual(res.json()["reason"], "graph unavailable")
        self.assertNotIn(CDN, res.headers)

    def test_post_is_gone_so_only_the_cacheable_route_can_trigger_ingest(self):
        self.assertEqual(self.client.post("/tick").status_code, 405)


class Keepalive(unittest.TestCase):
    client = TestClient(api_main.app)
    auth = {"Authorization": "Bearer test-secret"}

    def test_writes_once_and_runs_no_feeds(self):
        with mock.patch.object(graph, "run") as run, \
                mock.patch("ingest.once.run_once") as ran:
            res = self.client.get("/cron/keepalive", headers=self.auth)
        self.assertEqual(res.status_code, 200)
        run.assert_called_once()
        self.assertIn("keepalive", run.call_args.args[0])
        ran.assert_not_called()

    def test_requires_the_secret(self):
        with mock.patch.object(graph, "run") as run:
            res = self.client.get("/cron/keepalive")
        self.assertEqual(res.status_code, 404)
        run.assert_not_called()

    def test_reports_failure_so_a_dead_keepalive_shows_in_the_logs(self):
        with mock.patch.object(graph, "run", side_effect=RuntimeError("down")):
            res = self.client.get("/cron/keepalive", headers=self.auth)
        self.assertEqual(res.status_code, 503)

    def test_old_cron_route_is_gone(self):
        self.assertEqual(self.client.get("/cron/tick", headers=self.auth).status_code, 404)


if __name__ == "__main__":
    unittest.main()
