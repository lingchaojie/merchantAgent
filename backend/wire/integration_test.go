package wire

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/merchantagent/backend/authz"
	"github.com/merchantagent/backend/connector"
	"github.com/merchantagent/backend/connector/crm"
	"github.com/merchantagent/backend/connector/erp"
	"github.com/merchantagent/backend/org"
	"github.com/merchantagent/backend/provider"
	"github.com/merchantagent/backend/runtime"
	"github.com/merchantagent/backend/skill"
	"github.com/merchantagent/backend/sync"
)

const tenant = "mock-corp-001"

func fgaObj(s string) string { return tenant + "/" + s }

// seedStore builds a real OpenFGA store with org + order fixtures + skill tuples.
// Skips the whole test if OpenFGA/LLM aren't configured.
func seedStore(t *testing.T) (*authz.Store, *skill.Store) {
	t.Helper()
	apiURL := os.Getenv("OPENFGA_API_URL")
	if apiURL == "" {
		apiURL = "http://localhost:18080"
	}
	ctx := context.Background()
	store, err := authz.NewStore(ctx, apiURL, "m3-integration")
	if err != nil {
		t.Skipf("OpenFGA not reachable (%v)", err)
	}
	idp, err := org.NewMockAdapterFromFile(filepath.Join("..", "testdata", "mock-org.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := authz.NewSyncer(store, idp, nil).Seed(ctx, tenant); err != nil {
		t.Fatal(err)
	}
	fx := sync.Diff{Writes: []sync.Tuple{
		{User: "user:u_sales1", Relation: "owner", Object: "order:" + fgaObj("SO-1001")},
		{User: "department:" + fgaObj("d_sales"), Relation: "owner_dept", Object: "order:" + fgaObj("SO-1001")},
		{User: "user:u_fin", Relation: "viewer", Object: "data_domain:" + fgaObj("cost")},
		{User: "department:" + fgaObj("d_sales") + "#manager", Relation: "viewer", Object: "data_domain:" + fgaObj("cost")},
		{User: "department:" + fgaObj("d_root") + "#manager", Relation: "viewer", Object: "data_domain:" + fgaObj("cost")},
	}}
	if err := store.ApplyDiff(ctx, fx); err != nil {
		t.Fatal(err)
	}
	sk, err := skill.Open()
	if err != nil {
		t.Fatal(err)
	}
	skills, _ := sk.List(ctx, tenant)
	if err := store.ApplyDiff(ctx, sync.Diff{Writes: skill.Tuples(skills, tenant)}); err != nil {
		t.Fatal(err)
	}
	return store, sk
}

func liveAgent(t *testing.T) (*runtime.LLMAgent, *runtime.AuditLog, *skill.Store) {
	t.Helper()
	key := os.Getenv("LLM_API_KEY")
	if key == "" {
		t.Skip("set LLM_API_KEY (source backend/dev.env) for the live LLM test")
	}
	store, sk := seedStore(t)
	prov := provider.NewOpenAI(os.Getenv("LLM_BASE_URL"), key, os.Getenv("LLM_MODEL"))
	conns := []connector.Connector{mustERP(t), mustCRM(t)}
	res := NewResolver(store, sk, tenant)
	audit := runtime.NewAuditLog()
	ag := runtime.NewLLMAgent(prov, conns, runtime.NewGuard(store, tenant), res, audit, tenant)
	return ag, audit, sk
}

func mustERP(t *testing.T) *erp.ERP {
	e, err := erp.Open()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { e.Close() })
	return e
}
func mustCRM(t *testing.T) *crm.CRM {
	c, err := crm.Open()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	return c
}

func auditHas(entries []runtime.AuditEntry, tool, decision string) bool {
	for _, e := range entries {
		if e.Tool == tool && e.Decision == decision {
			return true
		}
	}
	return false
}
