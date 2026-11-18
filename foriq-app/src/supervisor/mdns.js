// Publishes foriq.local on the LAN (macOS: dns-sd proxy registration with the
// system mDNSResponder – no multicast stack of our own, no root, the computer is
// not renamed), as a supervised child process. Re-registers when the IP changes.
const os = require("os");
const { execFileSync } = require("child_process");
const { Service } = require("./service");
const { LocalizedError } = require("../i18n");
const { APP_NAME, HOSTNAME } = require("../constants");

// The default interface needs a /sbin/route process; health checks, the LAN probe
// and the status window all ask for it, so cache it briefly. The IP itself is
// read fresh every time (no process). fresh=true after wake/network changes.
const ROUTE_CACHE_MS = 10000;
let routeCache = { at: 0, iface: null };

function defaultInterface(fresh) {
  if (!fresh && Date.now() - routeCache.at < ROUTE_CACHE_MS) return routeCache.iface;
  let iface = null;
  try {
    const out = execFileSync("/sbin/route", ["-n", "get", "default"], { encoding: "utf8", timeout: 2000 });
    const m = out.match(/interface:\s*(\S+)/);
    iface = m ? m[1] : null;
  } catch {}
  routeCache = { at: Date.now(), iface };
  return iface;
}

function lanIp({ fresh = false } = {}) {
  const ifaces = os.networkInterfaces();
  const v4 = (name) => (ifaces[name] || []).find((a) => a.family === "IPv4" && !a.internal);
  const def = defaultInterface(fresh);
  if (def && v4(def)) return v4(def).address;
  for (const name of Object.keys(ifaces)) {
    if (/^en\d+$/.test(name) && v4(name)) return v4(name).address;
  }
  return null;
}

function createMdns({ paths, port }) {
  let registeredIp = null;
  const svc = new Service({
    name: "mdns",
    label: "Network name",
    logDir: paths.logDir,
    runDir: paths.runDir,
    stopSignal: "SIGTERM",
    stopTimeoutMs: 3000,
    startTimeoutMs: 15000,
    unhealthyRestartMs: 1000,
    runningDetail: () => `${HOSTNAME} → ${registeredIp}`,
    async prepare() {
      const ip = lanIp();
      if (!ip) throw new LocalizedError("err.noNetwork");
      registeredIp = ip;
      return {
        cmd: "/usr/bin/dns-sd",
        args: ["-P", APP_NAME, "_http._tcp", "local", String(port), HOSTNAME, ip],
        env: { PATH: process.env.PATH },
        cwd: paths.userData,
      };
    },
    async health() {
      // IP changed (other Wi-Fi, DHCP) → unhealthy → re-registration.
      return lanIp() === registeredIp;
    },
  });
  svc.hostname = HOSTNAME;
  svc.ip = () => registeredIp;
  return svc;
}

module.exports = { createMdns, lanIp, HOSTNAME };
