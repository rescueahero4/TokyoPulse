"""Train status classification. No database or network needed.

Run from the repo root: python -m unittest tests.unit.test_train_severity
"""

import unittest

from ingest.feeds.trains import classify_severity, normalize

NORMAL_TEXT = "現在、１５分以上の遅延はありません。"
# Exactly what ODPT published for the Asakusa Line on 2026-11-05, shown as "normal".
ASAKUSA_TEXT = "浅草線は、京成線内にて発生したお客様混雑のため、西馬込駅方面行列車のダイヤが乱れています。"


class ClassifySeverity(unittest.TestCase):
    def test_normal_text_without_status_is_normal(self):
        self.assertEqual(classify_severity(NORMAL_TEXT), "info")

    def test_a_status_saying_normal_is_normal(self):
        self.assertEqual(classify_severity("平常どおり運転しています。", "平常運転"), "info")

    def test_timetable_disruption_is_a_warning(self):
        self.assertEqual(classify_severity(ASAKUSA_TEXT, "ダイヤ乱れ"), "warning")

    def test_disruption_wording_is_caught_even_without_a_status(self):
        self.assertEqual(classify_severity(ASAKUSA_TEXT), "warning")

    def test_delay_is_a_warning(self):
        self.assertEqual(classify_severity("信号確認のため遅延しています。", "遅延"), "warning")

    def test_unrecognised_text_is_never_called_normal(self):
        self.assertEqual(classify_severity("お客様へのお知らせがあります。"), "warning")

    def test_suspension_is_critical_from_text_or_status(self):
        self.assertEqual(classify_severity("人身事故のため運転を見合わせています。", "運転見合わせ"), "critical")
        self.assertEqual(classify_severity("強風の影響により、運転見合わせ中です。"), "critical")

    def test_through_service_stopping_does_not_read_as_the_line_suspended(self):
        self.assertEqual(classify_severity("京成線との直通運転を中止しています。", "直通運転中止"), "warning")


class Normalize(unittest.TestCase):
    def test_asakusa_payload_becomes_a_delay_event(self):
        [event] = normalize([{
            "odpt:railway": "odpt.Railway:Toei.Asakusa",
            "odpt:trainInformationStatus": {"ja": "ダイヤ乱れ"},
            "odpt:trainInformationText": {"ja": ASAKUSA_TEXT},
            "dc:date": "2026-11-05T11:32:00+09:00",
        }])
        self.assertEqual(event["severity"], "warning")
        self.assertEqual(event["title"], "Asakusa Line: delays reported")

    def test_null_status_on_a_normal_line_stays_normal(self):
        [event] = normalize([{
            "odpt:railway": "odpt.Railway:Toei.Mita",
            "odpt:trainInformationStatus": None,
            "odpt:trainInformationText": {"ja": NORMAL_TEXT},
            "dc:date": "2026-11-05T11:32:00+09:00",
        }])
        self.assertEqual(event["severity"], "info")


if __name__ == "__main__":
    unittest.main()
