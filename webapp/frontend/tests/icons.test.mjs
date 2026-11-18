import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const publicDir = new URL("../public/", import.meta.url);
const exists = (url) => fs.existsSync(new URL(url.replace(/^\//, ""), publicDir));

test("icons referenced by layout and manifest exist in public/", () => {
  const sources = ["../src/app/layout.js", "../src/app/manifest.js"]
    .map((rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8"))
    .join("\n");
  const urls = [...sources.matchAll(/["'](\/[\w.-]+\.(?:svg|png|ico))["']/g)].map((m) => m[1]);
  assert.ok(urls.length > 0);
  for (const url of urls) assert.ok(exists(url), `missing public${url}`);
});

test("conventional icon URLs requested by browsers exist", () => {
  // Browsers fetch /favicon.ico without a <link>; /apple-touch-icon-precomposed.png
  // is aliased to /apple-touch-icon.png by the backend (frontend_static.py).
  for (const url of ["/favicon.ico", "/apple-touch-icon.png"]) {
    assert.ok(exists(url), `missing public${url}`);
  }
});
