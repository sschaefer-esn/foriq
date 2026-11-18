// Sensor on USB: detect, set up (flash + Wi-Fi), erase.
//
// The USB work is done by firmware-cpp/tools/app_flasher.py (in the bundle as
// `foriq-backend flasher …`), which emits JSON lines. Here: port polling, one
// operation at a time, approval/deletion in the backend via the local app
// endpoints (/api/v1/devices/app/*, header X-Foriq-App-Key).
//
// User-facing text in the state (message, error.msg/hint, result.dbNote,
// networks.error) is either a translatable message ({ key, params }) or free
// text from the flasher, shown as-is; main.js translates before sending it to
// the window. Confirmation dialogs are shown right away, so they use t() directly.
const { execFile, spawn } = require("child_process");
const { EventEmitter } = require("events");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { APP_DIR, BACKEND_BIN, FIRMWARE_DIR, REPO_DIR, PYTHON } = require("../supervisor/paths");
const { t, msg, translate, numberLocale } = require("../i18n");

const POLL_MS = 2000;
const FLASHER_SCRIPT = path.join(REPO_DIR, "firmware-cpp", "tools", "app_flasher.py");

function flasherCommand(args) {
  if (BACKEND_BIN) return { cmd: BACKEND_BIN, args: ["flasher", ...args] };
  return { cmd: PYTHON, args: [FLASHER_SCRIPT, ...args] };
}

function factoryImage(target) {
  const base = FIRMWARE_DIR
    ? path.join(FIRMWARE_DIR, "factory")
    : path.join(APP_DIR, "build", "firmware");
  return path.join(base, target, "factory.bin");
}

function exec(cmd, args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout }, (err, stdout) => resolve(err ? null : stdout));
  });
}

// Wi-Fi networks this Mac knows (readable without a prompt). Order = macOS priority.
async function macKnownNetworks() {
  const ports = await exec("/usr/sbin/networksetup", ["-listallhardwareports"]);
  const m = ports && ports.match(/Hardware Port: Wi-Fi\s*\nDevice: (\S+)/);
  if (!m) return [];
  const out = await exec("/usr/sbin/networksetup", ["-listpreferredwirelessnetworks", m[1]]);
  if (!out) return [];
  return out.split("\n").slice(1).map((l) => l.trim()).filter(Boolean);
}

// msg/hint: plain text (from the flasher) or a translatable message object.
// .message stays English for logs.
class FlashError extends Error {
  constructor(text, hint) {
    super(typeof text === "string" ? text : translate("en", text.key, text.params));
    this.text = text;
    this.hint = hint || null;
  }
}

// Start the flasher; onEvent receives log/progress, the promise the result.
function runFlasher(args, { onEvent, stdin } = {}) {
  return new Promise((resolve, reject) => {
    const { cmd, args: full } = flasherCommand(args);
    const child = spawn(cmd, full, {
      env: { PATH: process.env.PATH || "/usr/bin:/bin", HOME: process.env.HOME, LANG: "en_US.UTF-8", PYTHONUNBUFFERED: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buf = "";
    let result = null;
    let error = null;
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith("{")) continue;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (ev.event === "result") result = ev;
        else if (ev.event === "error") error = ev;
        else if (onEvent) onEvent(ev);
      }
    });
    child.stderr.on("data", (c) => (stderr = (stderr + c.toString("utf8")).slice(-2000)));
    child.on("error", (err) => reject(new FlashError(msg("sensor.err.helperStart", { error: err.message }))));
    child.on("close", (code) => {
      if (code === 0 && result) return resolve(result);
      if (error) return reject(new FlashError(error.msg, error.hint));
      reject(new FlashError(msg("sensor.err.helperExit", { code, tail: stderr.trim().split("\n").pop() || "" })));
    });
    if (stdin !== undefined) child.stdin.write(stdin + "\n");
    child.stdin.end();
  });
}

class SensorManager extends EventEmitter {
  constructor({ supervisor, confirm, isVisible }) {
    super();
    this.supervisor = supervisor;
    this.confirm = confirm; // async ({message, detail, ok}) → bool
    this.isVisible = isVisible;
    this.state = { phase: "idle", stick: null, info: null };
    this._timer = null;
    this._polling = false;
  }

  start() {
    if (!this._timer) this._timer = setInterval(() => this._poll(), POLL_MS);
    this._poll();
  }

  status() {
    return this.state;
  }

  _set(patch) {
    this.state = { ...this.state, ...patch };
    this.emit("state", this.state);
  }

  _busy() {
    return this.state.phase === "busy";
  }

  // ─── Detection ───────────────────────────────────────────────
  async _poll() {
    if (this._polling || this._busy() || !this.isVisible()) return;
    this._polling = true;
    try {
      const { sticks } = await runFlasher(["ports"]);
      const stick = sticks[0] || null;
      const prev = this.state.stick;
      const same = prev && stick && (prev.usb_id ? prev.usb_id === stick.usb_id : prev.port === stick.port);
      // Only treat as unplugged after two empty polls (USB re-enumeration).
      this._missing = stick ? 0 : (this._missing || 0) + 1;
      if (!stick) {
        if (prev && this._missing >= 2) this._set({ phase: "idle", stick: null, info: null, error: null, result: null, networks: null, progress: null });
      } else if (!same) {
        this._set({ phase: "idle", stick, info: { state: "checking" }, error: null, result: null, networks: null, progress: null, multiple: sticks.length > 1 });
        await this._inspect(false);
      } else if (prev.port !== stick.port) {
        this._set({ stick });
      }
    } catch (err) {
      console.error("[sensor] port poll:", err.message);
    } finally {
      this._polling = false;
    }
  }

  async _inspect(deep) {
    const { stick } = this.state;
    if (!stick) return null;
    let info;
    try {
      info = await runFlasher(["inspect", "--port", stick.port, "--target", stick.target, ...(deep ? ["--deep"] : [])]);
    } catch (err) {
      info = { state: "unknown", note: err.message };
    }
    if (info.port && info.port !== stick.port) this.state.stick = { ...stick, port: info.port };
    if (info.serial) info.foriq = await this._lookup(info.serial);
    this._set({ info });
    return info;
  }

  // ─── Backend ─────────────────────────────────────────────────
  _api(method, urlPath, body) {
    const port = this.supervisor.backend && this.supervisor.backend.port;
    const key = this.supervisor.secrets && this.supervisor.secrets.appKey;
    if (!port || !key) return Promise.resolve({ status: 0, data: null });
    const payload = body ? JSON.stringify(body) : null;
    return new Promise((resolve) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          path: urlPath,
          method,
          timeout: 8000,
          headers: {
            "X-Foriq-App-Key": key,
            ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
          },
        },
        (res) => {
          let text = "";
          res.on("data", (c) => (text += c));
          res.on("end", () => {
            let data = null;
            try {
              data = text ? JSON.parse(text) : null;
            } catch {}
            resolve({ status: res.statusCode, data });
          });
        }
      );
      req.on("timeout", () => req.destroy());
      req.on("error", () => resolve({ status: 0, data: null }));
      if (payload) req.write(payload);
      req.end();
    });
  }

  async _lookup(serial) {
    const res = await this._api("GET", `/api/v1/devices/app/lookup?serial=${encodeURIComponent(serial)}`);
    return res.status === 200 ? res.data : null;
  }

  // ─── Actions ─────────────────────────────────────────────────
  async _run(fn) {
    if (this._busy()) return;
    const { stick } = this.state;
    if (!stick) return;
    // A running detection may hold the port open – wait for it.
    while (this._polling) await new Promise((r) => setTimeout(r, 100));
    this._set({ phase: "busy", error: null, result: null, networks: null, progress: { step: "start", pct: 0 }, message: null });
    try {
      await fn(stick);
    } catch (err) {
      this._set({ phase: "error", progress: null, error: { msg: err.text || err.message, hint: err.hint || null } });
    }
  }

  _onFlasherEvent = (ev) => {
    if (ev.event === "progress") this._set({ progress: { step: ev.step, pct: ev.pct } });
    else if (ev.event === "log") this._set({ message: ev.msg });
  };

  setup({ name } = {}) {
    return this._run(async (stick) => {
      const { info } = this.state;
      if (info && info.state === "foriq") {
        const label = info.foriq && info.foriq.known
          ? t("sensor.labelNamed", { name: info.foriq.name })
          : t("sensor.labelSerial", { serial: info.serial });
        const ok = await this.confirm({
          message: t("sensor.reflash.message"),
          detail: t("sensor.reflash.detail", { label }),
          ok: t("sensor.reflash.ok"),
        });
        if (!ok) return this._set({ phase: "idle", progress: null });
      }
      const image = factoryImage(stick.target);
      if (!fs.existsSync(image)) {
        throw new FlashError(msg("sensor.err.imageMissing", { path: image }), msg("sensor.err.imageMissingHint"));
      }

      const ident = await runFlasher(
        ["flash", "--port", stick.port, "--target", stick.target, "--image", image],
        { onEvent: this._onFlasherEvent }
      );
      const current = { ...stick, port: ident.port || stick.port };
      this._set({ stick: current, info: { ...ident, state: "foriq" }, message: msg("sensor.registering") });

      const res = await this._api("POST", "/api/v1/devices/app/provision", {
        serial_number: ident.serial,
        setup_password: ident.setup,
        ...(name ? { name } : {}),
      });
      const approved = res.status === 200 && res.data && res.data.status === "approved";
      this._set({
        phase: "wifi",
        progress: null,
        message: null,
        result: { serial: ident.serial, setup: ident.setup, approved, name: res.data && res.data.name },
      });
      this.scan();
    });
  }

  // Wi-Fi networks the sensor sees, with the ones this Mac knows on top.
  scan() {
    const { stick } = this.state;
    if (!stick || this.state.phase !== "wifi" || this._scanning) return;
    this._set({ networks: { loading: true, list: (this.state.networks && this.state.networks.list) || [] } });
    this._scanning = (async () => {
      try {
        const [res, known] = await Promise.all([runFlasher(["scan", "--port", stick.port]), macKnownNetworks()]);
        const rank = new Map(known.map((ssid, i) => [ssid, i]));
        const list = res.networks
          .filter((n) => n.ssid !== "Foriq-Setup") // setup access point of other sensors
          .map((n) => ({ ssid: n.ssid, rssi: n.rssi, known: rank.has(n.ssid) }))
          .sort((a, b) => (a.known !== b.known ? (a.known ? -1 : 1) : a.known ? rank.get(a.ssid) - rank.get(b.ssid) : b.rssi - a.rssi));
        if (this.state.phase === "wifi") this._set({ networks: { list } });
      } catch (err) {
        if (this.state.phase === "wifi") this._set({ networks: { list: [], error: err.text || err.message } });
      } finally {
        this._scanning = null;
      }
    })();
  }


  wifi({ ssid, password, server }) {
    if (this.state.phase !== "wifi" || !this.state.result) return;
    const result = this.state.result;
    const networks = this.state.networks;
    return this._run(async (stick) => {
      if (this._scanning) await this._scanning; // port is only free once the scan is done
      this._set({ progress: { step: "wifi", pct: 0 }, message: msg("sensor.sendingWifi") });
      const args = ["wifi", "--port", stick.port, "--ssid", ssid];
      if (server) args.push("--server", server);
      try {
        const res = await runFlasher(args, { onEvent: this._onFlasherEvent, stdin: password || "" });
        this._set({ phase: "done", progress: null, message: null, result: { ...result, ip: res.ip, via: "usb" } });
      } catch (err) {
        // Back to the Wi-Fi form so a typo can be corrected.
        this._set({ phase: "wifi", progress: null, message: null, result, networks, error: { msg: err.text || err.message, hint: err.hint } });
      }
    });
  }

  portal() {
    if (this.state.phase !== "wifi") return;
    this._set({ phase: "done", error: null, result: { ...this.state.result, via: "portal" } });
  }

  remove() {
    return this._run(async (stick) => {
      this._set({ message: msg("sensor.reading") });
      let info = this.state.info;
      if (!info || info.state !== "foriq") info = await this._inspect(true);
      const known = info && info.foriq && info.foriq.known;
      const hits = known ? Number(info.foriq.hits || 0).toLocaleString(numberLocale()) : null;
      const ok = await this.confirm({
        message: known ? t("sensor.delete.knownMessage", { name: info.foriq.name }) : t("sensor.delete.blankMessage"),
        detail: known
          ? t("sensor.delete.knownDetail", { hits })
          : info && info.serial
            ? t("sensor.delete.unknownDetail", { serial: info.serial })
            : t("sensor.delete.detail"),
        ok: t("sensor.delete.ok"),
      });
      if (!ok) return this._set({ phase: "idle", progress: null, message: null });

      await runFlasher(["erase", "--port", stick.port, "--target", stick.target], { onEvent: this._onFlasherEvent });
      let dbNote = null;
      if (known) {
        const res = await this._api("DELETE", `/api/v1/devices/app/by-serial/${encodeURIComponent(info.serial)}`);
        if (res.status !== 200) dbNote = msg("sensor.dbNote");
      }
      this._set({
        phase: "deleted",
        progress: null,
        message: null,
        info: { state: "blank" },
        result: { name: known ? info.foriq.name : null, dbNote },
      });
    });
  }

  dismiss() {
    if (this._busy()) return;
    this._set({ phase: "idle", error: null, result: null, networks: null, progress: null, message: null });
    if (this.state.stick) this._inspect(false);
  }
}

module.exports = { SensorManager };
