// With sleep mode on: only really offline after 24 h without a sign of life —
// a deliberately sleeping sensor reports only sporadically.
const SLEEP_OFFLINE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

export function deviceStatus(device) {
  // Never seen → setup in progress. last_seen_at is set permanently on first
  // contact, so "provisioning" lasts exactly until the first time online.
  if (!device?.last_seen_at) return "provisioning";
  const age = Date.now() - new Date(device.last_seen_at).getTime();
  const cycleTime = (device.upload_interval_s || 30) * 1000;

  if (device.sleep_mode) {
    return age > SLEEP_OFFLINE_THRESHOLD_MS ? "offline" : "sleeping";
  }

  // Awake: settings_sync runs every ~30 s. 3 missed syncs (90 s) mark the
  // sensor offline. With a longer duty cycle (upload_interval_s > 0) it is
  // 3× that interval.
  const threshold = Math.max(90 * 1000, 3 * cycleTime);
  return age > threshold ? "offline" : "online";
}
