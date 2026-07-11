package runtime

import (
	"context"
	"testing"

	"github.com/merchantagent/backend/connector"
	"github.com/merchantagent/backend/org"
)

func TestKeywordRouter(t *testing.T) {
	r := KeywordRouter{}
	cases := []struct {
		q, tool, id string
		ok          bool
	}{
		{"SO-1001 进度怎么样", "query_order_status", "SO-1001", true},
		{"SO-1002的利润多少", "query_order_financials", "SO-1002", true},
		{"SO-1001 齐套了吗", "check_material_kitting", "SO-1001", true},
		{"你好", "", "", false},
		{"进度怎么样", "query_order_status", "", false}, // no order id → not ok
	}
	for _, c := range cases {
		tool, args, ok := r.Route(c.q)
		if tool != c.tool || ok != c.ok {
			t.Errorf("Route(%q) = (%q,%v), want (%q,%v)", c.q, tool, ok, c.tool, c.ok)
		}
		if c.id != "" && args["orderId"] != c.id {
			t.Errorf("Route(%q) orderId = %v, want %s", c.q, args["orderId"], c.id)
		}
	}
}

// fakeChecker returns configured allow/deny by "user|relation|object".
type fakeChecker struct{ allow map[string]bool }

func (f fakeChecker) Check(_ context.Context, u, r, o string) (bool, error) {
	return f.allow[u+"|"+r+"|"+o], nil
}

func TestGuard_Intersection(t *testing.T) {
	// user can use a skill exposing both tools (invoker true) and can view the
	// order, but NOT the cost domain → status allowed, financials denied.
	chk := fakeChecker{allow: map[string]bool{
		"user:u1|invoker|tool:t/query_order_status":      true,
		"user:u1|invoker|tool:t/query_order_financials":  true,
		"user:u1|viewer|business_record:t/order/SO-1001": true,
		// cost domain intentionally absent → false
	}}
	g := NewGuard(chk, "t")
	p := org.Principal{TenantID: "t", UserID: "u1"}

	status := connector.ToolSpec{Name: "query_order_status", ResourceType: "business_record", ResourceKind: "order", ResourceArg: "orderId"}
	fin := connector.ToolSpec{Name: "query_order_financials", ResourceType: "business_record", ResourceKind: "order", ResourceArg: "orderId", DataDomain: "cost"}
	args := map[string]any{"orderId": "SO-1001"}

	if d, _ := g.Authorize(context.Background(), p, status, args); !d.Allowed {
		t.Error("status should be allowed (invoker + order viewer true)")
	}
	if d, _ := g.Authorize(context.Background(), p, fin, args); d.Allowed {
		t.Error("financials must be denied (cost domain false)")
	}
}

func TestGuard_ResourceKindScopesBusinessRecord(t *testing.T) {
	chk := fakeChecker{allow: map[string]bool{
		"user:u1|invoker|tool:t/query_order_status":      true,
		"user:u1|viewer|business_record:t/order/SO-1001": true,
	}}
	g := NewGuard(chk, "t")
	spec := connector.ToolSpec{
		Name: "query_order_status", ResourceType: "business_record",
		ResourceKind: "order", ResourceArg: "orderId",
	}
	d, err := g.Authorize(context.Background(), org.Principal{TenantID: "t", UserID: "u1"}, spec, map[string]any{"orderId": "SO-1001"})
	if err != nil {
		t.Fatal(err)
	}
	if !d.Allowed {
		t.Fatalf("authorization = %+v, want allowed", d)
	}
}

// TestGuard_CapabilityWall: no skill grants the tool → denied up front, even if
// the user could view the record/domain (design §3.4).
func TestGuard_CapabilityWall(t *testing.T) {
	chk := fakeChecker{allow: map[string]bool{
		"user:u1|viewer|business_record:t/order/SO-1001": true, // could see record…
		// …but no invoker tuple → capability wall denies first
	}}
	g := NewGuard(chk, "t")
	p := org.Principal{TenantID: "t", UserID: "u1"}
	status := connector.ToolSpec{Name: "query_order_status", ResourceType: "business_record", ResourceKind: "order", ResourceArg: "orderId"}
	d, _ := g.Authorize(context.Background(), p, status, map[string]any{"orderId": "SO-1001"})
	if d.Allowed {
		t.Error("must be denied: no skill grants the tool")
	}
}

func TestAuditChain_VerifyAndTamper(t *testing.T) {
	log := NewAuditLog()
	log.Append(AuditEntry{UserID: "u1", Tool: "query_order_status", Decision: "allow"})
	log.Append(AuditEntry{UserID: "u1", Tool: "query_order_financials", Decision: "deny"})
	if !log.Verify() {
		t.Fatal("fresh chain should verify")
	}
	// Tamper with a stored entry → chain breaks.
	log.entries[0].Decision = "deny"
	if log.Verify() {
		t.Error("tampered chain must fail verification")
	}
}
