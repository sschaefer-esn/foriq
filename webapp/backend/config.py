import os
from dotenv import load_dotenv

load_dotenv()

# The Foriq app always sets DATABASE_URL itself; for development see the
# example in webapp/.env.example.
DATABASE_URL = os.getenv("DATABASE_URL", "").strip()
if not DATABASE_URL:
    raise RuntimeError(
        "DATABASE_URL is not set (e.g. postgresql://USER:PASSWORD@localhost:5432/foriq)."
    )

_JWT_DEV_DEFAULT = "dev-secret-change-in-production"
JWT_SECRET = os.getenv("JWT_SECRET", "")

# Fail fast: a missing JWT_SECRET, or one left at the dev default, makes ALL
# tokens forgeable. Better to abort at startup than to run silently with a
# publicly known secret.
if not JWT_SECRET or JWT_SECRET == _JWT_DEV_DEFAULT:
    raise RuntimeError(
        "JWT_SECRET is not set or still has the dev default. "
        "Set a strong, secret JWT_SECRET env variable (e.g. `openssl rand -hex 32`)."
    )

JWT_ALGORITHM = "HS256"
JWT_EXPIRATION_HOURS = 24

# Separate pepper for HMAC-hashed external API keys. Without an explicit value
# the external API stays closed.
API_KEY_HMAC_KEY = os.getenv("API_KEY_HMAC_KEY", "").strip()

# Optional pepper for HMAC-hashed device tokens and activation codes.
# Without a value the compatible plaintext token path stays active. A value
# that is set must be strong, so it does not create a false sense of security.
DEVICE_TOKEN_HMAC_KEY = os.getenv("DEVICE_TOKEN_HMAC_KEY", "").strip()
if DEVICE_TOKEN_HMAC_KEY and len(DEVICE_TOKEN_HMAC_KEY) < 32:
    raise RuntimeError(
        "DEVICE_TOKEN_HMAC_KEY is set but too short. Use at least "
        "32 characters or remove the optional variable entirely."
    )
