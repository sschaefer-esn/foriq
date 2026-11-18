// Secrets are generated exactly once on first start and stay stable afterwards
// (otherwise logins, device tokens and the DB login would become invalid).
// Never regenerate or rotate an existing key here: deviceTokenHmacKey in
// particular signs the tokens every paired sensor holds – changing it (or
// deleting secrets.json) locks out all sensors until they are paired again.
// Older installations may still contain "nextauthSecret" – it is ignored.
const fs = require("fs");
const crypto = require("crypto");

const KEYS = [
  "postgresPassword",
  "jwtSecret",
  "deviceTokenHmacKey",
  "apiKeyHmacKey",
  "appKey", // local app endpoints (sensor via USB), see src/sensor/
];

function loadOrCreateSecrets(file) {
  let secrets = {};
  if (fs.existsSync(file)) {
    // Older versions could leave the file readable by others: tighten it on every load.
    fs.chmodSync(file, 0o600);
    secrets = JSON.parse(fs.readFileSync(file, "utf8"));
  }
  let changed = false;
  for (const key of KEYS) {
    // Only generate missing keys. "" is a deliberate value (an existing
    // installation that uses no key for this purpose) and is kept.
    if (secrets[key] === undefined) {
      secrets[key] = crypto.randomBytes(32).toString("hex");
      changed = true;
    }
  }
  if (changed) {
    // Atomic: a crash mid-write must never leave a truncated secrets.json behind.
    const tmp = `${file}.tmp`;
    fs.rmSync(tmp, { force: true }); // a leftover would keep its old mode
    fs.writeFileSync(tmp, JSON.stringify(secrets, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
  return secrets;
}

module.exports = { loadOrCreateSecrets };
