import assert from "node:assert/strict";
import test from "node:test";
import {
  COUNT_SENSITIVITY_LEVELS,
  DEFAULT_COUNT_BRIDGE_MS,
  DEFAULT_COUNT_SENSITIVITY_BP,
  ENERGY_FS,
  ENERGY_TELEMETRY_FS,
  levelToSensitivity,
  sensitivityToEnergyThreshold,
} from "../src/lib/countingDefaults.js";

test("energy threshold matches the C++ detector including the telemetry scale", () => {
  // Reference values taken directly from EnergyDetector::setOp (_thresholdSq)
  // and its lastEnergy scaling, determined as a host build.
  const cases = [
    [800, 9999, 1500, 9.783503532, 5.469144821],
    [800, 3594, 400, 0.486678332, 0.272061467],
    [800, 3594, 1500, 0.945294559, 0.528435707],
    [800, 3594, 1525, 0.952392995, 0.532403827],
    [800, 3594, 6000, 1.890593290, 1.056873798],
    [800, 1000, 1500, 0.366881341, 0.205092907],
  ];
  for (const [fs, sensitivity, period, native, telemetry] of cases) {
    const actualNative = sensitivityToEnergyThreshold(sensitivity, period, fs);
    const actualTelemetry = sensitivityToEnergyThreshold(sensitivity, period, fs, ENERGY_TELEMETRY_FS);
    assert.ok(Math.abs(actualNative - native) < 1e-5, `native: ${fs} Hz, ${sensitivity}, ${period} ms`);
    assert.ok(Math.abs(actualTelemetry - telemetry) < 1e-5, `telemetry: ${fs} Hz, ${sensitivity}, ${period} ms`);
  }
});

test("each higher sensitivity level lowers the minimum peak", () => {
  for (const period of [400, DEFAULT_COUNT_BRIDGE_MS, 6000]) {
    let previous = Infinity;
    for (let level = 1; level <= COUNT_SENSITIVITY_LEVELS; level += 1) {
      const threshold = sensitivityToEnergyThreshold(levelToSensitivity(level), period, ENERGY_FS, ENERGY_TELEMETRY_FS);
      assert.ok(threshold > 0 && threshold < previous);
      previous = threshold;
    }
  }
});

test("auto and reset use the default stroke period", () => {
  const threshold = (period) => sensitivityToEnergyThreshold(DEFAULT_COUNT_SENSITIVITY_BP, period, ENERGY_FS, ENERGY_TELEMETRY_FS);
  assert.equal(threshold(null), threshold(DEFAULT_COUNT_BRIDGE_MS));
  assert.equal(threshold(undefined), threshold(DEFAULT_COUNT_BRIDGE_MS));
  assert.equal(threshold(-1), threshold(DEFAULT_COUNT_BRIDGE_MS));
  assert.ok(threshold(6000) > threshold(400));
  assert.equal(threshold(0), threshold(400));
  assert.equal(threshold(10000), threshold(6000));
});
