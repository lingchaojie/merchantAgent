package sync

import (
	"testing"

	"github.com/merchantagent/backend/org"
)

func TestRoleForPosition(t *testing.T) {
	cases := map[string]string{
		"销售部经理": "manager_tier", // 经理 wins (rule order)
		"销售":    "sales",
		"生产计划员": "planner",
		"IQC质检": "qc",
		"会计":    "finance",
		"":      "staff", // empty → least privilege
		"神秘岗位":  "staff", // unmatched → least privilege
	}
	for pos, want := range cases {
		if got := RoleForPosition(pos, DefaultRoleRules); got != want {
			t.Errorf("RoleForPosition(%q) = %q, want %q", pos, got, want)
		}
	}
}

func sampleSnapshot() org.Snapshot {
	return org.Snapshot{
		TenantID: "t1",
		Admins:   []string{"boss"},
		Departments: []org.Dept{
			{DeptID: "root", Name: "co"},
			{DeptID: "sales", Name: "sales", ParentID: "root"},
		},
		Users: []org.User{
			{UserID: "boss", Status: org.StatusActive, DeptIDs: []string{"root"}, LeaderInDeptIDs: []string{"root"}, PositionText: "总经理"},
			{UserID: "s1", Status: org.StatusActive, DeptIDs: []string{"sales"}, PositionText: "销售"},
			{UserID: "gone", Status: org.StatusQuit, DeptIDs: []string{"sales"}, PositionText: "销售"},
		},
	}
}

func TestSnapshotToTuples_Membership(t *testing.T) {
	ts := SnapshotToTuples(sampleSnapshot(), DefaultRoleRules)
	has := func(u, r, o string) bool {
		for _, x := range ts {
			if x.User == u && x.Relation == r && x.Object == o {
				return true
			}
		}
		return false
	}
	if !has("user:boss", "admin", "tenant:t1") {
		t.Error("missing admin tuple")
	}
	if !has("user:boss", "leader", "department:t1/root") {
		t.Error("missing leader tuple (drives manager inheritance)")
	}
	if !has("department:t1/root", "parent", "department:t1/sales") {
		t.Error("missing dept parent tuple")
	}
	// parent is a dept→dept relation; the tenant must never be a parent.
	if has("tenant:t1", "parent", "department:t1/sales") {
		t.Error("tenant wrongly emitted as department parent")
	}
	// Quit user must not appear as a member anywhere.
	if has("user:gone", "member", "tenant:t1") || has("user:gone", "direct_member", "department:t1/sales") {
		t.Error("quit user leaked into tuples")
	}
}

func TestReconcile_Idempotent(t *testing.T) {
	desired := SnapshotToTuples(sampleSnapshot(), DefaultRoleRules)
	// current == desired → empty diff (idempotent replay).
	if d := Reconcile(desired, desired); !d.Empty() {
		t.Errorf("expected empty diff, got %d writes / %d deletes", len(d.Writes), len(d.Deletes))
	}
	// From empty → all writes, no deletes.
	d := Reconcile(nil, desired)
	if len(d.Writes) != len(desired) || len(d.Deletes) != 0 {
		t.Errorf("seed diff wrong: %d writes (want %d), %d deletes (want 0)", len(d.Writes), len(desired), len(d.Deletes))
	}
	// Dropping a user from desired → that user's tuples become deletes.
	d2 := Reconcile(desired, nil)
	if len(d2.Writes) != 0 || len(d2.Deletes) != len(desired) {
		t.Errorf("teardown diff wrong: %d writes (want 0), %d deletes (want %d)", len(d2.Writes), len(d2.Deletes), len(desired))
	}
}
