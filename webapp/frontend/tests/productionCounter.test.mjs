import assert from "node:assert/strict";
import test from "node:test";

import {
  PROJECTION_MAX_HOURS,
  calculateProductionMetrics,
} from "../src/lib/productionCounter.js";

const NOW = new Date("2026-09-01T12:00:00Z").getTime();
const production = {
  current_count: 400,
  target_count: 1000,
  material_count: 800,
};

test("computes remaining quantity and material coverage", () => {
  const result = calculateProductionMetrics(production, { now: NOW });
  assert.equal(result.remaining, 600);
  assert.equal(result.materialRemaining, 400);
  assert.equal(result.materialShortfall, 200);
  assert.equal(result.progress, 40);
});

test("shows a projection only with enough recent strokes", () => {
  const result = calculateProductionMetrics(production, {
    rate: 300,
    sampleCount: 10,
    lastHitAt: new Date(NOW - 60_000).toISOString(),
    now: NOW,
  });
  assert.equal(result.projectionStatus, "available");
  assert.equal(result.etaHours, 2);
  assert.equal(result.etaAt, NOW + 2 * 60 * 60 * 1000);

  const tooFew = calculateProductionMetrics(production, {
    rate: 300,
    sampleCount: 4,
    lastHitAt: new Date(NOW - 60_000).toISOString(),
    now: NOW,
  });
  assert.equal(tooFew.projectionStatus, "insufficient");
  assert.equal(tooFew.etaAt, null);
});

test("suppresses stale and long-range projections", () => {
  const stale = calculateProductionMetrics(production, {
    rate: 300,
    sampleCount: 10,
    lastHitAt: new Date(NOW - 6 * 60_000).toISOString(),
    now: NOW,
  });
  assert.equal(stale.projectionStatus, "stale");

  const tooLong = calculateProductionMetrics(production, {
    rate: 600 / (PROJECTION_MAX_HOURS + 1),
    sampleCount: 10,
    lastHitAt: new Date(NOW - 60_000).toISOString(),
    now: NOW,
  });
  assert.equal(tooLong.projectionStatus, "too_long");
  assert.equal(tooLong.etaAt, null);
});

test("flags target reached and overproduction", () => {
  const result = calculateProductionMetrics({
    current_count: 1050,
    target_count: 1000,
    material_count: 1100,
  }, { now: NOW });
  assert.equal(result.remaining, 0);
  assert.equal(result.overTarget, 50);
  assert.equal(result.progress, 100);
  assert.equal(result.projectionStatus, "complete");
});
