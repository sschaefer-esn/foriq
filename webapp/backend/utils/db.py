import os
from sqlalchemy import create_engine
from config import DATABASE_URL

# Connection pool: set explicitly instead of SQLAlchemy's defaults (5+10).
# Values can be tuned via env to the Postgres connection limit; pool_recycle
# avoids stale connections (e.g. after a server idle timeout).
_POOL_SIZE = int(os.getenv("DB_POOL_SIZE", "20"))
_MAX_OVERFLOW = int(os.getenv("DB_MAX_OVERFLOW", "20"))
_POOL_RECYCLE = int(os.getenv("DB_POOL_RECYCLE", "1800"))


def engine_url(url: str) -> str:
    """Pin the psycopg2 driver: SQLAlchemy 2.1 maps a plain postgresql:// URL to
    psycopg 3. postgresql:// and postgres:// stay accepted in DATABASE_URL."""
    for prefix in ("postgresql://", "postgres://"):
        if url.startswith(prefix):
            return "postgresql+psycopg2://" + url[len(prefix):]
    return url


engine = create_engine(
    engine_url(DATABASE_URL),
    pool_size=_POOL_SIZE,
    max_overflow=_MAX_OVERFLOW,
    pool_recycle=_POOL_RECYCLE,
    pool_pre_ping=True,
    connect_args={"options": "-c timezone=UTC"},
)


def make_con():
    return engine.connect()
