// Backend (FastAPI/uvicorn) as a service: API, /health and the static web UI
// (Next.js export, FORIQ_FRONTEND_DIR) on ONE port for browsers and sensors.
const fs = require("fs");
const http = require("http");
const path = require("path");
const { Service } = require("./service");
const { LocalizedError } = require("../i18n");
const { BACKEND_BIN, BACKEND_DIR, FIRMWARE_DIR, FRONTEND_DIR, PYTHON } = require("./paths");

function httpStatus(port, urlPath, timeoutMs = 3000, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: urlPath, timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(0));
  });
}

// Minimal environment instead of process.env: keeps variables from the
// developer's shell (DATABASE_URL, JWT_SECRET …) from leaking into the app.
function baseEnv() {
  return {
    PATH: process.env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: process.env.HOME,
    LANG: "en_US.UTF-8",
    TMPDIR: process.env.TMPDIR,
  };
}

function createBackend({ paths, secrets, postgres, getPort }) {
  const svc = new Service({
    name: "backend",
    label: "Backend",
    logDir: paths.logDir,
    runDir: paths.runDir,
    stopSignal: "SIGTERM",
    stopTimeoutMs: 8000,
    async prepare() {
      // 0.0.0.0: sensors and browsers on the LAN must reach the port.
      const port = await getPort();
      let cmd, args, cwd;
      if (BACKEND_BIN) {
        // Bundled backend (PyInstaller, scripts/build-backend.sh) – no Python needed.
        if (!fs.existsSync(BACKEND_BIN)) throw new LocalizedError("err.backendMissing", { path: BACKEND_BIN });
        cmd = BACKEND_BIN;
        args = ["--host", "0.0.0.0", "--port", String(port)];
        cwd = paths.userData;
      } else {
        if (!fs.existsSync(path.join(BACKEND_DIR, "main.py"))) {
          throw new LocalizedError("err.backendMissing", { path: BACKEND_DIR });
        }
        if (PYTHON.includes("/") && !fs.existsSync(PYTHON)) throw new LocalizedError("err.pythonMissing", { path: PYTHON });
        cmd = PYTHON;
        args = [
          "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", String(port),
          "--workers", "1", "--no-proxy-headers",
        ];
        cwd = BACKEND_DIR;
      }
      if (!fs.existsSync(path.join(FRONTEND_DIR, "index.html"))) {
        // Not fatal: sensors must be able to send even without the web UI.
        svc._log(`[supervisor] web UI missing (${FRONTEND_DIR}) – run \`npm run build:frontend\`\n`);
      }
      return {
        cmd,
        args,
        cwd,
        port,
        env: {
          ...baseEnv(),
          PYTHONUNBUFFERED: "1",
          // Development: .pyc files go to the data dir instead of webapp/backend/__pycache__.
          PYTHONPYCACHEPREFIX: path.join(paths.userData, "pycache"),
          DATABASE_URL: postgres.databaseUrl(),
          // At most 10 connections, within Postgres' max_connections=20 (postgres.js).
          DB_POOL_SIZE: "5",
          DB_MAX_OVERFLOW: "5",
          JWT_SECRET: secrets.jwtSecret,
          DEVICE_TOKEN_HMAC_KEY: secrets.deviceTokenHmacKey,
          API_KEY_HMAC_KEY: secrets.apiKeyHmacKey,
          FORIQ_APP_KEY: secrets.appKey,
          FORIQ_FRONTEND_DIR: FRONTEND_DIR,
          // Empty = development: ota.py uses firmware-cpp/ from the repo.
          FORIQ_FIRMWARE_DIR: FIRMWARE_DIR || "",
        },
      };
    },
    async health() {
      return (await httpStatus(svc.port, "/health")) === 200;
    },
  });
  return svc;
}

module.exports = { createBackend, httpStatus };
