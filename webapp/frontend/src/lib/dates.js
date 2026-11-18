// Formatting of ISO calendar dates ("YYYY-MM-DD") from the API with the active
// Intl locale. Dates are built in local time (noon) so no time zone can shift
// them to the neighbouring day.

export function parseIsoDate(iso) {
  const [year, month, day] = String(iso).split("-").map(Number);
  return new Date(year, month - 1, day, 12);
}

export function formatIsoDate(iso, intlLocale, options) {
  return parseIsoDate(iso).toLocaleDateString(intlLocale, options);
}

/** Short weekday without a trailing period ("Mon" / "Mo"). */
export function formatWeekdayShort(iso, intlLocale) {
  return formatIsoDate(iso, intlLocale, { weekday: "short" }).replace(/\.$/, "");
}

/** Day and month, e.g. "03/11" (en-GB) or "03.11." (de-DE). */
export function formatDayMonth(iso, intlLocale) {
  return formatIsoDate(iso, intlLocale, { day: "2-digit", month: "2-digit" });
}

/** Week range, e.g. "03/11–09/11/2026" or "03.11.–09.11.2026". */
export function formatDateRange(startIso, endIso, intlLocale) {
  const end = formatIsoDate(endIso, intlLocale, { day: "2-digit", month: "2-digit", year: "numeric" });
  return `${formatDayMonth(startIso, intlLocale)}–${end}`;
}

/** Month and year, e.g. "November 2026". */
export function formatMonthYear(iso, intlLocale) {
  return formatIsoDate(iso, intlLocale, { month: "long", year: "numeric" });
}

/** Day of month for dense axes: "3" (en) or "3." (German ordinal style). */
export function formatDayOfMonth(iso, intlLocale) {
  const day = String(parseIsoDate(iso).getDate());
  return intlLocale.startsWith("de") ? `${day}.` : day;
}
