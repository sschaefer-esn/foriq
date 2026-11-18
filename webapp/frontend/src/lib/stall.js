const RATE_WINDOW_MS = 15 * 60 * 1000;

/**
 * Live rate in pieces/h from the 15-min window. The server snapshot
 * (hits_last_15m at load time) fades out of the window linearly while SSE hits
 * since loading (live_hit_times) take over — so the rate stays current without
 * polling. Returns null when there is no data.
 */
export function liveRate(device, now = Date.now()) {
  const base = device?.hits_last_15m;
  const loadedAt = device?.rate_loaded_at;
  if (base == null || !loadedAt) return null;

  return Math.round(4 * liveRateSampleCount(device, now));
}

/** Effective number of hits in the sliding 15-minute window. */
export function liveRateSampleCount(device, now = Date.now()) {
  const base = device?.hits_last_15m;
  const loadedAt = device?.rate_loaded_at;
  if (base == null || !loadedAt) return 0;

  const weight = Math.max(0, 1 - (now - loadedAt) / RATE_WINDOW_MS);
  const liveHits = (device?.live_hit_times || []).filter(
    (t) => now - t < RATE_WINDOW_MS
  ).length;
  return base * weight + liveHits;
}

/** Append a hit timestamp and prune everything outside the 15-min window. */
export function pushLiveHit(times, now = Date.now()) {
  return [...(times || []), now].filter((t) => now - t < RATE_WINDOW_MS);
}
