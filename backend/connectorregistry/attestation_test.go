package connectorregistry

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestVerifySubmissionBindsTenantDeviceExpiryAndDigest(t *testing.T) {
	now := time.Date(2026, 7, 12, 10, 0, 0, 0, time.UTC)
	credential, devicePrivate, verifier := signedFixtureCredential(t, now, "mock-corp-001", "device-01")
	claims, err := verifier.Verify(now, credential)
	if err != nil {
		t.Fatal(err)
	}
	v := validSubmittedVersion()
	v.DeviceID = "device-01"
	sig := signDigest(t, devicePrivate, v, now)
	if err := verifier.VerifySubmission(now, claims, v, now, sig); err != nil {
		t.Fatal(err)
	}
	v.TenantID = "other-tenant"
	if err := verifier.VerifySubmission(now, claims, v, now, sig); !errors.Is(err, ErrAttestationScope) {
		t.Fatalf("error=%v", err)
	}
}

func TestCredentialVerifierFailsClosed(t *testing.T) {
	now := time.Date(2026, 7, 12, 10, 0, 0, 0, time.UTC)
	credential, devicePrivate, verifier := signedFixtureCredential(t, now, "mock-corp-001", "device-01")
	claims, err := verifier.Verify(now, credential)
	if err != nil {
		t.Fatal(err)
	}
	v := validSubmittedVersion()
	sig := signDigest(t, devicePrivate, v, now)

	tests := []struct {
		name string
		run  func() error
	}{
		{"expired credential", func() error { _, err := verifier.Verify(now.Add(2*time.Hour), credential); return err }},
		{"wrong device", func() error {
			changed := v
			changed.DeviceID = "device-02"
			return verifier.VerifySubmission(now, claims, changed, now, sig)
		}},
		{"changed digest", func() error {
			changed := v
			changed.Digest = "sha256:" + strings.Repeat("c", 64)
			return verifier.VerifySubmission(now, claims, changed, now, sig)
		}},
		{"future signature", func() error {
			future := now.Add(5*time.Minute + time.Second)
			return verifier.VerifySubmission(now, claims, v, future, signDigest(t, devicePrivate, v, future))
		}},
		{"expired submission verifier", func() error { return verifier.VerifySubmission(now.Add(2*time.Hour), claims, v, now, sig) }},
		{"signature after exact expiry", func() error {
			expiry := time.Unix(claims.ExpiresAt, 0).UTC()
			signedAt := expiry.Add(500 * time.Millisecond)
			return verifier.VerifySubmission(expiry.Add(-time.Minute), claims, v, signedAt, signDigest(t, devicePrivate, v, signedAt))
		}},
		{"wrong scopes", func() error {
			changed := claims
			changed.Scopes = []string{"connector:submit"}
			return verifier.VerifySubmission(now, changed, v, now, sig)
		}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if err := tc.run(); err == nil {
				t.Fatal("accepted invalid credential or submission")
			}
		})
	}
}

func TestVerifySubmissionTreatsCredentialExpiryAsExclusive(t *testing.T) {
	now := time.Date(2026, 7, 12, 10, 0, 0, 0, time.UTC)
	credential, devicePrivate, verifier := signedFixtureCredential(t, now, "mock-corp-001", "device-01")
	claims, err := verifier.Verify(now, credential)
	if err != nil {
		t.Fatal(err)
	}
	v := validSubmittedVersion()
	expiresAt := time.Unix(claims.ExpiresAt, 0).UTC()
	justBeforeExpiry := expiresAt.Add(-time.Nanosecond)
	if err := verifier.VerifySubmission(expiresAt.Add(-time.Minute), claims, v, justBeforeExpiry, signDigest(t, devicePrivate, v, justBeforeExpiry)); err != nil {
		t.Fatalf("immediately before expiry: %v", err)
	}
	if err := verifier.VerifySubmission(expiresAt.Add(-time.Minute), claims, v, expiresAt, signDigest(t, devicePrivate, v, expiresAt)); !errors.Is(err, ErrAttestationScope) {
		t.Fatalf("at expiry error=%v", err)
	}
}

func signedFixtureCredential(t *testing.T, now time.Time, tenant, device string) (string, ed25519.PrivateKey, CredentialVerifier) {
	t.Helper()
	platformPublic, platformPrivate, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	devicePublic, devicePrivate, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKIXPublicKey(devicePublic)
	if err != nil {
		t.Fatal(err)
	}
	claims := ImplementationClaims{
		CredentialID: "implementation-credential-01",
		TenantID:     tenant,
		DeviceID:     device,
		DeviceKey:    string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der})),
		Scopes:       []string{"connector:draft", "connector:test", "connector:submit"},
		IssuedAt:     now.Add(-time.Hour).Unix(),
		ExpiresAt:    now.Add(time.Hour).Unix(),
	}
	payload, err := json.Marshal(claims)
	if err != nil {
		t.Fatal(err)
	}
	signature := ed25519.Sign(platformPrivate, payload)
	encoded := base64.RawURLEncoding.EncodeToString(payload) + "." + base64.RawURLEncoding.EncodeToString(signature)
	return encoded, devicePrivate, CredentialVerifier{PlatformPublicKey: platformPublic}
}

func signDigest(t *testing.T, private ed25519.PrivateKey, v Version, signedAt time.Time) string {
	t.Helper()
	message := SubmissionSigningInput(v.TenantID, v.DeviceID, v.ConnectorID, v.Version, v.Digest, signedAt)
	return base64.RawURLEncoding.EncodeToString(ed25519.Sign(private, []byte(message)))
}
