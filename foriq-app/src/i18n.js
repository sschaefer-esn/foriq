// Minimal i18n for the app: German by default (DEFAULT_LOCALE), English selectable.
//
// Locale: explicit choice from settings.json ("language") → else DEFAULT_LOCALE.
// The system language is deliberately ignored. Lookup falls back
// chosen locale → DEFAULT_LOCALE → en → key. No electron import, so the module
// (and the supervisor that uses it for English log text) runs under plain node.
//
// The supervisor and the sensor manager do not know the active locale: they
// produce messages as { key, params } (see msg()), which main.js translates at
// the UI boundary with text(). Params may themselves be messages.
const DICTS = {
  en: require("./i18n/en"),
  de: require("./i18n/de"),
};
const LOCALES = Object.keys(DICTS);
const NUMBER_LOCALE = { en: "en-US", de: "de-DE" };
// Product default UI language. Switching the default to English is this one line.
const DEFAULT_LOCALE = "de";

let current = DEFAULT_LOCALE;

function interpolate(s, vars) {
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined || vars[k] === null ? m : String(vars[k])));
}

function translate(locale, key, vars) {
  for (const loc of [locale, DEFAULT_LOCALE, "en"]) {
    const dict = DICTS[loc];
    if (dict && dict[key] !== undefined) return interpolate(dict[key], vars);
  }
  return interpolate(key, vars);
}

function t(key, vars) {
  return translate(current, key, vars);
}

function msg(key, params) {
  return params ? { key, params } : { key };
}

function isMsg(m) {
  return !!m && typeof m === "object" && typeof m.key === "string";
}

// Message (or plain string, passed through) → text in the given locale.
function text(m, locale = current) {
  if (m === null || m === undefined || typeof m === "string") return m;
  if (!isMsg(m)) return String(m);
  const params = {};
  for (const [k, v] of Object.entries(m.params || {})) params[k] = isMsg(v) ? text(v, locale) : v;
  return translate(locale, m.key, params).trim();
}

// Error carrying a translatable message; .message stays English for logs.
class LocalizedError extends Error {
  constructor(key, params) {
    super(translate("en", key, params));
    this.i18n = msg(key, params);
  }
}

// What to show for an error: its message object if it has one, else its text.
function errorText(err) {
  return (err && err.i18n) || (err && err.message) || String(err);
}

// Explicit choice from settings.json, else the product default (system language ignored).
function resolveLocale(stored) {
  return LOCALES.includes(stored) ? stored : DEFAULT_LOCALE;
}

function setLocale(locale) {
  current = LOCALES.includes(locale) ? locale : DEFAULT_LOCALE;
  return current;
}

function getLocale() {
  return current;
}

function numberLocale(locale = current) {
  return NUMBER_LOCALE[locale] || NUMBER_LOCALE[DEFAULT_LOCALE];
}

// Full dictionary for the renderer (same fallback order as translate()).
function dictionary(locale = current) {
  return { ...DICTS.en, ...DICTS[DEFAULT_LOCALE], ...(DICTS[locale] || {}) };
}

module.exports = {
  LOCALES,
  DEFAULT_LOCALE,
  DICTS,
  t,
  translate,
  text,
  msg,
  LocalizedError,
  errorText,
  resolveLocale,
  setLocale,
  getLocale,
  numberLocale,
  dictionary,
};
