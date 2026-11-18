import csv
import io
import json
import unittest
from collections import namedtuple

from openpyxl import load_workbook

from export import (
    _SINGLE_COLS,
    _build_xlsx,
    _single_records,
    _spreadsheet_cell,
    _to_csv,
    _to_json,
)


Hit = namedtuple("Hit", "local_date local_time gforce recorded_at")


def _sample_data(name="Press 1", serial="S3-001"):
    return {
        "device-1": {
            "name": name,
            "serial": serial,
            "rows": [
                Hit("2026-08-17", "08:15:00", 1.234, "2026-08-17 06:15:00"),
                Hit("2026-08-17", "08:16:00", 2.0, "2026-08-17 06:16:00"),
            ],
        }
    }


class ExportTests(unittest.TestCase):
    def test_spreadsheet_formula_prefixes_are_neutralized(self):
        for value in ("=1+1", "+cmd", "-2+3", "@SUM(A1:A2)", "  =1+1", "\t=1+1"):
            with self.subTest(value=value):
                self.assertEqual(_spreadsheet_cell(value), "'" + value)

        self.assertEqual(_spreadsheet_cell("Press 1"), "Press 1")
        self.assertEqual(_spreadsheet_cell(-1.25), -1.25)

    def test_csv_and_xlsx_neutralize_customer_controlled_cells(self):
        data = _sample_data(name="=HYPERLINK(\"https://example.invalid\")", serial="+cmd")
        records = _single_records(data)

        csv_rows = list(csv.reader(io.StringIO(_to_csv(_SINGLE_COLS, records).lstrip("\ufeff")), delimiter=";"))
        self.assertTrue(csv_rows[1][0].startswith("'="))
        self.assertEqual(csv_rows[1][1], "'+cmd")

        xlsx = _build_xlsx(data, "single")
        workbook = load_workbook(xlsx, read_only=True, data_only=False)
        row = next(workbook["Export"].iter_rows(min_row=2, values_only=True))
        self.assertTrue(row[0].startswith("'="))
        self.assertEqual(row[1], "'+cmd")
        workbook.close()
        xlsx.close()

    def test_csv_json_and_xlsx_share_the_same_canonical_rows(self):
        data = _sample_data()
        records = _single_records(data)

        json_rows = json.loads(_to_json(records))
        csv_rows = list(csv.reader(io.StringIO(_to_csv(_SINGLE_COLS, records).lstrip("\ufeff")), delimiter=";"))[1:]

        xlsx = _build_xlsx(data, "single")
        workbook = load_workbook(xlsx, read_only=True, data_only=False)
        xlsx_rows = list(workbook["Export"].iter_rows(min_row=2, values_only=True))
        workbook.close()
        xlsx.close()

        expected = [[str(row[key]) if not isinstance(row[key], float) else f"{row[key]:.2f}" for key, _ in _SINGLE_COLS] for row in json_rows]
        normalized_xlsx = []
        for row in xlsx_rows:
            normalized = [str(value) for value in row]
            normalized[4] = f"{float(row[4]):.2f}"
            normalized_xlsx.append(normalized)

        self.assertEqual(csv_rows, expected)
        self.assertEqual(normalized_xlsx, expected)


if __name__ == "__main__":
    unittest.main()
