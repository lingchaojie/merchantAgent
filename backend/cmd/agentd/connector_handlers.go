package main

import (
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/merchantagent/backend/connectorregistry"
	"github.com/merchantagent/backend/org"
)

type submitConnectorRequest struct {
	Version   connectorregistry.Version `json:"version"`
	SignedAt  string                    `json:"signedAt"`
	Signature string                    `json:"implementationSignature"`
}

func loadImplementationPublicKey(path string) (ed25519.PublicKey, error) {
	if path == "" {
		return nil, errors.New("IMPLEMENTATION_PUBLIC_KEY_FILE is required")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read public key: %w", err)
	}
	return connectorregistry.ParseEd25519PublicKeyPEM(data)
}

func (s *server) handleConnectorSubmit(w http.ResponseWriter, r *http.Request) {
	credential, ok := implementationCredential(r.Header.Get("Authorization"))
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "valid implementation credential required"})
		return
	}
	now := s.currentTime()
	claims, err := s.credentialVerifier.Verify(now, credential)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "valid implementation credential required"})
		return
	}
	var body submitConnectorRequest
	if err := decodeStrictJSON(r, &body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid connector submission"})
		return
	}
	signedAt, err := time.Parse(time.RFC3339Nano, body.SignedAt)
	if err != nil || body.Signature == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid connector submission"})
		return
	}
	version := body.Version
	version.TenantID = claims.TenantID
	version.DeviceID = claims.DeviceID
	version.ImplementationCredentialID = claims.CredentialID
	version.SubmittedBy = claims.CredentialID
	version.ApprovedBy = ""
	version.Status = ""
	version.CreatedAt = time.Time{}
	version.UpdatedAt = time.Time{}
	if err := s.credentialVerifier.VerifySubmission(now, claims, version, signedAt, body.Signature); err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid implementation attestation"})
		return
	}
	err = s.asm.Registry.Submit(r.Context(), connectorregistry.Submission{Version: version, ActorID: claims.CredentialID})
	if err != nil {
		code := http.StatusBadRequest
		if errors.Is(err, connectorregistry.ErrImmutableVersion) {
			code = http.StatusConflict
		}
		writeJSON(w, code, map[string]string{"error": err.Error()})
		return
	}
	version.Status = connectorregistry.StatusPendingApproval
	writeJSON(w, http.StatusCreated, version)
}

func (s *server) handleConnectorApproval(w http.ResponseWriter, r *http.Request) {
	uid := r.Header.Get("X-User-Id")
	if uid == "" {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "missing X-User-Id"})
		return
	}
	principal, err := s.asm.IDP.Authenticate(r.Context(), org.LoginContext{TenantID: s.tenant, Credential: uid})
	if err != nil || principal.TenantID != s.tenant {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "tenant member only"})
		return
	}
	version, ok, err := s.storedConnectorVersion(r, principal.TenantID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "connector version not found"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"connectorId": version.ConnectorID,
		"version":     version.Version,
		"digest":      version.Digest,
		"status":      version.Status,
	})
}

func (s *server) handleConnectorsList(w http.ResponseWriter, r *http.Request) {
	versions, err := s.asm.Registry.List(r.Context(), s.tenant)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, versions)
}

func (s *server) handleConnectorPublish(w http.ResponseWriter, r *http.Request) {
	s.handleConnectorTransition(w, r, connectorregistry.StatusPublished)
}

func (s *server) handleConnectorSuspend(w http.ResponseWriter, r *http.Request) {
	s.handleConnectorTransition(w, r, connectorregistry.StatusSuspended)
}

func (s *server) handleConnectorRevoke(w http.ResponseWriter, r *http.Request) {
	s.handleConnectorTransition(w, r, connectorregistry.StatusRevoked)
}

func (s *server) handleConnectorTransition(w http.ResponseWriter, r *http.Request, to connectorregistry.Status) {
	version, ok, err := s.storedConnectorVersion(r, s.tenant)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "connector version not found"})
		return
	}
	var body struct {
		Digest string `json:"digest"`
	}
	if err := decodeOptionalStrictJSON(r, &body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid lifecycle request"})
		return
	}
	if body.Digest != "" && body.Digest != version.Digest {
		writeJSON(w, http.StatusConflict, map[string]string{"error": connectorregistry.ErrDigestMismatch.Error()})
		return
	}
	err = s.asm.Registry.Transition(r.Context(), connectorregistry.Transition{
		TenantID: s.tenant, ConnectorID: version.ConnectorID, Version: version.Version,
		Digest: version.Digest, ActorID: r.Header.Get("X-User-Id"), To: to,
	})
	if err != nil {
		code := http.StatusConflict
		if errors.Is(err, connectorregistry.ErrVersionNotFound) {
			code = http.StatusNotFound
		}
		writeJSON(w, code, map[string]string{"error": err.Error()})
		return
	}
	version.Status = to
	writeJSON(w, http.StatusOK, version)
}

func (s *server) storedConnectorVersion(r *http.Request, tenant string) (connectorregistry.Version, bool, error) {
	versions, err := s.asm.Registry.List(r.Context(), tenant)
	if err != nil {
		return connectorregistry.Version{}, false, err
	}
	for _, version := range versions {
		if version.ConnectorID == r.PathValue("id") && version.Version == r.PathValue("version") {
			return version, true, nil
		}
	}
	return connectorregistry.Version{}, false, nil
}

func (s *server) currentTime() time.Time {
	if s.now != nil {
		return s.now().UTC()
	}
	return time.Now().UTC()
}

func implementationCredential(header string) (string, bool) {
	const prefix = "Implementation "
	if !strings.HasPrefix(header, prefix) || strings.TrimSpace(strings.TrimPrefix(header, prefix)) != strings.TrimPrefix(header, prefix) || len(header) == len(prefix) {
		return "", false
	}
	return strings.TrimPrefix(header, prefix), true
}

func decodeStrictJSON(r *http.Request, dst any) error {
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(dst); err != nil {
		return err
	}
	return requireHTTPJSONEOF(decoder)
}

func decodeOptionalStrictJSON(r *http.Request, dst any) error {
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(dst); errors.Is(err, io.EOF) {
		return nil
	} else if err != nil {
		return err
	}
	return requireHTTPJSONEOF(decoder)
}

func requireHTTPJSONEOF(decoder *json.Decoder) error {
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("multiple JSON values")
		}
		return err
	}
	return nil
}
