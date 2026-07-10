package wire

import (
	"context"
	"fmt"

	"github.com/merchantagent/backend/authz"
	"github.com/merchantagent/backend/config"
	"github.com/merchantagent/backend/connector"
	"github.com/merchantagent/backend/connector/crm"
	"github.com/merchantagent/backend/connector/erp"
	"github.com/merchantagent/backend/connector/localfile"
	"github.com/merchantagent/backend/org"
	"github.com/merchantagent/backend/provider"
	"github.com/merchantagent/backend/runtime"
	"github.com/merchantagent/backend/skill"
)

// Config drives Assemble.
type Config struct {
	OpenFGAURL string
	Tenant     string
	OrgFile    string
	ConfigDB   string            // config store file path ("" → in-memory)
	SkillDB    string            // skill store file path ("" → in-memory)
	Provider   provider.Provider // the LLM seam
}

// Assembled is the wired composition root: the LLM agent plus the pieces the
// server needs (idp for login, per-tenant audit for /audit) and Close for teardown.
type Assembled struct {
	Agent     *runtime.LLMAgent
	IDP       *org.MockAdapter
	Audit     *runtime.TenantAudit
	Store     *authz.Store
	Projector *Projector
	Cfg       *config.Store
	Sk        *skill.Store
	Conns     []connector.Connector // ERP + CRM, for the tool catalog

	erp *erp.ERP
	crm *crm.CRM
}

// Assemble builds everything: OpenFGA store, ERP/CRM connectors, skill + config
// registries, and the LLM agent. A single Projector.Reproject seeds OpenFGA from
// every source of truth (org snapshot + rules, skills, config roles/domains/
// grants, demo fixtures) via a differential reconcile — the sole projection path.
func Assemble(ctx context.Context, cfg Config) (*Assembled, error) {
	store, err := authz.NewStore(ctx, cfg.OpenFGAURL, "agentd")
	if err != nil {
		return nil, fmt.Errorf("openfga store (is it up?): %w", err)
	}
	idp, err := org.NewMockAdapterFromFile(cfg.OrgFile)
	if err != nil {
		return nil, err
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
	sk, err := openSkill(cfg.SkillDB)
	if err != nil {
		e.Close()
		c.Close()
		return nil, err
	}
	cf, err := openConfig(cfg.ConfigDB, cfg.Tenant)
	if err != nil {
		e.Close()
		c.Close()
		sk.Close()
		return nil, err
	}

	projector := NewProjector(store, idp, cf, sk, cfg.Tenant)
	if err := projector.Reproject(ctx); err != nil {
		e.Close()
		c.Close()
		sk.Close()
		cf.Close()
		return nil, fmt.Errorf("initial projection: %w", err)
	}

	audit := runtime.NewTenantAudit()
	resolver := NewResolver(store, sk, cfg.Tenant)
	conns := []connector.Connector{e, c}
	agent := runtime.NewLLMAgent(cfg.Provider, conns, runtime.NewGuard(store, cfg.Tenant), resolver, audit, cfg.Tenant).
		WithAmbient(localfile.Tools()...) // local files via the desktop reverse bridge

	return &Assembled{Agent: agent, IDP: idp, Audit: audit, Store: store, Projector: projector, Cfg: cf, Sk: sk, Conns: conns, erp: e, crm: c}, nil
}

// Close releases the connector, skill, and config stores.
func (a *Assembled) Close() {
	a.erp.Close()
	a.crm.Close()
	a.Sk.Close()
	a.Cfg.Close()
}

func openSkill(path string) (*skill.Store, error) {
	if path == "" {
		return skill.Open()
	}
	return skill.OpenFile(path)
}

func openConfig(path, tenant string) (*config.Store, error) {
	if path == "" {
		return config.Open(tenant)
	}
	return config.OpenFile(path, tenant)
}
