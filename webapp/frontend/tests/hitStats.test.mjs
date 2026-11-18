import assert from "node:assert/strict";
import test from "node:test";

import { detectRhythmGroups, rhythmStats } from "../src/lib/hitStats.js";

function makeGroups(starts, size, intervalMs = 400) {
  return starts.flatMap((start) => (
    Array.from({ length: size }, (_, index) => start + index * intervalMs)
  ));
}

test("rhythm values follow the visible window instead of the day mode", () => {
  const oldFourHitGroups = makeGroups(
    Array.from({ length: 15 }, (_, index) => index * 4000),
    4,
  );
  const currentFiveHitGroups = makeGroups(
    Array.from({ length: 9 }, (_, index) => 100000 + index * 4000),
    5,
  );
  const timestamps = [...oldFourHitGroups, ...currentFiveHitGroups];
  const windowStart = 96000;
  const windowEnd = timestamps.at(-1);
  const context = timestamps.filter((timestamp) => (
    timestamp > windowStart - 60000 && timestamp <= windowEnd + 60000
  ));
  const visible = timestamps.filter((timestamp) => (
    timestamp > windowStart && timestamp <= windowEnd
  ));

  assert.equal(detectRhythmGroups(timestamps).groups[0].size, 4);

  const currentGrouping = detectRhythmGroups(context, {
    rangeStart: windowStart,
    rangeEnd: windowEnd,
  });
  assert.equal(currentGrouping.confident, true);
  assert.deepEqual(currentGrouping.groups.map((group) => group.size), Array(8).fill(5));
  assert.equal(rhythmStats(visible).medianIntervalMs, 400);
});
