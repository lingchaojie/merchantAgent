// Command agentd is the HTTP API the desktop shell calls. It wires the
// composition root via wire.Assemble (OpenFGA + org sync + ERP/CRM connectors +
// skill registry + LLM agent) and exposes /login, /chat (SSE), /audit.
//
// SECURITY (demo shortcut — DO NOT ship): /chat trusts the userId in the request
// body. In production the principal MUST be derived from a verified session
// (WeCom OAuth → our JWT), never from a client-supplied id (research/11 §6,
// research/10 §3). Binds to loopback for local demo only.
package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"sync"

	"github.com/merchantagent/backend/provider"
	"github.com/merchantagent/backend/wire"
)

type server struct {
	asm      *wire.Assembled
	tenant   string
	mu       sync.Mutex
	sessions map[string][]provider.Message // sessionId → history (per-session)
	pending  map[string]chan fileResult    // reqId → waiting file bridge request
}

func main() {
	addr := envOr("ADDR", "127.0.0.1:8765") // loopback only (demo)
	apiURL := envOr("OPENFGA_API_URL", "http://localhost:18080")
	tenant := envOr("TENANT", "mock-corp-001")
	ctx := context.Background()

	key := os.Getenv("LLM_API_KEY")
	if key == "" {
		log.Println("WARNING: LLM_API_KEY unset — /chat will fail. Source backend/dev.env.")
	}
	prov := provider.NewOpenAI(envOr("LLM_BASE_URL", "https://www.linx2.ai"), key, envOr("LLM_MODEL", "gpt-5.5"))

	asm, err := wire.Assemble(ctx, wire.Config{
		OpenFGAURL: apiURL,
		Tenant:     tenant,
		OrgFile:    envOr("MOCK_ORG_FILE", "testdata/mock-org.yaml"),
		Provider:   prov,
	})
	if err != nil {
		log.Fatalf("assemble: %v", err)
	}
	defer asm.Close()

	s := &server{
		asm: asm, tenant: tenant,
		sessions: map[string][]provider.Message{},
		pending:  map[string]chan fileResult{},
	}
	log.Printf("agentd listening on %s (tenant=%s, openfga=%s, model=%s)", addr, tenant, apiURL, envOr("LLM_MODEL", "gpt-5.5"))
	log.Fatal(http.ListenAndServe(addr, s.routes()))
}

// routes builds the HTTP mux (shared by main and the integration test).
func (s *server) routes() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("/login", s.handleLogin)
	mux.HandleFunc("/chat", s.handleChat)
	mux.HandleFunc("/chat/file-result", s.handleFileResult)
	mux.HandleFunc("/audit", s.handleAudit)
	return mux
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}
