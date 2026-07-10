package config

import (
	"sort"
	"testing"
)

func TestTuples_Projection(t *testing.T) {
	roles := []Role{{RoleID: "sales", Label: "销售"}, {RoleID: "finance", Label: "财务"}}
	domains := []Domain{{DomainID: "cost", Label: "成本"}}
	grants := []Grant{
		{DomainID: "cost", Subject: "user:u_fin"},
		{DomainID: "cost", Subject: "role:mock-corp-001/finance#assignee"},
	}
	got := Tuples(roles, domains, grants, "mock-corp-001")
	set := map[string]bool{}
	for _, tp := range got {
		set[tp.String()] = true
	}
	want := []string{
		"tenant:mock-corp-001|tenant|role:mock-corp-001/sales",
		"tenant:mock-corp-001|tenant|role:mock-corp-001/finance",
		"tenant:mock-corp-001|tenant|data_domain:mock-corp-001/cost",
		"user:u_fin|viewer|data_domain:mock-corp-001/cost",
		"role:mock-corp-001/finance#assignee|viewer|data_domain:mock-corp-001/cost",
	}
	for _, w := range want {
		if !set[w] {
			t.Errorf("missing tuple: %s", w)
		}
	}
	if len(got) != len(want) {
		t.Errorf("got %d tuples, want %d: %v", len(got), len(want), got)
	}
	// Output must be sorted (diffable).
	if !sort.SliceIsSorted(got, func(i, j int) bool { return got[i].String() < got[j].String() }) {
		t.Error("Tuples output not sorted")
	}
}

func TestLoadRules(t *testing.T) {
	rules := []Rule{{Match: []string{"经理"}, RoleID: "manager_tier"}}
	sr := LoadRules(rules)
	if len(sr) != 1 || sr[0].Role != "manager_tier" || sr[0].Match[0] != "经理" {
		t.Fatalf("LoadRules = %+v", sr)
	}
}
