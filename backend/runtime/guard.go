package runtime

import (
	"context"
	"fmt"

	"github.com/merchantagent/backend/connector"
	"github.com/merchantagent/backend/org"
)

// Checker is the minimal authz surface the guard needs. authz.Store satisfies
// it; unit tests use a fake. Keeps runtime decoupled from OpenFGA.
type Checker interface {
	Check(ctx context.Context, user, relation, object string) (bool, error)
}

// Decision is the guard's verdict for a tool invocation.
type Decision struct {
	Allowed bool
	Reason  string
}

// Guard enforces research/11 §6.1: a tool call is allowed only if the caller
// passes BOTH the record-level check (can view the specific resource) AND the
// data-domain check (can view the sensitive domain the tool touches). This is
// the structural cap that keeps the agent ≤ the user's permissions.
type Guard struct {
	chk    Checker
	tenant string
}

func NewGuard(chk Checker, tenant string) *Guard { return &Guard{chk: chk, tenant: tenant} }

func (g *Guard) obj(typ, id string) string { return fmt.Sprintf("%s:%s/%s", typ, g.tenant, id) }

// CanViewDomain reports whether a user may view a sensitive data domain. Used to
// build the prompt's boundary note (design §4.2 layer 5) so the model decides
// deterministically instead of guessing from the role name — advisory only; the
// authoritative check is still Authorize on every tool call.
func (g *Guard) CanViewDomain(ctx context.Context, userID, domain string) (bool, error) {
	return g.chk.Check(ctx, "user:"+userID, "viewer", g.obj("data_domain", domain))
}

// Authorize evaluates a tool spec + args for a principal.
func (g *Guard) Authorize(ctx context.Context, p org.Principal, spec connector.ToolSpec, args map[string]any) (Decision, error) {
	user := "user:" + p.UserID

	// Capability authz (design §3.4): can the user invoke this tool at all? True
	// iff they can USE some skill that exposes it (tool.invoker = usable_by from
	// exposed_by). This is the skill-mediated capability wall, checked BEFORE any
	// data authz so a role without the skill is denied up front.
	okCap, err := g.chk.Check(ctx, user, "invoker", g.obj("tool", spec.Name))
	if err != nil {
		return Decision{}, err
	}
	if !okCap {
		return Decision{false, "no skill grants tool " + spec.Name}, nil
	}

	// Record-level data authz: does the user have the relation declared by the
	// tool? Existing tools default to viewer; writes can require operator.
	if spec.ResourceType != "" && spec.ResourceArg != "" {
		id, ok := args[spec.ResourceArg].(string)
		if !ok || id == "" {
			return Decision{false, "missing resource id arg " + spec.ResourceArg}, nil
		}
		if spec.ResourceKind != "" {
			id = spec.ResourceKind + "/" + id
		}
		relation := spec.ResourceRelation
		if relation == "" {
			relation = "viewer"
		}
		ok, err := g.chk.Check(ctx, user, relation, g.obj(spec.ResourceType, id))
		if err != nil {
			return Decision{}, err
		}
		if !ok {
			return Decision{false, fmt.Sprintf("no %s access to %s %s", relation, spec.ResourceType, id)}, nil
		}
	}

	// Sensitivity authz: can the user view the data domain the tool touches?
	if spec.DataDomain != "" {
		ok, err := g.chk.Check(ctx, user, "viewer", g.obj("data_domain", spec.DataDomain))
		if err != nil {
			return Decision{}, err
		}
		if !ok {
			return Decision{false, "no access to data domain " + spec.DataDomain}, nil
		}
	}

	return Decision{true, "authorized"}, nil
}
