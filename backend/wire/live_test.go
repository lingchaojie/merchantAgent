package wire

import (
	"context"
	"strings"
	"testing"

	"github.com/merchantagent/backend/org"
)

// TestLive_SalesProgress: real gpt-5.5 drives the loop — load skill, call
// query_order_status, answer. Asserts on the deterministic audit (LLM phrasing
// is not asserted), plus a non-empty final answer.
func TestLive_SalesProgress(t *testing.T) {
	ag, audit, _ := liveAgent(t)
	final, _, err := ag.Ask(context.Background(),
		org.Principal{TenantID: tenant, UserID: "u_sales1", DisplayName: "小销售"},
		nil, "帮我看下订单 SO-1001 的进度和交期", nil)
	if err != nil {
		t.Fatalf("ask: %v", err)
	}
	if strings.TrimSpace(final) == "" {
		t.Error("empty final answer")
	}
	t.Logf("sales/progress answer: %s", final)
	if !auditHas(audit.Entries(), "query_order_status", "allow") {
		t.Errorf("expected an allowed query_order_status; audit=%+v", audit.Entries())
	}
}

// TestLive_PermissionDifferentiation: SAME profit question, different callers →
// guard decisions differ. Sales denied on the cost domain; manager allowed.
func TestLive_PermissionDifferentiation(t *testing.T) {
	ag, audit, _ := liveAgent(t)
	ctx := context.Background()

	// Sales asks profit → the outcome must be: NO allowed financials call ever
	// happens (the boundary note walls them off; even if they called, the guard
	// would deny — that mechanism is covered by the hermetic test). We assert the
	// security OUTCOME, not the LLM's phrasing.
	salesFinal, _, err := ag.Ask(ctx, org.Principal{TenantID: tenant, UserID: "u_sales1", DisplayName: "小销售"},
		nil, "订单 SO-1001 的利润是多少", nil)
	if err != nil {
		t.Fatalf("sales ask: %v", err)
	}
	t.Logf("sales/profit answer: %s", salesFinal)
	if auditHas(audit.Entries(), "query_order_financials", "allow") {
		t.Errorf("sales must NEVER get an allowed financials call; audit=%+v", audit.Entries())
	}
	if strings.Contains(salesFinal, "18000") || strings.Contains(salesFinal, "82000") {
		t.Errorf("sales answer leaked profit/cost figures: %s", salesFinal)
	}

	// Manager asks the same (same agent+audit) → financials ALLOWED (boundary note
	// says cost is visible → model calls → guard allows).
	mgrFinal, _, err := ag.Ask(ctx, org.Principal{TenantID: tenant, UserID: "u_smgr", DisplayName: "销售经理"},
		nil, "订单 SO-1001 的利润是多少", nil)
	if err != nil {
		t.Fatalf("manager ask: %v", err)
	}
	t.Logf("manager/profit answer: %s", mgrFinal)
	if !auditHas(audit.Entries(), "query_order_financials", "allow") {
		t.Errorf("manager asking profit should be ALLOWED; audit=%+v", audit.Entries())
	}
}
