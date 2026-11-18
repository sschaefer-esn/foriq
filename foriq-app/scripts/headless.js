#!/usr/bin/env node
// Runs the supervisor without an Electron window (tests/debugging).
//   node scripts/headless.js [userDataDir]
// Default data dir same as the app: ~/Library/Application Support/Foriq
// Next to a running app: own data dir + FORIQ_PORT, FORIQ_PG_PORT,
// FORIQ_NO_MDNS=1 (otherwise the fixed ports 8420/54329 collide).
const path = require("path");
const { Supervisor, statusLogger } = require("../src/supervisor");
const { defaultUserData } = require("../src/constants");

const userData = path.resolve(process.argv[2] || process.env.FORIQ_USER_DATA || defaultUserData());

const sup = new Supervisor({ userData });
const logStatus = statusLogger();
sup.on("status", (s) => {
  const lines = logStatus(s);
  if (lines) console.log(`[${new Date().toLocaleTimeString("en-GB")}] ${lines.join("\n")}`);
});

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  console.log("Stopping services …");
  await sup.stopAll();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log(`Data dir: ${userData}`);
sup.startAll().then(() => {
  const s = sup.status();
  console.log(`Address: ${s.publicUrl}  (local: ${s.localUrl})`);
});
