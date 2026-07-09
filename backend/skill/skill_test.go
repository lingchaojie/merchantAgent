package skill

import (
	"context"
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
