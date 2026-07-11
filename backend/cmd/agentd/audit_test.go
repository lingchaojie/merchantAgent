package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/merchantagent/backend/org"
	"github.com/merchantagent/backend/runtime"
)

type auditIdentity struct {
	principals map[string]org.Principal
}

func (a auditIdentity) Authenticate(_ context.Context, lc org.LoginContext) (org.Principal, error) {
	p, ok := a.principals[lc.Credential]
	if !ok {
		return org.Principal{}, fmt.Errorf("not active")
	}
	return p, nil
}

type auditChecker map[string]bool

func (a auditChecker) Check(_ context.Context, user, relation, object string) (bool, error) {
	return relation == "admin" && object == "tenant:mock-corp-001" && a[user], nil
}

func TestAuditReadRequiresIdentityAndScopesEntries(t *testing.T) {
	audit := runtime.NewTenantAudit()
	audit.Append(runtime.AuditEntry{TenantID: "mock-corp-001", UserID: "u_sales1", Tool: "sales_tool"})
	audit.Append(runtime.AuditEntry{TenantID: "mock-corp-001", UserID: "u_plan", Tool: "production_tool"})
	audit.Append(runtime.AuditEntry{TenantID: "mock-corp-001", UserID: "u_boss", Tool: "boss_tool"})
	idp := auditIdentity{principals: map[string]org.Principal{
		"u_sales1": {TenantID: "mock-corp-001", UserID: "u_sales1"},
		"u_boss":   {TenantID: "mock-corp-001", UserID: "u_boss"},
	}}
	checker := auditChecker{"user:u_boss": true}

	tests := []struct {
		name, user string
		wantCode   int
		wantTools  []string
	}{
		{name: "missing identity", wantCode: http.StatusUnauthorized},
		{name: "inactive or outside user", user: "ghost", wantCode: http.StatusForbidden},
		{name: "member sees self", user: "u_sales1", wantCode: http.StatusOK, wantTools: []string{"sales_tool"}},
		{name: "admin sees tenant", user: "u_boss", wantCode: http.StatusOK, wantTools: []string{"sales_tool", "production_tool", "boss_tool"}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodGet, "/audit", nil)
			if tc.user != "" {
				r.Header.Set("X-User-Id", tc.user)
			}
			w := httptest.NewRecorder()
			serveAudit(w, r, "mock-corp-001", audit, idp, checker)
			if w.Code != tc.wantCode {
				t.Fatalf("status = %d, want %d: %s", w.Code, tc.wantCode, w.Body.String())
			}
			if tc.wantCode != http.StatusOK {
				return
			}
			var response struct {
				Verified bool                 `json:"verified"`
				Entries  []runtime.AuditEntry `json:"entries"`
			}
			if err := json.NewDecoder(w.Body).Decode(&response); err != nil {
				t.Fatal(err)
			}
			if !response.Verified {
				t.Fatal("filtered audit response must retain verified tenant-chain status")
			}
			if len(response.Entries) != len(tc.wantTools) {
				t.Fatalf("entries = %+v, want tools %v", response.Entries, tc.wantTools)
			}
			for i, want := range tc.wantTools {
				if response.Entries[i].Tool != want {
					t.Fatalf("entry %d tool = %q, want %q", i, response.Entries[i].Tool, want)
				}
			}
		})
	}
}

func TestAuditReadRejectsCrossTenantQuery(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/audit?tenant=other", nil)
	r.Header.Set("X-User-Id", "u_boss")
	w := httptest.NewRecorder()
	serveAudit(w, r, "mock-corp-001", runtime.NewTenantAudit(), auditIdentity{principals: map[string]org.Principal{
		"u_boss": {TenantID: "mock-corp-001", UserID: "u_boss"},
	}}, auditChecker{"user:u_boss": true})
	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", w.Code)
	}
}
