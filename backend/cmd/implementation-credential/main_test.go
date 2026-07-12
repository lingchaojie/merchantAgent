package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/pem"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/merchantagent/backend/connectorregistry"
)

func TestRunIssuesPlatformSignedCredential(t *testing.T) {
	platformPublic, platformPrivate, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	devicePublic, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	platformPath := filepath.Join(dir, "platform-private.pem")
	devicePath := filepath.Join(dir, "device-public.pem")
	writePKCS8PrivateKey(t, platformPath, platformPrivate)
	writePublicKey(t, devicePath, devicePublic)

	var stdout, stderr bytes.Buffer
	expires := time.Now().UTC().Add(time.Hour).Truncate(time.Second)
	err = run([]string{
		"-tenant", "mock-corp-001",
		"-device", "device-01",
		"-device-public-key", devicePath,
		"-expires", expires.Format(time.RFC3339),
		"-platform-private-key", platformPath,
	}, &stdout, &stderr)
	if err != nil {
		t.Fatalf("run: %v stderr=%s", err, stderr.String())
	}
	claims, err := (connectorregistry.CredentialVerifier{PlatformPublicKey: platformPublic}).Verify(time.Now().UTC(), string(bytes.TrimSpace(stdout.Bytes())))
	if err != nil {
		t.Fatal(err)
	}
	if claims.TenantID != "mock-corp-001" || claims.DeviceID != "device-01" || claims.CredentialID == "" {
		t.Fatalf("claims=%+v", claims)
	}
	if bytes.Contains(stdout.Bytes(), platformPrivate) || bytes.Contains(stderr.Bytes(), platformPrivate) {
		t.Fatal("private key material written to command output")
	}
}

func writePKCS8PrivateKey(t *testing.T, path string, key ed25519.PrivateKey) {
	t.Helper()
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}), 0o600); err != nil {
		t.Fatal(err)
	}
}

func writePublicKey(t *testing.T, path string, key ed25519.PublicKey) {
	t.Helper()
	der, err := x509.MarshalPKIXPublicKey(key)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}), 0o600); err != nil {
		t.Fatal(err)
	}
}
