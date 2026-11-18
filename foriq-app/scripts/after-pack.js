// electron-builder afterPack hook (runs BEFORE signing):
// copies the frontend export and the backend and firmware builds to
// Contents/Resources/foriq/. extraResources cannot do this reliably – the
// PyInstaller folder contains framework symlinks that must be preserved.
// Also adds pg_dump/pg_restore for the database backup (copyPgTools).
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const PARTS = [
  { from: ["build", "frontend"], to: "frontend", check: "index.html", hint: "npm run build:frontend" },
  { from: ["build", "backend", "foriq-backend"], to: "backend", check: "foriq-backend", hint: "npm run build:backend" },
];

// Sensor firmware for local OTA updates: same layout as firmware-cpp/release/<build>/,
// so ota.py finds it unchanged via FORIQ_FIRMWARE_DIR.
const FIRMWARE_TARGETS = ["m5sticks3"];

function copyFirmware(projectDir, resDir) {
  const fwRoot = path.resolve(projectDir, "..", "firmware-cpp", ".pio", "build");
  const destRoot = path.join(resDir, "firmware", "release");
  fs.rmSync(path.join(resDir, "firmware"), { recursive: true, force: true });
  for (const target of FIRMWARE_TARGETS) {
    const bin = path.join(fwRoot, target, "firmware.bin");
    if (!fs.existsSync(bin)) {
      throw new Error(`Firmware missing: ${bin} – run \`pio run -e ${target}\` first`);
    }
    fs.mkdirSync(path.join(destRoot, target), { recursive: true });
    fs.copyFileSync(bin, path.join(destRoot, target, "firmware.bin"));
    // Complete USB image for setting up new sensors (scripts/build-firmware.sh).
    const factory = path.join(projectDir, "build", "firmware", target, "factory.bin");
    if (!fs.existsSync(factory)) {
      throw new Error(`USB image missing: ${factory} – run \`npm run build:firmware\` first`);
    }
    fs.mkdirSync(path.join(resDir, "firmware", "factory", target), { recursive: true });
    fs.copyFileSync(factory, path.join(resDir, "firmware", "factory", target, "factory.bin"));
  }
  console.log(`  • firmware copied  targets=${FIRMWARE_TARGETS.join(",")} (+ factory.bin)`);
}

// pg_dump/pg_restore for the daily backup (src/supervisor/backup.js). The
// @embedded-postgres package ships only the server, so take them from Homebrew's
// postgresql@18 (same major version as the server), put them next to the server
// binaries and point their libraries at the bundled ones in native/lib (libpq,
// OpenSSL, zstd, lz4, gettext are all there). electron-builder signs them later.
const PG_TOOLS = ["pg_dump", "pg_restore"];
const PG_TOOLS_SRC = process.env.FORIQ_PG_TOOLS_DIR || "/opt/homebrew/opt/postgresql@18/bin";

function copyPgTools(appPath) {
  const native = path.join(appPath, "Contents", "Resources", "app", "node_modules", "@embedded-postgres", "darwin-arm64", "native");
  for (const tool of PG_TOOLS) {
    const src = path.join(PG_TOOLS_SRC, tool);
    if (!fs.existsSync(src)) throw new Error(`${src} missing – run \`brew install postgresql@18\` first`);
    const dest = path.join(native, "bin", tool);
    fs.copyFileSync(fs.realpathSync(src), dest);
    fs.chmodSync(dest, 0o755);
    const deps = execFileSync("otool", ["-L", dest], { encoding: "utf8" })
      .split("\n")
      .slice(1)
      .map((line) => line.trim().split(" ")[0])
      .filter((dep) => dep && !dep.startsWith("/usr/lib/") && !dep.startsWith("/System/"));
    for (const dep of deps) {
      const lib = path.basename(dep);
      if (!fs.existsSync(path.join(native, "lib", lib))) throw new Error(`${tool} needs ${lib}, which is not bundled`);
      execFileSync("install_name_tool", ["-change", dep, `@loader_path/../lib/${lib}`, dest], { stdio: "ignore" });
    }
    // Rewriting invalidated the signature; re-sign ad hoc so the check below can run.
    execFileSync("codesign", ["--force", "--sign", "-", dest], { stdio: "ignore" });
    const version = execFileSync(dest, ["--version"], { encoding: "utf8" }).trim();
    if (!/\) 18\./.test(version)) throw new Error(`${tool}: expected PostgreSQL 18, got "${version}"`);
    console.log(`  • ${tool} added  ${version}`);
  }
}

exports.copyPgTools = copyPgTools;

exports.default = async function afterPack(context) {
  const projectDir = context.packager.projectDir;
  const appName = context.packager.appInfo.productFilename;
  const resDir = path.join(context.appOutDir, `${appName}.app`, "Contents", "Resources", "foriq");
  for (const part of PARTS) {
    const src = path.join(projectDir, ...part.from);
    if (!fs.existsSync(path.join(src, part.check))) {
      throw new Error(`${part.to} build missing – run \`${part.hint}\` first`);
    }
    const dest = path.join(resDir, part.to);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.cpSync(src, dest, { recursive: true, verbatimSymlinks: true });
    console.log(`  • ${part.to} copied  dest=${path.relative(projectDir, dest)}`);
  }
  copyFirmware(projectDir, resDir);
  copyPgTools(path.join(context.appOutDir, `${appName}.app`));
};
