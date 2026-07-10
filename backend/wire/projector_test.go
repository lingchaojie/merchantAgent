package wire

import (
	"context"
	"os"
	"testing"

	"github.com/merchantagent/backend/authz"
	"github.com/merchantagent/backend/config"
	"github.com/merchantagent/backend/org"
	"github.com/merchantagent/backend/skill"
)

func TestDesired_MergesAndDedups(t *testing.T) {
	ctx := context.Background()
	idp, err := org.NewMockAdapterFromFile("../testdata/mock-org.yaml")
	if err != nil {
		t.Fatal(err)
	}
	cfg, _ := config.Open(tenant)
	sk, _ := skill.Open()
	defer sk.Close()
	p := &Projector{idp: idp, cfg: cfg, sk: sk, tenant: tenant}

	desired, err := p.desired(ctx)
	if err != nil {
		t.Fatal(err)
	}
	set := map[string]int{}
	for _, tp := range desired {
		set[tp.String()]++
	}
	// No duplicates.
	for k, n := range set {
		if n > 1 {
			t.Errorf("duplicate tuple %s (x%d)", k, n)
		}
	}
	// Must contain: org member, skill usable_by, domain grant, role object, demo fixture.
	must := []string{
		"user:u_sales1|member|tenant:mock-corp-001",
		"role:mock-corp-001/sales#assignee|usable_by|skill:mock-corp-001/order360",
		"user:u_fin|viewer|data_domain:mock-corp-001/cost",
		"tenant:mock-corp-001|tenant|role:mock-corp-001/finance",
		"user:u_sales1|owner|order:mock-corp-001/SO-1001",
	}
	for _, m := range must {
		if set[m] == 0 {
			t.Errorf("desired missing: %s", m)
		}
	}
}

func TestDesired_RuleEditDropsRole(t *testing.T) {
	ctx := context.Background()
	idp, _ := org.NewMockAdapterFromFile("../testdata/mock-org.yaml")
	cfg, _ := config.Open(tenant)
	sk, _ := skill.Open()
	defer sk.Close()
	p := &Projector{idp: idp, cfg: cfg, sk: sk, tenant: tenant}

	// Replace rules so "销售" no longer maps to sales → u_sales1 loses the tuple.
	cfg.ReplaceRules(ctx, []config.Rule{{Match: []string{"经理"}, RoleID: "manager_tier"}})
	desired, _ := p.desired(ctx)
	for _, tp := range desired {
		if tp.String() == "user:u_sales1|assignee|role:mock-corp-001/sales" {
			t.Error("u_sales1 should have lost the sales role after rule edit")
		}
	}
}

// TestReproject_DeletesOnConfigChange proves the security-critical delete path:
// removing a config grant and re-projecting must reconcile the now-undesired
// tuple OUT of OpenFGA (not just stop writing it). Needs a live OpenFGA store.
func TestReproject_DeletesOnConfigChange(t *testing.T) {
	apiURL := os.Getenv("OPENFGA_API_URL")
	if apiURL == "" {
		apiURL = "http://localhost:18080"
	}
	ctx := context.Background()
	store, err := authz.NewStore(ctx, apiURL, "reproject-delete-test")
	if err != nil {
		t.Skipf("OpenFGA not reachable (%v)", err)
	}
	idp, err := org.NewMockAdapterFromFile("../testdata/mock-org.yaml")
	if err != nil {
		t.Fatal(err)
	}
	cfg, _ := config.Open(tenant)
	sk, _ := skill.Open()
	defer sk.Close()
	p := NewProjector(store, idp, cfg, sk, tenant)

	if err := p.Reproject(ctx); err != nil {
		t.Fatal(err)
	}
	ok, err := store.Check(ctx, "user:u_fin", "viewer", "data_domain:"+tenant+"/cost")
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected u_fin cost viewer after initial projection")
	}

	// Remove the grant; reproject must DELETE the now-undesired tuple.
	if err := cfg.RemoveGrant(ctx, "cost", "user:u_fin"); err != nil {
		t.Fatal(err)
	}
	if err := p.Reproject(ctx); err != nil {
		t.Fatal(err)
	}
	ok, err = store.Check(ctx, "user:u_fin", "viewer", "data_domain:"+tenant+"/cost")
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Error("cost viewer tuple should have been reconciled away after grant removal")
	}
}
