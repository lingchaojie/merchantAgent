// Package wire is the composition root: it assembles connectors + authz + skill
// registry + provider into the LLM agent, and adapts the skill registry to the
// runtime's SkillResolver (design §4). Keeping this here means low-level packages
// (authz, skill, runtime) don't depend on each other's concretions.
package wire

import (
	"context"
	"sort"
	"strings"

	"github.com/merchantagent/backend/org"
	"github.com/merchantagent/backend/runtime"
	"github.com/merchantagent/backend/skill"
)

// SkillLister is the OpenFGA surface the resolver needs (authz.Store satisfies
// it). ListObjects(user, "usable_by", "skill") returns the skill object ids a
// principal may use — resolved THROUGH role#assignee by OpenFGA. This is the
// real capability pre-filter (design §4.1).
type SkillLister interface {
	ListObjects(ctx context.Context, user, relation, typ string) ([]string, error)
}

// RoleIDs resolves the caller's current tenant roles once per turn. OpenFGA
// returns fully-qualified objects; only this resolver's tenant namespace is
// accepted before ids are sorted for deterministic invocation metadata.
func (r *Resolver) RoleIDs(ctx context.Context, p org.Principal) ([]string, error) {
	objects, err := r.lister.ListObjects(ctx, "user:"+p.UserID, "assignee", "role")
	if err != nil {
		return nil, err
	}
	prefix := "role:" + r.tenant + "/"
	roles := make([]string, 0, len(objects))
	for _, object := range objects {
		if strings.HasPrefix(object, prefix) {
			roles = append(roles, strings.TrimPrefix(object, prefix))
		}
	}
	sort.Strings(roles)
	return roles, nil
}

// Resolver implements runtime.SkillResolver by intersecting the OpenFGA
// usable_by set with the tenant's skill registry rows.
type Resolver struct {
	lister SkillLister
	store  *skill.Store
	tenant string
}

func NewResolver(l SkillLister, s *skill.Store, tenant string) *Resolver {
	return &Resolver{lister: l, store: s, tenant: tenant}
}

// UsableSkills returns the SkillInfos a principal may use: registry rows whose
// skill id appears in the OpenFGA usable_by ListObjects result.
func (r *Resolver) UsableSkills(ctx context.Context, p org.Principal) ([]runtime.SkillInfo, error) {
	objs, err := r.lister.ListObjects(ctx, "user:"+p.UserID, "usable_by", "skill")
	if err != nil {
		return nil, err
	}
	allowed := map[string]bool{}
	for _, o := range objs {
		allowed[skillIDFromObject(o)] = true
	}
	rows, err := r.store.List(ctx, r.tenant)
	if err != nil {
		return nil, err
	}
	var out []runtime.SkillInfo
	for _, sk := range rows {
		if !allowed[sk.SkillID] {
			continue
		}
		out = append(out, runtime.SkillInfo{
			ID: sk.SkillID, Name: sk.Name, Description: sk.Description,
			PlaybookMD: sk.PlaybookMD, AllowedTools: sk.AllowedTools, DataDomains: sk.DataDomains,
		})
	}
	return out, nil
}

// skillIDFromObject turns "skill:<tenant>/<id>" into "<id>".
func skillIDFromObject(obj string) string {
	s := strings.TrimPrefix(obj, "skill:")
	if i := strings.IndexByte(s, '/'); i >= 0 {
		return s[i+1:]
	}
	return s
}
