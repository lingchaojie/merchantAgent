package connectorregistry

import (
	"bytes"
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"
)

var (
	ErrInvalidCredential    = errors.New("invalid implementation credential")
	ErrExpiredCredential    = errors.New("implementation credential is expired or not yet valid")
	ErrAttestationScope     = errors.New("implementation attestation is outside credential scope")
	ErrAttestationSignature = errors.New("invalid implementation attestation signature")
)

var submissionScopes = map[string]struct{}{
	"connector:draft":  {},
	"connector:test":   {},
	"connector:submit": {},
}

type ImplementationClaims struct {
	CredentialID string   `json:"credentialId"`
	TenantID     string   `json:"tenantId"`
	DeviceID     string   `json:"deviceId"`
	DeviceKey    string   `json:"devicePublicKeyPem"`
	Scopes       []string `json:"scopes"`
	IssuedAt     int64    `json:"issuedAt"`
	ExpiresAt    int64    `json:"expiresAt"`
}

type CredentialVerifier struct {
	PlatformPublicKey ed25519.PublicKey
}

func (v CredentialVerifier) Verify(now time.Time, encoded string) (ImplementationClaims, error) {
	var claims ImplementationClaims
	if len(v.PlatformPublicKey) != ed25519.PublicKeySize {
		return claims, fmt.Errorf("%w: platform public key is not configured", ErrInvalidCredential)
	}
	parts := strings.Split(encoded, ".")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return claims, fmt.Errorf("%w: malformed envelope", ErrInvalidCredential)
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return claims, fmt.Errorf("%w: malformed payload", ErrInvalidCredential)
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || len(signature) != ed25519.SignatureSize {
		return claims, fmt.Errorf("%w: malformed signature", ErrInvalidCredential)
	}
	if !ed25519.Verify(v.PlatformPublicKey, payload, signature) {
		return claims, fmt.Errorf("%w: signature verification failed", ErrInvalidCredential)
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&claims); err != nil {
		return ImplementationClaims{}, fmt.Errorf("%w: claims: %v", ErrInvalidCredential, err)
	}
	if err := requireJSONEOF(decoder); err != nil {
		return ImplementationClaims{}, fmt.Errorf("%w: claims: %v", ErrInvalidCredential, err)
	}
	if claims.CredentialID == "" || claims.TenantID == "" || claims.DeviceID == "" || claims.DeviceKey == "" || claims.IssuedAt <= 0 || claims.ExpiresAt <= claims.IssuedAt {
		return ImplementationClaims{}, fmt.Errorf("%w: incomplete claims", ErrInvalidCredential)
	}
	if _, err := parseEd25519PublicKey([]byte(claims.DeviceKey)); err != nil {
		return ImplementationClaims{}, fmt.Errorf("%w: device public key: %v", ErrInvalidCredential, err)
	}
	nowUnix := now.UTC().Unix()
	if nowUnix < claims.IssuedAt || nowUnix >= claims.ExpiresAt {
		return ImplementationClaims{}, ErrExpiredCredential
	}
	return claims, nil
}

func (v CredentialVerifier) VerifySubmission(now time.Time, claims ImplementationClaims, version Version, signedAt time.Time, signature string) error {
	if !hasExactSubmissionScopes(claims.Scopes) || version.TenantID != claims.TenantID || version.DeviceID != claims.DeviceID || version.ImplementationCredentialID != claims.CredentialID {
		return ErrAttestationScope
	}
	nowUnix := now.UTC().Unix()
	if nowUnix < claims.IssuedAt || nowUnix >= claims.ExpiresAt {
		return ErrExpiredCredential
	}
	signedAt = signedAt.UTC()
	issuedAt := time.Unix(claims.IssuedAt, 0).UTC()
	expiresAt := time.Unix(claims.ExpiresAt, 0).UTC()
	if signedAt.Before(issuedAt) || signedAt.After(expiresAt) || signedAt.After(now.UTC().Add(5*time.Minute)) {
		return ErrAttestationScope
	}
	deviceKey, err := parseEd25519PublicKey([]byte(claims.DeviceKey))
	if err != nil {
		return fmt.Errorf("%w: device public key", ErrInvalidCredential)
	}
	decodedSignature, err := base64.RawURLEncoding.DecodeString(signature)
	if err != nil || len(decodedSignature) != ed25519.SignatureSize {
		return ErrAttestationSignature
	}
	message := SubmissionSigningInput(version.TenantID, version.DeviceID, version.ConnectorID, version.Version, version.Digest, signedAt)
	if !ed25519.Verify(deviceKey, []byte(message), decodedSignature) {
		return ErrAttestationSignature
	}
	return nil
}

func SubmissionSigningInput(tenant, device, connectorID, version, digest string, signedAt time.Time) string {
	return strings.Join([]string{
		"merchantagent.connector.submit.v1",
		tenant,
		device,
		connectorID,
		version,
		digest,
		signedAt.UTC().Format(time.RFC3339Nano),
	}, "\n")
}

func SignImplementationCredential(privateKey ed25519.PrivateKey, claims ImplementationClaims) (string, error) {
	if len(privateKey) != ed25519.PrivateKeySize {
		return "", fmt.Errorf("platform private key must be Ed25519")
	}
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", fmt.Errorf("marshal implementation claims: %w", err)
	}
	signature := ed25519.Sign(privateKey, payload)
	return base64.RawURLEncoding.EncodeToString(payload) + "." + base64.RawURLEncoding.EncodeToString(signature), nil
}

func ParseEd25519PublicKeyPEM(data []byte) (ed25519.PublicKey, error) {
	return parseEd25519PublicKey(data)
}

func parseEd25519PublicKey(data []byte) (ed25519.PublicKey, error) {
	block, rest := pem.Decode(data)
	if block == nil || len(bytes.TrimSpace(rest)) != 0 {
		return nil, fmt.Errorf("expected one PEM public key")
	}
	parsed, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("parse PKIX public key: %w", err)
	}
	key, ok := parsed.(ed25519.PublicKey)
	if !ok || len(key) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("public key is not Ed25519")
	}
	return key, nil
}

func hasExactSubmissionScopes(scopes []string) bool {
	if len(scopes) != len(submissionScopes) {
		return false
	}
	seen := make(map[string]struct{}, len(scopes))
	for _, scope := range scopes {
		if _, required := submissionScopes[scope]; !required {
			return false
		}
		if _, duplicate := seen[scope]; duplicate {
			return false
		}
		seen[scope] = struct{}{}
	}
	return true
}

func requireJSONEOF(decoder *json.Decoder) error {
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("multiple JSON values")
		}
		return err
	}
	return nil
}
