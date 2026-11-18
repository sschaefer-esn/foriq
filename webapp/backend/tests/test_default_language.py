import unittest

import export
from layouts import CreateLayoutRequest
from utils import default_language
from utils.default_language import DEFAULT_LANG, default_name


class DefaultLanguageTests(unittest.TestCase):
    def test_product_default_is_german(self):
        self.assertEqual(DEFAULT_LANG, "de")

    def test_default_names_are_german(self):
        self.assertEqual(default_name("company"), "Meine Firma")
        self.assertEqual(default_name("sensor", serial="A1B2C3"), "Neuer Sensor A1B2C3")
        self.assertEqual(default_name("layout"), "Halle 1")
        self.assertEqual(default_name("downtime_rule", device="Presse 1"), "Presse 1 – Stillstand")
        self.assertEqual(CreateLayoutRequest().name, "Halle 1")

    def test_name_tables_define_the_same_keys(self):
        tables = default_language._DEFAULT_NAMES
        self.assertEqual(set(tables["en"]), set(tables["de"]))
        self.assertIn(DEFAULT_LANG, tables)

    def test_export_labels_default_to_german(self):
        self.assertEqual(set(export._LABELS["en"]), set(export._LABELS["de"]))
        self.assertEqual(dict(export._SINGLE_COLS)["device"], "Gerät")
        self.assertIn('<html lang="de">', export._to_html(export._DEVICE_COLS, [], "Test"))


if __name__ == "__main__":
    unittest.main()
