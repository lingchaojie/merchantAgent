package runtime

import (
	"encoding/json"
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
	var entry AuditEntry
	if err := json.Unmarshal([]byte(`{
		"tenantId":"mock-corp-001","userId":"u_prod1","tool":"report_production_progress",
		"toolVersion":"1.0.0","executionLocation":"desktop","deviceId":"device-m71",
		"connector":{
			"connectorId":"sql-orders","version":"1.0.0","digest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			"adapter":"sqlserver","sourceProfileId":"erp-test","environment":"test","deviceId":"device-m71",
			"resourceKind":"order","resourceId":"ORD-1001","resourceRelation":"operator","approvalVersion":"1.0.0",
			"idempotencyKeyId":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
			"requestFingerprintId":"sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
			"executionStatus":"succeeded","readBackStatus":"succeeded","durationMs":27,
			"before":{"completionRate":45,"internal_cost":900,"credentialRef":"erp-test"},
			"after":{"completionRate":60,"rawResponse":"SELECT * FROM dbo.production_orders"}
		}
	}`), &entry); err != nil {
		t.Fatal(err)
	}
	log := NewAuditLog()
	if err := log.Append(entry); err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(log.Entries())
	if err != nil {
		t.Fatal(err)
	}
	text := string(encoded)
	for _, secret := range []string{"SELECT", "dbo.", "credentialRef", "internal_cost", "rawResponse"} {
		if strings.Contains(text, secret) {
			t.Fatalf("audit serialization leaked %q: %s", secret, text)
		}
	}
	if !strings.Contains(text, `"connector":{"connectorId":"sql-orders"`) ||
		!strings.Contains(text, `"idempotencyKeyId":"sha256:`) ||
		!strings.Contains(text, `"requestFingerprintId":"sha256:`) {
		t.Fatalf("audit serialization missing connector identifiers: %s", text)
	}
}
