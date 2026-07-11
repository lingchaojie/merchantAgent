// Package e2e is the composition root test: it wires the REAL OpenFGA store +
// org sync + mock ERP connector + agent runtime, and proves "same question,
// different permissions" through the whole loop (router → guard → connector),
// not via direct FGA asserts. Skips if OpenFGA isn't running.
package e2e

import (
	"context"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/merchantagent/backend/authz"
	"github.com/merchantagent/backend/connector/mockerp"
	"github.com/merchantagent/backend/org"
	"github.com/merchantagent/backend/runtime"
	"github.com/merchantagent/backend/skill"
	"github.com/merchantagent/backend/sync"
)

const tenant = "mock-corp-001"

func td(p string) string  { return filepath.Join("..", "testdata", p) }
func obj(s string) string { return tenant + "/" + s }

func newAgent(t *testing.T) (*runtime.Agent, *runtime.AuditLog) {
	t.Helper()
	apiURL := os.Getenv("OPENFGA_API_URL")
	if apiURL == "" {
		apiURL = "http://localhost:18080"
	}
	if !isOpenFGA(apiURL) {
		t.Skipf("OpenFGA not reachable at %s (run: docker compose up -d)", apiURL)
	}
	ctx := context.Background()
	store, err := authz.NewStore(ctx, apiURL, "phase0-e2e")
	if err != nil {
		t.Fatalf("store: %v", err)
	}
	idp, err := org.NewMockAdapterFromFile(td("mock-org.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := authz.NewSyncer(store, idp, nil).Seed(ctx, tenant); err != nil {
		t.Fatalf("seed: %v", err)
	}
	// scenario fixtures: order ownership + cost-domain viewers.
	fx := sync.Diff{Writes: []sync.Tuple{
		{User: "user:u_sales1", Relation: "owner", Object: "business_record:" + obj("order/SO-1001")},
		{User: "department:" + obj("d_sales"), Relation: "owner_dept", Object: "business_record:" + obj("order/SO-1001")},
		{User: "department:" + obj("d_prod") + "#member", Relation: "operator", Object: "business_record:" + obj("order/SO-1001")},
		{User: "user:u_fin", Relation: "viewer", Object: "data_domain:" + obj("cost")},
		{User: "department:" + obj("d_sales") + "#manager", Relation: "viewer", Object: "data_domain:" + obj("cost")},
		{User: "department:" + obj("d_root") + "#manager", Relation: "viewer", Object: "data_domain:" + obj("cost")},
	}}
	if err := store.ApplyDiff(ctx, fx); err != nil {
		t.Fatal(err)
	}
	// Capability remains independent from record access and comes only from the
	// administrator-assigned roles on seeded skills.
	skStore, err := skill.Open()
	if err != nil {
		t.Fatal(err)
	}
	defer skStore.Close()
	skills, err := skStore.List(ctx, tenant)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.ApplyDiff(ctx, sync.Diff{Writes: skill.Tuples(skills, tenant)}); err != nil {
		t.Fatal(err)
	}
	erp, err := mockerp.Load(td("mock-erp.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	audit := runtime.NewAuditLog()
	return runtime.NewAgent(erp, runtime.NewGuard(store, tenant), nil, audit), audit
}

func isOpenFGA(apiURL string) bool {
	cl := http.Client{Timeout: time.Second}
	resp, err := cl.Get(apiURL + "/healthz")
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
	return strings.Contains(resp.Header.Get("Content-Type"), "json") && strings.Contains(string(b), "SERVING")
}
