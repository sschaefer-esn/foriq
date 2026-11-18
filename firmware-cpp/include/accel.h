#pragma once
#include <Arduino.h>

// Accelerometer of the M5Stick S3 (Bosch BMI270, src/accel_bmi270.cpp).
// Returns the acceleration magnitude in g, sqrt(x^2 + y^2 + z^2).
struct AccelFifoStatus {
    // Gap before/after the returned samples. Lets the detector split episodes
    // at real FIFO data loss without mistaking plain loop latency for lost
    // data.
    bool gapBefore = false;
    bool gapAfter = false;
};

namespace Accel {
    bool  init();
    float readTotalAccel();
    bool  recoverI2C();
    // FIFO at full IMU ODR; every loop iteration drains all magnitude samples.
    bool  enableFifo();
    int   odrHz();
    // All FIFO samples (magnitude in g), up to maxN.
    // >0 = sample count, 0 = FIFO empty, -1 = I2C error.
    int   drainFifo(float* mags, int maxN, AccelFifoStatus* status = nullptr);
}
