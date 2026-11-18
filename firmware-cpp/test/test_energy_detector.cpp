#ifndef FORIQ_ENERGY_DETECTOR_TEST
#define FORIQ_ENERGY_DETECTOR_TEST
#endif
#include "energy_detector.h"

#include <assert.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>

namespace {
constexpr double kDtMs = 1000.0 / EnergyDetector::kFs;
constexpr double kPi = 3.14159265358979323846;

int samplesForMs(double durationMs) {
    return (int)lround(durationMs * EnergyDetector::kFs / 1000.0);
}

struct Harness {
    explicit Harness(int sensitivityBp = 5000, int periodMs = 800)
        : sensitivity(sensitivityBp), period(periodMs) {
        detector.reset();
        detector.setOp(sensitivity, period);
    }

    void sample(float g) {
        hits += detector.pushNative(g);
        tMs += kDtMs;
    }

    void rest(int samples) {
        for (int i = 0; i < samples; i++) sample(1.0f);
    }

    void restMs(double durationMs) { rest(samplesForMs(durationMs)); }

    void impulse() { sample(3.0f); }

    void wallGap(float gapMs) {
        hits += detector.noteWallGap(gapMs);
        tMs += gapMs;
    }

    void setOp(int sensitivityBp, int periodMs) {
        sensitivity = sensitivityBp;
        period = periodMs;
        detector.setOp(sensitivity, period);
    }

    EnergyDetector detector;
    int sensitivity;
    int period;
    double tMs = 0;
    int hits = 0;
};

float halfSinePulse(double tMs, double centerMs, double durationMs) {
    const double u = (tMs - centerMs) / (durationMs * 0.5);
    if (u <= -1.0 || u >= 1.0) return 1.0f;
    return (float)(1.0 + 0.5 * (1.0 + cos(kPi * u)));
}

int runHalfSines(double durationMs, double firstCenterMs = -1,
                 double secondCenterMs = -1) {
    EnergyDetector detector;
    detector.reset();
    detector.setOp(5000, 900);
    int hits = 0;
    for (double t = 0; t <= durationMs; t += kDtMs) {
        float g = 1.0f;
        if (firstCenterMs >= 0) g += halfSinePulse(t, firstCenterMs, 300.0) - 1.0f;
        if (secondCenterMs >= 0) g += halfSinePulse(t, secondCenterMs, 300.0) - 1.0f;
        hits += detector.pushNative(g);
    }
    return hits;
}

int runImpulsePair(int separationSamples) {
    Harness h;
    h.restMs(320.0);
    h.impulse();
    h.rest(separationSamples - 1);
    h.impulse();
    h.restMs(1200.0);
    return h.hits;
}

void testBasicDetection() {
    assert(runHalfSines(3000.0) == 0);
    assert(runHalfSines(3500.0, 1200.0) == 1);
    assert(runHalfSines(4500.0, 1200.0, 1980.0) == 2);
}

void testHalfPeriodBoundary() {
    // T=800 ms: T/2 is exactly representable at the production rate. A
    // second impulse on the boundary sample is already active and therefore
    // stays part of the open episode; the first inactive sample after it splits.
    const int halfPeriodSamples = samplesForMs(400.0);
    assert(runImpulsePair(halfPeriodSamples - 1) == 1);
    assert(runImpulsePair(halfPeriodSamples) == 1);
    assert(runImpulsePair(halfPeriodSamples + 1) == 2);
}

void testWallGaps() {
    Harness shortGap;
    shortGap.restMs(320.0);
    shortGap.impulse();
    shortGap.restMs(40.0);
    shortGap.wallGap(200.0f);           // 40 + 200 ms < T/2: discard episode
    assert(shortGap.hits == 0);
    shortGap.restMs(320.0);
    shortGap.impulse();
    shortGap.restMs(720.0);
    assert(shortGap.hits == 1);         // cleanly re-armed after the gap

    Harness longGap;
    longGap.restMs(320.0);
    longGap.impulse();
    longGap.restMs(40.0);
    longGap.wallGap(500.0f);            // open episode is safely completed
    assert(longGap.hits == 1);
    longGap.restMs(320.0);
    longGap.impulse();
    longGap.restMs(720.0);
    assert(longGap.hits == 2);
}

void testParameterChanges() {
    Harness identical;
    identical.restMs(320.0);
    identical.impulse();
    identical.restMs(40.0);
    identical.setOp(5000, 800);         // identical: open episode is kept
    identical.restMs(720.0);
    assert(identical.hits == 1);

    Harness sensitivityChange;
    sensitivityChange.restMs(320.0);
    sensitivityChange.impulse();
    sensitivityChange.restMs(40.0);
    sensitivityChange.setOp(6000, 800); // real change: discard mixed episode
    sensitivityChange.restMs(720.0);
    assert(sensitivityChange.hits == 0);
    sensitivityChange.impulse();
    sensitivityChange.restMs(720.0);
    assert(sensitivityChange.hits == 1);

    Harness periodChange;
    periodChange.restMs(320.0);
    periodChange.impulse();
    periodChange.restMs(40.0);
    periodChange.setOp(5000, 1000);      // window and T/2 change atomically
    periodChange.restMs(880.0);
    assert(periodChange.hits == 0);
    periodChange.impulse();
    periodChange.restMs(880.0);
    assert(periodChange.hits == 1);
}

void testSampleIndexRollover() {
    Harness rollover;
    rollover.detector.setSampleIndexForTest(UINT32_MAX - (uint32_t)samplesForMs(320.0));
    rollover.restMs(240.0);
    rollover.impulse();                  // episode starts just before UINT32_MAX
    rollover.restMs(720.0);              // active duration + T/2 end after the wrap
    assert(rollover.hits == 1);
    assert(rollover.detector.lastDurMs == 200);
    assert(fabs(rollover.detector.lastEnergy
                - 2.0f * sqrtf(EnergyDetector::kTelemetryFs / EnergyDetector::kFs)) < 1e-5f);

    Harness rolloverGap;
    rolloverGap.detector.setSampleIndexForTest(UINT32_MAX - (uint32_t)samplesForMs(80.0));
    rolloverGap.restMs(40.0);
    rolloverGap.impulse();
    rolloverGap.restMs(20.0);
    rolloverGap.wallGap(500.0f);
    assert(rolloverGap.hits == 1);
}

void testMaximumWindowIsNotClamped() {
    EnergyDetector detector;
    detector.reset();
    detector.setOp(5000, 6000);
    assert(detector.windowSamplesForTest() == samplesForMs(1500.0));
}
}

int main() {
    testBasicDetection();
    testHalfPeriodBoundary();
    testWallGaps();
    testParameterChanges();
    testSampleIndexRollover();
    testMaximumWindowIsNotClamped();
    puts("EnergyDetector tests passed");
    return 0;
}
