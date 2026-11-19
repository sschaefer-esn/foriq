// App settings (userData/settings.json). Defaults: start at login and
// prevent sleep are on; language is the product default (i18n.DEFAULT_LOCALE).
const fs = require("fs");
const path = require("path");

const DEFAULTS = {
  preventSleep: true,
  // Autostart is registered only on the very first start. After that the state
  // of the macOS login items applies (the user can change it there).
  autostartInitialized: false,
  // Look for a new release once a day (only a check; installing needs a click).
  checkUpdates: true,
  // "en" | "de"; null = never chosen → i18n.DEFAULT_LOCALE ("de"), see i18n.resolveLocale.
  language: null,
};

class Settings {
  constructor(userData) {
    this.file = path.join(userData, "settings.json");
    let stored = {};
    try {
      stored = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {}
    this.values = { ...DEFAULTS, ...stored };
  }

  get(key) {
    return this.values[key];
  }

  set(key, value) {
    this.values[key] = value;
    fs.writeFileSync(this.file, JSON.stringify(this.values, null, 2));
  }
}

module.exports = { Settings };
