package wire

import (
	"context"
	"testing"

	"github.com/merchantagent/backend/org"
	"github.com/merchantagent/backend/skill"
)

// fakeLister returns a fixed usable_by set (no OpenFGA needed).
type fakeLister struct{ objs []string }

func (f fakeLister) ListObjects(_ context.Context, _, _, _ string) ([]string, error) {
	return f.objs, nil
}

func TestResolver_IntersectsRegistryWithUsableBy(t *testing.T) {
	store, err := skill.Open()
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	// User may use only order360 (per OpenFGA); customer360 is filtered out even
	// though it exists in the registry.
	r := NewResolver(fakeLister{objs: []string{"skill:mock-corp-001/order360"}}, store, "mock-corp-001")
	got, err := r.UsableSkills(context.Background(), org.Principal{TenantID: "mock-corp-001", UserID: "u_sales1"})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].ID != "order360" {
		t.Fatalf("usable = %+v, want [order360]", got)
	}
	if len(got[0].AllowedTools) != 3 {
		t.Errorf("order360 tools = %v", got[0].AllowedTools)
	}
}

func TestResolver_EmptyWhenNoUsable(t *testing.T) {
	store, _ := skill.Open()
	defer store.Close()
	r := NewResolver(fakeLister{objs: nil}, store, "mock-corp-001")
	got, err := r.UsableSkills(context.Background(), org.Principal{TenantID: "mock-corp-001", UserID: "u_plan"})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Errorf("planner should have 0 usable skills, got %+v", got)
	}
}

func TestSkillIDFromObject(t *testing.T) {
	if got := skillIDFromObject("skill:mock-corp-001/order360"); got != "order360" {
		t.Errorf("got %q", got)
	}
}
