import unittest

from utils.activation_code import normalize_activation_code


class ActivationCodeTests(unittest.TestCase):
    def test_normalizes_word_code_to_lowercase(self):
        self.assertEqual(
            normalize_activation_code(" This-Is-Activation "),
            "this-is-activation",
        )

    def test_keeps_legacy_code_compatible(self):
        self.assertEqual(
            normalize_activation_code("abcdefgh2345"),
            "ABCDEFGH2345",
        )

    def test_rejects_codes_with_wrong_word_count_or_characters(self):
        for code in ("this-is", "this-is-activation-extra", "this_is-activation"):
            with self.subTest(code=code):
                with self.assertRaises(ValueError):
                    normalize_activation_code(code)


if __name__ == "__main__":
    unittest.main()
