#include "energy_detector.h"
#include <limits.h>
#include <math.h>

namespace {
int clampInt(int value, int lo, int hi) {
    return value < lo ? lo : value > hi ? hi : value;
}
}

void EnergyDetector::resetWindow() {
    _windowSum = 0;
    _windowIndex = 0;
    _windowCount = 0;
}

void EnergyDetector::reset() {
    resetWindow();
    _inEpisode = false;
    _armed = true;
    _sampleIndex = _episodeStart = _episodePeak = _lastActive = _strokes = 0;
    _episodeMaxG = _episodeMinG = 0;
    _episodePeakEnergySq = 0;
    lastPeakG = lastEnergy = 0;
    lastDurMs = 0;
}

float EnergyDetector::amplitudeFromSensitivity(int bp) {
    if (bp < 1000) bp = 1000;
    if (bp > 9999) bp = 9999;
    const float fraction = (bp - 1000) / 8999.0f;
    return kAminLo * powf(kAminHi / kAminLo, fraction);
}

float EnergyDetector::referenceEnergy(float dtMs, float windowMs, float pulseMs) {
    const float duration = fmaxf(4000.0f, 8.0f * fmaxf(windowMs, pulseMs));
    const int n = (int)fmaxf(8.0f, floorf(duration / dtMs));
    const int center = n / 2;
    const int half = (int)fmaxf(1.0f, roundf((pulseMs / dtMs) / 2.0f));
    const int requestedWindow = (int)fmaxf(1.0f, roundf(windowMs / fmaxf(dtMs, 1e-6f)));
    const int window = requestedWindow > kWinMax ? kWinMax : requestedWindow;
    float sum = 0, maxSum = 0;
    const int skip = n / 5;

    // Recompute the canonical value leaving the window instead of storing it.
    // This keeps the 800 Hz variant from needing a second 4.8 KB ring on the
    // 8 KB loop stack.
    auto canonicalEnergy = [&](int i) {
        const float u = (float)(i - center) / (float)half;
        const float deviation = (u <= -1.0f || u >= 1.0f) ? 0.0f
            : 0.5f * (1.0f + cosf(3.14159265f * u));
        return deviation * deviation;
    };
    for (int i = 0; i < n; i++) {
        sum += canonicalEnergy(i);
        if (i >= window) sum -= canonicalEnergy(i - window);
        if (sum < 0) sum = 0;
        if (i >= skip && sum > maxSum) maxSum = sum;
    }
    return maxSum > 1e-12f ? sqrtf(maxSum) : sqrtf((float)window * 0.25f);
}

void EnergyDetector::setOp(int sensitivityBp, int strokePeriodMs) {
    const int bp = clampInt(sensitivityBp, 1000, 9999);
    const int periodMs = strokePeriodMs < 0 ? 1500 : clampInt(strokePeriodMs, 400, 6000);
    if (bp == _sensitivityBp && periodMs == _configuredPeriodMs) return;

    // A real parameter change must not produce an episode mixing the old
    // threshold and window with the new lockout.
    reset();
    _sensitivityBp = bp;
    _configuredPeriodMs = periodMs;
    _periodMs = (float)periodMs;
    const float windowMs = fmaxf(20.0f, _periodMs / 4.0f);
    const float pulseMs = _periodMs / 3.0f;
    const float dtMs = 1000.0f / kFs;
    int window = (int)lroundf(windowMs / dtMs);
    if (window < 1) window = 1;
    if (window > kWinMax) window = kWinMax;
    if (window != _windowSamples) {
        _windowSamples = window;
        resetWindow();
    }

    const float minAmplitude = amplitudeFromSensitivity(bp);
    const float reference = referenceEnergy(dtMs, windowMs, pulseMs);
    const float threshold = minAmplitude * reference;
    _thresholdSq = threshold * threshold;

    // The motion peak is roughly in the middle of the stroke, so a lockout of
    // T/2 from the peak to the next possible stroke is sufficient.
    _lockoutSamples = (uint32_t)(_periodMs * 0.5f * kFs / 1000.0f);
    if (_lockoutSamples < 1) _lockoutSamples = 1;
}

void EnergyDetector::feed(float g) {
    const float deviation = g - 1.0f;
    const float energy = deviation * deviation;
    _windowSum += energy;
    if (_windowCount == _windowSamples) {
        const float oldDeviation = _windowG[_windowIndex] - 1.0f;
        _windowSum -= oldDeviation * oldDeviation;
        _windowG[_windowIndex] = g;
        if (++_windowIndex >= _windowSamples) _windowIndex = 0;
    } else {
        _windowG[_windowCount++] = g;
    }
    if (_windowSum < 0) _windowSum = 0;
    const bool active = _windowSum > _thresholdSq;

    if (!_inEpisode) {
        if (!active) {
            _armed = true;
        } else if (_armed) {
            _inEpisode = true;
            _episodeStart = _sampleIndex;
            _episodePeak = _sampleIndex;
            _armed = false;
            // With a very short peak the threshold may only be crossed a few
            // samples later, so include the whole energy window history in
            // the envelope.
            _episodeMaxG = _episodeMinG = _windowG[0];
            for (int i = 1; i < _windowCount; i++) {
                if (_windowG[i] > _episodeMaxG) _episodeMaxG = _windowG[i];
                if (_windowG[i] < _episodeMinG) _episodeMinG = _windowG[i];
            }
            _episodePeakEnergySq = _windowSum;
        }
    }
    if (_inEpisode) {
        if (g > _episodeMaxG) _episodeMaxG = g;
        if (g < _episodeMinG) _episodeMinG = g;
    }
    if (_inEpisode && active) {
        _lastActive = _sampleIndex;
        if (_windowSum > _episodePeakEnergySq) {
            _episodePeakEnergySq = _windowSum;
            _episodePeak = _sampleIndex;
        }
    }
    if (_inEpisode && (_sampleIndex - _episodePeak) >= _lockoutSamples && !active) {
        completeEpisode();
    }
    _sampleIndex++;
}

void EnergyDetector::completeEpisode() {
    _strokes++;
    lastPeakG = _episodeMaxG - _episodeMinG;
    // Telemetry stays on the 250 Hz scale for compatibility. Detection and the
    // reference threshold still run entirely at the native rate.
    lastEnergy = sqrtf(_episodePeakEnergySq * (kTelemetryFs / kFs));
    const uint32_t durationSamples = _lastActive - _episodeStart + 1u;
    const uint64_t durationMs = (uint64_t)durationSamples * 1000u / (uint32_t)kFs;
    lastDurMs = durationMs > (uint64_t)INT_MAX ? INT_MAX : (int)durationMs;
    _inEpisode = false;
    _armed = true;
}

int EnergyDetector::noteWallGap(float gapMs) {
    const uint32_t before = _strokes;
    if (!(gapMs >= 80.0f)) return 0; // also rejects NaN/negative values
    resetWindow();
    if (_inEpisode) {
        const float gapSamples = gapMs * kFs / 1000.0f;
        const uint32_t extraSamples = gapSamples >= (float)UINT32_MAX
            ? UINT32_MAX : (uint32_t)gapSamples;
        const uint32_t elapsedSamples = _sampleIndex - _episodePeak;
        if (elapsedSamples >= _lockoutSamples
                || extraSamples >= _lockoutSamples - elapsedSamples) {
            completeEpisode();
        } else {
            _inEpisode = false;
            _armed = true;
        }
    }
    return (int)(_strokes - before);
}

int EnergyDetector::pushNative(float g) {
    const uint32_t before = _strokes;
    feed(g);
    return (int)(_strokes - before);
}
