package sync

import (
	"fmt"
	"sort"

	"github.com/merchantagent/backend/org"
)

// Tuple is an OpenFGA relationship tuple: <User> is related to <Object> via <Relation>.
// User may itself be a userset like "department:t/d#member".
type Tuple struct {
	User     string
	Relation string
	Object   string
}

func (t Tuple) String() string { return t.User + "|" + t.Relation + "|" + t.Object }

// obj helpers build namespaced object ids. Everything is scoped by tenant so a
// Check can never cross tenants.
func tenantObj(t string) string     { return "tenant:" + t }
func deptObj(t, d string) string    { return fmt.Sprintf("department:%s/%s", t, d) }
func roleObj(t, r string) string    { return fmt.Sprintf("role:%s/%s", t, r) }
func userSubj(u string) string      { return "user:" + u }
func deptMember(t, d string) string { return deptObj(t, d) + "#member" }

// SnapshotToTuples produces the full desired tuple set for a snapshot. Pure and
// deterministic (sorted output) so it can be diffed and re-run idempotently.
func SnapshotToTuples(s org.Snapshot, rules []RoleRule) []Tuple {
	var out []Tuple
	t := s.TenantID

	// Admins + active members of the tenant.
	for _, a := range s.Admins {
		out = append(out, Tuple{userSubj(a), "admin", tenantObj(t)})
	}
	for _, u := range s.Users {
		if u.Status != org.StatusActive {
			continue
		}
		out = append(out, Tuple{userSubj(u.UserID), "member", tenantObj(t)})
	}

	// Department hierarchy + tenant link.
	for _, d := range s.Departments {
		out = append(out, Tuple{tenantObj(t), "tenant", deptObj(t, d.DeptID)})
		if d.ParentID != "" {
			out = append(out, Tuple{deptObj(t, d.ParentID), "parent", deptObj(t, d.DeptID)})
		}
	}

	// Department membership, leadership, and role assignment per active user.
	roleSet := map[string]bool{}
	for _, u := range s.Users {
		if u.Status != org.StatusActive {
			continue
		}
		for _, d := range u.DeptIDs {
			out = append(out, Tuple{userSubj(u.UserID), "direct_member", deptObj(t, d)})
		}
		for _, d := range u.LeaderInDeptIDs {
			out = append(out, Tuple{userSubj(u.UserID), "leader", deptObj(t, d)})
		}
		for _, r := range RolesForUser(u, rules) {
			roleSet[r] = true
			out = append(out, Tuple{userSubj(u.UserID), "assignee", roleObj(t, r)})
		}
	}
	for r := range roleSet {
		out = append(out, Tuple{tenantObj(t), "tenant", roleObj(t, r)})
	}

	sort.Slice(out, func(i, j int) bool { return out[i].String() < out[j].String() })
	return out
}
