#include "hit_buffer.h"
#include "config.h"
#include "task_sync.h"
#include "time_sync.h"
#include <SPIFFS.h>
#include <Preferences.h>
#include <esp_system.h>
#include <stddef.h>
#include <unistd.h>

// v4 records (36 B) live in their own file so older record formats are never
// mixed with the deduplicable records. The legacy v2 file is discarded;
// v3 buffers (hits3.bin) are no longer sent.
static const char* HITS_FILE_V2 = "/spiffs/hits.bin";
static const char* HITS_JOURNAL = "/spiffs/hits4.jrn";

// Fixed, preallocated ring journal: no growing file and therefore no expensive
// SPIFFS GC runs during operation. Headers A/B are written alternately; after
// a power loss the newest valid generation wins.
// 8192 records = 288 KiB payload (a good 27 minutes at 5 strokes/s).
static constexpr uint32_t JOURNAL_MAGIC = 0x344A5146; // "FQJ4" little-endian
static constexpr uint16_t JOURNAL_VERSION = 1;
static constexpr uint32_t JOURNAL_CAPACITY = 8192;
static constexpr long JOURNAL_HEADER_A = 0;
static constexpr long JOURNAL_HEADER_B = 64;
static constexpr long JOURNAL_DATA_OFFSET = 4096;
static constexpr long JOURNAL_FILE_SIZE =
    JOURNAL_DATA_OFFSET + (long)JOURNAL_CAPACITY * (long)sizeof(BinaryHit);

struct __attribute__((packed)) JournalHeader {
    uint32_t magic;
    uint16_t version;
    uint16_t size;
    uint32_t generation;
    uint32_t head;
    uint32_t tail;
    uint32_t capacity;
    uint32_t checksum;
};

static JournalHeader _journal = {};
static bool _journalReady = false;

static uint32_t headerChecksum(const JournalHeader& h) {
    const uint8_t* p = reinterpret_cast<const uint8_t*>(&h);
    uint32_t hash = 2166136261u; // FNV-1a; detects torn/partial header writes.
    for (size_t i = 0; i < offsetof(JournalHeader, checksum); i++) {
        hash ^= p[i];
        hash *= 16777619u;
    }
    return hash;
}

static bool validHeader(const JournalHeader& h) {
    return h.magic == JOURNAL_MAGIC && h.version == JOURNAL_VERSION &&
           h.size == sizeof(JournalHeader) && h.capacity == JOURNAL_CAPACITY &&
           h.head - h.tail <= h.capacity && h.checksum == headerChecksum(h);
}

static bool readHeader(FILE* f, long offset, JournalHeader& out) {
    if (fseek(f, offset, SEEK_SET) != 0) return false;
    return fread(&out, sizeof(out), 1, f) == 1 && validHeader(out);
}

static bool newerGeneration(uint32_t a, uint32_t b) {
    return (int32_t)(a - b) > 0;
}

static bool writeHeader(FILE* f, const JournalHeader& state) {
    JournalHeader next = state;
    next.generation++;
    next.checksum = headerChecksum(next);
    long offset = (next.generation & 1u) ? JOURNAL_HEADER_B : JOURNAL_HEADER_A;
    if (fseek(f, offset, SEEK_SET) != 0 || fwrite(&next, sizeof(next), 1, f) != 1 ||
            fflush(f) != 0) {
        return false;
    }
    _journal = next;
    return true;
}

static bool preallocateJournal(FILE* f) {
    static uint8_t zeros[4096] = {};
    long written = 0;
    while (written < JOURNAL_FILE_SIZE) {
        size_t n = min((long)sizeof(zeros), JOURNAL_FILE_SIZE - written);
        if (fwrite(zeros, 1, n, f) != n) return false;
        written += (long)n;
        delay(1); // give the boot WDT/RTOS room; the sensor loop is not running yet.
    }
    return fflush(f) == 0;
}

static bool initJournal() {
    FILE* f = fopen(HITS_JOURNAL, "r+b");
    if (f) {
        JournalHeader a = {}, b = {};
        bool va = readHeader(f, JOURNAL_HEADER_A, a);
        bool vb = readHeader(f, JOURNAL_HEADER_B, b);
        if (va || vb) {
            _journal = !va ? b : (!vb ? a : (newerGeneration(b.generation, a.generation) ? b : a));
            fclose(f);
            _journalReady = true;
            Serial.printf("Hit journal: %lu/%lu records in use\n",
                          (unsigned long)(_journal.head - _journal.tail),
                          (unsigned long)_journal.capacity);
            return true;
        }
        fclose(f);
        // No valid header means an interrupted initial creation; there was no
        // committed head yet, so there are no records to rescue.
        remove(HITS_JOURNAL);
    }

    f = fopen(HITS_JOURNAL, "w+b");
    if (!f) return false;
    bool ok = preallocateJournal(f);
    if (ok) {
        JournalHeader initial = {};
        initial.magic = JOURNAL_MAGIC;
        initial.version = JOURNAL_VERSION;
        initial.size = sizeof(JournalHeader);
        initial.capacity = JOURNAL_CAPACITY;
        initial.generation = 0;
        _journal = initial;
        ok = writeHeader(f, initial);
    }
    fclose(f);
    if (!ok) {
        remove(HITS_JOURNAL);
        return false;
    }
    _journalReady = true;
    Serial.printf("Hit journal created: %ld bytes, %lu records\n",
                  JOURNAL_FILE_SIZE, (unsigned long)JOURNAL_CAPACITY);
    return true;
}

static bool writeJournalRecords(const BinaryHit* hits, int count) {
    if (!_journalReady || count <= 0) return count <= 0;
    uint32_t used = _journal.head - _journal.tail;
    if ((uint32_t)count > _journal.capacity - used) return false;

    FILE* f = fopen(HITS_JOURNAL, "r+b");
    if (!f) return false;
    uint32_t slot = _journal.head % _journal.capacity;
    int first = min(count, (int)(_journal.capacity - slot));
    bool ok = fseek(f, JOURNAL_DATA_OFFSET + (long)slot * sizeof(BinaryHit), SEEK_SET) == 0 &&
              fwrite(hits, sizeof(BinaryHit), first, f) == (size_t)first;
    if (ok && first < count) {
        ok = fseek(f, JOURNAL_DATA_OFFSET, SEEK_SET) == 0 &&
             fwrite(hits + first, sizeof(BinaryHit), count - first, f) == (size_t)(count - first);
    }
    if (ok) ok = fflush(f) == 0;
    if (ok) {
        JournalHeader next = _journal;
        next.head += (uint32_t)count;
        ok = writeHeader(f, next);
    }
    fclose(f);
    return ok;
}

static int readJournalRecords(BinaryHit* out, int maxCount) {
    if (!_journalReady || !out || maxCount <= 0) return 0;
    uint32_t used = _journal.head - _journal.tail;
    int count = min(maxCount, (int)used);
    if (count <= 0) return 0;
    FILE* f = fopen(HITS_JOURNAL, "rb");
    if (!f) return -1;
    uint32_t slot = _journal.tail % _journal.capacity;
    int first = min(count, (int)(_journal.capacity - slot));
    bool ok = fseek(f, JOURNAL_DATA_OFFSET + (long)slot * sizeof(BinaryHit), SEEK_SET) == 0 &&
              fread(out, sizeof(BinaryHit), first, f) == (size_t)first;
    if (ok && first < count) {
        ok = fseek(f, JOURNAL_DATA_OFFSET, SEEK_SET) == 0 &&
             fread(out + first, sizeof(BinaryHit), count - first, f) == (size_t)(count - first);
    }
    fclose(f);
    return ok ? count : -1;
}

static bool commitJournalRecords(int count) {
    if (!_journalReady || count < 0 || (uint32_t)count > _journal.head - _journal.tail) return false;
    if (count == 0) return true;
    FILE* f = fopen(HITS_JOURNAL, "r+b");
    if (!f) return false;
    JournalHeader next = _journal;
    next.tail += (uint32_t)count;
    bool ok = writeHeader(f, next);
    fclose(f);
    return ok;
}

// ─── Lock-free ring buffer (single writer: sensor, single reader: network) ──
// Monotonically increasing counters; index = counter % capacity.
// Survives uint32_t overflow as long as (head - tail) < 2^31.
static BinaryHit*      _ring = nullptr;
static uint32_t        _ringCapacity = 0;
static volatile uint32_t _head = 0;  // written by the sensor loop only
static volatile uint32_t _tail = 0;  // written by the network task only
static volatile uint32_t _dropCount = 0;
static volatile uint32_t _spiffsWriteErrorCount = 0;
static uint32_t _persistedDropCount = 0;
static uint32_t _persistedSpiffsWriteErrorCount = 0;
static uint64_t _bootId = 0;
static uint32_t _eventSequence = 0;

static void recordSpiffsWriteError() {
    _spiffsWriteErrorCount++;
    Serial.printf("HitBuffer: SPIFFS write failed (total errors: %lu)\n",
                  (unsigned long)_spiffsWriteErrorCount);
}

void HitBuffer::init() {
    _head = 0;
    _tail = 0;
    // Allocate the large ring once from the heap; if the boot heap is unusually short,
    // fall back step by step down to 128 records instead of failing to start.
    for (_ringCapacity = HIT_RAM_CAPACITY; _ringCapacity >= 128; _ringCapacity /= 2) {
        _ring = static_cast<BinaryHit*>(malloc(_ringCapacity * sizeof(BinaryHit)));
        if (_ring) break;
    }
    if (!_ring) _ringCapacity = 0;
    Serial.printf("HitBuffer: RAM ring %lu records (%lu bytes)\n",
                  (unsigned long)_ringCapacity,
                  (unsigned long)(_ringCapacity * sizeof(BinaryHit)));
    Preferences prefs;
    prefs.begin("hit-diag", true);
    _dropCount = prefs.getULong("drops", 0);
    _spiffsWriteErrorCount = prefs.getULong("fs_errors", 0);
    prefs.end();
    _persistedDropCount = _dropCount;
    _persistedSpiffsWriteErrorCount = _spiffsWriteErrorCount;
    _eventSequence = 0;
    // 63 random bits fit into a PostgreSQL BIGINT without sign conversion.
    // boot_id 0 is reserved/invalid. The ID is stable for this boot; buffered
    // records carry it themselves and stay unique across reboots.
    _bootId = ((uint64_t)(esp_random() & 0x7FFFFFFFUL) << 32) | esp_random();
    if (_bootId == 0) _bootId = 1;
    // Discard the legacy 16-byte file from pre-v3 firmware: it is only non-empty
    // after offline periods, and an OTA update requires being online — the
    // residual risk of losing a few hits beats a format sniffer.
    remove(HITS_FILE_V2);
    if (!initJournal()) {
        recordSpiffsWriteError();
    }
}

void HitBuffer::addHit(float gforce, int durationMs, float rn, float energy,
                       int hitDurationMs, float confidence) {
    uint32_t midTicks = millis() - (durationMs / 2);

    uint32_t epochS;
    uint16_t epochMs;
    TimeSync::ticksToEpochWithMs(midTicks, epochS, epochMs);

    BinaryHit hit;
    hit.epoch_s = epochS;
    hit.epoch_ms = epochMs;
    hit.energy = energy;
    hit.gforce = gforce;
    hit.duration_ms = (uint16_t)hitDurationMs;
    hit.rn = rn;
    hit.confidence = confidence > 1.0f ? 1.0f : confidence;
    hit.boot_id = _bootId;
    hit.event_sequence = ++_eventSequence;

    // Lock-free: check for space, write, then publish head
    uint32_t head = _head;
    uint32_t tail = _tail;
    if (!_ring || (head - tail) >= _ringCapacity) {
        // buffer full → drop the hit (non-blocking)
        _dropCount++;
        return;
    }
    _ring[head % _ringCapacity] = hit;
    __sync_synchronize(); // publish the full record before core 0 sees head
    _head = head + 1; // atomic publish (32-bit writes are atomic on ESP32)
}

int HitBuffer::drainRam(BinaryHit* out, int maxCount) {
    uint32_t head = _head;
    __sync_synchronize(); // read head, then take over the published record
    uint32_t tail = _tail;
    int available = (int)(head - tail);
    int toRead = available < maxCount ? available : maxCount;
    for (int i = 0; i < toRead; i++) {
        out[i] = _ring[(tail + i) % _ringCapacity];
    }
    __sync_synchronize();
    _tail = tail + toRead; // atomic publish
    return toRead;
}

int HitBuffer::ramCount() {
    return (int)(_head - _tail);
}

int HitBuffer::ramCapacity() { return (int)_ringCapacity; }
int HitBuffer::ramHighWater() { return (int)(_ringCapacity * 3u / 4u); }

uint32_t HitBuffer::getDropCount() {
    return _dropCount;
}

uint32_t HitBuffer::getSpiffsWriteErrorCount() {
    return _spiffsWriteErrorCount;
}

void HitBuffer::persistDiagnostics() {
    uint32_t drops = _dropCount;
    uint32_t fsErrors = _spiffsWriteErrorCount;
    if (drops == _persistedDropCount && fsErrors == _persistedSpiffsWriteErrorCount) return;

    Preferences prefs;
    prefs.begin("hit-diag", false);
    if (drops != _persistedDropCount) prefs.putULong("drops", drops);
    if (fsErrors != _persistedSpiffsWriteErrorCount) prefs.putULong("fs_errors", fsErrors);
    prefs.end();
    _persistedDropCount = drops;
    _persistedSpiffsWriteErrorCount = fsErrors;
}

// ─── SPIFFS fallback (network task only) ───────────────────────────────

bool HitBuffer::appendToFile(const BinaryHit* hits, int count) {
    if (count <= 0) return true;
    xSemaphoreTake(TaskSync::getBufferMutex(), portMAX_DELAY);
    bool ok = writeJournalRecords(hits, count);
    xSemaphoreGive(TaskSync::getBufferMutex());
    if (!ok) recordSpiffsWriteError();
    return ok;
}

bool HitBuffer::hasPendingFile() {
    xSemaphoreTake(TaskSync::getBufferMutex(), portMAX_DELAY);
    bool has = _journalReady && _journal.head != _journal.tail;
    xSemaphoreGive(TaskSync::getBufferMutex());
    return has;
}

long HitBuffer::getFileSize() {
    return (long)fileRecordCount() * (long)sizeof(BinaryHit);
}

int HitBuffer::fileRecordCount() {
    xSemaphoreTake(TaskSync::getBufferMutex(), portMAX_DELAY);
    int count = _journalReady ? (int)(_journal.head - _journal.tail) : 0;
    xSemaphoreGive(TaskSync::getBufferMutex());
    return count;
}

int HitBuffer::readPendingFile(BinaryHit* out, int maxCount) {
    xSemaphoreTake(TaskSync::getBufferMutex(), portMAX_DELAY);
    int count = readJournalRecords(out, maxCount);
    xSemaphoreGive(TaskSync::getBufferMutex());
    if (count < 0) recordSpiffsWriteError();
    return count;
}

bool HitBuffer::commitPendingFile(int count) {
    xSemaphoreTake(TaskSync::getBufferMutex(), portMAX_DELAY);
    bool ok = commitJournalRecords(count);
    xSemaphoreGive(TaskSync::getBufferMutex());
    if (!ok) recordSpiffsWriteError();
    return ok;
}

uint32_t HitBuffer::oldestPendingEpochS() {
    uint32_t oldest = 0;
    BinaryHit first;
    xSemaphoreTake(TaskSync::getBufferMutex(), portMAX_DELAY);
    int count = readJournalRecords(&first, 1);
    xSemaphoreGive(TaskSync::getBufferMutex());
    if (count == 1) oldest = first.epoch_s;
    else if (count < 0) recordSpiffsWriteError();

    uint32_t head = _head;
    __sync_synchronize();
    uint32_t tail = _tail;
    if (head != tail) {
        uint32_t ramEpoch = _ring[tail % _ringCapacity].epoch_s;
        if (ramEpoch != 0 && (oldest == 0 || ramEpoch < oldest)) oldest = ramEpoch;
    }
    return oldest;
}

void HitBuffer::clear() {
    xSemaphoreTake(TaskSync::getBufferMutex(), portMAX_DELAY);
    int pending = _journalReady ? (int)(_journal.head - _journal.tail) : 0;
    bool ok = pending == 0 || commitJournalRecords(pending);
    xSemaphoreGive(TaskSync::getBufferMutex());
    if (!ok) recordSpiffsWriteError();
}

int HitBuffer::size() {
    return ramCount() + fileRecordCount();
}

bool HitBuffer::empty() {
    return ramCount() == 0 && !hasPendingFile();
}
