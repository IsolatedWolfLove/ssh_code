package store

import "testing"

func TestGenerateOrLoadKeyPersists(t *testing.T) {
	dir := t.TempDir()

	key1, err := GenerateOrLoadKey(dir)
	if err != nil {
		t.Fatalf("GenerateOrLoadKey: %v", err)
	}
	if len(key1) != keySize {
		t.Fatalf("key length = %d, want %d", len(key1), keySize)
	}

	key2, err := GenerateOrLoadKey(dir)
	if err != nil {
		t.Fatalf("GenerateOrLoadKey (second call): %v", err)
	}

	if string(key1) != string(key2) {
		t.Fatal("second GenerateOrLoadKey call returned a different key; expected it to load the persisted one")
	}
}

func TestEncryptDecryptRoundTrip(t *testing.T) {
	dir := t.TempDir()
	key, err := GenerateOrLoadKey(dir)
	if err != nil {
		t.Fatalf("GenerateOrLoadKey: %v", err)
	}

	plaintext := "s3cr3t-password-with-unicode-éè"
	encrypted, err := Encrypt(key, plaintext)
	if err != nil {
		t.Fatalf("Encrypt: %v", err)
	}

	if encrypted == plaintext {
		t.Fatal("Encrypt returned the plaintext unchanged")
	}

	decrypted, err := Decrypt(key, encrypted)
	if err != nil {
		t.Fatalf("Decrypt: %v", err)
	}
	if decrypted != plaintext {
		t.Fatalf("Decrypt = %q, want %q", decrypted, plaintext)
	}
}

func TestEncryptEmptyStringRoundTrips(t *testing.T) {
	dir := t.TempDir()
	key, err := GenerateOrLoadKey(dir)
	if err != nil {
		t.Fatalf("GenerateOrLoadKey: %v", err)
	}

	encrypted, err := Encrypt(key, "")
	if err != nil {
		t.Fatalf("Encrypt: %v", err)
	}

	decrypted, err := Decrypt(key, encrypted)
	if err != nil {
		t.Fatalf("Decrypt: %v", err)
	}
	if decrypted != "" {
		t.Fatalf("Decrypt = %q, want empty string", decrypted)
	}
}

func TestDecryptWithWrongKeyFails(t *testing.T) {
	dirA := t.TempDir()
	dirB := t.TempDir()

	keyA, err := GenerateOrLoadKey(dirA)
	if err != nil {
		t.Fatalf("GenerateOrLoadKey(A): %v", err)
	}
	keyB, err := GenerateOrLoadKey(dirB)
	if err != nil {
		t.Fatalf("GenerateOrLoadKey(B): %v", err)
	}

	encrypted, err := Encrypt(keyA, "top secret")
	if err != nil {
		t.Fatalf("Encrypt: %v", err)
	}

	if _, err := Decrypt(keyB, encrypted); err == nil {
		t.Fatal("Decrypt with the wrong key succeeded; expected an authentication failure")
	}
}

func TestDecryptMalformedValueFails(t *testing.T) {
	dir := t.TempDir()
	key, err := GenerateOrLoadKey(dir)
	if err != nil {
		t.Fatalf("GenerateOrLoadKey: %v", err)
	}

	if _, err := Decrypt(key, "not-valid-base64!!!"); err == nil {
		t.Fatal("Decrypt of malformed base64 succeeded; expected an error")
	}

	if _, err := Decrypt(key, "c2hvcnQ="); err == nil {
		t.Fatal("Decrypt of a too-short value succeeded; expected an error")
	}
}
