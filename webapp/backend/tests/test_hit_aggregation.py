import unittest
from datetime import date, datetime, timedelta, timezone

from utils.hit_aggregation import (
    DEFAULT_COMPANY_TIMEZONE,
    canonical_timezone_name,
    counted_hit_predicate,
    local_day_range_utc,
    local_today,
    parse_local_date,
)


class HitAggregationContractTests(unittest.TestCase):
    def test_local_day_bounds_are_half_open_naive_utc(self):
        bounds = local_day_range_utc(date(2026, 8, 17), "Europe/Berlin")
        self.assertEqual(bounds.start, datetime(2026, 8, 16, 22, 0))
        self.assertEqual(bounds.end, datetime(2026, 8, 17, 22, 0))
        self.assertIsNone(bounds.start.tzinfo)
        self.assertLess(bounds.start, bounds.end)

    def test_berlin_dst_days_have_23_and_25_hours(self):
        spring = local_day_range_utc(date(2026, 3, 29), "Europe/Berlin")
        autumn = local_day_range_utc(date(2026, 10, 25), "Europe/Berlin")
        self.assertEqual(spring.end - spring.start, timedelta(hours=23))
        self.assertEqual(autumn.end - autumn.start, timedelta(hours=25))

    def test_local_today_uses_company_timezone(self):
        instant = datetime(2026, 1, 1, 23, 30, tzinfo=timezone.utc)
        self.assertEqual(local_today("Europe/Berlin", instant), date(2026, 1, 2))
        self.assertEqual(local_today("America/New_York", instant), date(2026, 1, 1))

    def test_date_format_is_strict(self):
        self.assertEqual(parse_local_date("2026-08-17"), date(2026, 8, 17))
        for invalid in ("20260817", "17.08.2026", "2026-02-30", ""):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                parse_local_date(invalid)

    def test_invalid_stored_timezone_falls_back(self):
        self.assertEqual(canonical_timezone_name("Not/AZone"), DEFAULT_COMPANY_TIMEZONE)

    def test_counted_predicate_is_explicit_and_alias_safe(self):
        self.assertEqual(counted_hit_predicate(), "counted IS TRUE")
        self.assertEqual(counted_hit_predicate("h"), "h.counted IS TRUE")
        with self.assertRaises(ValueError):
            counted_hit_predicate("h; DROP TABLE device_hits")


if __name__ == "__main__":
    unittest.main()
