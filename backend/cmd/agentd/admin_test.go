package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/merchantagent/backend/provider"
	"github.com/merchantagent/backend/wire"
)

// fakeChecker lets us test requireAdmin without OpenFGA.
type fakeChecker struct{ admins map[string]bool }

func (f fakeChecker) Check(_ context.Context, user, relation, object string) (bool, error) {
	return f.admins[user], nil
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
