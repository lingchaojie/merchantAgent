package skill

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
)

func TestList_Seeded(t *testing.T) {
	s, err := Open()
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	skills, err := s.List(context.Background(), "mock-corp-001")
	if err != nil {
		t.Fatal(err)
	}
	if len(skills) != 2 {
		t.Fatalf("skills = %d, want 2 (order360, customer360)", len(skills))
	}
	byID := map[string]Skill{}
	for _, sk := range skills {
		byID[sk.SkillID] = sk
	}
	o := byID["order360"]
	if len(o.AllowedTools) != 3 || o.SourceTemplate != "order-360" {
		t.Errorf("order360 = %+v", o)
	}
	if len(o.Roles) != 2 { // sales, manager_tier
		t.Errorf("order360 roles = %v", o.Roles)
	}
}

func TestTuples_Projection(t *testing.T) {
	s, _ := Open()
	defer s.Close()
	skills, _ := s.List(context.Background(), "mock-corp-001")
	tuples := Tuples(skills, "mock-corp-001")

	want := map[string]bool{
		// order360 exposes query_order_status
		"skill:mock-corp-001/order360|exposed_by|tool:mock-corp-001/query_order_status": false,
		// sales role may use order360
		"role:mock-corp-001/sales#assignee|usable_by|skill:mock-corp-001/order360": false,
		// manager_tier may use order360
		"role:mock-corp-001/manager_tier#assignee|usable_by|skill:mock-corp-001/order360": false,
	}
	for _, tp := range tuples {
		if _, ok := want[tp.String()]; ok {
			want[tp.String()] = true
		}
	}
	for k, seen := range want {
		if !seen {
			t.Errorf("missing projected tuple: %s", k)
		}
	}
	// DataDomains must NOT be projected (advisory only, §3.3).
	for _, tp := range tuples {
		if strings.Contains(tp.Object, "data_domain") || strings.Contains(tp.User, "data_domain") {
			t.Errorf("data_domain must not be projected, got %s", tp.String())
		}
	}
}

func TestSkillCRUD_AndClone(t *testing.T) {
	ctx := context.Background()
	s, _ := Open()
	defer s.Close()

	tmpls, err := s.ListTemplates(ctx)
	if err != nil || len(tmpls) != 1 || tmpls[0].TemplateID != "order-360" {
		t.Fatalf("templates = %+v err=%v", tmpls, err)
	}
	// Clone the platform template into a new tenant skill.
	id, err := s.CloneTemplate(ctx, "mock-corp-001", "order-360")
	if err != nil {
		t.Fatal(err)
	}
	skills, _ := s.List(ctx, "mock-corp-001")
	if len(skills) != 3 {
		t.Fatalf("skills = %d, want 3 after clone", len(skills))
	}
	// Update the clone's roles (Gate A) + playbook.
	err = s.Update(ctx, Skill{
		TenantID: "mock-corp-001", SkillID: id, Name: "订单360副本",
		Description: "d", PlaybookMD: "p", AllowedTools: []string{"query_order_status"},
		DataDomains: []string{"cost"}, Roles: []string{"sales"},
	})
	if err != nil {
		t.Fatal(err)
	}
	// Delete it.
	if err := s.Delete(ctx, "mock-corp-001", id); err != nil {
		t.Fatal(err)
	}
	skills, _ = s.List(ctx, "mock-corp-001")
	if len(skills) != 2 {
		t.Fatalf("skills = %d, want 2 after delete", len(skills))
	}
}

func TestRemoveRoleFromSkills(t *testing.T) {
	ctx := context.Background()
	s, _ := Open()
	defer s.Close()
	// order360 seeds roles [sales, manager_tier]; drop sales.
	if err := s.RemoveRoleFromAll(ctx, "mock-corp-001", "sales"); err != nil {
		t.Fatal(err)
	}
	skills, _ := s.List(ctx, "mock-corp-001")
	for _, sk := range skills {
		for _, r := range sk.Roles {
			if r == "sales" {
				t.Errorf("skill %s still has role sales", sk.SkillID)
			}
		}
	}
}

func TestCreate_RejectsMalformedID(t *testing.T) {
	ctx := context.Background()
	s, _ := Open()
	defer s.Close()

	before, _ := s.List(ctx, "mock-corp-001")
	// An id embedded into "skill:<tenant>/<id>" must not contain whitespace, ':'
	// or '#'; a persisted bad id would fail every (boot-time, fatal) Reproject.
	for _, bad := range []string{"bad id", "skill:x", "skill#x"} {
		if err := s.Create(ctx, Skill{SkillID: bad, Name: "x"}); err == nil {
			t.Fatalf("Create(%q) returned nil error", bad)
		}
	}
	after, _ := s.List(ctx, "mock-corp-001")
	if len(after) != len(before) {
		t.Fatalf("malformed skill persisted: skills %d → %d", len(before), len(after))
	}
	// A clean id still succeeds.
	if err := s.Create(ctx, Skill{TenantID: "mock-corp-001", SkillID: "returns360", Name: "退货360"}); err != nil {
		t.Fatalf("valid Create errored: %v", err)
	}
	after, _ = s.List(ctx, "mock-corp-001")
	if len(after) != len(before)+1 {
		t.Fatalf("valid skill not persisted: skills %d → %d", len(before), len(after))
	}
	// CloneTemplate derives ids from a seed-controlled templateId (safe), so a
	// normal clone still works with no id guard needed there.
	if _, err := s.CloneTemplate(ctx, "mock-corp-001", "order-360"); err != nil {
		t.Fatalf("CloneTemplate errored: %v", err)
	}
}

// TestOpenFile_SeedGuardSurvivesEmptySkills proves OpenFile guards on templates,
// not skills: after an admin deletes every seeded skill, re-opening the same
// file must not re-run seed.sql (which would crash on the templates UNIQUE
// constraint) and must not resurrect the deleted skills.
func TestOpenFile_SeedGuardSurvivesEmptySkills(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "skills.db")

	s, err := OpenFile(path)
	if err != nil {
		t.Fatal(err)
	}
	// Delete both seeded skills.
	if err := s.Delete(ctx, "mock-corp-001", "order360"); err != nil {
		t.Fatal(err)
	}
	if err := s.Delete(ctx, "mock-corp-001", "customer360"); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}

	// Re-open: must NOT error (no re-seed → no UNIQUE crash) and must NOT re-seed.
	s2, err := OpenFile(path)
	if err != nil {
		t.Fatalf("re-open after emptying skills errored (re-seed crash?): %v", err)
	}
	defer s2.Close()
	skills, err := s2.List(ctx, "mock-corp-001")
	if err != nil {
		t.Fatal(err)
	}
	if len(skills) != 0 {
		t.Fatalf("skills = %d, want 0 (deleted skills must not be re-seeded)", len(skills))
	}
}
