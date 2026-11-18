import unittest

from fastapi import HTTPException

from utils.auth_utils import check_new_password, hash_password, verify_password

# Created with bcrypt 4.3.0 (the version before bcrypt 5).
BCRYPT4_HASH = "$2b$12$PI1ah/qPkcaDa1IYJOkfa.VEBI7R4MKCW3q6lnmF6yDa5Z368VUwi"  # "correct horse battery"
BCRYPT4_LONG_HASH = "$2b$12$n4sSi9ixFXm38y7XTFOXm.5BJdyODNNe10heAviNGkrKAYaIVWqoy"  # "x" * 80


class PasswordPolicyTests(unittest.TestCase):
    def _detail(self, password):
        with self.assertRaises(HTTPException) as ctx:
            check_new_password(password)
        self.assertEqual(ctx.exception.status_code, 400)
        return ctx.exception.detail

    def test_rejects_short_password(self):
        self.assertEqual(self._detail("short"), "Password must be at least 8 characters")

    def test_rejects_password_longer_than_bcrypt_limit(self):
        self.assertEqual(self._detail("a" * 73), "Password must be at most 72 bytes")
        # The limit counts UTF-8 bytes, not characters: 37 x "ä" = 74 bytes.
        self.assertEqual(self._detail("ä" * 37), "Password must be at most 72 bytes")

    def test_accepts_password_at_the_limit_and_it_round_trips(self):
        password = "a" * 72
        check_new_password(password)
        self.assertTrue(verify_password(password, hash_password(password)))

    def test_overlong_login_password_is_rejected_without_error(self):
        stored = hash_password("a" * 72)
        self.assertFalse(verify_password("b" * 100, stored))

    def test_hash_from_bcrypt_4_still_verifies(self):
        self.assertTrue(verify_password("correct horse battery", BCRYPT4_HASH))
        self.assertFalse(verify_password("wrong horse battery", BCRYPT4_HASH))

    def test_long_password_set_with_bcrypt_4_still_logs_in(self):
        # bcrypt 4 truncated to 72 bytes when hashing; login with the full password works.
        self.assertTrue(verify_password("x" * 80, BCRYPT4_LONG_HASH))


if __name__ == "__main__":
    unittest.main()
