package runtime

import "testing"

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
