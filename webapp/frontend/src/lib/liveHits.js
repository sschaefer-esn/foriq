const HIT_RETENTION_MS = 5 * 60 * 1000;

// Per stream subscriber and across reconnects: a stored stroke may change
// counters, rate and charts only once. No timer per individual stroke.
export function createHitDeduplicator() {
  const seen = new Map();
  return (hit, now = Date.now()) => {
    for (const [key, receivedAt] of seen) {
      if (now - receivedAt < HIT_RETENTION_MS) break;
      seen.delete(key);
    }
    // id + recorded_at is the primary key of the partitioned hit table.
    // Fallback for older backends without an ID in the event.
    const key = JSON.stringify([hit.device_id, hit.recorded_at, hit.id ?? hit.gforce]);
    if (seen.has(key)) return false;
    seen.set(key, now);
    return true;
  };
}
