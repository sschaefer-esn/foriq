// Bundled PostgreSQL (EDB binaries from @embedded-postgres/darwin-arm64).
// Data dir in the user's Library, initdb on first start, schema.sql on EVERY
// start (idempotent – covers first setup and updates).
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { Client } = require("pg");
const { Service, killOrphan } = require("./service");
const { pgBinDir, SCHEMA_FILE } = require("./paths");

const execFileP = promisify(execFile);
const DB_USER = "foriq";
const DB_NAME = "foriq";

async function initdbIfNeeded(dataDir, password, log) {
  if (fs.existsSync(path.join(dataDir, "PG_VERSION"))) return false;
  fs.mkdirSync(path.dirname(dataDir), { recursive: true });
  // Discard a half-done dir from an aborted initdb (it holds no data yet).
  if (fs.existsSync(dataDir)) fs.rmSync(dataDir, { recursive: true, force: true });

  const pwFile = path.join(os.tmpdir(), `foriq-pw-${process.pid}`);
  fs.writeFileSync(pwFile, password, { mode: 0o600 });
  try {
    const { stdout, stderr } = await execFileP(
      path.join(pgBinDir(), "initdb"),
      [
        "-D", dataDir,
        "-U", DB_USER,
        "--pwfile", pwFile,
        "--auth=scram-sha-256",
        "-E", "UTF8",
        "--no-locale",
      ],
      { env: { PATH: process.env.PATH, LC_ALL: "C" } }
    );
    log(stdout + stderr);
  } finally {
    fs.rmSync(pwFile, { force: true });
  }
  return true;
}

// An orphaned postmaster from a crashed app run blocks the data dir.
async function stopStalePostmaster(dataDir, log) {
  const pidFile = path.join(dataDir, "postmaster.pid");
  if (!fs.existsSync(pidFile)) return;
  const pid = parseInt(fs.readFileSync(pidFile, "utf8").split("\n")[0], 10);
  // SIGINT = "fast shutdown" (clean, without waiting for clients).
  if (await killOrphan(pid, { command: "bin/postgres" }, "SIGINT")) {
    log(`[supervisor] stopped orphaned postmaster ${pid}\n`);
  }
}

function createPostgres({ paths, secrets, getPort }) {
  const conn = (database) => ({
    host: "127.0.0.1",
    port: svc.port,
    user: DB_USER,
    password: secrets.postgresPassword,
    database,
    connectionTimeoutMillis: 2000,
  });

  async function query(database, sql) {
    const client = new Client(conn(database));
    await client.connect();
    try {
      return await client.query(sql);
    } finally {
      await client.end();
    }
  }

  const svc = new Service({
    name: "postgres",
    label: "Database",
    logDir: paths.logDir,
    runDir: paths.runDir,
    stopSignal: "SIGINT",
    stopTimeoutMs: 20000,
    startTimeoutMs: 60000,
    unhealthyRestartMs: 60000,
    async prepare() {
      const log = (t) => svc._log(t);
      await stopStalePostmaster(paths.pgData, log);
      if (await initdbIfNeeded(paths.pgData, secrets.postgresPassword, log)) {
        log("[supervisor] created new data dir\n");
      }
      const port = await getPort();
      return {
        cmd: path.join(pgBinDir(), "postgres"),
        args: [
          "-D", paths.pgData,
          "-p", String(port),
          "-c", "listen_addresses=127.0.0.1",
          // No Unix sockets in /tmp → no collision with other Postgres instances.
          "-c", "unix_socket_directories=",
          "-c", "logging_collector=off",
          // Small single-user install: modest memory and connection limits
          // (defaults: 128MB / 100). Budget: backend pool ≤ 10 (apps.js) + health
          // check, schema, backup and a psql session. Durability settings stay default.
          "-c", "shared_buffers=64MB",
          "-c", "max_connections=20",
        ],
        env: { PATH: process.env.PATH, LC_ALL: "C" },
        cwd: paths.pgData,
        port,
      };
    },
    async health() {
      await query("postgres", "SELECT 1");
      return true;
    },
    async afterHealthy() {
      const exists = await query("postgres", {
        text: "SELECT 1 FROM pg_database WHERE datname = $1",
        values: [DB_NAME],
      });
      if (exists.rowCount === 0) {
        await query("postgres", `CREATE DATABASE ${DB_NAME} OWNER ${DB_USER} ENCODING 'UTF8' TEMPLATE template0`);
        svc._log("[supervisor] created database foriq\n");
      }
      // schema.sql as one simple query (multiple statements, DO $$ blocks are fine).
      const sql = fs.readFileSync(SCHEMA_FILE, "utf8");
      const t0 = Date.now();
      await query(DB_NAME, sql);
      svc._log(`[supervisor] applied schema.sql (${Date.now() - t0} ms)\n`);
    },
  });

  svc.dbUser = DB_USER;
  svc.dbName = DB_NAME;
  svc.databaseUrl = () =>
    `postgresql://${DB_USER}:${secrets.postgresPassword}@127.0.0.1:${svc.port}/${DB_NAME}`;
  return svc;
}

module.exports = { createPostgres };
