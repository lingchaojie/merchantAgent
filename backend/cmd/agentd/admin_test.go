package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/merchantagent/backend/connector"
	"github.com/merchantagent/backend/connector/clientexec"
	"github.com/merchantagent/backend/provider"
	"github.com/merchantagent/backend/skill"
	"github.com/merchantagent/backend/wire"
)

// fakeChecker lets us test requireAdmin without OpenFGA.
type fakeChecker struct{ admins map[string]bool }

func (f fakeChecker) Check(_ context.Context, user, relation, object string) (bool, error) {
	return f.admins[user], nil
}

type adminCatalogTool struct{ spec connector.ToolSpec }

func (t adminCatalogTool) Spec() connector.ToolSpec { return t.spec }
func (adminCatalogTool) Invoke(context.Context, map[string]any) (map[string]any, error) {
	return nil, nil
}

type adminCatalogConnector struct {
	name  string
	tools []connector.Tool
}

func (c adminCatalogConnector) Name() string            { return c.name }
func (c adminCatalogConnector) Tools() []connector.Tool { return c.tools }

type adminToolCatalog struct {
	tools map[string]connector.Tool
	err   error
}

func (c adminToolCatalog) Snapshot(context.Context) (map[string]connector.Tool, error) {
	return c.tools, c.err
}

func openAdminSkillStore(t *testing.T) *skill.Store {
	t.Helper()
	store, err := skill.Open()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	return store
}

func findAdminSkill(t *testing.T, store *skill.Store, tenant, id string) (skill.Skill, bool) {
	t.Helper()
	skills, err := store.List(context.Background(), tenant)
	if err != nil {
		t.Fatal(err)
	}
	for _, sk := range skills {
		if sk.SkillID == id {
			return sk, true
		}
	}
	return skill.Skill{}, false
}

func callAdminHandler(handler func()) (panicValue any) {
	defer func() { panicValue = recover() }()
	handler()
	return nil
}

func TestSkillCreateRejectsUnavailableToolsBeforePersistence(t *testing.T) {
	store := openAdminSkillStore(t)
	srv := &server{tenant: "t", asm: &wire.Assembled{
		Sk:      store,
		Catalog: adminToolCatalog{tools: map[string]connector.Tool{"available_tool": adminCatalogTool{spec: connector.ToolSpec{Name: "available_tool"}}}},
	}}
	r := httptest.NewRequest(http.MethodPost, "/admin/skills", strings.NewReader(`{
		"skill":{"skillId":"new-skill","name":"New","allowedTools":["missing_tool"]}
	}`))
	w := httptest.NewRecorder()
	panicValue := callAdminHandler(func() { srv.handleSkillCreate(w, r) })

	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "missing_tool") {
		t.Errorf("create unavailable tool: %d %s", w.Code, w.Body.String())
	}
	if panicValue != nil {
		t.Errorf("create reached projection: %v", panicValue)
	}
	if _, exists := findAdminSkill(t, store, "t", "new-skill"); exists {
		t.Error("invalid skill was persisted")
	}
}

func TestSkillUpdateRejectsUnavailableToolsWithoutChangingHistoricalRow(t *testing.T) {
	store := openAdminSkillStore(t)
	historical := skill.Skill{TenantID: "t", SkillID: "historical", Name: "Historical", AllowedTools: []string{"retired_tool"}}
	if err := store.Create(context.Background(), historical); err != nil {
		t.Fatal(err)
	}
	srv := &server{tenant: "t", asm: &wire.Assembled{
		Sk:      store,
		Catalog: adminToolCatalog{tools: map[string]connector.Tool{"available_tool": adminCatalogTool{spec: connector.ToolSpec{Name: "available_tool"}}}},
	}}
	r := httptest.NewRequest(http.MethodPut, "/admin/skills/historical", strings.NewReader(`{
		"name":"Changed","allowedTools":["missing_tool"]
	}`))
	r.SetPathValue("id", "historical")
	w := httptest.NewRecorder()
	panicValue := callAdminHandler(func() { srv.handleSkillUpdate(w, r) })

	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "missing_tool") {
		t.Errorf("update unavailable tool: %d %s", w.Code, w.Body.String())
	}
	if panicValue != nil {
		t.Errorf("update reached projection: %v", panicValue)
	}
	got, exists := findAdminSkill(t, store, "t", "historical")
	if !exists || got.Name != historical.Name || len(got.AllowedTools) != 1 || got.AllowedTools[0] != "retired_tool" {
		t.Fatalf("historical skill changed: %+v", got)
	}
}

func TestSkillCreateFailsClosedOnCatalogError(t *testing.T) {
	store := openAdminSkillStore(t)
	srv := &server{tenant: "t", asm: &wire.Assembled{
		Sk: store, Catalog: adminToolCatalog{err: errors.New("catalog unavailable")},
	}}
	r := httptest.NewRequest(http.MethodPost, "/admin/skills", strings.NewReader(`{
		"skill":{"skillId":"new-skill","name":"New","allowedTools":["any_tool"]}
	}`))
	w := httptest.NewRecorder()
	panicValue := callAdminHandler(func() { srv.handleSkillCreate(w, r) })

	if w.Code != http.StatusInternalServerError || !strings.Contains(w.Body.String(), "catalog unavailable") {
		t.Errorf("create catalog error: %d %s", w.Code, w.Body.String())
	}
	if panicValue != nil {
		t.Errorf("catalog error reached projection: %v", panicValue)
	}
	if _, exists := findAdminSkill(t, store, "t", "new-skill"); exists {
		t.Error("skill was persisted after catalog error")
	}
}

func TestAdminToolsDeduplicatesAndExposesExecutionMetadata(t *testing.T) {
	legacy := adminCatalogConnector{name: "erp", tools: []connector.Tool{
		adminCatalogTool{spec: connector.ToolSpec{Name: "query_order_status", Description: "ERP status"}},
		adminCatalogTool{spec: connector.ToolSpec{Name: "z_legacy_report", Description: "Legacy report"}},
	}}
	srv := &server{asm: &wire.Assembled{Conns: []connector.Connector{legacy, clientexec.NewReference()}}}
	w := httptest.NewRecorder()
	srv.handleTools(w, httptest.NewRequest(http.MethodGet, "/admin/tools", nil))

	if w.Code != http.StatusOK {
		t.Fatalf("GET /admin/tools: %d %s", w.Code, w.Body.String())
	}
	var got []struct {
		Name                 string `json:"name"`
		Description          string `json:"description"`
		PackageID            string `json:"packageId"`
		Version              string `json:"version"`
		Execution            string `json:"execution"`
		Risk                 string `json:"risk"`
		RequiresConfirmation bool   `json:"requiresConfirmation"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode tools: %v", err)
	}
	if len(got) != 3 {
		t.Fatalf("tools count = %d, want 3 (duplicate query_order_status removed): %+v", len(got), got)
	}
	var raw []map[string]json.RawMessage
	if err := json.Unmarshal(w.Body.Bytes(), &raw); err != nil {
		t.Fatalf("decode raw tools: %v", err)
	}
	confirmation, exists := raw[0]["requiresConfirmation"]
	if !exists || string(confirmation) != "false" {
		t.Fatalf("query_order_status requiresConfirmation JSON = %s, exists=%v; want explicit false", confirmation, exists)
	}
	wantNames := []string{"query_order_status", "report_production_progress", "z_legacy_report"}
	for i, want := range wantNames {
		if got[i].Name != want {
			t.Fatalf("tool[%d].name = %q, want %q", i, got[i].Name, want)
		}
	}
	query := got[0]
	if query.Description != "查询订单及本地生产进度（不含成本利润）" ||
		query.PackageID != "reference-manufacturing" || query.Version != "1.0.0" ||
		query.Execution != "desktop" || query.Risk != "read" || query.RequiresConfirmation {
		t.Fatalf("query_order_status metadata = %+v", query)
	}
	legacyTool := got[2]
	if legacyTool.Execution != "server" || legacyTool.Risk != "read" {
		t.Fatalf("legacy defaults = execution %q risk %q, want server/read", legacyTool.Execution, legacyTool.Risk)
	}
}

func TestRequireAdmin(t *testing.T) {
	chk := fakeChecker{admins: map[string]bool{"user:u_boss": true}}
	guarded := requireAdmin(chk, "mock-corp-001", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	// missing X-User-Id → 401
	r0 := httptest.NewRequest("GET", "/admin/roles", nil)
	w0 := httptest.NewRecorder()
	guarded(w0, r0)
	if w0.Code != http.StatusUnauthorized {
		t.Errorf("no header got %d, want 401", w0.Code)
	}
	// non-admin → 403
	r1 := httptest.NewRequest("GET", "/admin/roles", nil)
	r1.Header.Set("X-User-Id", "u_sales1")
	w1 := httptest.NewRecorder()
	guarded(w1, r1)
	if w1.Code != http.StatusForbidden {
		t.Errorf("non-admin got %d, want 403", w1.Code)
	}
	// admin → 200
	r2 := httptest.NewRequest("GET", "/admin/roles", nil)
	r2.Header.Set("X-User-Id", "u_boss")
	w2 := httptest.NewRecorder()
	guarded(w2, r2)
	if w2.Code != http.StatusOK {
		t.Errorf("admin got %d, want 200", w2.Code)
	}
}

func TestAdminRoleCreate_Projects(t *testing.T) {
	apiURL := os.Getenv("OPENFGA_API_URL")
	if apiURL == "" {
		apiURL = "http://localhost:18080"
	}
	asm, err := wire.Assemble(context.Background(), wire.Config{
		OpenFGAURL: apiURL, Tenant: "mock-corp-001",
		OrgFile:  filepath.Join("..", "..", "testdata", "mock-org.yaml"),
		Provider: &provider.Fake{}, // LLM never called during admin CRUD
	})
	if err != nil {
		t.Skipf("assemble (OpenFGA up?): %v", err)
	}
	defer asm.Close()
	srv := &server{asm: asm, tenant: "mock-corp-001", sessions: map[string][]provider.Message{}, pending: map[string]chan fileResult{}}

	body := `{"roleId":"logistics","label":"物流"}`
	r := httptest.NewRequest("POST", "/admin/roles", strings.NewReader(body))
	r.Header.Set("X-User-Id", "u_boss")
	w := httptest.NewRecorder()
	srv.routes().ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("create role: %d %s", w.Code, w.Body.String())
	}
	roles, _ := asm.Cfg.Roles(context.Background())
	found := false
	for _, ro := range roles {
		if ro.RoleID == "logistics" {
			found = true
		}
	}
	if !found {
		t.Error("logistics role not persisted")
	}
	// Prove projection reached OpenFGA: a bare role with no assignees still emits
	// its registration edge tenant:<t>|tenant|role:<t>/logistics.
	tuples, err := asm.Store.ReadTuples(context.Background())
	if err != nil {
		t.Fatalf("read tuples: %v", err)
	}
	wantUser, wantRel, wantObj := "tenant:mock-corp-001", "tenant", "role:mock-corp-001/logistics"
	projected := false
	for _, tp := range tuples {
		if tp.User == wantUser && tp.Relation == wantRel && tp.Object == wantObj {
			projected = true
		}
	}
	if !projected {
		t.Errorf("role tuple %s|%s|%s not projected to OpenFGA", wantUser, wantRel, wantObj)
	}
}

func TestAdminGrantAddRemove_Projects(t *testing.T) {
	ctx := context.Background()
	apiURL := os.Getenv("OPENFGA_API_URL")
	if apiURL == "" {
		apiURL = "http://localhost:18080"
	}
	asm, err := wire.Assemble(ctx, wire.Config{
		OpenFGAURL: apiURL, Tenant: "mock-corp-001",
		OrgFile:  filepath.Join("..", "..", "testdata", "mock-org.yaml"),
		Provider: &provider.Fake{},
	})
	if err != nil {
		t.Skipf("assemble (OpenFGA up?): %v", err)
	}
	defer asm.Close()
	srv := &server{asm: asm, tenant: "mock-corp-001", sessions: map[string][]provider.Message{}, pending: map[string]chan fileResult{}}

	check := func() bool {
		ok, err := asm.Store.Check(ctx, "user:u_sales1", "viewer", "data_domain:mock-corp-001/cost")
		if err != nil {
			t.Fatalf("check: %v", err)
		}
		return ok
	}
	post := func(method string) {
		r := httptest.NewRequest(method, "/admin/domains/cost/grants", strings.NewReader(`{"subject":"user:u_sales1"}`))
		r.Header.Set("X-User-Id", "u_boss")
		w := httptest.NewRecorder()
		srv.routes().ServeHTTP(w, r)
		if w.Code != http.StatusOK {
			t.Fatalf("%s grant: %d %s", method, w.Code, w.Body.String())
		}
	}

	// Add grant → viewer edge must now exist in OpenFGA.
	post("POST")
	if !check() {
		t.Error("after AddGrant, u_sales1 not viewer on cost")
	}
	// Remove grant → reconcile must delete the edge from OpenFGA.
	post("DELETE")
	if check() {
		t.Error("after RemoveGrant, u_sales1 still viewer on cost")
	}
}
