import unittest
from datetime import datetime

from pydantic import ValidationError

import devices


class ProductionCounterTests(unittest.TestCase):
    def test_request_validates_count_ranges(self):
        valid = devices.ProductionCounterRequest(
            target_count=2500,
            material_count=3000,
        )
        self.assertEqual(valid.target_count, 2500)

        for invalid_target in (0, -1, True, 1_000_000_001):
            with self.subTest(invalid_target=invalid_target):
                with self.assertRaises(ValidationError):
                    devices.ProductionCounterRequest(target_count=invalid_target)

        with self.assertRaises(ValidationError):
            devices.ProductionCounterRequest(target_count=10, material_count=-1)

    def test_payload_derives_remaining_values(self):
        payload = devices.production_counter_payload(
            datetime(2026, 9, 1, 12, 0),
            target_count=1000,
            material_count=800,
            current_count=450,
        )
        self.assertEqual(payload["remaining_count"], 550)
        self.assertEqual(payload["material_remaining"], 350)
        self.assertEqual(payload["started_at"], "2026-09-01T12:00:00Z")


if __name__ == "__main__":
    unittest.main()
