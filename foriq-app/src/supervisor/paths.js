// Central paths and constants of the supervisor.
//
// Two modes:
//  - Development (`npm start`, headless.js): backend, schema.sql and the frontend
//    export come from the repo or foriq-app/build (FORIQ_REPO, default = parent dir).
//  - App bundle (Foriq.app): everything lives in Contents/Resources/foriq/
//    (electron-builder extraResources + after-pack.js, see package.json → build).
// Backend: in the bundle a PyInstaller program (BACKEND_BIN); in development it runs
// from source with the app's virtualenv (build/venv, `npm run setup:python`) or,
// without one, FORIQ_PYTHON (FORIQ_BACKEND_BIN tests the build).
const path = require("path");
const fs = require("fs");
const { LocalizedError } = require("../i18n");

const APP_DIR = path.resolve(__dirname, "..", "..");
const REPO_DIR = process.env.FORIQ_REPO
  ? path.resolve(process.env.FORIQ_REPO)
  : path.resolve(APP_DIR, "..");

const BUNDLE_RES = process.resourcesPath ? path.join(process.resourcesPath, "foriq") : null;
const PACKAGED = !!BUNDLE_RES && fs.existsSync(BUNDLE_RES);

// EDB binaries from @embedded-postgres/darwin-arm64 (Apple silicon only). The
// package is ESM and only exports dist/index.js, so resolve the path directly.
// Virtualenv created by scripts/setup-python.sh (FORIQ_VENV overrides the location).
const VENV_DIR = process.env.FORIQ_VENV
  ? path.resolve(process.env.FORIQ_VENV)
  : path.join(APP_DIR, "build", "venv");

const PG_BIN_DIR = path.join(APP_DIR, "node_modules", "@embedded-postgres", "darwin-arm64", "native", "bin");

// The package ships only the server (postgres, initdb, pg_ctl). The app build adds
// pg_dump/pg_restore next to them (after-pack.js, from Homebrew's postgresql@18 –
// same major version as the server); in development Homebrew's are used directly.
const HOMEBREW_PG_BIN = "/opt/homebrew/opt/postgresql@18/bin";

function pgBinDir() {
  if (fs.existsSync(path.join(PG_BIN_DIR, "postgres"))) return PG_BIN_DIR;
  throw new LocalizedError("err.postgresBinMissing");
}

function pgToolPath(name) {
  for (const dir of [PG_BIN_DIR, HOMEBREW_PG_BIN]) {
    if (fs.existsSync(path.join(dir, name))) return path.join(dir, name);
  }
  throw new LocalizedError("err.pgToolMissing", { name });
}

function dataPaths(userData) {
  return {
    userData,
    secretsFile: path.join(userData, "secrets.json"),
    runtimeFile: path.join(userData, "runtime.json"),
    pgData: path.join(userData, "postgres", "data"),
    logDir: path.join(userData, "logs"),
    runDir: path.join(userData, "run"),
    backupDir: path.join(userData, "backups"),
  };
}

module.exports = {
  APP_DIR,
  REPO_DIR,
  PACKAGED,
  BACKEND_DIR: path.join(REPO_DIR, "webapp", "backend"),
  BACKEND_BIN: process.env.FORIQ_BACKEND_BIN
    ? path.resolve(process.env.FORIQ_BACKEND_BIN)
    : PACKAGED
      ? path.join(BUNDLE_RES, "backend", "foriq-backend")
      : null,
  SCHEMA_FILE: PACKAGED
    ? path.join(BUNDLE_RES, "sql", "schema.sql")
    : path.join(REPO_DIR, "webapp", "sql", "schema.sql"),
  // Static Next.js export (scripts/build-frontend.sh), served by the backend.
  FRONTEND_DIR: process.env.FORIQ_FRONTEND_DIR
    ? path.resolve(process.env.FORIQ_FRONTEND_DIR)
    : PACKAGED
      ? path.join(BUNDLE_RES, "frontend")
      : path.join(APP_DIR, "build", "frontend"),
  // Sensor firmware for local OTA updates (shipped with the release, see after-pack.js).
  FIRMWARE_DIR: process.env.FORIQ_FIRMWARE_DIR
    ? path.resolve(process.env.FORIQ_FIRMWARE_DIR)
    : PACKAGED
      ? path.join(BUNDLE_RES, "firmware")
      : null,
  // Development only (backend from source, USB helper): Python 3.11+ with the
  // packages from webapp/backend/requirements.txt – the venv's interpreter if it
  // exists, else FORIQ_PYTHON (without "/" it is looked up in PATH).
  PYTHON: fs.existsSync(path.join(VENV_DIR, "bin", "python"))
    ? path.join(VENV_DIR, "bin", "python")
    : process.env.FORIQ_PYTHON || "python3",
  pgBinDir,
  pgToolPath,
  dataPaths,
};
