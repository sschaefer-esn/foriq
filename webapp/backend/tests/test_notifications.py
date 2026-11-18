import unittest
from datetime import datetime, timezone

from fastapi import HTTPException

from notifications import (
    NotificationRuleUpdate,
    WeeklyWindow,
    _validate_non_overlapping,
    active_window,
)


class NotificationScheduleTests(unittest.TestCase):
    def test_offline_notifications_are_opt_in(self):
        rule = NotificationRuleUpdate()
        self.assertFalse(rule.notify_device_offline)

    def test_prior_work_phase_is_opt_in(self):
        rule = NotificationRuleUpdate()
        self.assertFalse(rule.require_work_phase)
        self.assertEqual(rule.minimum_work_minutes, 5)
        self.assertTrue(rule.notify_activity_resumed)

    def test_weekday_window_uses_company_timezone(self):
        window = active_window(
            datetime(2026, 8, 17, 7, 30, tzinfo=timezone.utc),
            [{"days": [1, 2, 3, 4, 5], "start": "08:00", "end": "10:00"}],
            "Europe/Berlin",
        )
        self.assertIsNotNone(window)
        self.assertEqual(window[0], datetime(2026, 8, 17, 6, 0))

    def test_overnight_window_remains_active_next_day(self):
        windows = [{"days": [5], "start": "23:00", "end": "02:00"}]
        self.assertIsNotNone(
            active_window(
                datetime(2026, 1, 9, 22, 30, tzinfo=timezone.utc),
                windows,
                "Europe/Berlin",
            )
        )
        self.assertIsNotNone(
            active_window(
                datetime(2026, 1, 10, 0, 30, tzinfo=timezone.utc),
                windows,
                "Europe/Berlin",
            )
        )

    def test_overlapping_windows_are_rejected(self):
        with self.assertRaises(HTTPException):
            _validate_non_overlapping([
                WeeklyWindow(days=[1], start="08:00", end="10:00"),
                WeeklyWindow(days=[1], start="09:30", end="11:00"),
            ])

    def test_adjacent_windows_are_allowed(self):
        _validate_non_overlapping([
            WeeklyWindow(days=[1], start="08:00", end="10:00"),
            WeeklyWindow(days=[1], start="10:00", end="11:00"),
        ])


if __name__ == "__main__":
    unittest.main()
