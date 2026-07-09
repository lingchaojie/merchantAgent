package skill

import (
	"fmt"
	"sort"

	"github.com/merchantagent/backend/sync"
)

// Tuples projects skills into the OpenFGA tuples that back capability authz
// (design §3.4). For each skill: it belongs to the tenant, it EXPOSES its tools
// (tool.exposed_by), and each assigned role may USE it (skill.usable_by). Tool
// reachability (tool.invoker = usable_by from exposed_by) then falls out of the
// model. Pure + sorted → diffable and idempotent, like sync.SnapshotToTuples.
//
// NOTE: DataDomains are intentionally NOT projected — they are advisory (prompt
// hint + admin warning), never a grant. Data-domain viewers are seeded
// separately (the independent second axis), keeping capability ≠ data (§3.3).
func Tuples(skills []Skill, tenantID string) []sync.Tuple {
	t := tenantID
	var out []sync.Tuple
	for _, sk := range skills {
		skObj := fmt.Sprintf("skill:%s/%s", t, sk.SkillID)
		out = append(out, sync.Tuple{User: "tenant:" + t, Relation: "tenant", Object: skObj})
		for _, tool := range sk.AllowedTools {
			toolObj := fmt.Sprintf("tool:%s/%s", t, tool)
			out = append(out,
				sync.Tuple{User: skObj, Relation: "exposed_by", Object: toolObj},
				sync.Tuple{User: "tenant:" + t, Relation: "tenant", Object: toolObj},
			)
		}
		for _, r := range sk.Roles {
			roleAssignee := fmt.Sprintf("role:%s/%s#assignee", t, r)
			out = append(out, sync.Tuple{User: roleAssignee, Relation: "usable_by", Object: skObj})
		}
	}
	// De-dup (a tool exposed by two skills would emit its tenant tuple twice).
	seen := map[string]bool{}
	uniq := out[:0]
	for _, tp := range out {
		if k := tp.String(); !seen[k] {
			seen[k] = true
			uniq = append(uniq, tp)
		}
	}
	sort.Slice(uniq, func(i, j int) bool { return uniq[i].String() < uniq[j].String() })
	return uniq
}
