"""Central product defaults for the energy detector."""

import math

DEFAULT_COUNT_BRIDGE_MS = 1500
USER_TIMING_FACTOR = 1.0

# Sensitivity slider in basis points (1000 = counts more, 9999 = stricter).
MIN_COUNT_SENSITIVITY_BP = 1000
MAX_COUNT_SENSITIVITY_BP = 9999
DEFAULT_COUNT_SENSITIVITY_BP = 3594

def normalize_count_sensitivity(value):
    """New basis-point semantics; convert old -40..40 values safely during rollout."""
    try:
        raw = int(value)
    except (TypeError, ValueError):
        return DEFAULT_COUNT_SENSITIVITY_BP
    if MIN_COUNT_SENSITIVITY_BP <= raw <= MAX_COUNT_SENSITIVITY_BP:
        return raw
    if raw == 0:
        return DEFAULT_COUNT_SENSITIVITY_BP
    if -40 <= raw <= 40:
        base_logit = math.log(0.7 / 0.3)
        cutoff = 1.0 / (1.0 + math.exp(-(base_logit - raw * math.log(2.0) / 20.0)))
        return max(MIN_COUNT_SENSITIVITY_BP,
                   min(MAX_COUNT_SENSITIVITY_BP, round(cutoff * 10000)))
    return DEFAULT_COUNT_SENSITIVITY_BP


def sensitivity_to_legacy_offset(value):
    """Map the energy slider onto the old ``-40..40`` wire field during rollout.

    This is purely a temporary protocol adapter for field devices not yet
    updated via OTA. No server-side inference takes place.
    """
    cutoff = normalize_count_sensitivity(value) / 10000.0
    base_logit = math.log(0.7 / 0.3)
    offset = (base_logit - math.log(cutoff / (1.0 - cutoff))) / (math.log(2.0) / 20.0)
    return max(-40, min(40, round(offset)))
