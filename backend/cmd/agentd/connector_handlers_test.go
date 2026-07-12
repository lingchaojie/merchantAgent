package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/merchantagent/backend/connector"
	"github.com/merchantagent/backend/connectorregistry"
	"github.com/merchantagent/backend/org"
	"github.com/merchantagent/backend/wire"
)

func TestResolveConnectorDB(t *testing.T) {
	tests := []struct {
		name, explicit, dataDir, want string
		wantErr                       bool
	}{
		{name: "explicit path", explicit: "/secure/registry.db", dataDir: "/ignored", want: "/secure/registry.db"},
		{name: "data directory", dataDir: "/var/lib/merchantagent", want: filepath.Join("/var/lib/merchantagent", "connectors.db")},
		{name: "missing persistent path", wantErr: true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := resolveConnectorDB(tc.explicit, tc.dataDir)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("resolveConnectorDB()=%q, want error", got)
				}
				return
			}
			if err != nil || got != tc.want {
				t.Fatalf("resolveConnectorDB()=%q, %v; want %q", got, err, tc.want)
			}
		})
	}
}

func TestConnectorRoutesSeparateImplementerAndAdminAuthority(t *testing.T) {
	s, credential, version := connectorTestServer(t)
	publicBody := signedSubmissionBody(t, credential, version)
	resp := requestJSON(t, s, http.MethodPost, "/implementation/connectors", publicBody, map[string]string{"Authorization": "Implementation " + credential.encoded})
	if resp.Code != http.StatusCreated {
		t.Fatalf("submit=%d %s", resp.Code, resp.Body.String())
	}
	resp = requestJSON(t, s, http.MethodPost, "/admin/connectors/sql-orders/versions/1.0.0/publish", nil, map[string]string{"X-User-Id": "u_impl1"})
	if resp.Code != http.StatusForbidden {
		t.Fatalf("implementer publish=%d", resp.Code)
	}
	resp = requestJSON(t, s, http.MethodPost, "/admin/connectors/sql-orders/versions/1.0.0/publish", nil, map[string]string{"X-User-Id": "u_admin"})
	if resp.Code != http.StatusOK {
		t.Fatalf("admin publish=%d %s", resp.Code, resp.Body.String())
	}

	resp = requestJSON(t, s, http.MethodGet, "/connectors/sql-orders/versions/1.0.0/approval", nil, map[string]string{"X-User-Id": "u_sales1"})
	if resp.Code != http.StatusOK {
		t.Fatalf("approval=%d %s", resp.Code, resp.Body.String())
	}
	var status map[string]any
	if err := json.Unmarshal(resp.Body.Bytes(), &status); err != nil {
		t.Fatal(err)
	}
	if len(status) != 4 || status["digest"] != version.Digest || status["status"] != string(connectorregistry.StatusPublished) {
		t.Fatalf("approval response=%v", status)
	}
}

func TestConnectorSubmissionRejectsUnknownFieldsAndWrongAttestation(t *testing.T) {
	s, credential, version := connectorTestServer(t)
	body := signedSubmissionBody(t, credential, version)
	body["privateConfig"] = map[string]string{"connectionString": "secret"}
	resp := requestJSON(t, s, http.MethodPost, "/implementation/connectors", body, map[string]string{"Authorization": "Implementation " + credential.encoded})
	if resp.Code != http.StatusBadRequest {
		t.Fatalf("unknown field=%d %s", resp.Code, resp.Body.String())
	}

	other := version
	other.DeviceID = "device-02"
	wrongDeviceBody := signedSubmissionBody(t, credential, other)
	wrongDeviceInput := connectorregistry.SubmissionSigningInput("mock-corp-001", "device-02", other.ConnectorID, other.Version, other.Digest, credential.issuedAt)
	wrongDeviceBody["implementationSignature"] = base64.RawURLEncoding.EncodeToString(ed25519.Sign(credential.devicePrivate, []byte(wrongDeviceInput)))
	resp = requestJSON(t, s, http.MethodPost, "/implementation/connectors", wrongDeviceBody, map[string]string{"Authorization": "Implementation " + credential.encoded})
	if resp.Code != http.StatusUnauthorized {
		t.Fatalf("wrong device=%d %s", resp.Code, resp.Body.String())
	}
}

func TestConnectorAdminLifecycleRejectsDigestMismatch(t *testing.T) {
	s, credential, version := connectorTestServer(t)
	resp := requestJSON(t, s, http.MethodPost, "/implementation/connectors", signedSubmissionBody(t, credential, version), map[string]string{"Authorization": "Implementation " + credential.encoded})
	if resp.Code != http.StatusCreated {
		t.Fatalf("submit=%d %s", resp.Code, resp.Body.String())
	}
	resp = requestJSON(t, s, http.MethodPost, "/admin/connectors/sql-orders/versions/1.0.0/publish", map[string]string{"digest": "sha256:" + strings.Repeat("c", 64)}, map[string]string{"X-User-Id": "u_admin"})
	if resp.Code != http.StatusConflict {
		t.Fatalf("digest mismatch=%d %s", resp.Code, resp.Body.String())
	}
}

type fixtureImplementationCredential struct {
	encoded       string
	devicePrivate ed25519.PrivateKey
	issuedAt      time.Time
}

func connectorTestServer(t *testing.T) (*server, fixtureImplementationCredential, connectorregistry.Version) {
	t.Helper()
	now := time.Now().UTC().Truncate(time.Second)
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
	claims := connectorregistry.ImplementationClaims{
		CredentialID: "implementation-credential-01", TenantID: "mock-corp-001", DeviceID: "device-01",
		DeviceKey: string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der})),
		Scopes:    []string{"connector:draft", "connector:test", "connector:submit"}, IssuedAt: now.Add(-time.Hour).Unix(), ExpiresAt: now.Add(time.Hour).Unix(),
	}
	payload, err := json.Marshal(claims)
	if err != nil {
		t.Fatal(err)
	}
	encoded := base64.RawURLEncoding.EncodeToString(payload) + "." + base64.RawURLEncoding.EncodeToString(ed25519.Sign(platformPrivate, payload))
	registry, err := connectorregistry.Open(filepath.Join(t.TempDir(), "connectors.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = registry.Close() })
	idp, err := org.NewMockAdapterFromFile(filepath.Join("..", "..", "testdata", "mock-org.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	checker := fakeChecker{admins: map[string]bool{"user:u_admin": true}}
	s := &server{
		asm: &wire.Assembled{Registry: registry, IDP: idp}, tenant: "mock-corp-001", adminChecker: checker,
		credentialVerifier: connectorregistry.CredentialVerifier{PlatformPublicKey: platformPublic}, now: func() time.Time { return now },
	}
	return s, fixtureImplementationCredential{encoded: encoded, devicePrivate: devicePrivate, issuedAt: now}, validConnectorVersion()
}

func validConnectorVersion() connectorregistry.Version {
	min, max := 1, 64
	return connectorregistry.Version{
		TenantID: "request-tenant", ConnectorID: "sql-orders", Version: "1.0.0", Digest: "sha256:" + strings.Repeat("a", 64),
		Adapter: "sqlserver", Environment: "test", ImplementationCredentialID: "request-credential", DeviceID: "device-01",
		Contract: connectorregistry.PublicContract{Tools: []connectorregistry.ToolContract{{
			Name: "query_order_status", Description: "Query order status", Execution: connector.ExecutionDesktop,
			ResourceType: "business_record", ResourceKind: "order", ResourceArg: "orderId", ResourceRelation: "viewer", DataDomain: "operations",
			Params:       []connectorregistry.ParamContract{{Name: "orderId", Description: "Order identifier", Type: connector.ParamString, Required: true, MinLength: &min, MaxLength: &max}},
			ResultFields: []string{"orderId", "status"}, Risk: connector.RiskRead, TimeoutMS: 10000, MaxResults: 100,
		}}},
		Checks: connectorregistry.CheckSummary{CheckerVersion: "1.0.0", RulesetVersion: "m7.1-sql-v1", TestsDigest: "sha256:" + strings.Repeat("b", 64)},
	}
}

func signedSubmissionBody(t *testing.T, credential fixtureImplementationCredential, version connectorregistry.Version) map[string]any {
	t.Helper()
	// Claims always win over the request's identity fields, including tenant.
	version.TenantID = "mock-corp-001"
	version.DeviceID = "device-01"
	message := connectorregistry.SubmissionSigningInput(version.TenantID, version.DeviceID, version.ConnectorID, version.Version, version.Digest, credential.issuedAt)
	signature := base64.RawURLEncoding.EncodeToString(ed25519.Sign(credential.devicePrivate, []byte(message)))
	return map[string]any{"version": version, "signedAt": credential.issuedAt.Format(time.RFC3339), "implementationSignature": signature}
}

func requestJSON(t *testing.T, s *server, method, path string, body any, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	var input []byte
	if body != nil {
		var err error
		input, err = json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
	}
	r := httptest.NewRequest(method, path, bytes.NewReader(input))
	if body != nil {
		r.Header.Set("Content-Type", "application/json")
	}
	for key, value := range headers {
		r.Header.Set(key, value)
	}
	w := httptest.NewRecorder()
	s.routes().ServeHTTP(w, r)
	return w
}
