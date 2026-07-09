// Package sync translates a normalized org.Snapshot into OpenFGA tuples and
// reconciles them against what already exists. All logic here is pure and
// hermetically testable (no OpenFGA, no network).
package sync

import (
	"strings"

	"github.com/merchantagent/backend/org"
)

// RoleRule maps a free-text position to a platform role. Rules are evaluated in
// order; the first whose Match substring is contained in the position wins.
// This is only a SUGGESTION layer — structured signals (dept, leader, tags) are
// authoritative; unmatched positions fall back to Default (fail-closed: staff).
type RoleRule struct {
	Match []string
	Role  string
}

// DefaultRoleRules is a reasonable starter set for trade/manufacturing SMEs.
// Managers are detected here, but note: is_leader_in_dept already grants the
// `manager` relation structurally, so this mainly assigns functional roles.
var DefaultRoleRules = []RoleRule{
	{Match: []string{"经理", "主管", "总监", "厂长", "负责人", "总经理"}, Role: "manager_tier"},
	{Match: []string{"销售", "业务", "外贸", "BD"}, Role: "sales"},
	{Match: []string{"采购"}, Role: "purchasing"},
	{Match: []string{"计划", "PMC", "排产"}, Role: "planner"},
	{Match: []string{"质检", "QC", "IQC", "IPQC", "OQC", "品控"}, Role: "qc"},
	{Match: []string{"财务", "会计", "出纳"}, Role: "finance"},
}

const DefaultRole = "staff"

// RoleForPosition returns the platform role for a free-text position. Empty or
// unmatched positions return DefaultRole (least privilege).
func RoleForPosition(position string, rules []RoleRule) string {
	p := strings.TrimSpace(position)
	if p == "" {
		return DefaultRole
	}
	for _, r := range rules {
		for _, m := range r.Match {
			if strings.Contains(p, m) {
				return r.Role
			}
		}
	}
	return DefaultRole
}

// RolesForUser derives the set of role ids for a user from position text plus
// tags. Deterministic and de-duplicated. Dept/leader relations are modeled
// separately (as department#member / department#leader), not as roles here.
func RolesForUser(u org.User, rules []RoleRule) []string {
	seen := map[string]bool{}
	var roles []string
	add := func(r string) {
		if r != "" && !seen[r] {
			seen[r] = true
			roles = append(roles, r)
		}
	}
	add(RoleForPosition(u.PositionText, rules))
	for _, tag := range u.TagIDs {
		// Use '-' not ':' — the colon is OpenFGA's type separator and is illegal
		// inside an object id (would break role:<tenant>/<roleid>).
		add("tag-" + tag) // tag-derived role group
	}
	return roles
}
