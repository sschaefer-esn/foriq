import unittest

from utils.db import engine, engine_url


class EngineUrlTests(unittest.TestCase):
    def test_plain_postgres_urls_use_psycopg2(self):
        for url in ("postgresql://u:p@h:5432/db", "postgres://u:p@h:5432/db"):
            self.assertEqual(engine_url(url), "postgresql+psycopg2://u:p@h:5432/db")

    def test_explicit_driver_is_kept(self):
        url = "postgresql+psycopg2://u:p@h/db"
        self.assertEqual(engine_url(url), url)

    def test_engine_uses_psycopg2(self):
        self.assertEqual(engine.dialect.driver, "psycopg2")


if __name__ == "__main__":
    unittest.main()
