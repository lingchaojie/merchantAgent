package authz

import (
	"context"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/merchantagent/backend/org"
	"github.com/merchantagent/backend/sync"
)

const tenant = "mock-corp-001"

func obj(s string) string { return tenant + "/" + s }

// isOpenFGA verifies the endpoint is a real OpenFGA server, not just anything
// that returns 200 (OpenFGA /healthz returns JSON {"status":"SERVING"}). This
// guards against a different service (e.g. an SPA gateway) squatting the port.
func isOpenFGA(apiURL string) bool {
	cl := http.Client{Timeout: time.Second}
	resp, err := cl.Get(apiURL + "/healthz")
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	if ct := resp.Header.Get("Content-Type"); !strings.Contains(ct, "json") {
		return false
	}
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
	return strings.Contains(string(b), "SERVING")
}

// setup connects to OpenFGA (skips the test if unreachable), creates a fresh
// store, seeds org tuples from the mock IdP, and writes the scenario fixtures
// (orders + the cost data-domain viewers). Returns the ready Store.
func setup(t *testing.T) *Store {
	t.Helper()
	apiURL := os.Getenv("OPENFGA_API_URL")
	if apiURL == "" {
		apiURL = "http://localhost:18080"
	}
	if !isOpenFGA(apiURL) {
		t.Skipf("OpenFGA not reachable at %s (run: docker compose up -d). "+
			"Set OPENFGA_API_URL to override.", apiURL)
	}
	ctx := context.Background()
	store, err := NewStore(ctx, apiURL, "phase0-acceptance")
	if err != nil {
		t.Fatalf("new store: %v", err)
	}

	// Seed org (tenant/dept/role/manager) from the mock directory.
	idp, err := org.NewMockAdapterFromFile(filepath.Join("..", "testdata", "mock-org.yaml"))
	if err != nil {
		t.Fatalf("mock idp: %v", err)
	}
	if _, err := NewSyncer(store, idp, nil).Seed(ctx, tenant); err != nil {
		t.Fatalf("seed: %v", err)
	}

	// Scenario fixtures: orders + who may view the cost data-domain.
	// cost is high-sensitivity → only finance + dept managers (incl. boss via
	// root-dept manager inheritance). Sales staff are intentionally excluded.
	fixtures := sync.Diff{Writes: []sync.Tuple{
		{User: "user:u_sales1", Relation: "owner", Object: "business_record:" + obj("order/SO-1001")},
		{User: "department:" + obj("d_sales"), Relation: "owner_dept", Object: "business_record:" + obj("order/SO-1001")},
		{User: "department:" + obj("d_prod") + "#member", Relation: "operator", Object: "business_record:" + obj("order/SO-1001")},
		{User: "user:u_sales1", Relation: "owner", Object: "business_record:" + obj("order/SO-1002")},
		{User: "department:" + obj("d_sales"), Relation: "owner_dept", Object: "business_record:" + obj("order/SO-1002")},
		{User: "user:u_fin", Relation: "viewer", Object: "data_domain:" + obj("cost")},
		{User: "department:" + obj("d_sales") + "#manager", Relation: "viewer", Object: "data_domain:" + obj("cost")},
		{User: "department:" + obj("d_root") + "#manager", Relation: "viewer", Object: "data_domain:" + obj("cost")},
	}}
	if err := store.ApplyDiff(ctx, fixtures); err != nil {
		t.Fatalf("apply fixtures: %v", err)
	}
	return store
}
