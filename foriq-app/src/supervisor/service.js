// Generic process supervisor for one service:
// start, health checks, restart with backoff on crash/hang, clean stop.
//
// States: stopped · starting · running · unhealthy · backoff · stopping
//
// `detail` is a translatable message ({ key, params }, see ../i18n.js) or a plain
// string; main.js translates it for the UI, statusLogger() logs it in English.
const { spawn, execFileSync } = require("child_process");
const { EventEmitter } = require("events");
const fs = require("fs");
const path = require("path");
const { msg, errorText } = require("../i18n");

const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];
// Fast checks while starting or unhealthy (the UI turns green quickly), slow ones
// once healthy (idle cost).
const HEALTH_INTERVAL_MS = 2000;
const HEALTHY_INTERVAL_MS = 10000;
const STABLE_RESET_MS = 60000; // healthy this long → reset the backoff counter
const LOG_ROTATE_BYTES = 5 * 1024 * 1024;
const LOG_GENERATIONS = 3; // <name>.log.1 … .3

// <file>.2 → .3, <file>.1 → .2, <file> → .1 (the oldest generation is overwritten).
function rotateLogFiles(file, generations = LOG_GENERATIONS) {
  for (let i = generations - 1; i >= 1; i--) {
    try {
      fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`);
    } catch {}
  }
  try {
    fs.renameSync(file, `${file}.1`);
  } catch {}
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function psField(pid, field) {
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", `${field}=`], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

async function waitForExit(pid, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return !isAlive(pid);
}

// Kills an orphaned process left over from an earlier (crashed) app run.
// Guards against PID reuse: `identity` is either the start time ({ lstart })
// or a substring of the command line ({ command }).
async function killOrphan(pid, identity, signal = "SIGTERM") {
  if (!pid || !isAlive(pid)) return false;
  if (identity.lstart && psField(pid, "lstart") !== identity.lstart) return false;
  if (identity.command && !psField(pid, "command").includes(identity.command)) return false;
  try {
    process.kill(pid, signal);
  } catch {
    return false;
  }
  if (!(await waitForExit(pid, 10000))) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
    await waitForExit(pid, 3000);
  }
  return true;
}

class Service extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.name           technical name (log/PID file; UI label key service.<name>)
   * @param {string} o.label          display name for logs
   * @param {() => Promise<{cmd,args,env,cwd,port?}>} o.prepare  before every start
   * @param {() => Promise<boolean>} o.health
   * @param {() => Promise<void>} [o.afterHealthy]  once per process start (e.g. schema)
   * @param {string} [o.stopSignal]
   * @param {number} [o.stopTimeoutMs]
   * @param {number} [o.startTimeoutMs]
   * @param {number} [o.unhealthyRestartMs]
   * @param {() => string|object} [o.runningDetail]  status detail in state "running"
   * @param {number} [o.logRotateBytes]  rotate the log at this size (tests use a tiny value)
   */
  constructor(o) {
    super();
    this.o = {
      stopSignal: "SIGTERM",
      stopTimeoutMs: 8000,
      startTimeoutMs: 90000,
      unhealthyRestartMs: 45000,
      logRotateBytes: LOG_ROTATE_BYTES,
      ...o,
    };
    this.name = o.name;
    this.label = o.label;
    this.state = "stopped";
    this.detail = msg("svc.stopped");
    this.child = null;
    this.wanted = false;
    this.failures = 0;
    this.restarts = 0;
    this.port = null;
    this.lastLines = [];
  }

  status() {
    return {
      name: this.name,
      label: this.label,
      state: this.state,
      detail: this.detail,
      pid: this.child ? this.child.pid : null,
      port: this.port,
      restarts: this.restarts,
      lastLine: this.lastLines[this.lastLines.length - 1] || "",
    };
  }

  _set(state, detail) {
    this.state = state;
    this.detail = detail;
    this.emit("change", this.status());
  }

  get _pidFile() {
    return path.join(this.o.runDir, `${this.name}.pid`);
  }

  // The PID file holds PID + start time (guards against PID reuse).
  async cleanupOrphan() {
    try {
      const { pid, lstart } = JSON.parse(fs.readFileSync(this._pidFile, "utf8"));
      if (lstart && (await killOrphan(pid, { lstart }, this.o.stopSignal))) {
        this._log(`[supervisor] killed orphaned process ${pid}\n`);
      }
    } catch {}
    try {
      fs.unlinkSync(this._pidFile);
    } catch {}
  }

  // The child's stdout/stderr are pipes into this process (_capture), so rotating
  // only swaps our own write stream – the child never notices.
  _openLog() {
    this.logFile = path.join(this.o.logDir, `${this.name}.log`);
    try {
      this.logBytes = fs.statSync(this.logFile).size;
    } catch {
      this.logBytes = 0;
    }
    if (this.logBytes >= this.o.logRotateBytes) {
      rotateLogFiles(this.logFile);
      this.logBytes = 0;
    }
    this.logStream = fs.createWriteStream(this.logFile, { flags: "a" });
  }

  _log(text) {
    if (!this.logStream) return;
    if (this.logBytes >= this.o.logRotateBytes) {
      // Pending writes of the old stream still land in the renamed file (same inode).
      this.logStream.end();
      rotateLogFiles(this.logFile);
      this.logStream = fs.createWriteStream(this.logFile, { flags: "a" });
      this.logBytes = 0;
    }
    this.logStream.write(text);
    this.logBytes += Buffer.byteLength(text);
  }

  _capture(buf) {
    this._log(buf);
    for (const line of buf.toString("utf8").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      this.lastLines.push(t.slice(0, 300));
      if (this.lastLines.length > 40) this.lastLines.shift();
    }
  }

  async start() {
    if (this.wanted && (this.child || this.restartTimer)) return;
    this.wanted = true;
    this.failures = 0;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    if (!this.logStream) this._openLog();
    await this.cleanupOrphan();
    await this._launch();
  }

  async _launch() {
    this.restartTimer = null;
    if (!this.wanted) return;
    this._set("starting", msg("svc.starting"));
    let spec;
    try {
      spec = await this.o.prepare();
    } catch (err) {
      this._log(`[supervisor] prepare failed: ${err.stack || err}\n`);
      return this._scheduleRestart(errorText(err));
    }
    if (!this.wanted) return;
    if (spec.port) this.port = spec.port;

    this._log(`\n[supervisor] ${new Date().toISOString()} starting: ${spec.cmd} ${spec.args.join(" ")}\n`);
    const child = spawn(spec.cmd, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    this.startedAt = Date.now();
    this.afterDone = false;
    this.killReason = null;

    child.stdout.on("data", (d) => this._capture(d));
    child.stderr.on("data", (d) => this._capture(d));
    child.on("error", (err) => {
      this._capture(Buffer.from(`[supervisor] ${err.message}\n`));
      // ENOENT etc. emit no 'exit' – finish up ourselves.
      if (child.pid === undefined) this._onExit(child, null, null);
    });
    child.on("exit", (code, signal) => this._onExit(child, code, signal));

    if (child.pid) {
      const lstart = psField(child.pid, "lstart");
      fs.writeFileSync(this._pidFile, JSON.stringify({ pid: child.pid, lstart }));
      this._startHealthLoop(child);
    }
  }

  _onExit(child, code, signal) {
    if (this.child !== child) return;
    this.child = null;
    clearTimeout(this.healthTimer);
    try {
      fs.unlinkSync(this._pidFile);
    } catch {}
    this._log(`[supervisor] exited (code=${code}, signal=${signal})\n`);
    this.emit("exit");
    if (!this.wanted) {
      this._set("stopped", msg("svc.stopped"));
      return;
    }
    const why =
      this.killReason ||
      (signal ? msg("svc.crashed", { signal }) : msg("svc.exited", { code }));
    this._scheduleRestart(why);
  }

  _scheduleRestart(reason) {
    if (!this.wanted) return;
    const delay = BACKOFF_MS[Math.min(this.failures, BACKOFF_MS.length - 1)];
    this.failures += 1;
    this.restarts += 1;
    this._set("backoff", msg("svc.backoff", { reason, seconds: Math.round(delay / 1000) }));
    this.restartTimer = setTimeout(() => this._launch(), delay);
  }

  // Health checks as a setTimeout chain: the next check is scheduled only after
  // the previous one finished, with the interval depending on the state.
  _startHealthLoop(child) {
    clearTimeout(this.healthTimer);
    let lastOk = Date.now();
    let healthySince = null;
    const tick = async () => {
      if (this.child !== child || this.state === "stopping") return;
      this.healthBusy = true;
      try {
        let ok = false;
        try {
          ok = await this.o.health();
        } catch {
          ok = false;
        }
        if (this.child !== child || this.state === "stopping") return;
        const now = Date.now();

        if (ok) {
          lastOk = now;
          if (!this.afterDone && this.o.afterHealthy) {
            this._set("starting", msg("svc.settingUp"));
            try {
              await this.o.afterHealthy();
            } catch (err) {
              this._capture(Buffer.from(`[supervisor] setup failed: ${err.message}\n`));
              this._restart(msg("svc.setupFailed", { error: err.message }));
              return;
            }
          }
          this.afterDone = true;
          if (this.state !== "running") {
            healthySince = now;
            const detail = this.o.runningDetail
              ? this.o.runningDetail()
              : this.port ? msg("svc.runningPort", { port: this.port }) : msg("svc.running");
            this._set("running", detail);
            this.emit("healthy");
          } else if (healthySince && now - healthySince > STABLE_RESET_MS) {
            this.failures = 0;
          }
          return;
        }

        healthySince = null;
        if (this.state === "starting") {
          if (now - this.startedAt > this.o.startTimeoutMs) this._restart(msg("svc.startTimeout"));
        } else if (this.state === "running") {
          this._set("unhealthy", msg("svc.notResponding"));
        } else if (this.state === "unhealthy" && now - lastOk > this.o.unhealthyRestartMs) {
          this._restart(msg("svc.hung"));
        }
      } finally {
        this.healthBusy = false;
        if (this.child === child && this.state !== "stopping") this._scheduleHealth();
      }
    };
    this.healthTick = tick;
    this._scheduleHealth();
  }

  _scheduleHealth(delay) {
    clearTimeout(this.healthTimer);
    if (delay === undefined) delay = this.state === "running" ? HEALTHY_INTERVAL_MS : HEALTH_INTERVAL_MS;
    this.healthTimer = setTimeout(this.healthTick, delay);
  }

  // After wake from sleep or a network change: check right away instead of waiting
  // for the next cycle; a pending restart (backoff) is attempted immediately.
  checkNow() {
    if (!this.wanted) return;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this._launch();
    } else if (this.child && this.healthTick && !this.healthBusy) {
      this._scheduleHealth(0);
    }
  }

  _restart(reason) {
    const child = this.child;
    if (!child) return;
    this.killReason = reason;
    this._kill(child);
  }

  _kill(child) {
    return new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {}
      }, this.o.stopTimeoutMs);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        child.kill(this.o.stopSignal);
      } catch {
        resolve();
      }
    });
  }

  async stop() {
    this.wanted = false;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const child = this.child;
    if (!child) {
      this._set("stopped", msg("svc.stopped"));
      return;
    }
    this._set("stopping", msg("svc.stopping"));
    clearTimeout(this.healthTimer);
    await this._kill(child);
  }

  // Resolves once the service is healthy (false if it is stopped or times out).
  waitHealthy(timeoutMs = 120000) {
    if (this.state === "running") return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (ok) => {
        clearTimeout(timer);
        this.off("healthy", onHealthy);
        this.off("change", onChange);
        resolve(ok);
      };
      const onHealthy = () => done(true);
      const onChange = (s) => {
        if (s.state === "stopped") done(false);
      };
      const timer = setTimeout(() => done(false), timeoutMs);
      this.on("healthy", onHealthy);
      this.on("change", onChange);
    });
  }
}

module.exports = { Service, killOrphan, isAlive, rotateLogFiles };
