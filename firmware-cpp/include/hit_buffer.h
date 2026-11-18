#pragma once
#include <Arduino.h>

// Wire format v4 (36 B, endpoint /ingest/hits-bin4): v3 plus a stable event ID
// made of boot_id + event_sequence. The ID is written into the record at
// capture time and therefore survives SPIFFS, reboots and HTTP retries.
struct __attribute__((packed)) BinaryHit {
    uint32_t epoch_s;
    uint16_t epoch_ms;
    float    energy;        // stroke energy (dimensionless)
    float    gforce;
    uint16_t duration_ms;
    float    rn;
    float    confidence;
    uint64_t boot_id;
    uint32_t event_sequence;
};

static_assert(sizeof(BinaryHit) == 36, "BinaryHit v4 must be exactly 36 bytes");

// Capture and HTTP staging are deliberately separate: the large SPSC ring rides
// out weak shop-floor WiFi without reserving as much staging RAM for every
// upload. 512 × 36 B = 18 KB; about 100 s of RAM reserve at 5 strokes/s.
#define HIT_RAM_CAPACITY 512
#define HIT_UPLOAD_BATCH_CAPACITY 64

namespace HitBuffer {
    void init();

    // Sensor-Loop (Core 1): Lock-free write in RAM-Ring-Buffer
    // Non-blocking. On overflow the hit is dropped and _dropCount is incremented.
    void addHit(float gforce, int durationMs, float rn, float energy, int hitDurationMs,
                float confidence);

    // Network task (core 0): reads hits from RAM and advances the tail.
    // Returns the number of hits read.
    int  drainRam(BinaryHit* out, int maxCount);

    // Number of hits currently in RAM.
    int  ramCount();
    int  ramCapacity();
    int  ramHighWater();

    // Counter for dropped hits (overflow)
    uint32_t getDropCount();

    // Persistent diagnostic counter for failed SPIFFS writes.
    uint32_t getSpiffsWriteErrorCount();
    void persistDiagnostics();

    // SPIFFS fallback (network task only)
    bool hasPendingFile();
    long getFileSize();
    int  fileRecordCount();
    int  readPendingFile(BinaryHit* out, int maxCount);
    bool commitPendingFile(int count);
    uint32_t oldestPendingEpochS();
    // true only if the complete batch was durably written.
    bool appendToFile(const BinaryHit* hits, int count);
    void clear();
    int  size(); // RAM + SPIFFS combined
    bool empty();
}
