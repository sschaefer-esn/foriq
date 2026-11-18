import unittest
from types import SimpleNamespace

from settings import _energy_wire_config


class EnergySettingsRolloutTests(unittest.TestCase):
    def setUp(self):
        self.device = SimpleNamespace(
            count_sensitivity=5000,
            count_bridge_ms=901,
            std_window=92,
            sensitivity_ms=50,
            hysteresis_ms=120,
            min_peak_g=0.096,
            stroke_threshold=0.5,
        )

    def test_field_firmware_keeps_stored_compatibility_values(self):
        stored, config = _energy_wire_config(self.device, "12.6.2")

        self.assertEqual(stored, 5000)
        self.assertGreaterEqual(config["count_sensitivity"], -40)
        self.assertLessEqual(config["count_sensitivity"], 40)
        self.assertEqual(config["sensitivity_ms"], 50)
        self.assertEqual(config["std_window"], 92)
        self.assertAlmostEqual(config["min_peak_g"], 0.096)

    def test_energy_firmware_receives_only_two_counting_values(self):
        stored, config = _energy_wire_config(self.device, "13.25.0")

        self.assertEqual(stored, 5000)
        self.assertEqual(config, {
            "count_sensitivity": 5000,
            "count_bridge_ms": 901,
        })


if __name__ == "__main__":
    unittest.main()
