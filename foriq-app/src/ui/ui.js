const COLOR = {
  running: "green",
  starting: "yellow",
  unhealthy: "yellow",
  stopping: "yellow",
  backoff: "red",
  stopped: "grey",
};

const $ = (id) => document.getElementById(id);
let current = null;
let currentSettings = null;
let currentSensor = null;

// ─── Strings (dictionary for the active locale, sent by main.js) ─
let STRINGS = {};

function t(key, vars) {
  const s = STRINGS[key] !== undefined ? STRINGS[key] : key;
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined || vars[k] === null ? m : String(vars[k])));
}

// Static text in index.html: elements with data-i18n="key".
function applyStatic() {
  for (const node of document.querySelectorAll("[data-i18n]")) node.textContent = t(node.dataset.i18n);
}

function applyI18n({ locale, strings }) {
  STRINGS = strings || {};
  document.documentElement.lang = locale;
  $("language").value = locale;
  applyStatic();
  if (current) render(current);
  if (currentSettings) renderSettings(currentSettings);
  if (currentSensor) {
    lastSensorKey = "";
    onSensor(currentSensor);
  }
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function render(s) {
  current = s;
  $("overall").textContent = t(`ui.overall.${s.overall}`);
  $("url").textContent = s.publicUrl;
  const alt = [t("ui.altLocal", { url: s.localUrl })];
  if (s.ip) alt.push(t("ui.altIp", { url: s.publicUrl.replace("foriq.local", s.ip) }));
  $("alt").textContent = alt.join(" · ");

  const list = $("services");
  list.replaceChildren(
    ...s.services.map((svc) => {
      const li = el("li");
      li.append(el("span", `dot ${COLOR[svc.state] || "grey"}`));
      const text = el("div");
      text.append(el("div", "name", svc.label));
      const detail = el("div", "detail", svc.detail);
      // Last log line as a tooltip (helps with problems).
      if (svc.lastLine) detail.title = t("ui.logTooltip", { line: svc.lastLine });
      text.append(detail);
      li.append(text);

      const actions = el("div", "row-actions");
      const restart = el("button", "", "↻");
      restart.title = t("ui.restart");
      restart.disabled = !s.running;
      restart.onclick = () => window.foriq.action("restart", svc.name);
      const log = el("button", "", t("ui.log"));
      log.onclick = () => window.foriq.action("open-log", svc.name);
      actions.append(restart, log);
      li.append(actions);
      return li;
    })
  );

  renderBackup(s);
  $("open").disabled = !s.ready;
  $("toggle").textContent = s.running ? t("ui.stop") : t("ui.start");
}

// Database backup row (same look as a service row; detail text comes from main.js).
function renderBackup(s) {
  const b = s.backup;
  const li = el("li");
  li.append(el("span", `dot ${b.running ? "yellow" : b.error ? "red" : b.lastAt ? "green" : "grey"}`));
  const text = el("div");
  text.append(el("div", "name", b.label));
  text.append(el("div", "detail", b.detail));
  li.append(text);
  const actions = el("div", "row-actions");
  const now = el("button", "", t("ui.backupNow"));
  now.disabled = !s.running || b.running;
  now.onclick = () => window.foriq.action("backup-now");
  const show = el("button", "", t("ui.showBackups"));
  show.title = t("ui.showBackupsTooltip");
  show.onclick = () => window.foriq.action("open-backups");
  actions.append(now, show);
  li.append(actions);
  $("backup").replaceChildren(li);
}

$("open").onclick = () => window.foriq.action("open-browser");
$("logs").onclick = () => window.foriq.action("open-logs");
$("reset-password").onclick = () => window.foriq.action("reset-password");
$("toggle").onclick = async () => {
  $("toggle").disabled = true;
  try {
    await window.foriq.action(current && current.running ? "stop" : "start");
  } finally {
    $("toggle").disabled = false;
  }
};

function renderSettings(st) {
  currentSettings = st;
  const auto = $("autostart");
  auto.checked = st.autostart.enabled;
  auto.disabled = !st.autostart.available;
  $("autostart-row").classList.toggle("disabled", !st.autostart.available);
  $("autostart-row").title = st.autostart.available ? "" : t("ui.autostartUnavailable");
  $("prevent-sleep").checked = st.preventSleep;
  if (st.language) $("language").value = st.language;
}
$("autostart").onchange = (e) => window.foriq.setSetting("autostart", e.target.checked).then(renderSettings);
$("prevent-sleep").onchange = (e) => window.foriq.setSetting("preventSleep", e.target.checked).then(renderSettings);
// main.js answers a language change with an "i18n" event (+ fresh status/sensor state).
$("language").onchange = (e) => window.foriq.setSetting("language", e.target.value).then(renderSettings);

// ─── Sensor on USB ─────────────────────────────────────────────
let lastSsid = "";
let lastPw = ""; // only in this window's memory, so a re-render keeps the input

function sensorState(st) {
  const info = st.info || {};
  if (info.state === "checking") return t("ui.sensor.state.checking");
  if (info.state === "blank") return t("ui.sensor.state.blank");
  if (info.state === "download") return t("ui.sensor.state.download");
  if (info.state === "foriq") {
    const fw = info.fw ? ` · FW ${info.fw}` : "";
    if (info.foriq && info.foriq.known) return t("ui.sensor.state.named", { name: info.foriq.name, fw });
    return t("ui.sensor.state.notRegistered", { fw });
  }
  return t("ui.sensor.state.unknown");
}

function button(text, cls, onclick, disabled) {
  const b = el("button", cls, text);
  b.onclick = onclick;
  b.disabled = !!disabled;
  return b;
}

function input(id, placeholder, type = "text") {
  const i = el("input");
  i.id = id;
  i.type = type;
  i.placeholder = placeholder;
  i.autocomplete = "off";
  i.spellcheck = false;
  return i;
}

function errorBox(err) {
  const box = el("div", "s-error");
  box.append(el("div", "", err.msg));
  if (err.hint) box.append(el("div", "s-hint", err.hint));
  return box;
}

function approvalNote(result) {
  return result && result.approved ? t("ui.sensor.approved") : t("ui.sensor.approveHint");
}

function renderSensor(st) {
  const box = $("sensor");
  const head = el("div", "s-head");
  head.append(el("div", "label", t("ui.sensor.title")));
  const parts = [head];

  if (!st.stick) {
    parts.push(el("div", "s-muted", t("ui.sensor.none")));
    box.replaceChildren(...parts);
    return;
  }
  head.append(el("div", "s-model", st.stick.model));
  const sensorApi = window.foriq.sensor;

  if (st.phase === "busy") {
    const p = st.progress || { step: "start", pct: 0 };
    const step = STRINGS[`ui.sensor.step.${p.step}`];
    const pct = p.step === "write" ? ` ${t("ui.sensor.pct", { pct: p.pct })}` : "";
    parts.push(el("div", "s-line", (step || st.message || t("ui.sensor.wait")) + pct));
    const bar = el("div", "s-bar");
    const fill = el("div", "s-fill");
    fill.style.width = `${p.step === "write" ? p.pct : p.step === "boot" || p.step === "wifi" ? 100 : 3}%`;
    if (p.step !== "write") bar.classList.add("indeterminate");
    bar.append(fill);
    parts.push(bar);
    if (st.message) parts.push(el("div", "s-muted", st.message));
    parts.push(el("div", "s-muted", t("ui.sensor.dontUnplug")));
  } else if (st.phase === "wifi") {
    const r = st.result || {};
    parts.push(el("div", "s-line", t("ui.sensor.wifi.written")));
    if (st.error) parts.push(errorBox(st.error));
    const form = el("form", "s-form");
    const nets = st.networks || { loading: true, list: [] };
    // Choice: networks the sensor sees (those known to this Mac on top) + "Other network …".
    const select = el("select");
    select.id = "s-net";
    for (const n of nets.list) {
      const strength = n.rssi > -60 ? "" : ` · ${t(n.rssi > -72 ? "ui.sensor.wifi.medium" : "ui.sensor.wifi.weak")}`;
      const o = el("option", "", `${n.known ? "★ " : ""}${n.ssid}${strength}`);
      o.value = n.ssid;
      select.append(o);
    }
    const other = el("option", "", nets.loading ? t("ui.sensor.wifi.scanning") : t("ui.sensor.wifi.other"));
    other.value = "";
    select.append(other);
    if (lastSsid && nets.list.some((n) => n.ssid === lastSsid)) select.value = lastSsid;
    const ssid = input("s-ssid", t("ui.sensor.wifi.ssid"));
    ssid.value = nets.list.some((n) => n.ssid === lastSsid) ? "" : lastSsid;
    const syncOther = () => (ssid.hidden = select.value !== "");
    select.onchange = syncOther;
    syncOther();
    const chosen = () => (select.value || ssid.value).trim();

    const pw = input("s-pw", t("ui.sensor.wifi.password"), "password");
    pw.value = lastPw;
    pw.oninput = () => (lastPw = pw.value);

    const adv = el("details", "s-adv");
    adv.append(el("summary", "", t("ui.sensor.wifi.advanced")));
    const server = input("s-server", t("ui.sensor.wifi.server"));
    adv.append(server);
    const rescan = button(t("ui.sensor.wifi.rescan"), "", () => sensorApi("scan"), nets.loading);
    rescan.type = "button";
    adv.append(rescan);
    const row = el("div", "s-actions");
    const go = button(t("ui.sensor.wifi.connect"), "primary", null);
    go.type = "submit";
    row.append(go, button(t("ui.sensor.wifi.later"), "", () => sensorApi("portal")));
    form.append(select, ssid, pw, adv, row);
    if (nets.error) form.prepend(el("div", "s-muted", t("ui.sensor.wifi.scanError", { error: nets.error })));
    form.onsubmit = (e) => {
      e.preventDefault();
      const name = chosen();
      if (!name) return ssid.focus();
      lastSsid = name;
      sensorApi("wifi", { ssid: name, password: pw.value, server: server.value.trim() });
    };
    parts.push(form);
    parts.push(el("div", "s-muted", approvalNote(r)));
  } else if (st.phase === "done") {
    lastPw = "";
    const r = st.result || {};
    if (r.via === "usb") {
      parts.push(el("div", "s-line ok", t("ui.sensor.done.usb", { ip: r.ip ? ` (${r.ip})` : "" })));
    } else {
      parts.push(el("div", "s-line", t("ui.sensor.done.phoneTitle")));
      const ol = el("ol", "s-steps");
      const li1 = el("li", "", t("ui.sensor.done.phone1"));
      li1.append(el("code", "s-code", r.setup || "–"));
      ol.append(li1, el("li", "", t("ui.sensor.done.phone2")), el("li", "", t("ui.sensor.done.phone3")));
      parts.push(ol);
      parts.push(el("div", "s-muted", t("ui.sensor.done.unplug")));
    }
    parts.push(el("div", "s-muted", approvalNote(r)));
    parts.push(row1(button(t("ui.sensor.done"), "", () => sensorApi("dismiss"))));
  } else if (st.phase === "deleted") {
    const r = st.result || {};
    parts.push(el("div", "s-line ok", r.name ? t("ui.sensor.deletedNamed", { name: r.name }) : t("ui.sensor.deleted")));
    if (r.dbNote) parts.push(errorBox({ msg: r.dbNote }));
    parts.push(row1(button(t("ui.sensor.done"), "", () => sensorApi("dismiss"))));
  } else {
    parts.push(el("div", "s-line", sensorState(st)));
    if (st.multiple) parts.push(el("div", "s-muted", t("ui.sensor.multiple")));
    if (st.phase === "error" && st.error) parts.push(errorBox(st.error));
    const checking = st.info && st.info.state === "checking";
    const row = el("div", "s-actions");
    row.append(
      button(t("ui.sensor.setup"), "primary", () => sensorApi("setup", {}), checking || st.multiple),
      button(t("ui.sensor.erase"), "", () => sensorApi("remove"), checking || st.multiple || (st.info && st.info.state === "blank"))
    );
    parts.push(row);
  }
  box.replaceChildren(...parts);
}

function row1(...buttons) {
  const row = el("div", "s-actions");
  row.append(...buttons);
  return row;
}

// Do not rebuild the form on every progress event (input would be lost otherwise).
let lastSensorKey = "";
function onSensor(st) {
  currentSensor = st;
  const key = st.phase === "wifi"
    ? `wifi:${JSON.stringify(st.error || null)}:${JSON.stringify(st.networks || null)}`
    : JSON.stringify(st);
  if (key === lastSensorKey) return;
  lastSensorKey = key;
  renderSensor(st);
}

// Strings first, then the first render; later updates arrive as events.
window.foriq.onI18n(applyI18n);
window.foriq.onStatus(render);
window.foriq.onSensor(onSensor);
window.foriq.i18n().then((d) => {
  applyI18n(d);
  window.foriq.settings().then(renderSettings);
  window.foriq.status().then(render);
  window.foriq.sensor("state").then(onSensor);
});
