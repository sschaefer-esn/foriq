// npm test (plain node): update check and download against a local HTTP server.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { Updater, compareVersions, parseSums } = require("../src/updater");

const DMG = Buffer.from("fake dmg content ".repeat(1000));
const SHA = crypto.createHash("sha256").update(DMG).digest("hex");

function serve(files) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const body = files[req.url];
      if (body === undefined) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "content-length": Buffer.byteLength(body) }).end(body);
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function updater(base, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foriq-updater-"));
  return new Updater({
    currentVersion: "0.1.0",
    repo: "owner/repo",
    baseUrl: base,
    userData: dir,
    cacheDir: path.join(dir, "cache"),
    logDir: path.join(dir, "logs"),
    appPath: null,
    installScript: null,
    ...extra,
  });
}

test("compareVersions and parseSums", () => {
  assert.equal(compareVersions("0.2.0", "0.1.9"), 1);
  assert.equal(compareVersions("0.10.0", "0.9.0"), 1);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  assert.equal(compareVersions("0.1.0", "0.1.1"), -1);
  assert.deepEqual(parseSums(`${SHA}  Foriq-0.2.0-arm64.dmg\n`), { sha256: SHA, file: "Foriq-0.2.0-arm64.dmg", version: "0.2.0" });
  assert.equal(parseSums("garbage"), null);
});

test("check finds a newer release and downloads it with a verified checksum", async () => {
  const server = await serve({
    "/SHA256SUMS": `${SHA}  Foriq-0.2.0-arm64.dmg\n`,
    "/Foriq-0.2.0-arm64.dmg": DMG,
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const u = updater(base);
    const s = await u.check();
    assert.equal(s.phase, "available");
    assert.equal(s.latest, "0.2.0");
    assert.equal(s.notesUrl, "https://github.com/owner/repo/releases/tag/v0.2.0");
    assert.equal(s.canInstall, false);
    const file = await u.download();
    assert.deepEqual(fs.readFileSync(file), DMG);
    assert.equal(u.status().progress, 100);
  } finally {
    server.close();
  }
});

test("same version is current; a damaged download is rejected", async () => {
  const server = await serve({
    "/SHA256SUMS": `${SHA}  Foriq-0.1.0-arm64.dmg\n`,
    "/Foriq-0.1.0-arm64.dmg": Buffer.from("something else"),
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const u = updater(base);
    assert.equal((await u.check()).phase, "current");
    await assert.rejects(u.download(), /checksum mismatch/);
    assert.equal(fs.readdirSync(u.o.cacheDir).length, 0);
  } finally {
    server.close();
  }
});

test("no network: the check fails quietly", async () => {
  const u = updater("http://127.0.0.1:9");
  const s = await u.check();
  assert.equal(s.phase, "error");
  assert.deepEqual(s.error, { key: "update.err.check" });
});

test("install refuses an unwritable install dir; a failure marker is shown once", async () => {
  const u = updater("http://127.0.0.1:9", { appPath: "/System/Foriq.app" });
  await u.install(() => assert.fail("must not quit"));
  assert.equal(u.status().error.key, "update.err.notWritable");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foriq-updater-"));
  fs.writeFileSync(path.join(dir, "update-failed.json"), JSON.stringify({ version: "0.2.0" }));
  const after = updater("http://127.0.0.1:9", { userData: dir });
  assert.deepEqual(after.status().error, { key: "update.err.installFailed", params: { version: "0.2.0" } });
  assert.equal(fs.existsSync(path.join(dir, "update-failed.json")), false);
});
