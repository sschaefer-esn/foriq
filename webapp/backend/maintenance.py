"""Small, idempotent retention pass for non-core data."""

import asyncio
import logging

from sqlalchemy import text

from utils.db import make_con


logger = logging.getLogger(__name__)
INTERVAL_S = 24 * 60 * 60
AUDIT_RETENTION_DAYS = 90
NOTIFICATION_RETENTION_DAYS = 180
# Hits are accepted for at most 400 days. Deduplication receipts are kept ten
# days longer so late firmware retries are not counted twice.
HIT_RECEIPT_RETENTION_DAYS = 410


def run_retention_once():
    with make_con() as con:
        audits = con.execute(
            text(
                "DELETE FROM audit_logs WHERE created_at < "
                "NOW() - CAST(:days AS integer) * INTERVAL '1 day'"
            ),
            {"days": AUDIT_RETENTION_DAYS},
        ).rowcount
        incidents = con.execute(
            text(
                "DELETE FROM notification_incidents WHERE resolved_at IS NOT NULL "
                "AND resolved_at < NOW() - CAST(:days AS integer) * INTERVAL '1 day'"
            ),
            {"days": NOTIFICATION_RETENTION_DAYS},
        ).rowcount
        hit_receipts = con.execute(
            text(
                "DELETE FROM device_hit_receipts WHERE recorded_at < "
                "NOW() - CAST(:days AS integer) * INTERVAL '1 day'"
            ),
            {"days": HIT_RECEIPT_RETENTION_DAYS},
        ).rowcount
        # Expired activation claims are deliberately kept: a reset sensor uses
        # them to prove via its setup code that it is the same device
        # (devices.py).
        con.commit()

    logger.info(
        "Retention: audits=%d incidents=%d hit_receipts=%d",
        audits,
        incidents,
        hit_receipts,
    )


async def retention_loop():
    while True:
        try:
            await asyncio.to_thread(run_retention_once)
            await asyncio.sleep(INTERVAL_S)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Retention pass failed")
            await asyncio.sleep(60 * 60)
