"""Product default language for user-visible text the backend writes itself.

The product currently targets the German market, so default names that end up
in the database (company, sensors, floor plan, notification rules) and the
labels of exported files default to German. Switching the product default to
English is the one line ``DEFAULT_LANG = "en"``. API error ``detail`` strings
and logs stay English (the web UI translates errors).
"""

DEFAULT_LANG = "de"

_DEFAULT_NAMES = {
    "en": {
        "company": "My company",
        "sensor": "New sensor {serial}",
        "layout": "Hall 1",
        "downtime_rule": "{device} – Downtime",
    },
    "de": {
        "company": "Meine Firma",
        "sensor": "Neuer Sensor {serial}",
        "layout": "Halle 1",
        "downtime_rule": "{device} – Stillstand",
    },
}


def default_name(key: str, **values) -> str:
    """Default name ``key`` in DEFAULT_LANG, with ``{placeholders}`` filled in."""
    return _DEFAULT_NAMES[DEFAULT_LANG][key].format(**values)
