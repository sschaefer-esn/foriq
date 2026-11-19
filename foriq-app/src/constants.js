// Shared app constants (single source for main.js, the supervisor and scripts).
// Shell scripts (scripts/*.sh) define their own copies at the top.
const os = require("os");
const path = require("path");

const APP_NAME = "Foriq";

// Fixed, uncommon port for browsers AND sensors (http://foriq.local:8420).
// The backend listens on it directly (API + web UI).
const PUBLIC_PORT = 8420;
const HOSTNAME = "foriq.local";

// GitHub repository whose releases the app checks for updates (scripts/install.sh has
// the same value). FORIQ_UPDATE_BASE overrides the release download URL for tests.
const GITHUB_REPO = "sschaefer-esn/foriq";

// Postgres only on 127.0.0.1, also fixed (stable address for psql and friends).
const POSTGRES_PORT = 54329;

// Data dir, same as Electron's app.getPath("userData") with app.setName(APP_NAME).
function defaultUserData() {
  return path.join(os.homedir(), "Library", "Application Support", APP_NAME);
}

module.exports = { APP_NAME, PUBLIC_PORT, HOSTNAME, POSTGRES_PORT, GITHUB_REPO, defaultUserData };
