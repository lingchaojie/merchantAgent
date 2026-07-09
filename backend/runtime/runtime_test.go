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
	// user can view the order but NOT the cost domain → financials denied.
	chk := fakeChecker{allow: map[string]bool{
		"user:u1|viewer|order:t/SO-1001": true,
		// cost domain intentionally absent → false
	}}
	g := NewGuard(chk, "t")
	p := org.Principal{TenantID: "t", UserID: "u1"}

	status := connector.ToolSpec{ResourceType: "order", ResourceArg: "orderId"}
	fin := connector.ToolSpec{ResourceType: "order", ResourceArg: "orderId", DataDomain: "cost"}
	args := map[string]any{"orderId": "SO-1001"}

	if d, _ := g.Authorize(context.Background(), p, status, args); !d.Allowed {
		t.Error("status should be allowed (order viewer true)")
	}
	if d, _ := g.Authorize(context.Background(), p, fin, args); d.Allowed {
		t.Error("financials must be denied (cost domain false)")
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
