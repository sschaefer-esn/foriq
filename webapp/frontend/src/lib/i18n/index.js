"use client";

// Minimal UI translation layer: German is the default (DEFAULT_LOCALE), English is
// selectable. The locale is the stored choice ("foriq-locale") or DEFAULT_LOCALE;
// the browser language is deliberately ignored. The static export is prerendered
// in DEFAULT_LOCALE (defined in ./defaultLocale.js).
// Dictionaries are flat objects ("area.key": "text") split by area under en/ and de/.
// A value may be a plural object { one, other }, chosen by vars.count.

import { useEffect, useSyncExternalStore } from "react";
import en from "./en/index.js";
import de from "./de/index.js";
import { apiDetailMessage as detailMessage } from "./apiErrors.js";
import { DEFAULT_LOCALE } from "./defaultLocale.js";

export const LOCALES = ["en", "de"];
export { DEFAULT_LOCALE };
const STORAGE_KEY = "foriq-locale";
const DICTIONARIES = { en, de };
// Locale tags for Intl/toLocale* (24-hour clock in both languages).
const INTL_LOCALES = { en: "en-GB", de: "de-DE" };

const listeners = new Set();
let current = null;
const warned = new Set();

function detectLocale() {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (LOCALES.includes(stored)) return stored;
  } catch {
    // localStorage unavailable
  }
  return DEFAULT_LOCALE;
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Active locale ("en" | "de"); always DEFAULT_LOCALE outside the browser (static export). */
export function getLocale() {
  if (typeof window === "undefined") return DEFAULT_LOCALE;
  if (current === null) current = detectLocale();
  return current;
}

const getServerLocale = () => DEFAULT_LOCALE;

export function setLocale(next) {
  if (!LOCALES.includes(next)) return;
  current = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // keep the choice for this page load only
  }
  if (typeof document !== "undefined") document.documentElement.lang = next;
  for (const listener of listeners) listener();
}

/** Intl locale tag for a UI locale (defaults to the active one). */
export function getIntlLocale(locale = getLocale()) {
  return INTL_LOCALES[locale] || INTL_LOCALES[DEFAULT_LOCALE];
}

function lookup(locale, key) {
  // Fallback order: chosen locale → DEFAULT_LOCALE → en → key.
  const value = DICTIONARIES[locale]?.[key] ?? DICTIONARIES[DEFAULT_LOCALE][key] ?? DICTIONARIES.en[key];
  if (value === undefined) {
    if (process.env.NODE_ENV !== "production" && !warned.has(key)) {
      warned.add(key);
      console.warn(`[i18n] missing key: ${key}`);
    }
    return key;
  }
  return value;
}

function format(locale, key, vars) {
  let value = lookup(locale, key);
  if (value && typeof value === "object") {
    value = vars?.count === 1 ? value.one : value.other;
  }
  if (!vars) return value;
  return value.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match));
}

/** Translate outside React (event handlers, helpers). Inside components prefer useT(). */
export function translate(key, vars) {
  return format(getLocale(), key, vars);
}

/** Text for a backend `detail` (string or validation array), or null. */
export function apiDetailMessage(detail, locale = getLocale()) {
  return detailMessage(detail, locale);
}

/**
 * Active locale for rendering. Hydration uses DEFAULT_LOCALE (what the static
 * HTML was prerendered with) and switches to a stored choice right after.
 */
export function useLocale() {
  const locale = useSyncExternalStore(subscribe, getLocale, getServerLocale);
  return { locale, setLocale, intlLocale: getIntlLocale(locale) };
}

// One stable translator function per locale (safe as a hook dependency).
const translators = Object.fromEntries(
  LOCALES.map((locale) => [locale, (key, vars) => format(locale, key, vars)]),
);

export function useT() {
  const { locale } = useLocale();
  return translators[locale];
}

/** Keeps <html lang> in sync with the active locale. */
export function LocaleProvider({ children }) {
  const { locale } = useLocale();
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  return children;
}
