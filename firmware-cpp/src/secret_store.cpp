#include "secret_store.h"
#include <vector>
#include <esp_system.h>
#include "mbedtls/aes.h"
#include "mbedtls/sha256.h"
#include "mbedtls/base64.h"

static const char ENC_PREFIX[] = "ENC1:";
static const size_t ENC_PREFIX_LEN = 5;

// Device-independent salt for the key derivation. It is part of the source,
// so this is obfuscation, not secrecy. Do NOT change it, or existing encrypted
// values become unreadable (then erase NVS and re-provision first).
static const uint8_t KEY_SALT[] = {
    0x9c, 0x4a, 0xf1, 0x07, 0x2e, 0xb8, 0x53, 0xd6,
    0x61, 0x1f, 0xa3, 0x8d, 0x42, 0xc7, 0x0b, 0xe9,
    0x77, 0x35, 0xda, 0x14, 0x88, 0x5e, 0xb0, 0x2c
};

// key = SHA-256( eFuse MAC (6 bytes) || KEY_SALT ) -> 32 bytes (AES-256).
static void deriveKey(uint8_t out[32]) {
    uint64_t mac = ESP.getEfuseMac(); // 48-bit, stable per device
    uint8_t buf[6 + sizeof(KEY_SALT)];
    for (int i = 0; i < 6; i++) buf[i] = (uint8_t)(mac >> (i * 8));
    memcpy(buf + 6, KEY_SALT, sizeof(KEY_SALT));
    mbedtls_sha256(buf, sizeof(buf), out, 0); // is224 = 0 -> SHA-256
}

static void fillRandom(uint8_t* p, size_t n) {
    for (size_t i = 0; i < n; i += 4) {
        uint32_t r = esp_random();
        size_t take = (n - i < 4) ? (n - i) : 4;
        memcpy(p + i, &r, take);
    }
}

bool SecretStore::isEncrypted(const String& stored) {
    return stored.startsWith(ENC_PREFIX);
}

String SecretStore::encrypt(const String& plaintext) {
    uint8_t key[32];
    deriveKey(key);

    // PKCS#7 padding to 16-byte blocks
    size_t len = plaintext.length();
    size_t padded = ((len / 16) + 1) * 16;
    std::vector<uint8_t> in(padded);
    memcpy(in.data(), plaintext.c_str(), len);
    uint8_t pad = (uint8_t)(padded - len);
    for (size_t i = len; i < padded; i++) in[i] = pad;

    uint8_t iv[16];
    fillRandom(iv, 16);
    uint8_t ivWork[16];
    memcpy(ivWork, iv, 16); // CBC mutates the IV -> use a copy

    std::vector<uint8_t> ct(padded);
    mbedtls_aes_context ctx;
    mbedtls_aes_init(&ctx);
    if (mbedtls_aes_setkey_enc(&ctx, key, 256) != 0 ||
        mbedtls_aes_crypt_cbc(&ctx, MBEDTLS_AES_ENCRYPT, padded, ivWork, in.data(), ct.data()) != 0) {
        mbedtls_aes_free(&ctx);
        return plaintext; // fail open: better store plaintext than lose data
    }
    mbedtls_aes_free(&ctx);

    // payload = IV(16) || Ciphertext
    std::vector<uint8_t> payload(16 + padded);
    memcpy(payload.data(), iv, 16);
    memcpy(payload.data() + 16, ct.data(), padded);

    size_t needed = 0;
    mbedtls_base64_encode(nullptr, 0, &needed, payload.data(), payload.size());
    std::vector<uint8_t> b64(needed + 1);
    size_t written = 0;
    if (mbedtls_base64_encode(b64.data(), b64.size(), &written, payload.data(), payload.size()) != 0) {
        return plaintext;
    }
    b64[written] = 0;

    return String(ENC_PREFIX) + (const char*)b64.data();
}

String SecretStore::decrypt(const String& stored) {
    if (!isEncrypted(stored)) return stored; // legacy plaintext or empty

    String b64 = stored.substring(ENC_PREFIX_LEN);
    const uint8_t* in = (const uint8_t*)b64.c_str();
    size_t inLen = b64.length();

    size_t needed = 0;
    mbedtls_base64_decode(nullptr, 0, &needed, in, inLen);
    std::vector<uint8_t> payload(needed);
    size_t written = 0;
    if (mbedtls_base64_decode(payload.data(), payload.size(), &written, in, inLen) != 0) {
        return ""; // corrupt
    }
    if (written < 32 || (written - 16) % 16 != 0) return ""; // IV + >=1 block

    uint8_t iv[16];
    memcpy(iv, payload.data(), 16);
    size_t ctLen = written - 16;

    uint8_t key[32];
    deriveKey(key);

    std::vector<uint8_t> pt(ctLen);
    mbedtls_aes_context ctx;
    mbedtls_aes_init(&ctx);
    if (mbedtls_aes_setkey_dec(&ctx, key, 256) != 0 ||
        mbedtls_aes_crypt_cbc(&ctx, MBEDTLS_AES_DECRYPT, ctLen, iv, payload.data() + 16, pt.data()) != 0) {
        mbedtls_aes_free(&ctx);
        return "";
    }
    mbedtls_aes_free(&ctx);

    // strip PKCS#7 padding
    uint8_t pad = pt[ctLen - 1];
    if (pad == 0 || pad > 16 || pad > ctLen) return ""; // invalid -> wrong key/corrupt
    size_t plainLen = ctLen - pad;

    String out;
    out.reserve(plainLen);
    for (size_t i = 0; i < plainLen; i++) out += (char)pt[i];
    return out;
}
