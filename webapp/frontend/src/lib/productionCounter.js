import { liveRate, liveRateSampleCount } from "./stall.js";
import { getIntlLocale, translate } from "./i18n/index.js";

export const PROJECTION_MIN_HITS = 5;
export const PROJECTION_FRESH_MS = 5 * 60 * 1000;
export const PROJECTION_MAX_HOURS = 24;

export function calculateProductionMetrics(production, {
  rate = null,
  sampleCount = 0,
  lastHitAt = null,
  now = Date.now(),
} = {}) {
  if (!production) return null;

  const current = Math.max(0, Number(production.current_count) || 0);
  const target = Math.max(1, Number(production.target_count) || 1);
  const material = production.material_count == null
    ? null
    : Math.max(0, Number(production.material_count) || 0);
  const remaining = Math.max(0, target - current);
  const overTarget = Math.max(0, current - target);
  const materialRemaining = material == null ? null : Math.max(0, material - current);
  const materialShortfall = material == null ? null : Math.max(0, target - material);
  const progress = Math.min(100, Math.max(0, (current / target) * 100));

  let projectionStatus = "insufficient";
  let etaAt = null;
  let etaHours = null;
  if (remaining === 0) {
    projectionStatus = "complete";
  } else if (!lastHitAt || now - new Date(lastHitAt).getTime() > PROJECTION_FRESH_MS) {
    projectionStatus = "stale";
  } else if (!rate || sampleCount < PROJECTION_MIN_HITS) {
    projectionStatus = "insufficient";
  } else {
    etaHours = remaining / rate;
    if (etaHours > PROJECTION_MAX_HOURS) {
      projectionStatus = "too_long";
    } else {
      projectionStatus = "available";
      etaAt = now + etaHours * 60 * 60 * 1000;
    }
  }

  return {
    current,
    target,
    remaining,
    overTarget,
    material,
    materialRemaining,
    materialShortfall,
    progress,
    rate,
    projectionStatus,
    etaAt,
    etaHours,
  };
}

export function productionMetrics(device, now = Date.now()) {
  return calculateProductionMetrics(device?.production, {
    rate: liveRate(device, now),
    sampleCount: liveRateSampleCount(device, now),
    lastHitAt: device?.last_hit_at,
    now,
  });
}

export function formatCount(value) {
  return new Intl.NumberFormat(getIntlLocale(), { maximumFractionDigits: 0 }).format(value || 0);
}

export function formatEta(timestamp, now = Date.now()) {
  if (!timestamp) return "–";
  const eta = new Date(timestamp);
  const today = new Date(now);
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
  const time = eta.toLocaleTimeString(getIntlLocale(), { hour: "2-digit", minute: "2-digit" });
  if (sameDay(eta, today)) return translate("deviceDetail.eta.today", { time });
  if (sameDay(eta, tomorrow)) return translate("deviceDetail.eta.tomorrow", { time });
  return eta.toLocaleString(getIntlLocale(), {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}
