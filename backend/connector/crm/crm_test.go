package crm

import (
	"context"
	"testing"

	"github.com/merchantagent/backend/connector"
)

func open(t *testing.T) *CRM {
	t.Helper()
	c, err := Open()
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { c.Close() })
	return c
}

func TestTools_Present(t *testing.T) {
	want := []string{"query_customer_contacts", "query_customer_followups", "query_customer_opportunities"}
	c := open(t)
	for _, name := range want {
		if _, ok := connector.Lookup(c, name); !ok {
			t.Errorf("missing tool %q", name)
		}
	}
}

func TestContacts(t *testing.T) {
	c := open(t)
	tool, _ := connector.Lookup(c, "query_customer_contacts")
	out, err := tool.Invoke(context.Background(), map[string]any{"customerName": "A公司"})
	if err != nil {
		t.Fatal(err)
	}
	cs, _ := out["contacts"].([]map[string]any)
	if len(cs) != 2 { // 张伟, 李娜
		t.Errorf("A公司 contacts = %v, want 2", out["contacts"])
	}
}

func TestFollowups_OrderedDesc(t *testing.T) {
	c := open(t)
	tool, _ := connector.Lookup(c, "query_customer_followups")
	out, err := tool.Invoke(context.Background(), map[string]any{"customerName": "A公司"})
	if err != nil {
		t.Fatal(err)
	}
	items, _ := out["followUps"].([]map[string]any)
	if len(items) != 2 || items[0]["date"] != "2026-07-05" {
		t.Errorf("A公司 followUps (desc) = %v", out["followUps"])
	}
}

func TestOpportunities(t *testing.T) {
	c := open(t)
	tool, _ := connector.Lookup(c, "query_customer_opportunities")
	out, err := tool.Invoke(context.Background(), map[string]any{"customerName": "A公司"})
	if err != nil {
		t.Fatal(err)
	}
	items, _ := out["opportunities"].([]map[string]any)
	if len(items) != 1 || items[0]["estAmount"] != 200000 {
		t.Errorf("A公司 opportunities = %v", out["opportunities"])
	}
}

func TestReadOnly_WritesRejected(t *testing.T) {
	c := open(t)
	if _, err := c.db.Exec(`INSERT INTO contacts (contact_id, customer_name, person) VALUES ('X','A公司','x')`); err == nil {
		t.Error("expected write to be rejected under query_only")
	}
}
