#pragma once
#include <Arduino.h>

// Obfuscates sensitive NVS values (WiFi credentials, device token) in flash.
//
// Scheme: AES-256-CBC with a random IV. The key is derived per device from the
// eFuse MAC plus a compiled-in salt (SHA-256), so every device has its own key.
//
// Protection level: very effective against simply dumping the flash
// (esptool read_flash), since only ciphertext is stored. NO protection against
// an attacker who reverse-engineers the firmware — the key lives in the
// machine code. Obfuscation only, not a hardware vault.
namespace SecretStore {
    // Plaintext -> "ENC1:<base64(IV+ciphertext)>". On error the plaintext is returned.
    String encrypt(const String& plaintext);

    // "ENC1:..." -> plaintext. Unencrypted values (legacy plaintext or empty)
    // are returned unchanged (backward compatibility).
    String decrypt(const String& stored);

    // true if the stored value is in ENC1 format.
    bool isEncrypted(const String& stored);
}
