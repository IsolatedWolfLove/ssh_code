// Package store implements the saved-connections store and credential
// encryption that replace Electron's safeStorage-backed SavedConnectionStore
// (src/main/saved-connections.ts) for the Wails backend.
//
// Security decision (see the plan): AES-256-GCM with a locally generated key
// file, not an OS keychain. A go-keyring-style OS Secret Service integration
// was considered and rejected because it needs a running DBus Secret Service
// on Linux, which is often absent on minimal/headless desktops. This scheme
// protects against casual disk inspection or another local user reading the
// file directly - the same threat model as Electron's safeStorage fallback
// path, and a strict improvement over that fallback's plain-base64 mode.
package store

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

const keyFileName = "store.key"
const keySize = 32 // AES-256

// GenerateOrLoadKey reads the 32-byte key from <dir>/store.key, creating it
// (with 0600 permissions) on first use. The directory must already exist.
func GenerateOrLoadKey(dir string) ([]byte, error) {
	keyPath := filepath.Join(dir, keyFileName)

	if data, err := os.ReadFile(keyPath); err == nil {
		if len(data) != keySize {
			return nil, fmt.Errorf("store key at %s has unexpected length %d (want %d)", keyPath, len(data), keySize)
		}
		return data, nil
	} else if !os.IsNotExist(err) {
		return nil, fmt.Errorf("unable to read store key: %w", err)
	}

	key := make([]byte, keySize)
	if _, err := rand.Read(key); err != nil {
		return nil, fmt.Errorf("unable to generate store key: %w", err)
	}

	if err := os.WriteFile(keyPath, key, 0o600); err != nil {
		return nil, fmt.Errorf("unable to persist store key: %w", err)
	}

	return key, nil
}

// Encrypt seals plaintext with AES-256-GCM under key, returning a base64
// string of nonce||ciphertext (nonce prepended, then the whole thing
// base64-encoded - a simple, self-contained wire format).
func Encrypt(key []byte, plaintext string) (string, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}

	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", err
	}

	sealed := gcm.Seal(nonce, nonce, []byte(plaintext), nil)
	return base64.StdEncoding.EncodeToString(sealed), nil
}

// Decrypt reverses Encrypt. Returns an error if key is wrong or value is
// malformed/tampered (GCM authentication failure).
func Decrypt(key []byte, value string) (string, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}

	raw, err := base64.StdEncoding.DecodeString(value)
	if err != nil {
		return "", fmt.Errorf("invalid encrypted value: %w", err)
	}

	nonceSize := gcm.NonceSize()
	if len(raw) < nonceSize {
		return "", errors.New("encrypted value is too short")
	}

	nonce, ciphertext := raw[:nonceSize], raw[nonceSize:]
	plaintext, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return "", fmt.Errorf("unable to decrypt value: %w", err)
	}

	return string(plaintext), nil
}
