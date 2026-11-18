"""TRANSITION(fw<14): translation between the old (German) and the new device protocol.

Firmware up to 13.x uses German field names, firmware 14 only the English ones.
Internally the backend uses the new names exclusively; this module is the only
place that knows the old names:

- upstream_aliases(): incoming device data (current_config) -> new names
- add_legacy_sync_keys() / add_legacy_hit_keys(): add the old keys (and the
  inert learning-mode zero values) to outgoing configuration

Release B: delete this module and all its call sites once every sensor reports
firmware 14.
"""

# old wire name -> new wire name (used in both directions)
LEGACY_CONFIG_KEYS = {
    "uebertragung_intervall_s": "upload_interval_s",
    "sleep_nach_min": "sleep_after_min",
    "neustart_plan": "restart_schedule",
}

# Firmware < 13.25 reads the old detector threshold under this name.
LEGACY_STROKE_THRESHOLD_KEY = "schlag_schwelle"


def upstream_aliases(data):
    """Map old field names in an incoming dict to the new ones.

    A new name sent alongside takes precedence. Unknown fields are left
    untouched (Pydantic ignores them).
    """
    if not isinstance(data, dict):
        return data
    result = dict(data)
    for old, new in LEGACY_CONFIG_KEYS.items():
        if old in result:
            value = result.pop(old)
            result.setdefault(new, value)
    return result


def _add_old_names(config):
    for old, new in LEGACY_CONFIG_KEYS.items():
        if new in config:
            config[old] = config[new]
    return config


def add_legacy_sync_keys(config):
    """Make the settings sync response readable for firmware 13.x.

    Without the learning/calibration keys firmware 13.x keeps its last
    recording state; fixed zero values stop running recordings, acknowledge
    consume acks and disable the auto trigger.
    """
    _add_old_names(config)
    config.update({
        "lernmodus": 0,
        "kalibrierung": 0,
        "kalibrierung_alle_events": 0,
        "kalibrierung_event_count": 0,
    })
    return config


def add_legacy_hit_keys(config):
    """Hit response for firmware 13.x (which also reads lernmodus from here)."""
    _add_old_names(config)
    config["lernmodus"] = 0
    return config
