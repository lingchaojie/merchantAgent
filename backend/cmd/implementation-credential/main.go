// Command implementation-credential is an offline platform-operator tool for
// issuing a tenant- and device-bound connector implementation credential.
package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/merchantagent/backend/connectorregistry"
)

func main() {
	if err := run(os.Args[1:], os.Stdout, os.Stderr); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(args []string, stdout, stderr io.Writer) error {
	flags := flag.NewFlagSet("implementation-credential", flag.ContinueOnError)
	flags.SetOutput(stderr)
	tenant := flags.String("tenant", "", "tenant identifier")
	device := flags.String("device", "", "device identifier")
	devicePublicKeyPath := flags.String("device-public-key", "", "device Ed25519 public key PEM")
	expiresValue := flags.String("expires", "", "expiry as RFC3339 timestamp or duration")
	platformPrivateKeyPath := flags.String("platform-private-key", "", "platform Ed25519 private key PEM")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 || *tenant == "" || *device == "" || *devicePublicKeyPath == "" || *expiresValue == "" || *platformPrivateKeyPath == "" {
		return errors.New("tenant, device, device-public-key, expires, and platform-private-key are required")
	}

	now := time.Now().UTC()
	expires, err := parseExpiry(now, *expiresValue)
	if err != nil {
		return err
	}
	if !expires.After(now) {
		return errors.New("expires must be in the future")
	}
	devicePEM, err := os.ReadFile(*devicePublicKeyPath)
	if err != nil {
		return fmt.Errorf("read device public key: %w", err)
	}
	deviceKey, err := connectorregistry.ParseEd25519PublicKeyPEM(devicePEM)
	if err != nil {
		return fmt.Errorf("device public key: %w", err)
	}
	canonicalDevicePEM, err := marshalPublicKey(deviceKey)
	if err != nil {
		return err
	}
	privatePEM, err := os.ReadFile(*platformPrivateKeyPath)
	if err != nil {
		return fmt.Errorf("read platform private key: %w", err)
	}
	platformPrivateKey, err := parsePrivateKey(privatePEM)
	if err != nil {
		return fmt.Errorf("platform private key: %w", err)
	}
	credentialID, err := newCredentialID()
	if err != nil {
		return err
	}
	credential, err := connectorregistry.SignImplementationCredential(platformPrivateKey, connectorregistry.ImplementationClaims{
		CredentialID: credentialID,
		TenantID:     *tenant,
		DeviceID:     *device,
		DeviceKey:    string(canonicalDevicePEM),
		Scopes:       []string{"connector:draft", "connector:test", "connector:submit"},
		IssuedAt:     now.Unix(),
		ExpiresAt:    expires.UTC().Unix(),
	})
	if err != nil {
		return fmt.Errorf("sign implementation credential: %w", err)
	}
	_, err = fmt.Fprintln(stdout, credential)
	return err
}

func parseExpiry(now time.Time, value string) (time.Time, error) {
	if expiry, err := time.Parse(time.RFC3339, value); err == nil {
		return expiry.UTC(), nil
	}
	duration, err := time.ParseDuration(value)
	if err != nil {
		return time.Time{}, errors.New("expires must be an RFC3339 timestamp or duration")
	}
	return now.Add(duration), nil
}

func parsePrivateKey(data []byte) (ed25519.PrivateKey, error) {
	block, rest := pem.Decode(data)
	if block == nil || strings.TrimSpace(string(rest)) != "" {
		return nil, errors.New("expected one PEM private key")
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("parse PKCS#8 key: %w", err)
	}
	key, ok := parsed.(ed25519.PrivateKey)
	if !ok || len(key) != ed25519.PrivateKeySize {
		return nil, errors.New("private key is not Ed25519")
	}
	return key, nil
}

func marshalPublicKey(key ed25519.PublicKey) ([]byte, error) {
	der, err := x509.MarshalPKIXPublicKey(key)
	if err != nil {
		return nil, fmt.Errorf("marshal device public key: %w", err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}), nil
}

func newCredentialID() (string, error) {
	random := make([]byte, 18)
	if _, err := io.ReadFull(rand.Reader, random); err != nil {
		return "", fmt.Errorf("generate credential id: %w", err)
	}
	return "implementation-" + base64.RawURLEncoding.EncodeToString(random), nil
}
