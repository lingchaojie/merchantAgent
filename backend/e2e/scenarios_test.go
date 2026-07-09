package e2e

import (
	"context"
	"strings"
	"testing"

	"github.com/merchantagent/backend/org"
)

func TestE2E_SameQuestionDifferentPermissions(t *testing.T) {
	agent, audit := newAgent(t)
	ctx := context.Background()
	p := func(u string) org.Principal { return org.Principal{TenantID: tenant, UserID: u} }

	// 1. Sales asks own order progress → allowed, has status.
	ans, err := agent.Ask(ctx, p("u_sales1"), "SO-1001 进度怎么样")
	if err != nil || ans.Denied {
		t.Fatalf("sales/progress: denied=%v err=%v", ans.Denied, err)
	}
	if !strings.Contains(ans.Text, "生产中") {
		t.Errorf("progress text = %q", ans.Text)
	}

	// 2. Sales asks profit → denied (cost domain filtered).
	ans, _ = agent.Ask(ctx, p("u_sales1"), "SO-1001 的利润多少")
	if !ans.Denied {
		t.Errorf("sales/profit should be denied, got %q", ans.Text)
	}

	// 3. Sales manager asks profit → allowed.
	ans, _ = agent.Ask(ctx, p("u_smgr"), "SO-1001 的利润多少")
	if ans.Denied || !strings.Contains(ans.Text, "利润") {
		t.Errorf("smgr/profit should be allowed, got denied=%v %q", ans.Denied, ans.Text)
	}

	// 4. Boss asks profit → allowed (root manager inherits down).
	ans, _ = agent.Ask(ctx, p("u_boss"), "SO-1001 的利润多少")
	if ans.Denied {
		t.Error("boss/profit should be allowed (root manager)")
	}

	// 5. Planner asks sales-dept order progress → denied (not a viewer).
	ans, _ = agent.Ask(ctx, p("u_plan"), "SO-1001 进度怎么样")
	if !ans.Denied {
		t.Errorf("planner/progress should be denied, got %q", ans.Text)
	}

	// 6. Sales asks kitting → allowed, incomplete (螺栓 short).
	ans, err = agent.Ask(ctx, p("u_sales1"), "SO-1001 齐套了吗")
	if err != nil || ans.Denied {
		t.Fatalf("sales/kitting: denied=%v err=%v", ans.Denied, err)
	}
	if !strings.Contains(ans.Text, "未齐套") {
		t.Errorf("kitting text = %q", ans.Text)
	}

	// Audit chain must be intact and have recorded every turn.
	if !audit.Verify() {
		t.Error("audit chain broken")
	}
	if n := len(audit.Entries()); n != 6 {
		t.Errorf("audit entries = %d, want 6", n)
	}
}
