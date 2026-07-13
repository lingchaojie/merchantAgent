package runtime

import (
	"encoding/json"
	"math"
	"reflect"
	"regexp"
	"strings"
	"testing"
)

func TestAuditLogDeepCopiesMutableFields(t *testing.T) {
	args := map[string]any{
		"orderId": "SO-1001",
		"nested":  map[string]any{"note": "original"},
		"items":   []any{map[string]any{"value": "original"}},
	}
	before := map[string]any{"progress": map[string]any{"rate": "60"}}
	after := map[string]any{"progress": map[string]any{"rate": "80"}}
	roles := []string{"planner"}
	log := NewAuditLog()
	if err := log.Append(AuditEntry{
		UserID: "u1", Tool: "report_production_progress", ToolCallID: "provider-call-1",
		Args: args, Before: before, After: after, RoleIDs: roles,
	}); err != nil {
		t.Fatal(err)
	}

	args["orderId"] = "MUTATED"
	args["nested"].(map[string]any)["note"] = "mutated"
	args["items"].([]any)[0].(map[string]any)["value"] = "mutated"
	before["progress"].(map[string]any)["rate"] = "0"
	after["progress"].(map[string]any)["rate"] = "100"
	roles[0] = "attacker"

	entries := log.Entries()
	if len(entries) != 1 || entries[0].Args["orderId"] != "SO-1001" || entries[0].RoleIDs[0] != "planner" {
		t.Fatalf("append boundary retained caller aliases: %+v", entries)
	}
	if entries[0].Args["nested"].(map[string]any)["note"] != "original" ||
		entries[0].Args["items"].([]any)[0].(map[string]any)["value"] != "original" ||
		entries[0].Before["progress"].(map[string]any)["rate"] != "60" ||
		entries[0].After["progress"].(map[string]any)["rate"] != "80" {
		t.Fatalf("nested append data mutated: %+v", entries[0])
	}

	entries[0].Args["orderId"] = "RETURN-MUTATED"
	entries[0].Before["progress"].(map[string]any)["rate"] = "RETURN-MUTATED"
	entries[0].After["progress"].(map[string]any)["rate"] = "RETURN-MUTATED"
	entries[0].RoleIDs[0] = "RETURN-MUTATED"
	again := log.Entries()
	if again[0].Args["orderId"] != "SO-1001" || again[0].RoleIDs[0] != "planner" ||
		again[0].Before["progress"].(map[string]any)["rate"] != "60" ||
		again[0].After["progress"].(map[string]any)["rate"] != "80" {
		t.Fatalf("Entries boundary exposed internal aliases: %+v", again[0])
	}
	if !log.Verify() {
		t.Fatal("caller mutations broke audit verification")
	}
}

func TestAuditLogRejectsUnsupportedValuesWithoutChangingChain(t *testing.T) {
	log := NewAuditLog()
	if err := log.Append(AuditEntry{Tool: "bad", Args: map[string]any{"unsupported": make(chan int)}}); err == nil {
		t.Fatal("unsupported audit value was silently accepted")
	}
	if entries := log.Entries(); len(entries) != 0 {
		t.Fatalf("failed append changed chain: %+v", entries)
	}
	if err := log.Append(AuditEntry{Tool: "good", ToolCallID: "call-1", Args: map[string]any{"ok": true}}); err != nil {
		t.Fatal(err)
	}
	if !log.Verify() {
		t.Fatal("valid append after rejected value did not verify")
	}
	log.entries[0].ToolCallID = "tampered-call"
	if log.Verify() {
		t.Fatal("tool call id is not covered by the audit hash")
	}
}

func TestConnectorAuditSerializationRejectsPrivateImplementationMaterial(t *testing.T) {
	entry := AuditEntry{
		TenantID: "mock-corp-001", UserID: "u_prod1", Tool: "report_production_progress",
		ToolVersion: "1.0.0", ExecutionLocation: "desktop", DeviceID: "device-m71",
		Connector: &ConnectorAudit{
			ConnectorID: "sql-orders", Version: "1.0.0", Digest: "sha256:" + strings.Repeat("a", 64),
			Adapter: "sqlserver", SourceProfileID: "erp-test", Environment: "test", DeviceID: "device-m71",
			ResourceKind: "order", ResourceID: "ORD-1001", ResourceRelation: "operator", ApprovalVersion: "1.0.0",
			ExecutionStatus: "succeeded", ReadBackStatus: "succeeded", DurationMS: 27,
			Before:                     map[string]any{"completionRate": 45, "internal_cost": 900, "credentialRef": "erp-test"},
			After:                      map[string]any{"completionRate": 60, "rawResponse": "SELECT * FROM dbo.production_orders"},
			idempotencyKeyMaterial:     []byte("low-entropy-idempotency-canary"),
			requestFingerprintMaterial: []byte("low-entropy-request-canary"),
		},
	}
	log := NewAuditLogWithIdentifierKey([]byte("01234567890123456789012345678901"))
	if err := log.Append(entry); err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(log.Entries())
	if err != nil {
		t.Fatal(err)
	}
	text := string(encoded)
	for _, secret := range []string{"SELECT", "dbo.", "credentialRef", "internal_cost", "rawResponse", "low-entropy-idempotency-canary", "low-entropy-request-canary"} {
		if strings.Contains(text, secret) {
			t.Fatalf("audit serialization leaked %q: %s", secret, text)
		}
	}
	if !strings.Contains(text, `"connector":{"connectorId":"sql-orders"`) ||
		!strings.Contains(text, `"idempotencyKeyId":"hmac-sha256:`) ||
		!strings.Contains(text, `"requestFingerprintId":"hmac-sha256:`) {
		t.Fatalf("audit serialization missing connector identifiers: %s", text)
	}
}

func TestConnectorAuditProjectionKeepsOnlyBoundedIntegerMetrics(t *testing.T) {
	values := map[string]any{
		"completionRate": float64(80),
		"version":        float64(math.MaxInt32),
		"note":           "private note",
		"status":         "in_production",
		"orderId":        "ORD-1001",
	}
	if got := filterConnectorAuditMap(values, []string{"completionRate", "version", "note", "status", "orderId"}); !reflect.DeepEqual(got, map[string]any{
		"completionRate": 80,
		"version":        math.MaxInt32,
	}) {
		t.Fatalf("typed connector audit projection = %#v", got)
	}

	invalid := map[string][]any{
		"completionRate": {
			-1, 101, 1.5, "80", true, nil, math.NaN(), math.Inf(1),
			map[string]any{"value": 80}, []any{80},
		},
		"version": {
			-1, float64(math.MaxInt32) + 1, int64(math.MaxInt32) + 1, 1.5, "80", true, nil, math.NaN(), math.Inf(1),
			map[string]any{"value": 80}, []any{80},
		},
	}
	for field, values := range invalid {
		for _, value := range values {
			entry := AuditEntry{TenantID: "t", Tool: "tool", Connector: &ConnectorAudit{
				Before: map[string]any{field: value},
			}}
			log := NewAuditLogWithIdentifierKey([]byte("01234567890123456789012345678901"))
			if err := log.Append(entry); err != nil {
				t.Fatalf("Append(%s=%#v): %v", field, value, err)
			}
			if got := log.Entries()[0].Connector.Before; got != nil {
				t.Fatalf("invalid connector audit value %s=%#v survived as %#v", field, value, got)
			}
		}
	}
}

func TestAuditLogDerivesKeyedTenantAndDomainSeparatedConnectorIdentifiers(t *testing.T) {
	keyA := []byte("01234567890123456789012345678901")
	keyB := []byte("abcdefghijklmnopqrstuvwxyzABCDEF")
	appendEntry := func(t *testing.T, log *AuditLog, tenant string) ConnectorAudit {
		t.Helper()
		connector := &ConnectorAudit{
			idempotencyKeyMaterial:     []byte("same-low-entropy-value"),
			requestFingerprintMaterial: []byte("same-low-entropy-value"),
		}
		if err := log.Append(AuditEntry{TenantID: tenant, Tool: "tool", Connector: connector}); err != nil {
			t.Fatal(err)
		}
		if connector.idempotencyKeyMaterial != nil || connector.requestFingerprintMaterial != nil {
			t.Fatal("raw connector identifier material was retained after append")
		}
		return *log.Entries()[0].Connector
	}

	first := appendEntry(t, NewAuditLogWithIdentifierKey(keyA), "tenant-a")
	repeat := appendEntry(t, NewAuditLogWithIdentifierKey(keyA), "tenant-a")
	otherTenant := appendEntry(t, NewAuditLogWithIdentifierKey(keyA), "tenant-b")
	otherKey := appendEntry(t, NewAuditLogWithIdentifierKey(keyB), "tenant-a")
	format := regexp.MustCompile(`^hmac-sha256:[0-9a-f]{64}$`)
	if !format.MatchString(first.IdempotencyKeyID) || !format.MatchString(first.RequestFingerprintID) {
		t.Fatalf("identifier format = %q, %q", first.IdempotencyKeyID, first.RequestFingerprintID)
	}
	if first.IdempotencyKeyID != repeat.IdempotencyKeyID || first.RequestFingerprintID != repeat.RequestFingerprintID {
		t.Fatal("same key, tenant, domain, and material did not derive stable identifiers")
	}
	if first.IdempotencyKeyID == first.RequestFingerprintID {
		t.Fatal("identifier domains are not separated")
	}
	if first.IdempotencyKeyID == otherTenant.IdempotencyKeyID || first.IdempotencyKeyID == otherKey.IdempotencyKeyID {
		t.Fatal("identifier derivation is not separated by tenant and backend key")
	}
}

func TestTenantAuditSharesOneIdentifierKeyAcrossTenantChains(t *testing.T) {
	root := NewTenantAuditWithIdentifierKey([]byte("01234567890123456789012345678901"))
	for _, tenant := range []string{"tenant-a", "tenant-b"} {
		if err := root.Append(AuditEntry{TenantID: tenant, Tool: "tool", Connector: &ConnectorAudit{
			idempotencyKeyMaterial: []byte("same-value"),
		}}); err != nil {
			t.Fatal(err)
		}
	}
	a := root.Chain("tenant-a").Entries()[0].Connector.IdempotencyKeyID
	b := root.Chain("tenant-b").Entries()[0].Connector.IdempotencyKeyID
	if a == b {
		t.Fatal("tenant audit identifiers are not tenant-separated")
	}
}
