import assert from "node:assert/strict";
import test from "node:test";
import { apiDetailMessage, translateApiError } from "../src/lib/i18n/apiErrors.js";
import { notificationMessage } from "../src/lib/notificationMessage.js";
import { formatDateRange, formatDayOfMonth, formatWeekdayShort } from "../src/lib/dates.js";
import en from "../src/lib/i18n/en/index.js";
import de from "../src/lib/i18n/de/index.js";

test("exact backend messages are translated to German and kept in English", () => {
  assert.equal(translateApiError("Device not found", "de"), "Gerät nicht gefunden");
  assert.equal(translateApiError("Device not found", "en"), "Device not found");
  assert.equal(translateApiError("Something unknown", "de"), "Something unknown");
  assert.equal(
    translateApiError("Password must be at most 72 bytes", "de"),
    "Passwort darf höchstens 72 Byte lang sein",
  );
});

test("templates translate interpolated messages", () => {
  assert.equal(
    translateApiError("Press 3 already belongs to rule Night shift", "de"),
    "Press 3 gehört bereits zur Regel Night shift",
  );
  assert.equal(
    translateApiError("At most 100 devices can be selected per export", "de"),
    "Maximal 100 Geräte pro Export auswählbar",
  );
});

test("validation arrays are unprefixed, translated and joined", () => {
  const detail = [
    { loc: ["body", "name"], msg: "Value error, Name must not be empty" },
    { loc: ["body", "weekly_windows"], msg: "Value error, Time windows must not overlap" },
    { loc: ["body", "x"], msg: "Value error, Time windows must not overlap" },
  ];
  assert.equal(
    apiDetailMessage(detail, "de"),
    "Name darf nicht leer sein · Zeitfenster dürfen sich nicht überschneiden",
  );
  assert.equal(apiDetailMessage(detail, "en"), "Name must not be empty · Time windows must not overlap");
  assert.equal(apiDetailMessage([], "de"), null);
  assert.equal(apiDetailMessage(undefined, "de"), null);
});

function translator(dict) {
  return (key, vars) => dict[key].replace(/\{(\w+)\}/g, (m, name) => vars[name]);
}

test("notification messages are composed from codes", () => {
  const tDe = translator(de);
  const tEn = translator(en);
  const base = { device_name: "Press 3", message: "server text" };
  assert.equal(notificationMessage({ ...base, alert_type: "no_hits" }, tDe),
    "Maschine Press 3 steht im überwachten Zeitraum.");
  assert.equal(notificationMessage({ ...base, alert_type: "device_offline" }, tDe),
    "Sensor Press 3 ist nicht erreichbar.");
  assert.equal(notificationMessage({ ...base, alert_type: "no_hits", resolved_at: "x", resolution: "activity_resumed" }, tDe),
    "Maschine Press 3 zählt wieder.");
  assert.equal(notificationMessage({ ...base, alert_type: "device_offline", resolved_at: "x", resolution: "sleep_mode" }, tEn),
    "Offline alert for Press 3 was closed because of sleep mode.");
  assert.equal(notificationMessage({ ...base, alert_type: "something_new" }, tDe), "server text");
});

test("ISO dates are formatted with the active locale", () => {
  assert.equal(formatWeekdayShort("2026-11-03", "de-DE"), "Di");
  assert.equal(formatWeekdayShort("2026-11-03", "en-GB"), "Tue");
  assert.equal(formatDateRange("2026-11-02", "2026-11-08", "de-DE"), "02.11.–08.11.2026");
  assert.equal(formatDayOfMonth("2026-11-03", "de-DE"), "3.");
  assert.equal(formatDayOfMonth("2026-11-03", "en-GB"), "3");
});
