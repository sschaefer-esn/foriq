import assert from "node:assert/strict";
import test from "node:test";
import { createHitDeduplicator } from "../src/lib/liveHits.js";

const hit = { id: 1, device_id: "machine-a", recorded_at: "2026-09-03T10:00:00Z", gforce: 2 };

test("DB identity separates real strokes with identical readings", () => {
  const accept = createHitDeduplicator();
  assert.equal(accept(hit, 0), true);
  assert.equal(accept({ ...hit }, 1), false);
  assert.equal(accept({ ...hit, id: 2 }, 2), true);
  assert.equal(accept({ ...hit, device_id: "machine-b" }, 3), true);
  assert.equal(accept({ ...hit, recorded_at: "2026-09-03T10:00:01Z" }, 4), true);
});

test("older events without an ID are deduplicated as well", () => {
  const accept = createHitDeduplicator();
  const legacy = { ...hit, id: undefined };
  assert.equal(accept(legacy, 0), true);
  assert.equal(accept({ ...legacy }, 1), false);
});

test("deduplication is isolated per subscriber and drops old entries", () => {
  const first = createHitDeduplicator();
  const second = createHitDeduplicator();
  assert.equal(first(hit, 0), true);
  assert.equal(second(hit, 0), true);
  assert.equal(first(hit, 299999), false);
  assert.equal(first(hit, 300000), true);
});
