// Orchestration: Postgres → backend (API + web UI on the public port),
// plus foriq.local via mDNS and the daily database backup.
const fs = require("fs");
const { EventEmitter } = require("events");
const { dataPaths } = require("./paths");
const { loadOrCreateSecrets } = require("./secrets");
const { requirePort } = require("./ports");
const { createPostgres } = require("./postgres");
const { createBackend, httpStatus } = require("./apps");
const { createMdns, lanIp } = require("./mdns");
const { Backups } = require("./backup");
const { HOSTNAME, PUBLIC_PORT, POSTGRES_PORT } = require("../constants");
const { msg, text } = require("../i18n");

// Fixed ports, deliberately no fallback: sensors have the address baked in.
// FORIQ_PORT/FORIQ_PG_PORT only for test instances next to the running app.
const FORIQ_PORT = parseInt(process.env.FORIQ_PORT || String(PUBLIC_PORT), 10);
const PG_PORT = parseInt(process.env.FORIQ_PG_PORT || String(POSTGRES_PORT), 10);

// Self-test via our own LAN IP: that is the only way sensors and other computers
// reach us. If localhost answers but the LAN IP does not, the macOS firewall is
// almost always blocking the (unsigned) app.
const LAN_PROBE_MS = 10000;

class Supervisor extends EventEmitter {
  constructor({ userData }) {
    super();
    this.paths = dataPaths(userData);
    for (const dir of [this.paths.userData, this.paths.logDir, this.paths.runDir, this.paths.backupDir]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.secrets = loadOrCreateSecrets(this.paths.secretsFile);
    this.running = false;
    this.lanOk = null; // null = unknown

    const { paths, secrets } = this;
    this.postgres = createPostgres({
      paths,
      secrets,
      getPort: requirePort(PG_PORT, "127.0.0.1"),
    });
    this.backend = createBackend({
      paths,
      secrets,
      postgres: this.postgres,
      getPort: requirePort(FORIQ_PORT, "0.0.0.0"),
    });
    this.mdns = createMdns({ paths, port: FORIQ_PORT });

    // FORIQ_NO_MDNS=1: test instances next to a running app do not announce foriq.local.
    this.mdnsEnabled = process.env.FORIQ_NO_MDNS !== "1";
    this.services = [this.postgres, this.backend];
    if (this.mdnsEnabled) this.services.push(this.mdns);
    for (const svc of this.services) svc.on("change", () => this._changed());
    this.backups = new Backups({ paths, postgres: this.postgres, secrets });
    this.backups.on("change", () => this._changed());

    this.backend.on("healthy", () => {
      this._writeRuntime();
      setTimeout(() => this._probeLan(), 1500);
    });
  }

  publicUrl() {
    return `http://${HOSTNAME}:${FORIQ_PORT}`;
  }

  localUrl() {
    return `http://localhost:${FORIQ_PORT}`;
  }

  // Backend row: running but unreachable from the LAN → yellow with a firewall
  // hint (does not restart the service).
  _serviceStatus(svc) {
    const s = svc.status();
    if (svc === this.backend && s.state === "running" && this.lanOk === false) {
      return { ...s, state: "unhealthy", detail: msg("svc.firewall") };
    }
    return s;
  }

  status() {
    const services = this.services.map((s) => this._serviceStatus(s));
    const states = services.map((s) => s.state);
    let overall = "stopped";
    if (this.running) {
      if (states.every((s) => s === "running")) overall = "running";
      else if (states.includes("backoff")) overall = "error";
      else if (states.some((s) => s === "starting" || s === "stopping" || s === "stopped")) overall = "starting";
      else overall = "warning";
      // A failed backup does not touch the services, but is worth a yellow light.
      if (overall === "running" && this.backups.error) overall = "warning";
    }
    return {
      running: this.running,
      overall,
      services,
      // Web UI reachable: backend healthy (only then open the browser).
      ready: this.running && this.backend.state === "running",
      lanOk: this.lanOk,
      backup: this.backups.status(),
      publicUrl: this.publicUrl(),
      localUrl: this.localUrl(),
      ip: this.mdns.ip(),
      userData: this.paths.userData,
    };
  }

  _changed() {
    clearTimeout(this._debounce);
    this._debounce = setTimeout(() => this.emit("status", this.status()), 50);
  }

  async _probeLan() {
    if (this.backend.state !== "running") return;
    const ip = lanIp();
    if (!ip) return;
    const ok = (await httpStatus(FORIQ_PORT, "/health", 3000, ip)) > 0;
    if (ok !== this.lanOk) {
      this.lanOk = ok;
      this._changed();
    }
  }

  _writeRuntime() {
    const runtime = {
      ports: {
        postgres: this.postgres.port,
        backend: this.backend.port,
      },
      publicUrl: this.publicUrl(),
      localUrl: this.localUrl(),
      pid: process.pid,
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(this.paths.runtimeFile, JSON.stringify(runtime, null, 2));
  }

  async startAll() {
    if (this.running) return;
    this.running = true;
    this.lanOk = null;
    this._changed();
    clearInterval(this.probeTimer);
    this.probeTimer = setInterval(() => this._probeLan(), LAN_PROBE_MS);
    if (this.mdnsEnabled) this.mdns.start();
    this.backups.start();

    await this.postgres.start();
    if (!(await this.postgres.waitHealthy(180000)) || !this.running) return;

    await this.backend.start();
  }

  async stopAll() {
    this.running = false;
    clearInterval(this.probeTimer);
    this.backups.stop();
    this.lanOk = null;
    this._changed();
    // Reverse order; Postgres last (clean shutdown, no recovery needed).
    await this.mdns.stop();
    await this.backend.stop();
    await this.postgres.stop();
    this._changed();
  }

  // Wake from sleep / network change: look at the LAN address now (not at the next
  // health cycle), re-register foriq.local if it changed, check all services.
  // Healthy services are not restarted.
  refreshNetwork() {
    if (!this.running) return;
    const ip = lanIp({ fresh: true });
    if (this.mdnsEnabled && this.mdns.child && ip !== this.mdns.ip()) {
      this.mdns._restart(msg("svc.networkChanged"));
    }
    for (const svc of this.services) svc.checkNow();
    this._probeLan();
  }

  async restartService(name) {
    const svc = this.services.find((s) => s.name === name);
    if (!svc || !this.running) return;
    if (svc._restart && svc.child) svc._restart(msg("svc.manualRestart"));
    else {
      await svc.stop();
      await svc.start();
    }
  }
}

// Status changes as text lines for stdout (main.js in development, headless.js),
// always in English. Returns null while the service states are unchanged.
function statusLogger() {
  let last = "";
  return (s) => {
    const line = s.services.map((x) => `${x.name}=${x.state}`).join(" ");
    if (line === last) return null;
    last = line;
    const problems = s.services
      .filter((x) => x.state === "unhealthy" || x.state === "backoff")
      .map((x) => `    ${x.name}: ${text(x.detail, "en")}${x.lastLine ? ` | ${x.lastLine}` : ""}`);
    return [`${s.overall.padEnd(8)} ${line}`, ...problems];
  };
}

module.exports = { Supervisor, statusLogger };
