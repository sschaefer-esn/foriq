import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const I18N = join(SRC, "lib/i18n");

const shape = (value) => (value && typeof value === "object" ? Object.keys(value).sort().join(",") : "string");

test("en and de areas define identical keys of the same shape", async () => {
  for (const file of readdirSync(join(I18N, "en"))) {
    const { default: en } = await import(join(I18N, "en", file));
    const { default: de } = await import(join(I18N, "de", file));
    assert.deepEqual(Object.keys(de).sort(), Object.keys(en).sort(), `key sets differ in ${file}`);
    for (const key of Object.keys(en)) {
      assert.equal(shape(de[key]), shape(en[key]), `shape differs for ${key}`);
    }
  }
});

test("no key is defined in more than one area", async () => {
  const seen = new Map();
  for (const file of readdirSync(join(I18N, "en"))) {
    if (file === "index.js") continue;
    const { default: dict } = await import(join(I18N, "en", file));
    for (const key of Object.keys(dict)) {
      assert.ok(!seen.has(key), `${key} defined in ${seen.get(key)} and ${file}`);
      seen.set(key, file);
    }
  }
});

function* sourceFiles(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (path !== I18N) yield* sourceFiles(path);
    } else if (/\.(js|jsx|mjs)$/.test(name)) {
      yield path;
    }
  }
}

test("every literal t()/translate() key used in src exists in en", async () => {
  const { default: en } = await import(join(I18N, "en/index.js"));
  const missing = [];
  let count = 0;
  for (const file of sourceFiles(SRC)) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/\b(?:t|translate)\(\s*["']([A-Za-z0-9_.-]+)["']/g)) {
      count += 1;
      if (!(match[1] in en)) missing.push(`${file.slice(SRC.length + 1)}: ${match[1]}`);
    }
  }
  assert.ok(count > 0, "no t() calls found");
  assert.deepEqual(missing, []);
});

test("German is the default locale, also outside the browser (prerender)", async () => {
  const { DEFAULT_LOCALE } = await import(join(I18N, "defaultLocale.js"));
  assert.equal(DEFAULT_LOCALE, "de");
  const i18n = await import(join(I18N, "index.js"));
  assert.equal(i18n.DEFAULT_LOCALE, "de");
  assert.equal(i18n.getLocale(), "de");
  assert.equal(i18n.getIntlLocale(), "de-DE");
  const { default: deDict } = await import(join(I18N, "de/index.js"));
  assert.equal(i18n.translate("common.pendingSettings.saveFailed"), deDict["common.pendingSettings.saveFailed"]);
  const { translateApiError } = await import(join(I18N, "apiErrors.js"));
  const de = (await import(join(I18N, "apiErrors.de.js"))).default;
  const [english, german] = Object.entries(de).find(([key]) => !key.includes("{"));
  assert.equal(translateApiError(english), german);
});

test("no browser-language detection and German static markup defaults", () => {
  const index = readFileSync(join(I18N, "index.js"), "utf8");
  const layout = readFileSync(join(SRC, "app/layout.js"), "utf8");
  const manifest = readFileSync(join(SRC, "app/manifest.js"), "utf8");
  assert.ok(!/navigator\.language/.test(index + layout), "navigator.language must not pick the locale");
  assert.match(layout, /<html lang="de"/);
  assert.match(manifest, /lang: "de-DE"/);
});
