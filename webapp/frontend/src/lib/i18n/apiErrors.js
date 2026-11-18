// Translation of backend error details (`detail`). Pure functions, no React,
// so they are usable from plain helpers and unit tests.

import apiErrorsDe from "./apiErrors.de.js";
import { DEFAULT_LOCALE } from "./defaultLocale.js";

// Pydantic prefixes messages of `raise ValueError(...)` in validators with this.
const VALUE_ERROR_PREFIX = /^Value error,\s*/;
const PLACEHOLDER = /\{(\w+)\}/g;

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Split a map into exact entries and {placeholder} templates. */
function compile(map) {
  const exact = {};
  const templates = [];
  for (const [english, translated] of Object.entries(map)) {
    const names = [...english.matchAll(PLACEHOLDER)].map((match) => match[1]);
    if (!names.length) {
      exact[english] = translated;
      continue;
    }
    const pattern = english.split(PLACEHOLDER)
      .map((part, index) => (index % 2 ? "(.+?)" : escapeRegExp(part)))
      .join("");
    templates.push({ regex: new RegExp(`^${pattern}$`), names, translated });
  }
  return { exact, templates };
}

const TABLES = { de: compile(apiErrorsDe) };

/** Translated text for a known English backend message; otherwise the message itself. */
export function translateApiError(detail, locale = DEFAULT_LOCALE) {
  if (typeof detail !== "string") return detail;
  const message = detail.replace(VALUE_ERROR_PREFIX, "");
  const table = TABLES[locale];
  if (!table) return message;
  if (typeof table.exact[message] === "string") return table.exact[message];
  for (const { regex, names, translated } of table.templates) {
    const match = message.match(regex);
    if (!match) continue;
    const values = Object.fromEntries(names.map((name, index) => [name, match[index + 1]]));
    return translated.replace(PLACEHOLDER, (whole, name) => (name in values ? values[name] : whole));
  }
  return message;
}

/**
 * User-facing text for a `detail` value: a string, or FastAPI's validation
 * array of `{ msg, loc }` (messages translated and joined). Null if empty.
 */
export function apiDetailMessage(detail, locale = DEFAULT_LOCALE) {
  if (typeof detail === "string" && detail) return translateApiError(detail, locale);
  if (Array.isArray(detail)) {
    const messages = detail
      .map((entry) => (typeof entry?.msg === "string" ? translateApiError(entry.msg, locale) : ""))
      .filter(Boolean);
    const unique = [...new Set(messages)];
    if (unique.length) return unique.join(" · ");
  }
  return null;
}
