package wire

import (
	"context"
	"fmt"

	"github.com/merchantagent/backend/authz"
	"github.com/merchantagent/backend/connector"
	"github.com/merchantagent/backend/connector/crm"
	"github.com/merchantagent/backend/connector/erp"
	"github.com/merchantagent/backend/connector/localfile"
	"github.com/merchantagent/backend/org"
	"github.com/merchantagent/backend/provider"
	"github.com/merchantagent/backend/runtime"
	"github.com/merchantagent/backend/skill"
	"github.com/merchantagent/backend/sync"
)

// Config drives Assemble.
type Config struct {
	OpenFGAURL string
	Tenant     string
	OrgFile    string
	Provider   provider.Provider // the LLM seam
}

// Assembled is the wired composition root: the LLM agent plus the pieces the
// server needs (idp for login, per-tenant audit for /audit) and Close for teardown.
type Assembled struct {
	Agent *runtime.LLMAgent
	IDP   *org.MockAdapter
	Audit *runtime.TenantAudit
	Store *authz.Store

	erp *erp.ERP
	crm *crm.CRM
	sk  *skill.Store
}

// Assemble builds everything: OpenFGA store (org seeded + demo scenario + skill
// tuples), ERP/CRM connectors, skill registry, resolver, and the LLM agent.
func Assemble(ctx context.Context, cfg Config) (*Assembled, error) {
	store, err := authz.NewStore(ctx, cfg.OpenFGAURL, "agentd")
	if err != nil {
		return nil, fmt.Errorf("openfga store (is it up?): %w", err)
	}
	idp, err := org.NewMockAdapterFromFile(cfg.OrgFile)
	if err != nil {
		return nil, err
	}
	if _, err := authz.NewSyncer(store, idp, nil).Seed(ctx, cfg.Tenant); err != nil {
		return nil, fmt.Errorf("seed org: %w", err)
	}

	e, err := erp.Open()
	if err != nil {
		return nil, err
	}
	c, err := crm.Open()
	if err != nil {
		e.Close()
		return nil, err
	}
	sk, err := skill.Open()
	if err != nil {
		e.Close()
		c.Close()
		return nil, err
	}

	// Demo scenario + skill tuples so the mock server has something to answer.
	if err := seedScenario(ctx, store, sk, cfg.Tenant); err != nil {
		e.Close()
		c.Close()
		sk.Close()
		return nil, err
	}

	audit := runtime.NewTenantAudit()
	resolver := NewResolver(store, sk, cfg.Tenant)
	conns := []connector.Connector{e, c}
	agent := runtime.NewLLMAgent(cfg.Provider, conns, runtime.NewGuard(store, cfg.Tenant), resolver, audit, cfg.Tenant).
		WithAmbient(localfile.Tools()...) // local files via the desktop reverse bridge

	return &Assembled{Agent: agent, IDP: idp, Audit: audit, Store: store, erp: e, crm: c, sk: sk}, nil
}

// Close releases the connector databases.
func (a *Assembled) Close() {
	a.erp.Close()
	a.crm.Close()
	a.sk.Close()
}

// seedScenario writes demo order ownership + cost-domain viewers, then projects
// the skill registry into capability tuples.
func seedScenario(ctx context.Context, store *authz.Store, sk *skill.Store, tenant string) error {
	o := func(s string) string { return tenant + "/" + s }
	demo := sync.Diff{Writes: []sync.Tuple{
		{User: "user:u_sales1", Relation: "owner", Object: "order:" + o("SO-1001")},
		{User: "department:" + o("d_sales"), Relation: "owner_dept", Object: "order:" + o("SO-1001")},
		{User: "user:u_sales1", Relation: "owner", Object: "order:" + o("SO-1002")},
		{User: "department:" + o("d_sales"), Relation: "owner_dept", Object: "order:" + o("SO-1002")},
		{User: "department:" + o("d_sales"), Relation: "owner_dept", Object: "order:" + o("SO-1003")},
		{User: "user:u_fin", Relation: "viewer", Object: "data_domain:" + o("cost")},
		{User: "department:" + o("d_sales") + "#manager", Relation: "viewer", Object: "data_domain:" + o("cost")},
		{User: "department:" + o("d_root") + "#manager", Relation: "viewer", Object: "data_domain:" + o("cost")},
	}}
	if err := store.ApplyDiff(ctx, demo); err != nil {
		return fmt.Errorf("seed demo scenario: %w", err)
	}
	skills, err := sk.List(ctx, tenant)
	if err != nil {
		return err
	}
	if err := store.ApplyDiff(ctx, sync.Diff{Writes: skill.Tuples(skills, tenant)}); err != nil {
		return fmt.Errorf("seed skill tuples: %w", err)
	}
	return nil
}
