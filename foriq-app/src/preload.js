const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("foriq", {
  status: () => ipcRenderer.invoke("status"),
  action: (name, arg) => ipcRenderer.invoke("action", name, arg),
  settings: () => ipcRenderer.invoke("settings"),
  setSetting: (key, value) => ipcRenderer.invoke("set-setting", key, value),
  onStatus: (cb) => ipcRenderer.on("status", (_e, s) => cb(s)),
  sensor: (action, arg) => ipcRenderer.invoke("sensor", action, arg),
  onSensor: (cb) => ipcRenderer.on("sensor", (_e, s) => cb(s)),
  // UI strings for the active locale: { locale, strings }. Re-sent on language change.
  update: () => ipcRenderer.invoke("update"),
  onUpdate: (cb) => ipcRenderer.on("update", (_e, s) => cb(s)),
  i18n: () => ipcRenderer.invoke("i18n"),
  onI18n: (cb) => ipcRenderer.on("i18n", (_e, d) => cb(d)),
});
