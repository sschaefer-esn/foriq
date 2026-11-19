// Foriq app (macOS): Dock app with a status window + menu bar icon.
// The actual web interface runs in the browser at http://foriq.local:8420.
//
// Quit logic (Foriq is a server – sensors can only send while it runs):
//  - Closing the window, Cmd+Q and "Quit" in the Dock only hide it.
//  - It really quits only via the menu bar icon (with confirmation), on logout/
//    shutdown of the Mac, and via `Foriq --quit` (scripts/tests).
//  - Electron catches SIGTERM/SIGINT itself and calls app.quit() – that cannot be
//    told apart from "Quit" in the Dock, so it only hides as well.
//    Exception in development (`npm start`): every quit really quits (Ctrl+C).
//
// UI text goes through ./i18n (German default, English selectable). The
// supervisor and sensor manager emit message objects; localizeStatus() and
// localizeSensor() translate them here before they reach the window.
const fs = require("fs");
const path = require("path");
const {
  app, BrowserWindow, Tray, Menu, ipcMain, shell, dialog, clipboard, powerMonitor, powerSaveBlocker,
} = require("electron");
const { Supervisor, statusLogger } = require("./supervisor");
const { SensorManager } = require("./sensor");
const { Settings } = require("./settings");
const { createTrayIcon } = require("./tray-icon");
const { Updater } = require("./updater");
const { APP_NAME, GITHUB_REPO } = require("./constants");
const i18n = require("./i18n");

const { t, text } = i18n;

app.setName(APP_NAME);
if (process.env.FORIQ_USER_DATA) app.setPath("userData", path.resolve(process.env.FORIQ_USER_DATA));

if (process.argv.includes("--quit") || !app.requestSingleInstanceLock()) {
  // --quit without a running instance: nothing to do. With a running instance, its
  // second-instance handler takes over (requestSingleInstanceLock notifies it).
  if (process.argv.includes("--quit")) app.requestSingleInstanceLock();
  app.exit(0);
} else {
  let supervisor;
  let sensor;
  let settings;
  let tray;
  let win;
  let reallyQuit = !app.isPackaged; // set only by the allowed ways to quit
  let shuttingDown = false;
  let sleepBlocker = null;
  let updater;

  // ─── Language ────────────────────────────────────────────────
  function applyLocale() {
    i18n.setLocale(i18n.resolveLocale(settings.get("language")));
  }

  function i18nPayload() {
    return { locale: i18n.getLocale(), strings: i18n.dictionary() };
  }

  function backupDetail(b) {
    if (b.running) return t("backup.running");
    if (b.error) return t("backup.failed", { error: text(b.error) });
    if (!b.lastAt) return t("backup.never");
    const time = new Date(b.lastAt).toLocaleString(i18n.numberLocale(), { dateStyle: "medium", timeStyle: "short" });
    return t("backup.last", { time });
  }

  function localizeStatus(s) {
    return {
      ...s,
      services: s.services.map((x) => ({ ...x, label: t(`service.${x.name}`), detail: text(x.detail) })),
      backup: { ...s.backup, label: t("service.backup"), detail: backupDetail(s.backup), error: text(s.backup.error) },
    };
  }

  function localizeSensor(st) {
    const out = { ...st };
    if (st.message) out.message = text(st.message);
    if (st.error) out.error = { ...st.error, msg: text(st.error.msg), hint: text(st.error.hint) };
    if (st.result && st.result.dbNote) out.result = { ...st.result, dbNote: text(st.result.dbNote) };
    if (st.networks && st.networks.error) out.networks = { ...st.networks, error: text(st.networks.error) };
    return out;
  }

  function localizeUpdate(u) {
    const vars = { version: u.current, latest: u.latest, current: u.current, pct: u.progress || 0 };
    let detail;
    if (u.phase === "checking") detail = t("update.checking");
    else if (u.phase === "available") detail = t("update.available", vars);
    else if (u.phase === "downloading") detail = t("update.downloading", vars);
    else if (u.phase === "installing") detail = t("update.installing", vars);
    else if (u.phase === "error") detail = text(u.error);
    else if (u.phase === "current") detail = t("update.current", vars);
    else detail = settings.get("checkUpdates") ? t("update.idle") : t("update.off");
    return { ...u, label: t("update.label", vars), detail, enabled: settings.get("checkUpdates") };
  }

  function sendUpdate() {
    if (win && !win.isDestroyed()) win.webContents.send("update", localizeUpdate(updater.status()));
  }

  async function installUpdate() {
    const u = updater.status();
    if (u.phase !== "available" || !u.canInstall) return;
    const opts = {
      type: "question",
      buttons: [t("update.confirm.ok"), t("common.cancel")],
      defaultId: 0,
      cancelId: 1,
      message: t("update.confirm.message", { latest: u.latest }),
      detail: t("update.confirm.detail"),
    };
    const { response } = win && !win.isDestroyed() ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
    if (response !== 0) return;
    await updater.install(quitForReal);
  }

  // Check once after start, then whenever the last check is older than a day.
  function scheduleUpdateChecks() {
    const due = () => settings.get("checkUpdates") && (!updater.state.checkedAt || Date.now() - updater.state.checkedAt > 24 * 3600e3);
    setTimeout(() => due() && updater.check(), 20000);
    setInterval(() => due() && updater.check(), 3600e3);
  }

  // Language switch from the status window: rebuild menus, re-render the window.
  function changeLanguage(locale) {
    if (!i18n.LOCALES.includes(locale)) return;
    settings.set("language", locale);
    applyLocale();
    buildAppMenu();
    updateTray(supervisor.status());
    if (win && !win.isDestroyed()) {
      win.webContents.send("i18n", i18nPayload());
      win.webContents.send("status", localizeStatus(supervisor.status()));
      win.webContents.send("sensor", localizeSensor(sensor.status()));
      sendUpdate();
    }
  }

  function showWindow() {
    if (!win) {
      win = new BrowserWindow({
        width: 440,
        height: 730,
        resizable: false,
        fullscreenable: false,
        maximizable: false,
        title: "Foriq",
        show: false,
        webPreferences: {
          preload: path.join(__dirname, "preload.js"),
          contextIsolation: true,
          sandbox: true,
        },
      });
      win.loadFile(path.join(__dirname, "ui", "index.html"));
      win.once("ready-to-show", () => win.show());
      win.on("show", () => sensor && sensor.start());
      win.on("close", (e) => {
        if (!shuttingDown) {
          e.preventDefault();
          win.hide();
        }
      });
      win.on("closed", () => (win = null));
      // Open external links from the status window in the default browser.
      win.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: "deny" };
      });
    } else {
      win.show();
    }
    win.focus();
    app.focus({ steal: true });
  }

  function hideWindow() {
    if (win && !win.isDestroyed()) win.hide();
  }

  function openBrowser() {
    const s = supervisor.status();
    // Only once the backend is healthy (it also serves the web UI).
    if (!s.ready) return;
    // Always foriq.local; only test instances without mDNS (FORIQ_NO_MDNS=1) use localhost.
    const hasMdns = s.services.some((x) => x.name === "mdns");
    shell.openExternal(hasMdns ? s.publicUrl : s.localUrl);
  }

  async function confirmQuit() {
    const { response } = await dialog.showMessageBox({
      type: "warning",
      buttons: [t("quit.button"), t("common.cancel")],
      defaultId: 1,
      cancelId: 1,
      message: t("quit.message"),
      detail: t("quit.detail"),
    });
    if (response === 0) quitForReal();
  }

  function quitForReal() {
    reallyQuit = true;
    app.quit();
  }

  // ─── Autostart & sleep ───────────────────────────────────────
  // Login item only for the installed app – in development the bare Electron.app
  // would be registered otherwise.
  function autostartStatus() {
    if (!app.isPackaged) return { available: false, enabled: false };
    return { available: true, enabled: app.getLoginItemSettings().openAtLogin };
  }

  function setAutostart(enabled) {
    if (!app.isPackaged) return;
    app.setLoginItemSettings({ openAtLogin: enabled });
    settings.set("autostartInitialized", true);
  }

  // Prevents the Mac from going to sleep automatically while the services run.
  // The display may still turn off; closing the lid still sleeps.
  function updateSleepBlocker() {
    const want = settings.get("preventSleep") && supervisor.running;
    if (want && sleepBlocker === null) {
      sleepBlocker = powerSaveBlocker.start("prevent-app-suspension");
    } else if (!want && sleepBlocker !== null) {
      powerSaveBlocker.stop(sleepBlocker);
      sleepBlocker = null;
    }
  }

  function settingsStatus() {
    return {
      autostart: autostartStatus(),
      preventSleep: settings.get("preventSleep"),
      checkUpdates: settings.get("checkUpdates"),
      language: i18n.getLocale(),
    };
  }

  // ─── Menus ───────────────────────────────────────────────────
  function buildAppMenu() {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: "Foriq",
          submenu: [
            { role: "about", label: t("menu.about") },
            { type: "separator" },
            { role: "hide", label: t("menu.hide") },
            { role: "hideOthers", label: t("menu.hideOthers") },
            { role: "unhide", label: t("menu.unhide") },
            { type: "separator" },
            // Cmd+Q only hides; really quit via the menu bar icon.
            { label: t("menu.closeWindow"), accelerator: "CmdOrCtrl+Q", click: hideWindow },
          ],
        },
        { role: "editMenu", label: t("menu.edit") },
        { role: "windowMenu", label: t("menu.window") },
      ])
    );
  }

  function updateTray(status) {
    if (!tray) return;
    const overall = t(`overall.${status.overall}`);
    tray.setToolTip(overall);
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: overall, enabled: false },
        { label: status.publicUrl, enabled: false },
        { type: "separator" },
        { label: t("tray.openBrowser"), click: openBrowser, enabled: status.ready },
        { label: t("tray.statusWindow"), click: showWindow },
        ...(updater && updater.status().phase === "available" && updater.status().canInstall
          ? [{ label: t("tray.update", { latest: updater.status().latest }), click: () => { showWindow(); installUpdate(); } }]
          : []),
        { type: "separator" },
        status.running
          ? { label: t("tray.stopServices"), click: () => supervisor.stopAll() }
          : { label: t("tray.startServices"), click: () => supervisor.startAll() },
        { label: t("tray.showLogs"), click: () => shell.openPath(supervisor.paths.logDir) },
        { type: "separator" },
        { label: t("tray.quit"), click: confirmQuit },
      ])
    );
  }

  // Second launch: show the window – or, with --quit, quit the running instance.
  app.on("second-instance", (_e, argv) => (argv.includes("--quit") ? quitForReal() : showWindow()));
  // Click on the Dock icon while running → status window.
  app.on("activate", () => showWindow());

  app.whenReady().then(async () => {
    settings = new Settings(app.getPath("userData"));
    applyLocale();
    supervisor = new Supervisor({ userData: app.getPath("userData") });

    // Updates: only the installed app can replace itself (dev: check only).
    updater = new Updater({
      currentVersion: app.getVersion(),
      repo: GITHUB_REPO,
      baseUrl: process.env.FORIQ_UPDATE_BASE,
      userData: app.getPath("userData"),
      cacheDir: path.join(app.getPath("cache"), APP_NAME, "updates"),
      logDir: supervisor.paths.logDir,
      appPath: app.isPackaged ? path.resolve(process.execPath, "..", "..", "..") : null,
      installScript: app.isPackaged ? path.join(process.resourcesPath, "foriq", "install.sh") : null,
    });
    updater.on("state", (u) => {
      sendUpdate();
      if (["available", "current", "error"].includes(u.phase)) updateTray(supervisor.status());
    });

    // First start: enable autostart (the default). Not for test runs with their
    // own data dir – that would be a real system login item.
    if (app.isPackaged && !settings.get("autostartInitialized") && !process.env.FORIQ_USER_DATA) {
      setAutostart(true);
    }

    buildAppMenu();
    tray = new Tray(createTrayIcon());
    tray.on("click", () => tray.popUpContextMenu());

    const logStatus = statusLogger();
    supervisor.on("status", (s) => {
      // Status changes to stdout (development: `npm start` in a terminal).
      const lines = logStatus(s);
      if (lines) console.log(`[foriq] ${lines.join("\n")}`);
      updateTray(s);
      updateSleepBlocker();
      if (win && !win.isDestroyed()) win.webContents.send("status", localizeStatus(s));
    });
    updateTray(supervisor.status());

    // Sensor on USB (set up/erase). Ports are polled only while the window is visible.
    sensor = new SensorManager({
      supervisor,
      isVisible: () => !!win && !win.isDestroyed() && win.isVisible(),
      confirm: async ({ message, detail, ok }) => {
        const opts = { type: "warning", buttons: [ok, t("common.cancel")], defaultId: 1, cancelId: 1, message, detail };
        const { response } = win && !win.isDestroyed()
          ? await dialog.showMessageBox(win, opts)
          : await dialog.showMessageBox(opts);
        return response === 0;
      },
    });
    sensor.on("state", (st) => win && !win.isDestroyed() && win.webContents.send("sensor", localizeSensor(st)));
    ipcMain.handle("sensor", (_e, action, arg) => {
      switch (action) {
        case "state":
          return localizeSensor(sensor.status());
        case "setup":
          sensor.setup(arg || {});
          return;
        case "wifi":
          sensor.wifi(arg || {});
          return;
        case "portal":
          return sensor.portal();
        case "scan":
          return sensor.scan();
        case "remove":
          sensor.remove();
          return;
        case "dismiss":
          return sensor.dismiss();
      }
    });

    ipcMain.handle("status", () => localizeStatus(supervisor.status()));
    ipcMain.handle("i18n", () => i18nPayload());
    ipcMain.handle("update", () => localizeUpdate(updater.status()));
    ipcMain.handle("settings", () => settingsStatus());
    ipcMain.handle("set-setting", (_e, key, value) => {
      if (key === "autostart") setAutostart(!!value);
      if (key === "preventSleep") {
        settings.set("preventSleep", !!value);
        updateSleepBlocker();
      }
      if (key === "language") changeLanguage(value);
      if (key === "checkUpdates") {
        settings.set("checkUpdates", !!value);
        if (value) updater.check();
        else sendUpdate();
      }
      return settingsStatus();
    });
    ipcMain.handle("action", async (_e, action, arg) => {
      switch (action) {
        case "open-browser":
          return openBrowser();
        case "start":
          // Do not wait for the full startup – the status lights show the progress.
          supervisor.startAll().catch((err) => console.error("Start failed:", err));
          return;
        case "stop":
          return supervisor.stopAll();
        case "restart":
          return supervisor.restartService(arg);
        case "open-logs":
          return shell.openPath(supervisor.paths.logDir);
        case "open-log":
          return shell.openPath(path.join(supervisor.paths.logDir, `${arg}.log`));
        case "reset-password":
          return resetOwnerPassword();
        case "backup-now":
          return supervisor.backups.run();
        case "update-check":
          return updater.check();
        case "update-install":
          return installUpdate();
        case "update-notes": {
          const u = updater.status();
          if (u.notesUrl) shell.openExternal(u.notesUrl);
          return;
        }
        case "open-backups":
          fs.mkdirSync(supervisor.paths.backupDir, { recursive: true });
          return shell.openPath(supervisor.paths.backupDir);
      }
    });

    // Forgotten owner password: local, no e-mail. Whoever operates this Mac may set
    // a new one (backend endpoint only via 127.0.0.1 with the app key).
    async function resetOwnerPassword() {
      const box = (opts) =>
        win && !win.isDestroyed() ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts);
      const { response } = await box({
        type: "warning",
        buttons: [t("reset.button"), t("common.cancel")],
        defaultId: 1,
        cancelId: 1,
        message: t("reset.message"),
        detail: t("reset.detail"),
      });
      if (response !== 0) return;
      const res = await sensor._api("POST", "/api/v1/devices/app/reset-owner-password");
      if (res.status !== 200 || !res.data) {
        const why = res.status === 0
          ? t("reset.unreachable")
          : (res.data && res.data.detail) || t("reset.httpError", { status: res.status });
        await box({ type: "error", message: t("reset.failed"), detail: String(why) });
        return;
      }
      const { username, password } = res.data;
      const done = await box({
        type: "info",
        buttons: [t("reset.copy"), t("reset.close")],
        defaultId: 0,
        message: t("reset.done"),
        detail: t("reset.doneDetail", { username, password }),
      });
      if (done.response === 0) clipboard.writeText(password);
    }

    // Logout/restart/shutdown: really quit, otherwise Foriq blocks the system.
    powerMonitor.on("shutdown", () => {
      reallyQuit = true;
    });
    // After sleep the Mac may be on another network or have a new IP: re-check
    // right away (foriq.local, LAN reachability, health) instead of at the next cycle.
    powerMonitor.on("resume", () => supervisor.refreshNetwork());

    // After autostart stay in the background (Dock dot + menu bar only).
    if (!(app.isPackaged && app.getLoginItemSettings().wasOpenedAtLogin)) showWindow();
    supervisor.startAll().catch((err) => console.error("Start failed:", err));
    scheduleUpdateChecks();
  });

  app.on("before-quit", (e) => {
    if (shuttingDown) return;
    if (!reallyQuit) {
      // The Cmd+Q replacement works via the menu; this catches "Quit" in the Dock.
      e.preventDefault();
      hideWindow();
      return;
    }
    // Shut all services down cleanly before the app exits.
    shuttingDown = true;
    e.preventDefault();
    const hardExit = setTimeout(() => app.exit(1), 45000);
    (supervisor ? supervisor.stopAll() : Promise.resolve())
      .catch((err) => console.error("Stop failed:", err))
      .finally(() => {
        clearTimeout(hardExit);
        app.exit(0);
      });
  });

  // Closing the window ≠ quitting the app.
  app.on("window-all-closed", () => {});

}
