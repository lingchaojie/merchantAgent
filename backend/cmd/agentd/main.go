// Command agentd is the Phase 0 HTTP API the desktop shell calls. It wires the
// composition root (OpenFGA store + org sync + mock ERP + agent runtime) and
// exposes /login, /ask, /audit.
//
// SECURITY (Phase 0 demo shortcut — DO NOT ship): /ask trusts the userId in the
// request body. In production the principal MUST be derived from a verified
// session (WeCom OAuth → our JWT), never from a client-supplied id. See
// research/11 §6 and research/10 §3. This server is for local demo only and
// binds to loopback.
package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"

	"github.com/merchantagent/backend/authz"
	"github.com/merchantagent/backend/connector/mockerp"
	"github.com/merchantagent/backend/org"
	"github.com/merchantagent/backend/runtime"
	"github.com/merchantagent/backend/sync"
)

type server struct {
	idp   *org.MockAdapter
	agent *runtime.Agent
	audit *runtime.AuditLog
}

func main() {
	addr := envOr("ADDR", "127.0.0.1:8765") // loopback only (demo)
	apiURL := envOr("OPENFGA_API_URL", "http://localhost:18080")
	tenant := envOr("TENANT", "mock-corp-001")
	ctx := context.Background()

	store, err := authz.NewStore(ctx, apiURL, "agentd")
	if err != nil {
		log.Fatalf("openfga store (is it up? docker compose up -d): %v", err)
	}
	idp, err := org.NewMockAdapterFromFile(envOr("MOCK_ORG_FILE", "testdata/mock-org.yaml"))
	if err != nil {
		log.Fatal(err)
	}
	if _, err := authz.NewSyncer(store, idp, nil).Seed(ctx, tenant); err != nil {
		log.Fatalf("seed org: %v", err)
	}
	seedDemoScenario(ctx, store, tenant) // demo order/data-domain tuples

	erp, err := mockerp.Load(envOr("MOCK_ERP_FILE", "testdata/mock-erp.yaml"))
	if err != nil {
		log.Fatal(err)
	}
	audit := runtime.NewAuditLog()
	agent := runtime.NewAgent(erp, runtime.NewGuard(store, tenant), nil, audit)

	s := &server{idp: idp, agent: agent, audit: audit}
	mux := http.NewServeMux()
	mux.HandleFunc("/login", s.handleLogin)
	mux.HandleFunc("/ask", s.handleAsk)
	mux.HandleFunc("/audit", s.handleAudit)
	log.Printf("agentd listening on %s (tenant=%s, openfga=%s)", addr, tenant, apiURL)
	log.Fatal(http.ListenAndServe(addr, mux))
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

// seedDemoScenario writes the demo order ownership + cost-domain viewers so the
// server has something to answer about. Mirrors the e2e fixtures.
func seedDemoScenario(ctx context.Context, store *authz.Store, tenant string) {
	o := func(s string) string { return tenant + "/" + s }
	_ = store.ApplyDiff(ctx, sync.Diff{Writes: []sync.Tuple{
		{User: "user:u_sales1", Relation: "owner", Object: "order:" + o("SO-1001")},
		{User: "department:" + o("d_sales"), Relation: "owner_dept", Object: "order:" + o("SO-1001")},
		{User: "user:u_sales1", Relation: "owner", Object: "order:" + o("SO-1002")},
		{User: "department:" + o("d_sales"), Relation: "owner_dept", Object: "order:" + o("SO-1002")},
		{User: "user:u_fin", Relation: "viewer", Object: "data_domain:" + o("cost")},
		{User: "department:" + o("d_sales") + "#manager", Relation: "viewer", Object: "data_domain:" + o("cost")},
		{User: "department:" + o("d_root") + "#manager", Relation: "viewer", Object: "data_domain:" + o("cost")},
	}})
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}
