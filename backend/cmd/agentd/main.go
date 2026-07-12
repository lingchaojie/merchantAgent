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
	"errors"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/merchantagent/backend/connector"
	"github.com/merchantagent/backend/connectorregistry"
	"github.com/merchantagent/backend/provider"
	"github.com/merchantagent/backend/wire"
)

type server struct {
	asm                *wire.Assembled
	tenant             string
	mu                 sync.Mutex
	pendingTools       map[string]chan connector.LocalToolResponse
	sessions           map[string][]provider.Message // sessionId → history (per-session)
	pending            map[string]chan fileResult    // reqId → waiting file bridge request
	adminChecker       adminChecker
	credentialVerifier connectorregistry.CredentialVerifier
	now                func() time.Time
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

	dataDir := envOr("DATA_DIR", "")
	configDB, skillDB := os.Getenv("CONFIG_DB"), os.Getenv("SKILL_DB")
	if configDB == "" && dataDir != "" {
		configDB = dataDir + "/config.db"
	}
	if skillDB == "" && dataDir != "" {
		skillDB = dataDir + "/skills.db"
	}
	connectorDB, err := resolveConnectorDB(os.Getenv("CONNECTOR_DB"), dataDir)
	if err != nil {
		log.Fatalf("connector registry: %v", err)
	}
	platformPublicKey, err := loadImplementationPublicKey(os.Getenv("IMPLEMENTATION_PUBLIC_KEY_FILE"))
	if err != nil {
		log.Fatalf("implementation verification key: %v", err)
	}

	asm, err := wire.Assemble(ctx, wire.Config{
		OpenFGAURL:  apiURL,
		Tenant:      tenant,
		OrgFile:     envOr("MOCK_ORG_FILE", "testdata/mock-org.yaml"),
		ConfigDB:    configDB,
		SkillDB:     skillDB,
		ConnectorDB: connectorDB,
		Provider:    prov,
	})
	if err != nil {
		log.Fatalf("assemble: %v", err)
	}
	defer asm.Close()

	s := &server{
		asm: asm, tenant: tenant,
		sessions:           map[string][]provider.Message{},
		pending:            map[string]chan fileResult{},
		pendingTools:       map[string]chan connector.LocalToolResponse{},
		credentialVerifier: connectorregistry.CredentialVerifier{PlatformPublicKey: platformPublicKey},
		now:                time.Now,
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
	mux.HandleFunc("/chat/local-tool-result", s.handleLocalToolResult)
	mux.HandleFunc("/audit", s.handleAudit)

	checker := s.adminChecker
	if checker == nil {
		checker = s.asm.Store
	}
	admin := func(h http.HandlerFunc) http.HandlerFunc { return requireAdmin(checker, s.tenant, h) }
	mux.HandleFunc("POST /implementation/connectors", s.handleConnectorSubmit)
	mux.HandleFunc("GET /connectors/{id}/versions/{version}/approval", s.handleConnectorApproval)
	mux.HandleFunc("GET /admin/connectors", admin(s.handleConnectorsList))
	mux.HandleFunc("POST /admin/connectors/{id}/versions/{version}/publish", admin(s.handleConnectorPublish))
	mux.HandleFunc("POST /admin/connectors/{id}/versions/{version}/suspend", admin(s.handleConnectorSuspend))
	mux.HandleFunc("POST /admin/connectors/{id}/versions/{version}/revoke", admin(s.handleConnectorRevoke))
	mux.HandleFunc("GET /admin/tools", admin(s.handleTools))
	mux.HandleFunc("GET /admin/roles", admin(s.handleRolesList))
	mux.HandleFunc("POST /admin/roles", admin(s.handleRoleCreate))
	mux.HandleFunc("PUT /admin/roles/{id}", admin(s.handleRoleUpdate))
	mux.HandleFunc("DELETE /admin/roles/{id}", admin(s.handleRoleDelete))
	mux.HandleFunc("GET /admin/rules", admin(s.handleRulesGet))
	mux.HandleFunc("PUT /admin/rules", admin(s.handleRulesPut))
	mux.HandleFunc("GET /admin/skills", admin(s.handleSkillsList))
	mux.HandleFunc("GET /admin/templates", admin(s.handleTemplatesList))
	mux.HandleFunc("POST /admin/skills", admin(s.handleSkillCreate))
	mux.HandleFunc("PUT /admin/skills/{id}", admin(s.handleSkillUpdate))
	mux.HandleFunc("DELETE /admin/skills/{id}", admin(s.handleSkillDelete))
	mux.HandleFunc("GET /admin/domains", admin(s.handleDomainsList))
	mux.HandleFunc("POST /admin/domains/{d}/grants", admin(s.handleGrantAdd))
	mux.HandleFunc("DELETE /admin/domains/{d}/grants", admin(s.handleGrantRemove))
	return mux
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func resolveConnectorDB(explicit, dataDir string) (string, error) {
	if explicit != "" {
		return explicit, nil
	}
	if dataDir != "" {
		return filepath.Join(dataDir, "connectors.db"), nil
	}
	return "", errors.New("CONNECTOR_DB or DATA_DIR is required")
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}
