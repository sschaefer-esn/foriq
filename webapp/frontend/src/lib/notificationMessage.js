// Alert text composed from the codes the backend returns (alert_type,
// resolution, device_name), so it follows the UI language (German by default).
// Unknown alert types fall back to the server-built `message`.

const KNOWN_TYPES = new Set(["no_hits", "device_offline"]);
const RESOLUTION_KEYS = {
  window_ended: "notifications.message.windowEnded",
  rule_changed: "notifications.message.ruleChanged",
  sensor_offline: "notifications.message.sensorOffline",
  sleep_mode: "notifications.message.sleepMode",
};

export function notificationMessage(alert, t) {
  if (!alert || !KNOWN_TYPES.has(alert.alert_type)) return alert?.message || "";
  const offline = alert.alert_type === "device_offline";
  let key;
  if (!alert.resolved_at) {
    key = offline ? "notifications.message.deviceOffline" : "notifications.message.noHits";
  } else {
    key = RESOLUTION_KEYS[alert.resolution]
      || (offline ? "notifications.message.deviceOnline" : "notifications.message.hitsResumed");
  }
  return t(key, { device: alert.device_name ?? "" });
}
