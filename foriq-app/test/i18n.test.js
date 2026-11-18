// npm test (plain node, no Electron).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const i18n = require("../src/i18n");

test("en and de define identical keys", () => {
  assert.deepEqual(Object.keys(i18n.DICTS.de).sort(), Object.keys(i18n.DICTS.en).sort());
});

test("German is the default; only an explicit stored choice overrides it", () => {
  assert.equal(i18n.DEFAULT_LOCALE, "de");
  assert.equal(i18n.getLocale(), "de");
  assert.equal(i18n.resolveLocale(null), "de");
  assert.equal(i18n.resolveLocale(undefined), "de");
  assert.equal(i18n.resolveLocale("fr"), "de");
  assert.equal(i18n.resolveLocale("en"), "en");
  assert.equal(i18n.setLocale("xx"), "de");
  assert.equal(i18n.t("common.cancel"), i18n.DICTS.de["common.cancel"]);
  assert.equal(i18n.translate("en", "common.cancel"), i18n.DICTS.en["common.cancel"]);
  assert.equal(i18n.translate("de", "no.such.key"), "no.such.key");
  assert.equal(i18n.dictionary()["common.cancel"], i18n.DICTS.de["common.cancel"]);
});

test("status window markup is German before the strings arrive", () => {
  const html = fs.readFileSync(path.join(__dirname, "../src/ui/index.html"), "utf8");
  assert.match(html, /<html lang="de">/);
  for (const [, key, content] of html.matchAll(/data-i18n="([^"]+)">([^<]*)</g)) {
    assert.equal(content, i18n.DICTS.de[key], key);
  }
  assert.match(html, /<option value="de" selected>/);
});
