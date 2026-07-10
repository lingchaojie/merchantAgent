package config

import (
	"context"
	"path/filepath"
	"testing"
)

func TestOpen_Seeded(t *testing.T) {
	s, err := Open("mock-corp-001")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	var roles, rules, domains, grants int
	s.db.QueryRow(`SELECT COUNT(*) FROM roles`).Scan(&roles)
	s.db.QueryRow(`SELECT COUNT(*) FROM role_rules`).Scan(&rules)
	s.db.QueryRow(`SELECT COUNT(*) FROM data_domains`).Scan(&domains)
	s.db.QueryRow(`SELECT COUNT(*) FROM domain_grants`).Scan(&grants)
	if roles != 7 || rules != 6 || domains != 2 || grants != 3 {
		t.Fatalf("seed counts = roles %d rules %d domains %d grants %d; want 7/6/2/3", roles, rules, domains, grants)
	}
}

func TestRolesCRUD(t *testing.T) {
	ctx := context.Background()
	s, _ := Open("mock-corp-001")
	defer s.Close()

	if err := s.CreateRole(ctx, Role{RoleID: "logistics", Label: "物流", Description: "仓储物流"}); err != nil {
		t.Fatal(err)
	}
	roles, _ := s.Roles(ctx)
	if len(roles) != 8 {
		t.Fatalf("roles = %d, want 8 after create", len(roles))
	}
	if err := s.UpdateRole(ctx, "logistics", "物流部", "含快递"); err != nil {
		t.Fatal(err)
	}
	// Add a position->role rule referencing "logistics" (plus one that doesn't)
	// so DeleteRole must cascade the rule away, not just the role row.
	if err := s.ReplaceRules(ctx, []Rule{
		{Match: []string{"仓管", "物流"}, RoleID: "logistics"},
		{Match: []string{"销售"}, RoleID: "sales"},
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteRole(ctx, "logistics"); err != nil {
		t.Fatal(err)
	}
	roles, _ = s.Roles(ctx)
	if len(roles) != 7 {
		t.Fatalf("roles = %d, want 7 after delete", len(roles))
	}
	// Cascade: no rule may still point at the deleted role; the unrelated rule survives.
	rules, _ := s.Rules(ctx)
	if len(rules) != 1 {
		t.Fatalf("rules = %d, want 1 after cascade delete", len(rules))
	}
	for _, r := range rules {
		if r.RoleID == "logistics" {
			t.Fatalf("rule still references deleted role: %+v", r)
		}
	}
	if rules[0].RoleID != "sales" {
		t.Fatalf("surviving rule = %+v, want RoleID sales", rules[0])
	}
}

func TestRulesReplaceAndDomains(t *testing.T) {
	ctx := context.Background()
	s, _ := Open("mock-corp-001")
	defer s.Close()
	// Replace rules wholesale.
	if err := s.ReplaceRules(ctx, []Rule{{Match: []string{"老板"}, RoleID: "manager_tier"}}); err != nil {
		t.Fatal(err)
	}
	rules, _ := s.Rules(ctx)
	if len(rules) != 1 || rules[0].RoleID != "manager_tier" || rules[0].Match[0] != "老板" {
		t.Fatalf("rules = %+v", rules)
	}
	// Grants add/remove.
	if err := s.AddGrant(ctx, "cost", "role:mock-corp-001/finance#assignee"); err != nil {
		t.Fatal(err)
	}
	grants, _ := s.Grants(ctx)
	if len(grants) != 4 {
		t.Fatalf("grants = %d, want 4", len(grants))
	}
	if err := s.RemoveGrant(ctx, "cost", "role:mock-corp-001/finance#assignee"); err != nil {
		t.Fatal(err)
	}
	grants, _ = s.Grants(ctx)
	if len(grants) != 3 {
		t.Fatalf("grants = %d, want 3 after remove", len(grants))
	}
}

func TestOpenFile_SeedGuardPersists(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "config.db")

	s1, err := OpenFile(path, "mock-corp-001")
	if err != nil {
		t.Fatal(err)
	}
	roles, _ := s1.Roles(ctx)
	if len(roles) != 7 {
		t.Fatalf("fresh OpenFile roles = %d, want 7 (seeded)", len(roles))
	}
	// Admin edit: delete a seeded role.
	if err := s1.DeleteRole(ctx, "staff"); err != nil {
		t.Fatal(err)
	}
	s1.Close()

	// Reopen: must NOT re-seed (edit survives), stays at 6.
	s2, err := OpenFile(path, "mock-corp-001")
	if err != nil {
		t.Fatal(err)
	}
	defer s2.Close()
	roles, _ = s2.Roles(ctx)
	if len(roles) != 6 {
		t.Fatalf("reopened roles = %d, want 6 (edit survived, no re-seed)", len(roles))
	}
}

func TestOpenFile_SeedGuardSurvivesEmptyRoles(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "config.db")
	s1, err := OpenFile(path, "mock-corp-001")
	if err != nil {
		t.Fatal(err)
	}
	// Admin empties all roles (each DeleteRole cascades its rules+grants).
	roles, _ := s1.Roles(ctx)
	for _, r := range roles {
		if err := s1.DeleteRole(ctx, r.RoleID); err != nil {
			t.Fatal(err)
		}
	}
	s1.Close()
	// Reopen must NOT crash on re-seed and must NOT resurrect roles.
	s2, err := OpenFile(path, "mock-corp-001")
	if err != nil {
		t.Fatalf("reopen after emptying roles: %v", err)
	}
	defer s2.Close()
	roles, _ = s2.Roles(ctx)
	if len(roles) != 0 {
		t.Fatalf("roles = %d, want 0 (no re-seed after admin emptied them)", len(roles))
	}
}

func TestAddGrant_RejectsMalformedSubject(t *testing.T) {
	ctx := context.Background()
	s, _ := Open("mock-corp-001")
	defer s.Close()

	before, _ := s.Grants(ctx)
	// Malformed subject (no type:id shape) must error and NOT persist.
	if err := s.AddGrant(ctx, "cost", "garbage"); err == nil {
		t.Fatal("AddGrant with malformed subject returned nil error")
	}
	after, _ := s.Grants(ctx)
	if len(after) != len(before) {
		t.Fatalf("malformed grant persisted: grants %d → %d", len(before), len(after))
	}
	// A structurally valid subject succeeds.
	if err := s.AddGrant(ctx, "cost", "user:u_x"); err != nil {
		t.Fatalf("valid AddGrant errored: %v", err)
	}
	after, _ = s.Grants(ctx)
	if len(after) != len(before)+1 {
		t.Fatalf("valid grant not persisted: grants %d → %d", len(before), len(after))
	}
}
