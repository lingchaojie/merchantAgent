package authz

import (
	"context"
	"fmt"

	"github.com/merchantagent/backend/org"
	"github.com/merchantagent/backend/sync"
)

// Syncer pulls an org snapshot from an IdP adapter and reconciles it into the
// OpenFGA store. This is the "免全量导入、复用既有角色" core: the enterprise
// authorizes, we read its existing org, and permissions are seeded automatically.
type Syncer struct {
	store *Store
	idp   org.Adapter
	rules []sync.RoleRule
}

func NewSyncer(store *Store, idp org.Adapter, rules []sync.RoleRule) *Syncer {
	if rules == nil {
		rules = sync.DefaultRoleRules
	}
	return &Syncer{store: store, idp: idp, rules: rules}
}

// Seed does a full sync into a FRESH store (current tuple state assumed empty),
// which is exactly the Phase 0 path: authorize → seed. It fetches the snapshot,
// translates to desired tuples, and applies them.
//
// NOTE (Phase 0 boundary): incremental reconciliation against an already-seeded
// store needs a Read of current tuples to compute deletes; that is a P0-follow-up.
// Seed here uses Reconcile(nil, desired) so it is correct for a fresh store and
// idempotent per run.
func (s *Syncer) Seed(ctx context.Context, tenantID string) (sync.Diff, error) {
	snap, err := s.idp.FetchSnapshot(ctx, tenantID)
	if err != nil {
		return sync.Diff{}, fmt.Errorf("fetch snapshot: %w", err)
	}
	desired := sync.SnapshotToTuples(snap, s.rules)
	diff := sync.Reconcile(nil, desired)
	if err := s.store.ApplyDiff(ctx, diff); err != nil {
		return sync.Diff{}, err
	}
	return diff, nil
}
