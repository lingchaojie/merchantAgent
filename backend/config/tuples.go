package config

import (
	"fmt"
	"sort"

	"github.com/merchantagent/backend/sync"
)

// Tuples projects config rows into OpenFGA tuples (design §2). Roles and data
// domains become objects (tenant edge); grants become data_domain viewer edges.
// Pure + sorted → diffable/idempotent, like sync.SnapshotToTuples & skill.Tuples.
// NOTE: role_rules are NOT projected here — they feed sync.SnapshotToTuples via
// LoadRules to derive user→role assignments.
func Tuples(roles []Role, domains []Domain, grants []Grant, tenant string) []sync.Tuple {
	var out []sync.Tuple
	ten := "tenant:" + tenant
	for _, r := range roles {
		out = append(out, sync.Tuple{User: ten, Relation: "tenant", Object: fmt.Sprintf("role:%s/%s", tenant, r.RoleID)})
	}
	for _, d := range domains {
		out = append(out, sync.Tuple{User: ten, Relation: "tenant", Object: fmt.Sprintf("data_domain:%s/%s", tenant, d.DomainID)})
	}
	for _, g := range grants {
		out = append(out, sync.Tuple{User: g.Subject, Relation: "viewer", Object: fmt.Sprintf("data_domain:%s/%s", tenant, g.DomainID)})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].String() < out[j].String() })
	return out
}

// LoadRules adapts config Rules into sync.RoleRule (fed to SnapshotToTuples so
// admin-edited mappings drive user→role derivation).
func LoadRules(rules []Rule) []sync.RoleRule {
	out := make([]sync.RoleRule, 0, len(rules))
	for _, r := range rules {
		out = append(out, sync.RoleRule{Match: r.Match, Role: r.RoleID})
	}
	return out
}
