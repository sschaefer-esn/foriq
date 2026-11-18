#include "accel.h"
#include "config.h"

#include <Wire.h>
#include <math.h>
#include "bmi270_config_file.h"

// ─── BMI270 driver ──────────────────────────────────────────
// Implements the Accel:: API from include/accel.h for the Bosch BMI270
// (M5StickS3). Register sequences follow the Bosch datasheet "BMI270 v1.2".
//
// Things to check when bringing up new hardware:
//   - I2C address 0x68 (SDO low) — alternatively 0x69 (SDO high)
//   - config file upload (8 KB) succeeds (INTERNAL_STATUS == 0x01)
//
// Scaling: +/-16 g, 16-bit -> 2048 LSB/g (ACCEL_SCALE in config.h).

namespace {

// BMI270 registers (Bosch datasheet 1.2, section 6)
constexpr uint8_t REG_CHIP_ID     = 0x00;
constexpr uint8_t REG_DATA_8      = 0x0C;   // ACC_X LSB (6 bytes XYZ)
constexpr uint8_t REG_INTERNAL_STATUS = 0x21;
constexpr uint8_t REG_ACC_CONF    = 0x40;
constexpr uint8_t REG_ACC_RANGE   = 0x41;
constexpr uint8_t REG_FIFO_LENGTH_0 = 0x24;
constexpr uint8_t REG_FIFO_DATA   = 0x26;
constexpr uint8_t REG_FIFO_CONFIG_0 = 0x48;
constexpr uint8_t REG_FIFO_CONFIG_1 = 0x49;
constexpr uint8_t REG_INIT_CTRL   = 0x59;
constexpr uint8_t REG_INIT_ADDR_0 = 0x5B;
constexpr uint8_t REG_INIT_ADDR_1 = 0x5C;
constexpr uint8_t REG_INIT_DATA   = 0x5E;
constexpr uint8_t REG_PWR_CONF    = 0x7C;
constexpr uint8_t REG_PWR_CTRL    = 0x7D;
constexpr uint8_t REG_CMD         = 0x7E;

constexpr uint8_t CHIP_ID_BMI270  = 0x24;
constexpr uint8_t CMD_SOFTRESET   = 0xB6;
constexpr uint8_t CMD_FIFO_FLUSH  = 0xB0;

constexpr int MAX_INIT_RETRIES = 5;

bool _initialized = false;

bool writeReg(uint8_t reg, uint8_t val) {
    Wire.beginTransmission(BMI270_ADDR);
    Wire.write(reg);
    Wire.write(val);
    return Wire.endTransmission() == 0;
}

uint8_t readReg(uint8_t reg) {
    Wire.beginTransmission(BMI270_ADDR);
    Wire.write(reg);
    Wire.endTransmission(false);
    Wire.requestFrom((uint8_t)BMI270_ADDR, (uint8_t)1);
    if (Wire.available() < 1) return 0xFF;
    return Wire.read();
}

bool readRegs(uint8_t reg, uint8_t* buf, size_t len) {
    Wire.beginTransmission(BMI270_ADDR);
    Wire.write(reg);
    if (Wire.endTransmission(false) != 0) return false;
    Wire.requestFrom((uint8_t)BMI270_ADDR, (uint8_t)len);
    for (size_t i = 0; i < len; i++) {
        if (!Wire.available()) return false;
        buf[i] = Wire.read();
    }
    return true;
}

bool initI2C() {
    Wire.end();
    if (!Wire.begin(PIN_SDA, PIN_SCL, 400000)) return false;
    Wire.setTimeOut(I2C_TIMEOUT_MS);
    return true;
}

// Bosch ships the config file as an 8 KB binary blob that must be loaded
// into the sensor after every soft reset. The array lives in
// bmi270_config_file.h (source: Bosch BMI270_SensorAPI).
constexpr uint16_t BMI270_CONFIG_FILE_SIZE = sizeof(bmi270_config_file);

bool uploadConfigFile() {
    // 1. PWR_CONF.adv_power_save = 0
    if (!writeReg(REG_PWR_CONF, 0x00)) return false;
    delay(1);

    // 2. INIT_CTRL = 0x00 (prepare config load)
    if (!writeReg(REG_INIT_CTRL, 0x00)) return false;

    // 3. Burst-write the config blob to REG_INIT_DATA
    const uint16_t chunk = 32;
    for (uint16_t off = 0; off < BMI270_CONFIG_FILE_SIZE; off += chunk) {
        // Set address (in 16-bit words, hence /2)
        uint16_t wordAddr = off / 2;
        if (!writeReg(REG_INIT_ADDR_0, (uint8_t)(wordAddr & 0x0F)) ||
                !writeReg(REG_INIT_ADDR_1, (uint8_t)((wordAddr >> 4) & 0xFF))) {
            return false;
        }

        Wire.beginTransmission(BMI270_ADDR);
        Wire.write(REG_INIT_DATA);
        for (uint16_t i = 0; i < chunk && (off + i) < BMI270_CONFIG_FILE_SIZE; i++) {
            Wire.write(bmi270_config_file[off + i]);
        }
        if (Wire.endTransmission() != 0) {
            Serial.printf("BMI270: config upload error at offset %u\n", off);
            return false;
        }
    }

    // 4. INIT_CTRL = 0x01 (load complete)
    if (!writeReg(REG_INIT_CTRL, 0x01)) return false;

    // 5. Poll until INTERNAL_STATUS.message == 0x01 (init_ok)
    for (int i = 0; i < 100; i++) {
        delay(5);
        uint8_t st = readReg(REG_INTERNAL_STATUS);
        if ((st & 0x0F) == 0x01) return true;
    }
    Serial.println("BMI270: INTERNAL_STATUS != init_ok after 500ms");
    return false;
}

bool sensorConfigurationValid() {
    return (readReg(REG_INTERNAL_STATUS) & 0x0F) == 0x01 &&
           readReg(REG_ACC_RANGE) == 0x03 &&
           readReg(REG_ACC_CONF) == 0xAB &&
           (readReg(REG_PWR_CTRL) & 0x0F) == 0x04 &&
           readReg(REG_PWR_CONF) == 0x00;
}

} // namespace

bool Accel::init() {
    _initialized = false;
    for (int attempt = 0; attempt < MAX_INIT_RETRIES; attempt++) {
        if (!initI2C()) {
            Serial.printf("I2C init error (attempt %d/%d)\n", attempt + 1, MAX_INIT_RETRIES);
            delay(1000);
            continue;
        }

        // Soft reset
        if (!writeReg(REG_CMD, CMD_SOFTRESET)) {
            delay(1000);
            continue;
        }
        delay(50);

        uint8_t chip = readReg(REG_CHIP_ID);
        if (chip != CHIP_ID_BMI270) {
            Serial.printf("BMI270: wrong CHIP_ID 0x%02X (expected 0x24)\n", chip);
            delay(1000);
            continue;
        }

        if (!uploadConfigFile()) {
            delay(1000);
            continue;
        }

        // ACC_RANGE = +/-16 g (0x03)
        bool configured = writeReg(REG_ACC_RANGE, 0x03);

        // ACC_CONF: ODR=800Hz (0x0B), BWP=normal (0x02 << 4), filter_perf=1 (0x80)
        configured = writeReg(REG_ACC_CONF, 0xAB) && configured;

        // PWR_CTRL: acc_en=1, gyr_en=0, aux_en=0, temp_en=0
        configured = writeReg(REG_PWR_CTRL, 0x04) && configured;

        // PWR_CONF: adv_power_save=0 (kept off for continuous reading)
        configured = writeReg(REG_PWR_CONF, 0x00) && configured;

        delay(10);
        if (!configured || !sensorConfigurationValid()) {
            Serial.printf("BMI270: configuration read-back failed (attempt %d/%d)\n",
                          attempt + 1, MAX_INIT_RETRIES);
            delay(1000);
            continue;
        }
        Serial.println("BMI270 initialized (+/-16g, 800Hz, gyro off).");
        _initialized = true;
        return true;
    }
    return false;
}

float Accel::readTotalAccel() {
    uint8_t buf[6];
    if (!readRegs(REG_DATA_8, buf, 6)) return NAN;

    int16_t ax = (int16_t)((buf[1] << 8) | buf[0]);   // BMI270: little-endian
    int16_t ay = (int16_t)((buf[3] << 8) | buf[2]);
    int16_t az = (int16_t)((buf[5] << 8) | buf[4]);

    float x = ax / ACCEL_SCALE;
    float y = ay / ACCEL_SCALE;
    float z = az / ACCEL_SCALE;
    return sqrtf(x * x + y * y + z * z);
}

bool Accel::recoverI2C() {
    if (!initI2C()) return false;
    if (!_initialized || !sensorConfigurationValid()) {
        Serial.println("BMI270: sensor configuration lost, full re-initialization");
        if (!Accel::init()) return false;
    }
    return Accel::enableFifo();
}

bool Accel::enableFifo() {
    // Headerless, accel only, ODR stays 800 Hz. Stream mode (stop_on_full=0).
    // Read back after writing: a silently lost FIFO write would still yield
    // plausible single reads but not a complete envelope.
    for (int attempt = 0; attempt < 3; attempt++) {
        bool ok = writeReg(REG_FIFO_CONFIG_1, 0x40) &&
                  writeReg(REG_FIFO_CONFIG_0, 0x00) &&
                  writeReg(REG_CMD, CMD_FIFO_FLUSH);
        delay(2);
        if (ok && readReg(REG_FIFO_CONFIG_1) == 0x40 &&
                readReg(REG_FIFO_CONFIG_0) == 0x00) {
            return true;
        }
    }
    Serial.println("BMI270: FIFO configuration read-back failed");
    return false;
}

int Accel::odrHz() { return 800; }

int Accel::drainFifo(float* mags, int maxN, AccelFifoStatus* status) {
    if (status) *status = AccelFifoStatus{};
    if (!mags || maxN < 1) return 0;
    uint8_t lenBuf[2];
    if (!readRegs(REG_FIFO_LENGTH_0, lenBuf, 2)) return -1;
    uint16_t fifoLen = ((uint16_t)(lenBuf[1] & 0x3F) << 8) | lenBuf[0];

    constexpr int MAX_DRAIN = FIFO_DRAIN_SAMPLES;
    int cap = maxN < MAX_DRAIN ? maxN : MAX_DRAIN;
    bool resync = (fifoLen % 6 != 0);
    if (status && (resync || fifoLen >= 2048)) status->gapBefore = true;
    int samples = fifoLen / 6;
    if (samples > cap) {
        samples = cap;
        resync = true;
        if (status) status->gapAfter = true;
    }
    if (samples <= 0) {
        if (resync) writeReg(REG_CMD, CMD_FIFO_FLUSH);
        return 0;
    }

    constexpr int CHUNK = 16;
    uint8_t buf[CHUNK * 6];
    bool ioFail = false;
    int written = 0;
    int left = samples;

    while (left > 0) {
        int n = left > CHUNK ? CHUNK : left;
        int nBytes = n * 6;
        if (!readRegs(REG_FIFO_DATA, buf, (size_t)nBytes)) { ioFail = true; break; }

        for (int i = 0; i < n; i++) {
            const uint8_t* s = buf + i * 6;
            int16_t ax = (int16_t)((s[1] << 8) | s[0]);
            int16_t ay = (int16_t)((s[3] << 8) | s[2]);
            int16_t az = (int16_t)((s[5] << 8) | s[4]);
            float x = ax / ACCEL_SCALE, y = ay / ACCEL_SCALE, z = az / ACCEL_SCALE;
            mags[written++] = sqrtf(x * x + y * y + z * z);
        }
        left -= n;
    }

    // Flush on desync/overflow or an aborted transfer, but keep the samples
    // already read (returning 0 would silently swallow the whole gap).
    if (ioFail && status) status->gapAfter = true;
    if (ioFail || resync) writeReg(REG_CMD, CMD_FIFO_FLUSH);
    return (ioFail && written == 0) ? -1 : written;
}
