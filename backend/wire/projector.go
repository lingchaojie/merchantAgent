package wire

import (
	"context"
	"fmt"
	"sort"
	stdsync "sync"

	"github.com/merchantagent/backend/authz"
	"github.com/merchantagent/backend/config"
	"github.com/merchantagent/backend/org"
	"github.com/merchantagent/backend/skill"
	"github.com/merchantagent/backend/sync"
)

// Projector is M6's single projection engine (design §3): it rebuilds the full
// desired tuple set from every source of truth (org snapshot + DB-driven rules,
// skills, domains/grants, plus non-config demo fixtures), reads current OpenFGA
// tuples, and applies the differential reconcile (incl. deletes). Used by both
// Assemble (startup seed) and every admin write (live re-projection). This is
// where the P0 "incremental reconcile" debt (authz.Syncer.Seed) is repaid.
type Projector struct {
	store  *authz.Store
	idp    org.Adapter
	cfg    *config.Store
	sk     *skill.Store
	tenant string
	mu     stdsync.Mutex // serialize Reproject; the Projector is OpenFGA's sole writer, so ReadTuples always reflects the last ApplyDiff
}

func NewProjector(store *authz.Store, idp org.Adapter, cfg *config.Store, sk *skill.Store, tenant string) *Projector {
	return &Projector{store: store, idp: idp, cfg: cfg, sk: sk, tenant: tenant}
}

// desired computes the full desired tuple set for the tenant (pure w.r.t. its
// inputs; reads DB + IdP but not OpenFGA).
func (p *Projector) desired(ctx context.Context) ([]sync.Tuple, error) {
	snap, err := p.idp.FetchSnapshot(ctx, p.tenant)
	if err != nil {
		return nil, fmt.Errorf("snapshot: %w", err)
	}
	rules, err := p.cfg.Rules(ctx)
	if err != nil {
		return nil, err
	}
	orgT := sync.SnapshotToTuples(snap, config.LoadRules(rules))

	skills, err := p.sk.List(ctx, p.tenant)
	if err != nil {
		return nil, err
	}
	skT := skill.Tuples(skills, p.tenant)

	roles, err := p.cfg.Roles(ctx)
	if err != nil {
		return nil, err
	}
	domains, err := p.cfg.Domains(ctx)
	if err != nil {
		return nil, err
	}
	grants, err := p.cfg.Grants(ctx)
	if err != nil {
		return nil, err
	}
	cfgT := config.Tuples(roles, domains, grants, p.tenant)

	all := append(orgT, skT...)
	all = append(all, cfgT...)
	all = append(all, demoFixtures(p.tenant)...)
	return dedupSort(all), nil
}

// Reproject rebuilds desired, reads current, and applies the diff (incl deletes).
// Serialized so concurrent admin writes can't race the reconcile.
func (p *Projector) Reproject(ctx context.Context) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	desired, err := p.desired(ctx)
	if err != nil {
		return err
	}
	current, err := p.store.ReadTuples(ctx)
	if err != nil {
		return err
	}
	return p.store.ApplyDiff(ctx, sync.Reconcile(current, desired))
}

// demoFixtures are the non-config-derived tuples the demo scenario needs:
// business-record ownership and operation. Cost-domain viewers now come from the
// config domain_grants table, so they are NOT here (avoids double source).
func demoFixtures(tenant string) []sync.Tuple {
	o := func(s string) string { return tenant + "/" + s }
	return []sync.Tuple{
		{User: "user:u_sales1", Relation: "owner", Object: "business_record:" + o("order/SO-1001")},
		{User: "department:" + o("d_sales"), Relation: "owner_dept", Object: "business_record:" + o("order/SO-1001")},
		{User: "department:" + o("d_prod") + "#member", Relation: "operator", Object: "business_record:" + o("order/SO-1001")},
		{User: "user:u_sales1", Relation: "owner", Object: "business_record:" + o("order/SO-1002")},
		{User: "department:" + o("d_sales"), Relation: "owner_dept", Object: "business_record:" + o("order/SO-1002")},
		{User: "department:" + o("d_sales"), Relation: "owner_dept", Object: "business_record:" + o("order/SO-1003")},
	}
}

func dedupSort(ts []sync.Tuple) []sync.Tuple {
	seen := map[string]bool{}
	out := ts[:0]
	for _, t := range ts {
		if k := t.String(); !seen[k] {
			seen[k] = true
			out = append(out, t)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].String() < out[j].String() })
	return out
}
