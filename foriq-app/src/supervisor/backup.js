// Daily database backup: pg_dump (custom format, compressed) into
// <userData>/backups/foriq-YYYYMMDD-HHMMSS.dump; the newest KEEP files are kept.
// A failed backup only shows as a warning – services are never stopped or
// restarted for it. Restore: see docs/self-hosting-macos.md.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { EventEmitter } = require("events");
const { pgToolPath } = require("./paths");
const { LocalizedError, errorText } = require("../i18n");

const execFileP = promisify(execFile);
const KEEP = 14;
const BACKUP_RE = /^foriq-\d{8}-\d{6}\.dump$/; // only files matching this are ever deleted
const PARTIAL_RE = /^foriq-\d{8}-\d{6}\.dump\.partial$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const FIRST_CHECK_MS = 60 * 1000; // shortly after start: backup if the newest is older than a day
const CHECK_MS = 60 * 60 * 1000; // then hourly (a failed backup is retried at the next check)
const DUMP_TIMEOUT_MS = 30 * 60 * 1000;

// Local time, so the file names read naturally in Finder; they sort chronologically.
function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// Our own backups in `dir`, oldest first.
function listBackups(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => BACKUP_RE.test(f)).sort();
  } catch {
    return [];
  }
}

// Deletes all but the newest `keep` backups plus leftovers of aborted runs.
// Other files in the directory are never touched. Returns the deleted names.
function prune(dir, keep = KEEP) {
  const all = listBackups(dir);
  const remove = all.slice(0, Math.max(0, all.length - keep));
  for (const f of fs.readdirSync(dir)) if (PARTIAL_RE.test(f)) remove.push(f);
  for (const f of remove) fs.rmSync(path.join(dir, f), { force: true });
  return remove;
}

class Backups extends EventEmitter {
  constructor({ paths, postgres, secrets }) {
    super();
    this.dir = paths.backupDir;
    this.postgres = postgres;
    this.secrets = secrets;
    this.running = false;
    this.error = null; // message of the last failure, cleared by the next success
    const newest = listBackups(this.dir).pop();
    this.lastAt = newest ? fs.statSync(path.join(this.dir, newest)).mtimeMs : null;
  }

  status() {
    return { lastAt: this.lastAt, error: this.error, running: this.running, dir: this.dir };
  }

  start() {
    this.stop();
    this.firstTimer = setTimeout(() => this._runIfDue(), FIRST_CHECK_MS);
    this.timer = setInterval(() => this._runIfDue(), CHECK_MS);
  }

  stop() {
    clearTimeout(this.firstTimer);
    clearInterval(this.timer);
  }

  _runIfDue() {
    if (this.lastAt && Date.now() - this.lastAt < DAY_MS) return;
    if (this.postgres.state !== "running") return; // skipped, retried at the next check
    this.run();
  }

  _log(line) {
    // Goes to logs/postgres.log ("Log" button of the database row).
    this.postgres._log(`[backup] ${new Date().toISOString()} ${line}\n`);
  }

  _changed() {
    this.emit("change", this.status());
  }

  // One backup now. Resolves true on success; never throws.
  async run() {
    if (this.running) return false;
    this.running = true;
    this._changed();
    const pg = this.postgres;
    const file = path.join(this.dir, `foriq-${stamp()}.dump`);
    const partial = `${file}.partial`;
    // Password via a private pgpass file, never on the command line.
    const pgpass = path.join(os.tmpdir(), `foriq-pgpass-${process.pid}-${Date.now()}`);
    try {
      if (pg.state !== "running") throw new LocalizedError("backup.err.dbNotRunning");
      const pgDump = pgToolPath("pg_dump");
      fs.mkdirSync(this.dir, { recursive: true });
      fs.chmodSync(this.dir, 0o700);
      const pw = this.secrets.postgresPassword.replace(/[\\:]/g, "\\$&");
      fs.writeFileSync(pgpass, `127.0.0.1:${pg.port}:${pg.dbName}:${pg.dbUser}:${pw}\n`, { mode: 0o600 });
      const t0 = Date.now();
      await execFileP(
        pgDump,
        [
          "--host=127.0.0.1",
          `--port=${pg.port}`,
          `--username=${pg.dbUser}`,
          `--dbname=${pg.dbName}`,
          "--no-password",
          "--format=custom", // compressed; restore with pg_restore
          `--file=${partial}`,
        ],
        { env: { PATH: process.env.PATH, LC_ALL: "C", PGPASSFILE: pgpass }, timeout: DUMP_TIMEOUT_MS }
      );
      fs.chmodSync(partial, 0o600);
      fs.renameSync(partial, file);
      this.lastAt = Date.now();
      this.error = null;
      const removed = prune(this.dir);
      const size = (fs.statSync(file).size / 1024 / 1024).toFixed(1);
      this._log(`wrote ${path.basename(file)} (${size} MB, ${Date.now() - t0} ms)` +
        (removed.length ? `, removed ${removed.join(", ")}` : ""));
      return true;
    } catch (err) {
      fs.rmSync(partial, { force: true });
      // pg_dump: its first stderr line says more than "Command failed: …".
      const stderr = err.stderr && err.stderr.trim().split("\n")[0].replace(/^pg_dump: (error: )?/, "");
      this.error = err.i18n || stderr || errorText(err);
      this._log(`FAILED: ${stderr || err.message}`);
      return false;
    } finally {
      fs.rmSync(pgpass, { force: true });
      this.running = false;
      this._changed();
    }
  }
}

module.exports = { Backups, prune, listBackups, KEEP };
