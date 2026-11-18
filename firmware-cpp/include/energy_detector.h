#pragma once
#include <stdint.h>
// Production stroke counter: boxcar energy sqrt(sum((g - 1)^2)) over
// w = max(20 ms, T/4). The threshold is derived from a canonical 1 g
// half-sine motion of duration T/3.
//
// After the energy peak, a stroke is locked out for T/2. The next stroke can
// only start after that and after the energy has dropped below the threshold.
class EnergyDetector {
public:
    // The BMI270 already delivers exact 800 Hz FIFO samples. They are used
    // without resampling so short envelope peaks are preserved.
    static constexpr float kFs = 800.0f;
    static constexpr int kWinMax = 1200; // max T/4 = 1500 ms at T=6000 ms
    static constexpr float kAminLo = 0.03f;
    static constexpr float kAminHi = 0.80f;
    static constexpr float kTelemetryFs = 250.0f;
    static_assert(kWinMax >= (int)(kFs * 1.5f),
                  "Energy window must cover T=6000 ms without clamping");

    void reset();
    void setOp(int sensitivityBp, int strokePeriodMs);
    int pushNative(float g);             // exactly one feed per 800 Hz FIFO sample
    int noteWallGap(float gapMs);        // closes/discards the open episode without interpolating

    float lastPeakG = 0;                 // peak-to-peak, telemetry only
    float lastEnergy = 0;                // peak of the production boxcar energy
    int lastDurMs = 0;

#ifdef FORIQ_ENERGY_DETECTOR_TEST
    // Host test: drive an episode across the uint32_t rollover.
    void setSampleIndexForTest(uint32_t sampleIndex) { _sampleIndex = sampleIndex; }
    int windowSamplesForTest() const { return _windowSamples; }
#endif

private:
    void feed(float g);
    void completeEpisode();
    static float referenceEnergy(float dtMs, float windowMs, float pulseMs);
    static float amplitudeFromSensitivity(int bp);
    void resetWindow();

    // Keep raw g rather than energy: the old energy contribution can be
    // subtracted from it, and the full peak envelope leading up to the
    // threshold crossing stays available.
    float _windowG[kWinMax] = {};
    float _windowSum = 0;
    float _thresholdSq = 0.0025f;
    float _periodMs = 1500.0f;
    int _windowSamples = 1, _windowIndex = 0, _windowCount = 0;
    int _sensitivityBp = -1, _configuredPeriodMs = -1;
    uint32_t _lockoutSamples = 1;
    bool _inEpisode = false, _armed = true;
    uint32_t _sampleIndex = 0, _episodeStart = 0, _episodePeak = 0;
    uint32_t _lastActive = 0, _strokes = 0;
    float _episodeMaxG = 0, _episodeMinG = 0;
    float _episodePeakEnergySq = 0;
};
