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
}
