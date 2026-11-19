// Update check and in-app update (no Electron import, so it runs under plain node).
//
// Check: reads SHA256SUMS of the newest GitHub release
// (https://github.com/<repo>/releases/latest/download/SHA256SUMS, written by
// scripts/release-github.sh). Its line "<sha256>  Foriq-<version>-arm64.dmg" gives the
// newest version and the checksum – no GitHub API, no rate limit, no account.
// Without internet the check simply fails quietly; Foriq keeps running.
//
// Install (only when the user clicks): download the DMG to the cache, verify SHA-256,
// then start a detached helper and quit. The helper waits until every Foriq process
// has exited (services shut down cleanly), runs the bundled install.sh on the verified
// DMG (stages the copy next to the target, then swaps – a failed copy leaves the old
// app intact) and opens the app again: the new one, or the old one if anything failed.
// The data directory is never touched. Result: logs/update.log, and on failure
// update-failed.json, which the next start shows in the status window.
const { EventEmitter } = require("events");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");

const DMG_RE = /^([0-9a-f]{64})\s+\*?(Foriq-(\d+\.\d+\.\d+)-arm64\.dmg)\s*$/m;

function compareVersions(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
  }
  return 0;
}

function parseSums(textBody) {
  const m = DMG_RE.exec(textBody || "");
  return m ? { sha256: m[1], file: m[2], version: m[3] } : null;
}

class Updater extends EventEmitter {
  // opts: currentVersion, repo ("owner/name"), baseUrl (override of the release
  // download dir, for tests), cacheDir, logDir, userData, appPath (the running
  // Foriq.app, null in development), installScript (bundled install.sh), fetch.
  constructor(opts) {
    super();
    this.o = opts;
    this.fetch = opts.fetch || globalThis.fetch;
    this.base = opts.baseUrl || `https://github.com/${opts.repo}/releases/latest/download`;
    this.state = { phase: "idle", current: opts.currentVersion, latest: null, checkedAt: null, error: null };
    this.failedFile = path.join(opts.userData, "update-failed.json");
    this._loadFailure();
  }

  status() {
    return {
      ...this.state,
      canInstall: !!this.o.appPath,
      notesUrl: this.state.latest ? `https://github.com/${this.o.repo}/releases/tag/v${this.state.latest}` : null,
    };
  }

  _set(patch) {
    this.state = { ...this.state, ...patch };
    this.emit("state", this.status());
  }

  // A failed update of the previous run (written by the helper) – shown once.
  _loadFailure() {
    try {
      const f = JSON.parse(fs.readFileSync(this.failedFile, "utf8"));
      fs.rmSync(this.failedFile, { force: true });
      this.state.phase = "error";
      this.state.error = { key: "update.err.installFailed", params: { version: f.version || "?" } };
    } catch {}
  }

  async check() {
    if (["checking", "downloading", "installing"].includes(this.state.phase)) return this.status();
    this._set({ phase: "checking", error: null });
    try {
      const res = await this.fetch(`${this.base}/SHA256SUMS`, { redirect: "follow", signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const info = parseSums(await res.text());
      if (!info) throw new Error("no DMG in SHA256SUMS");
      this.release = info;
      const newer = compareVersions(info.version, this.o.currentVersion) > 0;
      this._set({ phase: newer ? "available" : "current", latest: info.version, checkedAt: Date.now() });
    } catch (err) {
      this._log(`check failed: ${err.message}`);
      this._set({ phase: "error", checkedAt: Date.now(), error: { key: "update.err.check" } });
    }
    return this.status();
  }

  // Downloads and verifies the DMG; resolves to its path.
  async download() {
    const rel = this.release;
    if (!rel) throw new Error("no release known");
    fs.mkdirSync(this.o.cacheDir, { recursive: true });
    const dest = path.join(this.o.cacheDir, rel.file);
    if (fs.existsSync(dest) && (await sha256(dest)) === rel.sha256) return dest;

    this._set({ phase: "downloading", progress: 0, error: null });
    const res = await this.fetch(`${this.base}/${rel.file}`, { redirect: "follow" });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const total = Number(res.headers.get("content-length")) || 0;
    let done = 0;
    let lastPct = -1;
    const hash = crypto.createHash("sha256");
    const tmp = `${dest}.part`;
    const counter = new (require("stream").Transform)({
      transform: (chunk, _enc, cb) => {
        done += chunk.length;
        hash.update(chunk);
        const pct = total ? Math.floor((done / total) * 100) : 0;
        if (pct !== lastPct) {
          lastPct = pct;
          this._set({ progress: pct });
        }
        cb(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(tmp));
    if (hash.digest("hex") !== rel.sha256) {
      fs.rmSync(tmp, { force: true });
      throw Object.assign(new Error("checksum mismatch"), { key: "update.err.checksum" });
    }
    fs.renameSync(tmp, dest);
    return dest;
  }

  // Download + verify, then hand over to the helper. Calls quit() once the helper
  // runs; the helper waits for the app to exit before it replaces anything.
  async install(quit) {
    if (!this.o.appPath) throw new Error("not installed");
    const target = path.dirname(this.o.appPath);
    try {
      fs.accessSync(target, fs.constants.W_OK);
    } catch {
      this._set({ phase: "error", error: { key: "update.err.notWritable", params: { dir: target } } });
      return;
    }
    let dmg;
    try {
      dmg = await this.download();
    } catch (err) {
      this._log(`download failed: ${err.message}`);
      this._set({ phase: "error", error: { key: err.key || "update.err.download" } });
      return;
    }
    this._set({ phase: "installing", progress: 100 });
    this._startHelper(dmg, target);
    quit();
  }

  _startHelper(dmg, installDir) {
    fs.mkdirSync(this.o.logDir, { recursive: true });
    const logFile = path.join(this.o.logDir, "update.log");
    const out = fs.openSync(logFile, "a");
    const child = spawn("/bin/bash", ["-c", HELPER, "foriq-update"], {
      detached: true,
      stdio: ["ignore", out, out],
      env: {
        ...process.env,
        APP: this.o.appPath,
        INSTALL_DIR: installDir,
        INSTALL_SH: this.o.installScript,
        DMG: dmg,
        SHA256: this.release.sha256,
        VERSION: this.release.version,
        FAILED_FILE: this.failedFile,
      },
    });
    child.unref();
    this._log(`helper started (pid ${child.pid}) for ${this.release.version}`);
  }

  _log(line) {
    try {
      fs.mkdirSync(this.o.logDir, { recursive: true });
      fs.appendFileSync(path.join(this.o.logDir, "update.log"), `${new Date().toISOString()} ${line}\n`);
    } catch {}
  }
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    fs.createReadStream(file).on("data", (d) => h.update(d)).on("end", () => resolve(h.digest("hex"))).on("error", reject);
  });
}

// Runs detached after the app quit. Waits (max. 2 min) until no process of the app
// bundle is left – Electron, backend and PostgreSQL – then installs and reopens.
const HELPER = `
set -u
log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; }
log "waiting for Foriq to quit ($APP)"
for i in $(seq 1 120); do
  pgrep -f "$APP/Contents/" >/dev/null 2>&1 || break
  sleep 1
done
if pgrep -f "$APP/Contents/" >/dev/null 2>&1; then
  log "Foriq did not quit – update cancelled"
  printf '{"version":"%s","reason":"still running"}' "$VERSION" > "$FAILED_FILE"
  exit 1
fi
log "installing $VERSION"
if FORIQ_ASSUME_YES=1 FORIQ_INSTALL_DIR="$INSTALL_DIR" bash "$INSTALL_SH" "file://$DMG" "$SHA256"; then
  log "installed $VERSION"
  rm -f "$DMG"
else
  log "install failed – keeping the current version"
  printf '{"version":"%s","reason":"install.sh failed"}' "$VERSION" > "$FAILED_FILE"
fi
# Keep FORIQ_* overrides (test instances: own data dir and ports) for the restart.
args=()
while IFS= read -r kv; do
  case "$kv" in FORIQ_ASSUME_YES=*|FORIQ_INSTALL_DIR=*) ;; FORIQ_*) args+=(--env "$kv") ;; esac
done < <(env)
open \${args[@]+"\${args[@]}"} "$INSTALL_DIR/$(basename "$APP")"
`;

module.exports = { Updater, compareVersions, parseSums, HELPER };
