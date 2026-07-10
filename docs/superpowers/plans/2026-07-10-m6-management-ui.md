# M6 Management UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the tenant-admin management UI (roles / role-mapping / skills / assignments / data-domains) with a persistent config DB projected into OpenFGA via one differential-reconcile engine.

**Architecture:** New `backend/config` package is the source of truth (file SQLite: roles, role_rules, data_domains, domain_grants). A new `wire.Projector` rebuilds the full desired tuple set from org snapshot + rules + skills + grants + demo fixtures, reads current OpenFGA tuples (`authz.ReadTuples`), and applies `sync.Reconcile` (incl. deletes) — used by both startup and every admin write. Admin-guarded `/admin/*` REST endpoints. Desktop `AdminView` reaches agentd through one generic `admin` IPC channel that injects the caller's `X-User-Id`.

**Tech Stack:** Go 1.25 (`net/http` 1.22 routing, `modernc.org/sqlite`, `openfga/go-sdk` v0.8.2), Electron + React + TypeScript (electron-vite, vitest).

**Environment note:** Go runs in WSL. Run all Go commands via:
`wsl -e bash -lc 'cd /mnt/d/merchantAgent/backend && export GOPROXY=https://goproxy.cn,direct GOSUMDB=off PATH="$PATH:$HOME/.local/bin" && <cmd>'`
OpenFGA must be up for gated tests: `cd backend && docker compose up -d` (host `:18080`).
Desktop commands run in Windows: `cd desktop && <cmd>`.

---

## Phase M6a — Config DB foundation

### Task 1: config package skeleton + schema + seed + Open/OpenFile

**Files:**
- Create: `backend/config/schema.sql`
- Create: `backend/config/seed.sql`
- Create: `backend/config/config.go`
- Test: `backend/config/config_test.go`

- [ ] **Step 1: Write schema.sql**

```sql
-- backend/config/schema.sql
-- M6 config registry (source of truth for admin-editable authz config).
-- Runtime-editable, persisted to a file DB; the AUTHORIZATION projection of
-- these rows is turned into OpenFGA tuples by config.Tuples (same pattern as
-- org sync + skill.Tuples). Seeded once on a fresh DB; edits are never
-- clobbered (see config.go bootstrap).
CREATE TABLE IF NOT EXISTS roles (
  tenant_id   TEXT NOT NULL,
  role_id     TEXT NOT NULL,
  label       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (tenant_id, role_id)
);
CREATE TABLE IF NOT EXISTS role_rules (
  tenant_id   TEXT NOT NULL,
  ord         INTEGER NOT NULL,
  match_terms TEXT NOT NULL,   -- JSON array of substrings
  role_id     TEXT NOT NULL,
  PRIMARY KEY (tenant_id, ord)
);
CREATE TABLE IF NOT EXISTS data_domains (
  tenant_id TEXT NOT NULL,
  domain_id TEXT NOT NULL,
  label     TEXT NOT NULL,
  PRIMARY KEY (tenant_id, domain_id)
);
CREATE TABLE IF NOT EXISTS domain_grants (
  tenant_id TEXT NOT NULL,
  domain_id TEXT NOT NULL,
  subject   TEXT NOT NULL,     -- full OpenFGA subject string
  PRIMARY KEY (tenant_id, domain_id, subject)
);
```

- [ ] **Step 2: Write seed.sql** (equals today's hardcoded values → zero regression)

```sql
-- backend/config/seed.sql — mock-corp-001 starter config.
INSERT INTO roles (tenant_id, role_id, label, description) VALUES
 ('mock-corp-001','manager_tier','管理层','经理/主管/总监等'),
 ('mock-corp-001','sales','销售','销售/业务/外贸'),
 ('mock-corp-001','purchasing','采购',''),
 ('mock-corp-001','planner','计划员','PMC/排产'),
 ('mock-corp-001','qc','质检','QC/品控'),
 ('mock-corp-001','finance','财务','财务/会计/出纳'),
 ('mock-corp-001','staff','员工','默认兜底角色');

INSERT INTO role_rules (tenant_id, ord, match_terms, role_id) VALUES
 ('mock-corp-001',0,'["经理","主管","总监","厂长","负责人","总经理"]','manager_tier'),
 ('mock-corp-001',1,'["销售","业务","外贸","BD"]','sales'),
 ('mock-corp-001',2,'["采购"]','purchasing'),
 ('mock-corp-001',3,'["计划","PMC","排产"]','planner'),
 ('mock-corp-001',4,'["质检","QC","IQC","IPQC","OQC","品控"]','qc'),
 ('mock-corp-001',5,'["财务","会计","出纳"]','finance');

INSERT INTO data_domains (tenant_id, domain_id, label) VALUES
 ('mock-corp-001','cost','成本'),
 ('mock-corp-001','pricing','定价');

INSERT INTO domain_grants (tenant_id, domain_id, subject) VALUES
 ('mock-corp-001','cost','user:u_fin'),
 ('mock-corp-001','cost','department:mock-corp-001/d_sales#manager'),
 ('mock-corp-001','cost','department:mock-corp-001/d_root#manager');
```

- [ ] **Step 3: Write config.go — types + Open/OpenFile + bootstrap** (see next task steps for CRUD; this step is types + open only)

```go
// Package config is the M6 admin-editable authorization config (roles, position
// -> role rules, data domains, and data-domain grants). Rows here are a source
// of truth that wire.Projector projects into OpenFGA tuples, mirroring org sync
// and the skill registry. Persisted to a file DB so admin edits survive restart;
// seeded once on a fresh DB and never clobbered thereafter.
package config

import (
	"context"
	"database/sql"
	_ "embed"
	"encoding/json"
	"fmt"

	_ "modernc.org/sqlite"
)

//go:embed schema.sql
var schemaSQL string

//go:embed seed.sql
var seedSQL string

type Role struct {
	RoleID      string `json:"roleId"`
	Label       string `json:"label"`
	Description string `json:"description"`
}
type Rule struct {
	Match  []string `json:"match"`
	RoleID string   `json:"roleId"`
}
type Domain struct {
	DomainID string `json:"domainId"`
	Label    string `json:"label"`
}
type Grant struct {
	DomainID string `json:"domainId"`
	Subject  string `json:"subject"`
}

type Store struct {
	db     *sql.DB
	tenant string
}

// Open creates an in-memory config store (tests). Always applies schema + seed.
func Open(tenant string) (*Store, error) { return open(":memory:", tenant, true) }

// OpenFile opens/creates a file-backed config store. Seeds ONLY when the DB is
// fresh (no roles rows yet) so admin edits are never clobbered on restart.
func OpenFile(path, tenant string) (*Store, error) { return open(path, tenant, false) }

func open(dsn, tenant string, alwaysSeed bool) (*Store, error) {
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open config sqlite: %w", err)
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(schemaSQL); err != nil {
		db.Close()
		return nil, fmt.Errorf("config schema: %w", err)
	}
	s := &Store{db: db, tenant: tenant}
	seed := alwaysSeed
	if !seed {
		var n int
		if err := db.QueryRow(`SELECT COUNT(*) FROM roles WHERE tenant_id = ?`, tenant).Scan(&n); err != nil {
			db.Close()
			return nil, err
		}
		seed = n == 0
	}
	if seed {
		if _, err := db.Exec(seedSQL); err != nil {
			db.Close()
			return nil, fmt.Errorf("config seed: %w", err)
		}
	}
	return s, nil
}

func (s *Store) Close() error { return s.db.Close() }
```

- [ ] **Step 4: Write config_test.go — seeded reads (placeholder CRUD asserted in Task 2)**

```go
package config

import (
	"testing"
)

func TestOpen_Seeded(t *testing.T) {
	s, err := Open("mock-corp-001")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	var roles, rules, domains, grants int
	s.db.QueryRow(`SELECT COUNT(*) FROM roles`).Scan(&roles)
	s.db.QueryRow(`SELECT COUNT(*) FROM role_rules`).Scan(&rules)
	s.db.QueryRow(`SELECT COUNT(*) FROM data_domains`).Scan(&domains)
	s.db.QueryRow(`SELECT COUNT(*) FROM domain_grants`).Scan(&grants)
	if roles != 7 || rules != 6 || domains != 2 || grants != 3 {
		t.Fatalf("seed counts = roles %d rules %d domains %d grants %d; want 7/6/2/3", roles, rules, domains, grants)
	}
}
```

- [ ] **Step 5: Run tests — verify pass**

Run: `wsl -e bash -lc 'cd /mnt/d/merchantAgent/backend && export PATH="$PATH:$HOME/.local/bin" && go test ./config/ -run TestOpen_Seeded -v'`
Expected: PASS (seed counts 7/6/2/3).

- [ ] **Step 6: Commit**

```bash
git add backend/config/
git commit -m "feat(config): M6 config DB skeleton + schema + seed"
```

### Task 2: config CRUD + list methods

**Files:**
- Modify: `backend/config/config.go` (append methods)
- Test: `backend/config/config_test.go` (append)

- [ ] **Step 1: Write failing CRUD round-trip test**

```go
// append to config_test.go
import "context"

func TestRolesCRUD(t *testing.T) {
	ctx := context.Background()
	s, _ := Open("mock-corp-001")
	defer s.Close()

	if err := s.CreateRole(ctx, Role{RoleID: "logistics", Label: "物流", Description: "仓储物流"}); err != nil {
		t.Fatal(err)
	}
	roles, _ := s.Roles(ctx)
	if len(roles) != 8 {
		t.Fatalf("roles = %d, want 8 after create", len(roles))
	}
	if err := s.UpdateRole(ctx, "logistics", "物流部", "含快递"); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteRole(ctx, "logistics"); err != nil {
		t.Fatal(err)
	}
	roles, _ = s.Roles(ctx)
	if len(roles) != 7 {
		t.Fatalf("roles = %d, want 7 after delete", len(roles))
	}
}

func TestRulesReplaceAndDomains(t *testing.T) {
	ctx := context.Background()
	s, _ := Open("mock-corp-001")
	defer s.Close()
	// Replace rules wholesale.
	if err := s.ReplaceRules(ctx, []Rule{{Match: []string{"老板"}, RoleID: "manager_tier"}}); err != nil {
		t.Fatal(err)
	}
	rules, _ := s.Rules(ctx)
	if len(rules) != 1 || rules[0].RoleID != "manager_tier" || rules[0].Match[0] != "老板" {
		t.Fatalf("rules = %+v", rules)
	}
	// Grants add/remove.
	if err := s.AddGrant(ctx, "cost", "role:mock-corp-001/finance#assignee"); err != nil {
		t.Fatal(err)
	}
	grants, _ := s.Grants(ctx)
	if len(grants) != 4 {
		t.Fatalf("grants = %d, want 4", len(grants))
	}
	if err := s.RemoveGrant(ctx, "cost", "role:mock-corp-001/finance#assignee"); err != nil {
		t.Fatal(err)
	}
	grants, _ = s.Grants(ctx)
	if len(grants) != 3 {
		t.Fatalf("grants = %d, want 3 after remove", len(grants))
	}
}
```

- [ ] **Step 2: Run — verify FAIL** (methods undefined)

Run: `wsl -e bash -lc 'cd /mnt/d/merchantAgent/backend && export PATH="$PATH:$HOME/.local/bin" && go test ./config/ -run "TestRolesCRUD|TestRulesReplaceAndDomains" 2>&1 | head'`
Expected: FAIL / build error `s.CreateRole undefined`.

- [ ] **Step 3: Implement list + CRUD methods (append to config.go)**

```go
// ---- Roles ----
func (s *Store) Roles(ctx context.Context) ([]Role, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT role_id, label, description FROM roles WHERE tenant_id=? ORDER BY role_id`, s.tenant)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Role{}
	for rows.Next() {
		var r Role
		if err := rows.Scan(&r.RoleID, &r.Label, &r.Description); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (s *Store) CreateRole(ctx context.Context, r Role) error {
	if r.RoleID == "" || r.Label == "" {
		return fmt.Errorf("role id and label required")
	}
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO roles (tenant_id, role_id, label, description) VALUES (?,?,?,?)`,
		s.tenant, r.RoleID, r.Label, r.Description)
	return err
}

func (s *Store) UpdateRole(ctx context.Context, id, label, desc string) error {
	res, err := s.db.ExecContext(ctx,
		`UPDATE roles SET label=?, description=? WHERE tenant_id=? AND role_id=?`,
		label, desc, s.tenant, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return fmt.Errorf("role %q not found", id)
	}
	return nil
}

// DeleteRole removes the role and cascades: drops its data-domain grants and
// removes it from every skill's roles list is handled by the caller (agentd)
// via the skill store; here we clean the config-owned references (grants).
func (s *Store) DeleteRole(ctx context.Context, id string) error {
	subj := fmt.Sprintf("role:%s/%s#assignee", s.tenant, id)
	if _, err := s.db.ExecContext(ctx, `DELETE FROM domain_grants WHERE tenant_id=? AND subject=?`, s.tenant, subj); err != nil {
		return err
	}
	_, err := s.db.ExecContext(ctx, `DELETE FROM roles WHERE tenant_id=? AND role_id=?`, s.tenant, id)
	return err
}

// ---- Rules ----
func (s *Store) Rules(ctx context.Context) ([]Rule, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT match_terms, role_id FROM role_rules WHERE tenant_id=? ORDER BY ord`, s.tenant)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Rule{}
	for rows.Next() {
		var terms string
		var r Rule
		if err := rows.Scan(&terms, &r.RoleID); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(terms), &r.Match); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// ReplaceRules swaps the whole ordered rule list atomically.
func (s *Store) ReplaceRules(ctx context.Context, rules []Rule) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `DELETE FROM role_rules WHERE tenant_id=?`, s.tenant); err != nil {
		return err
	}
	for i, r := range rules {
		terms, _ := json.Marshal(r.Match)
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO role_rules (tenant_id, ord, match_terms, role_id) VALUES (?,?,?,?)`,
			s.tenant, i, string(terms), r.RoleID); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// ---- Domains + grants ----
func (s *Store) Domains(ctx context.Context) ([]Domain, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT domain_id, label FROM data_domains WHERE tenant_id=? ORDER BY domain_id`, s.tenant)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Domain{}
	for rows.Next() {
		var d Domain
		if err := rows.Scan(&d.DomainID, &d.Label); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

func (s *Store) Grants(ctx context.Context) ([]Grant, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT domain_id, subject FROM domain_grants WHERE tenant_id=? ORDER BY domain_id, subject`, s.tenant)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Grant{}
	for rows.Next() {
		var g Grant
		if err := rows.Scan(&g.DomainID, &g.Subject); err != nil {
			return nil, err
		}
		out = append(out, g)
	}
	return out, rows.Err()
}

func (s *Store) AddGrant(ctx context.Context, domain, subject string) error {
	if domain == "" || subject == "" {
		return fmt.Errorf("domain and subject required")
	}
	_, err := s.db.ExecContext(ctx,
		`INSERT OR IGNORE INTO domain_grants (tenant_id, domain_id, subject) VALUES (?,?,?)`,
		s.tenant, domain, subject)
	return err
}

func (s *Store) RemoveGrant(ctx context.Context, domain, subject string) error {
	_, err := s.db.ExecContext(ctx,
		`DELETE FROM domain_grants WHERE tenant_id=? AND domain_id=? AND subject=?`,
		s.tenant, domain, subject)
	return err
}
```

- [ ] **Step 4: Run — verify PASS**

Run: `wsl -e bash -lc 'cd /mnt/d/merchantAgent/backend && export PATH="$PATH:$HOME/.local/bin" && go test ./config/ -v'`
Expected: PASS (all config tests).

- [ ] **Step 5: Commit**

```bash
git add backend/config/
git commit -m "feat(config): CRUD + list for roles/rules/domains/grants"
```

### Task 3: config.Tuples + LoadRules (pure projection)

**Files:**
- Create: `backend/config/tuples.go`
- Test: `backend/config/tuples_test.go`

- [ ] **Step 1: Write failing projection test**

```go
package config

import (
	"sort"
	"testing"
)

func TestTuples_Projection(t *testing.T) {
	roles := []Role{{RoleID: "sales", Label: "销售"}, {RoleID: "finance", Label: "财务"}}
	domains := []Domain{{DomainID: "cost", Label: "成本"}}
	grants := []Grant{
		{DomainID: "cost", Subject: "user:u_fin"},
		{DomainID: "cost", Subject: "role:mock-corp-001/finance#assignee"},
	}
	got := Tuples(roles, domains, grants, "mock-corp-001")
	set := map[string]bool{}
	for _, tp := range got {
		set[tp.String()] = true
	}
	want := []string{
		"tenant:mock-corp-001|tenant|role:mock-corp-001/sales",
		"tenant:mock-corp-001|tenant|role:mock-corp-001/finance",
		"tenant:mock-corp-001|tenant|data_domain:mock-corp-001/cost",
		"user:u_fin|viewer|data_domain:mock-corp-001/cost",
		"role:mock-corp-001/finance#assignee|viewer|data_domain:mock-corp-001/cost",
	}
	for _, w := range want {
		if !set[w] {
			t.Errorf("missing tuple: %s", w)
		}
	}
	// Output must be sorted (diffable).
	if !sort.SliceIsSorted(got, func(i, j int) bool { return got[i].String() < got[j].String() }) {
		t.Error("Tuples output not sorted")
	}
}

func TestLoadRules(t *testing.T) {
	rules := []Rule{{Match: []string{"经理"}, RoleID: "manager_tier"}}
	sr := LoadRules(rules)
	if len(sr) != 1 || sr[0].Role != "manager_tier" || sr[0].Match[0] != "经理" {
		t.Fatalf("LoadRules = %+v", sr)
	}
}
```

- [ ] **Step 2: Run — verify FAIL** (`Tuples`/`LoadRules` undefined)

Run: `wsl -e bash -lc 'cd /mnt/d/merchantAgent/backend && export PATH="$PATH:$HOME/.local/bin" && go test ./config/ -run "TestTuples_Projection|TestLoadRules" 2>&1 | head'`
Expected: FAIL / build error.

- [ ] **Step 3: Implement tuples.go**

```go
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
```

- [ ] **Step 4: Run — verify PASS**

Run: `wsl -e bash -lc 'cd /mnt/d/merchantAgent/backend && export PATH="$PATH:$HOME/.local/bin" && go test ./config/ -v'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/config/tuples.go backend/config/tuples_test.go
git commit -m "feat(config): pure Tuples projection + LoadRules adapter"
```

---

### Task 4: skill store — CRUD, CloneTemplate, ListTemplates, OpenFile

**Files:**
- Modify: `backend/skill/skill.go` (append methods + OpenFile)
- Test: `backend/skill/skill_test.go` (append)

- [ ] **Step 1: Write failing CRUD + clone test**

```go
// append to skill_test.go
func TestSkillCRUD_AndClone(t *testing.T) {
	ctx := context.Background()
	s, _ := Open()
	defer s.Close()

	tmpls, err := s.ListTemplates(ctx)
	if err != nil || len(tmpls) != 1 || tmpls[0].TemplateID != "order-360" {
		t.Fatalf("templates = %+v err=%v", tmpls, err)
	}
	// Clone the platform template into a new tenant skill.
	id, err := s.CloneTemplate(ctx, "mock-corp-001", "order-360")
	if err != nil {
		t.Fatal(err)
	}
	skills, _ := s.List(ctx, "mock-corp-001")
	if len(skills) != 3 {
		t.Fatalf("skills = %d, want 3 after clone", len(skills))
	}
	// Update the clone's roles (Gate A) + playbook.
	err = s.Update(ctx, Skill{
		TenantID: "mock-corp-001", SkillID: id, Name: "订单360副本",
		Description: "d", PlaybookMD: "p", AllowedTools: []string{"query_order_status"},
		DataDomains: []string{"cost"}, Roles: []string{"sales"},
	})
	if err != nil {
		t.Fatal(err)
	}
	// Delete it.
	if err := s.Delete(ctx, "mock-corp-001", id); err != nil {
		t.Fatal(err)
	}
	skills, _ = s.List(ctx, "mock-corp-001")
	if len(skills) != 2 {
		t.Fatalf("skills = %d, want 2 after delete", len(skills))
	}
}

func TestRemoveRoleFromSkills(t *testing.T) {
	ctx := context.Background()
	s, _ := Open()
	defer s.Close()
	// order360 seeds roles [sales, manager_tier]; drop sales.
	if err := s.RemoveRoleFromAll(ctx, "mock-corp-001", "sales"); err != nil {
		t.Fatal(err)
	}
	skills, _ := s.List(ctx, "mock-corp-001")
	for _, sk := range skills {
		for _, r := range sk.Roles {
			if r == "sales" {
				t.Errorf("skill %s still has role sales", sk.SkillID)
			}
		}
	}
}
```

- [ ] **Step 2: Run — verify FAIL**

Run: `wsl -e bash -lc 'cd /mnt/d/merchantAgent/backend && export PATH="$PATH:$HOME/.local/bin" && go test ./skill/ -run "TestSkillCRUD_AndClone|TestRemoveRoleFromSkills" 2>&1 | head'`
Expected: FAIL / build error.

- [ ] **Step 3: Implement — add OpenFile + methods to skill.go**

Add `_ "embed"`, `encoding/json`, `fmt` are already imported. Add near `Open`:

```go
// OpenFile opens/creates a file-backed skill registry, seeding only a fresh DB
// (no skills rows) so admin edits survive restart. Mirrors config.OpenFile.
func OpenFile(path string) (*Store, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("open skill sqlite: %w", err)
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(schemaSQL); err != nil {
		db.Close()
		return nil, fmt.Errorf("skill schema: %w", err)
	}
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM skills`).Scan(&n); err != nil {
		db.Close()
		return nil, err
	}
	if n == 0 {
		if _, err := db.Exec(seedSQL); err != nil {
			db.Close()
			return nil, fmt.Errorf("skill seed: %w", err)
		}
	}
	return &Store{db: db}, nil
}
```

Note: `schema.sql` uses bare `CREATE TABLE`. Change both statements to `CREATE TABLE IF NOT EXISTS` so `OpenFile` re-open is safe.

Then append CRUD:

```go
func writeSkill(ctx context.Context, db *sql.DB, sk Skill, insert bool) error {
	tools, _ := json.Marshal(sk.AllowedTools)
	domains, _ := json.Marshal(sk.DataDomains)
	roles, _ := json.Marshal(sk.Roles)
	if insert {
		_, err := db.ExecContext(ctx,
			`INSERT INTO skills (tenant_id, skill_id, name, description, playbook_md, allowed_tools, data_domains, roles, source_template_id)
			 VALUES (?,?,?,?,?,?,?,?,?)`,
			sk.TenantID, sk.SkillID, sk.Name, sk.Description, sk.PlaybookMD,
			string(tools), string(domains), string(roles), nullable(sk.SourceTemplate))
		return err
	}
	res, err := db.ExecContext(ctx,
		`UPDATE skills SET name=?, description=?, playbook_md=?, allowed_tools=?, data_domains=?, roles=?
		 WHERE tenant_id=? AND skill_id=?`,
		sk.Name, sk.Description, sk.PlaybookMD, string(tools), string(domains), string(roles),
		sk.TenantID, sk.SkillID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return fmt.Errorf("skill %q not found", sk.SkillID)
	}
	return nil
}

func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func (s *Store) Create(ctx context.Context, sk Skill) error {
	if sk.SkillID == "" || sk.Name == "" {
		return fmt.Errorf("skill id and name required")
	}
	return writeSkill(ctx, s.db, sk, true)
}

func (s *Store) Update(ctx context.Context, sk Skill) error { return writeSkill(ctx, s.db, sk, false) }

func (s *Store) Delete(ctx context.Context, tenant, id string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM skills WHERE tenant_id=? AND skill_id=?`, tenant, id)
	return err
}

// RemoveRoleFromAll strips a role id from every skill's roles list (cascade on
// role delete, so no skill references a dead role → no stale usable_by tuple).
func (s *Store) RemoveRoleFromAll(ctx context.Context, tenant, roleID string) error {
	skills, err := s.List(ctx, tenant)
	if err != nil {
		return err
	}
	for _, sk := range skills {
		filtered := sk.Roles[:0:0]
		changed := false
		for _, r := range sk.Roles {
			if r == roleID {
				changed = true
				continue
			}
			filtered = append(filtered, r)
		}
		if changed {
			sk.Roles = filtered
			if err := writeSkill(ctx, s.db, sk, false); err != nil {
				return err
			}
		}
	}
	return nil
}

// ListTemplates returns the platform starter templates.
func (s *Store) ListTemplates(ctx context.Context) ([]Template, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT template_id, name, description, playbook_md, allowed_tools, data_domains, suggested_roles FROM templates ORDER BY template_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Template{}
	for rows.Next() {
		var t Template
		var tools, domains, roles string
		if err := rows.Scan(&t.TemplateID, &t.Name, &t.Description, &t.PlaybookMD, &tools, &domains, &roles); err != nil {
			return nil, err
		}
		jsonArr(tools, &t.AllowedTools)
		jsonArr(domains, &t.DataDomains)
		jsonArr(roles, &t.SuggestedRoles)
		out = append(out, t)
	}
	return out, rows.Err()
}

// CloneTemplate creates a tenant skill from a platform template, decoupled from
// it thereafter (design §3.5). Returns the new skill id (templateId + "-copy"
// with a numeric suffix if taken).
func (s *Store) CloneTemplate(ctx context.Context, tenant, templateID string) (string, error) {
	tmpls, err := s.ListTemplates(ctx)
	if err != nil {
		return "", err
	}
	var t *Template
	for i := range tmpls {
		if tmpls[i].TemplateID == templateID {
			t = &tmpls[i]
			break
		}
	}
	if t == nil {
		return "", fmt.Errorf("template %q not found", templateID)
	}
	id := uniqueSkillID(ctx, s.db, tenant, templateID)
	sk := Skill{
		TenantID: tenant, SkillID: id, Name: t.Name, Description: t.Description,
		PlaybookMD: t.PlaybookMD, AllowedTools: t.AllowedTools, DataDomains: t.DataDomains,
		Roles: t.SuggestedRoles, SourceTemplate: t.TemplateID,
	}
	if err := writeSkill(ctx, s.db, sk, true); err != nil {
		return "", err
	}
	return id, nil
}

func uniqueSkillID(ctx context.Context, db *sql.DB, tenant, base string) string {
	try := base
	for i := 1; ; i++ {
		var n int
		db.QueryRowContext(ctx, `SELECT COUNT(*) FROM skills WHERE tenant_id=? AND skill_id=?`, tenant, try).Scan(&n)
		if n == 0 {
			return try
		}
		try = fmt.Sprintf("%s-%d", base, i)
	}
}
```

- [ ] **Step 4: Run — verify PASS** (incl. existing skill tests)

Run: `wsl -e bash -lc 'cd /mnt/d/merchantAgent/backend && export PATH="$PATH:$HOME/.local/bin" && go test ./skill/ -v'`
Expected: PASS (TestList_Seeded, TestTuples_Projection, TestSkillCRUD_AndClone, TestRemoveRoleFromSkills).

- [ ] **Step 5: Commit**

```bash
git add backend/skill/
git commit -m "feat(skill): CRUD, CloneTemplate, ListTemplates, OpenFile"
```

## Phase M6b — Projection engine

### Task 5: authz.Store.ReadTuples (paginated full read)

**Files:**
- Modify: `backend/authz/store.go` (append method)
- Test: `backend/authz/read_test.go` (create; gated on OpenFGA)

- [ ] **Step 1: Write failing gated integration test**

```go
package authz

import (
	"context"
	"os"
	"testing"

	"github.com/merchantagent/backend/sync"
)

func TestReadTuples_RoundTrip(t *testing.T) {
	apiURL := os.Getenv("OPENFGA_API_URL")
	if apiURL == "" {
		apiURL = "http://localhost:18080"
	}
	ctx := context.Background()
	store, err := NewStore(ctx, apiURL, "readtuples-test")
	if err != nil {
		t.Skipf("OpenFGA not reachable (%v)", err)
	}
	want := []sync.Tuple{
		{User: "user:a", Relation: "member", Object: "tenant:t1"},
		{User: "user:b", Relation: "admin", Object: "tenant:t1"},
	}
	if err := store.ApplyDiff(ctx, sync.Diff{Writes: want}); err != nil {
		t.Fatal(err)
	}
	got, err := store.ReadTuples(ctx)
	if err != nil {
		t.Fatal(err)
	}
	set := map[string]bool{}
	for _, tp := range got {
		set[tp.String()] = true
	}
	for _, w := range want {
		if !set[w.String()] {
			t.Errorf("missing read-back tuple: %s (got %d tuples)", w.String(), len(got))
		}
	}
}
```

- [ ] **Step 2: Run — verify FAIL** (`ReadTuples` undefined)

Run: `cd backend && docker compose up -d` then
`wsl -e bash -lc 'cd /mnt/d/merchantAgent/backend && export PATH="$PATH:$HOME/.local/bin" && go test ./authz/ -run TestReadTuples_RoundTrip 2>&1 | head'`
Expected: build error `store.ReadTuples undefined`.

- [ ] **Step 3: Implement ReadTuples (append to store.go)**

```go
// ReadTuples returns every tuple in the store (all tenants), paginated via the
// OpenFGA Read API with an empty filter. This is the "current" side of the
// differential reconcile that wire.Projector runs on every config change.
func (s *Store) ReadTuples(ctx context.Context) ([]sync.Tuple, error) {
	var out []sync.Tuple
	var token string
	for {
		opts := fgaclient.ClientReadOptions{}
		if token != "" {
			opts.ContinuationToken = &token
		}
		resp, err := s.c.Read(ctx).Body(fgaclient.ClientReadRequest{}).Options(opts).Execute()
		if err != nil {
			return nil, fmt.Errorf("read tuples: %w", err)
		}
		for _, tp := range resp.GetTuples() {
			k := tp.GetKey()
			out = append(out, sync.Tuple{User: k.GetUser(), Relation: k.GetRelation(), Object: k.GetObject()})
		}
		token = resp.GetContinuationToken()
		if token == "" {
			break
		}
	}
	return out, nil
}
```

- [ ] **Step 4: Run — verify PASS**

Run: `wsl -e bash -lc 'cd /mnt/d/merchantAgent/backend && export PATH="$PATH:$HOME/.local/bin" && go test ./authz/ -run TestReadTuples_RoundTrip -v'`
Expected: PASS (or SKIP if OpenFGA down — ensure it's up).

- [ ] **Step 5: Commit**

```bash
git add backend/authz/store.go backend/authz/read_test.go
git commit -m "feat(authz): ReadTuples paginated full-store read"
```

---

### Task 6: wire.Projector + rewire Assemble

**Files:**
- Create: `backend/wire/projector.go`
- Test: `backend/wire/projector_test.go`
- Modify: `backend/wire/assemble.go`

- [ ] **Step 1: Write failing pure-desired test** (hermetic — no OpenFGA)

```go
package wire

import (
	"context"
	"testing"

	"github.com/merchantagent/backend/config"
	"github.com/merchantagent/backend/org"
	"github.com/merchantagent/backend/skill"
)

func TestDesired_MergesAndDedups(t *testing.T) {
	ctx := context.Background()
	idp, err := org.NewMockAdapterFromFile("../testdata/mock-org.yaml")
	if err != nil {
		t.Fatal(err)
	}
	cfg, _ := config.Open(tenant)
	sk, _ := skill.Open()
	defer sk.Close()
	p := &Projector{idp: idp, cfg: cfg, sk: sk, tenant: tenant}

	desired, err := p.desired(ctx)
	if err != nil {
		t.Fatal(err)
	}
	set := map[string]int{}
	for _, tp := range desired {
		set[tp.String()]++
	}
	// No duplicates.
	for k, n := range set {
		if n > 1 {
			t.Errorf("duplicate tuple %s (x%d)", k, n)
		}
	}
	// Must contain: org member, skill usable_by, domain grant, role object, demo fixture.
	must := []string{
		"user:u_sales1|member|tenant:mock-corp-001",
		"role:mock-corp-001/sales#assignee|usable_by|skill:mock-corp-001/order360",
		"user:u_fin|viewer|data_domain:mock-corp-001/cost",
		"tenant:mock-corp-001|tenant|role:mock-corp-001/finance",
		"user:u_sales1|owner|order:mock-corp-001/SO-1001",
	}
	for _, m := range must {
		if set[m] == 0 {
			t.Errorf("desired missing: %s", m)
		}
	}
}

func TestDesired_RuleEditDropsRole(t *testing.T) {
	ctx := context.Background()
	idp, _ := org.NewMockAdapterFromFile("../testdata/mock-org.yaml")
	cfg, _ := config.Open(tenant)
	sk, _ := skill.Open()
	defer sk.Close()
	p := &Projector{idp: idp, cfg: cfg, sk: sk, tenant: tenant}

	// Replace rules so "销售" no longer maps to sales → u_sales1 loses the tuple.
	cfg.ReplaceRules(ctx, []config.Rule{{Match: []string{"经理"}, RoleID: "manager_tier"}})
	desired, _ := p.desired(ctx)
	for _, tp := range desired {
		if tp.String() == "user:u_sales1|assignee|role:mock-corp-001/sales" {
			t.Error("u_sales1 should have lost the sales role after rule edit")
		}
	}
}
```

- [ ] **Step 2: Run — verify FAIL** (`Projector` undefined)

Run: `wsl -e bash -lc 'cd /mnt/d/merchantAgent/backend && export PATH="$PATH:$HOME/.local/bin" && go test ./wire/ -run "TestDesired" 2>&1 | head'`
Expected: build error.

- [ ] **Step 3: Implement projector.go**

```go
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
	mu     stdsync.Mutex // serialize Reproject (config writes are rare)
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

// demoFixtures are the non-config-derived tuples the demo scenario needs: order
// ownership (record-level data authz). Cost-domain viewers now come from the
// config domain_grants table, so they are NOT here (avoids double source).
func demoFixtures(tenant string) []sync.Tuple {
	o := func(s string) string { return tenant + "/" + s }
	return []sync.Tuple{
		{User: "user:u_sales1", Relation: "owner", Object: "order:" + o("SO-1001")},
		{User: "department:" + o("d_sales"), Relation: "owner_dept", Object: "order:" + o("SO-1001")},
		{User: "user:u_sales1", Relation: "owner", Object: "order:" + o("SO-1002")},
		{User: "department:" + o("d_sales"), Relation: "owner_dept", Object: "order:" + o("SO-1002")},
		{User: "department:" + o("d_sales"), Relation: "owner_dept", Object: "order:" + o("SO-1003")},
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
```

- [ ] **Step 4: Run desired tests — verify PASS**

Run: `wsl -e bash -lc 'cd /mnt/d/merchantAgent/backend && export PATH="$PATH:$HOME/.local/bin" && go test ./wire/ -run "TestDesired" -v'`
Expected: PASS (both). Fix imports if `config.Store.Rules` etc. mismatch — signatures are `Rules(ctx)`, `Roles(ctx)`, `Domains(ctx)`, `Grants(ctx)` (tenant is bound in the store).

- [ ] **Step 5: Rewire assemble.go** — replace `seedScenario` with Projector

Change `Assembled` struct: add `Projector *Projector` and `cfg *config.Store`. In `Assemble`, after opening `sk`, add:

```go
	cfgPath := "" // in-memory by default (tests / ephemeral)
	// (main.go passes a file path via Config.ConfigDB; see Task 7)
	var cfg *config.Store
	if cfg, err = openConfig(cfg0Path(cfg), cfg.tenant0(...)); err != nil { /* see below */ }
```

Simpler concrete edit — add a `ConfigDB`, `SkillDB` field to `Config`, and replace the body from `sk, err := skill.Open()` through `seedScenario(...)` with:

```go
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
```

Add helpers + delete `seedScenario`:

```go
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
```

Update the returned struct: `return &Assembled{Agent: agent, IDP: idp, Audit: audit, Store: store, Projector: projector, erp: e, crm: c, sk: sk, cfg: cf}, nil`.
Update `Close()` to also `a.cfg.Close()`.
Add imports: `"github.com/merchantagent/backend/config"`. Remove now-unused `"github.com/merchantagent/backend/sync"` import IF no longer referenced (the demo/skill diff code moved to projector.go). Verify with the build.
Add `ConfigDB string` and `SkillDB string` to `Config`.

- [ ] **Step 6: Run full backend build + wire integration (gated)**

Run: `wsl -e bash -lc 'cd /mnt/d/merchantAgent/backend && export GOPROXY=https://goproxy.cn,direct GOSUMDB=off PATH="$PATH:$HOME/.local/bin" && go build ./... && go test ./wire/ ./e2e/ -v 2>&1 | tail -40'`
Expected: build OK; `TestDesired*` PASS; existing gated integration/e2e PASS (OpenFGA up) or SKIP (down). If e2e fails, the fixture move is wrong — compare demoFixtures vs old seedScenario.

- [ ] **Step 7: Commit**

```bash
git add backend/wire/ 
git commit -m "feat(wire): Projector engine + Assemble uses Reproject (repays P0 reconcile debt)"
```

## Phase M6c — Admin API

### Task 7: expose stores, config paths, requireAdmin, /admin/tools

**Files:**
- Modify: `backend/wire/assemble.go` (export `Cfg`, `Sk` on `Assembled`)
- Modify: `backend/cmd/agentd/main.go` (config paths, routes)
- Create: `backend/cmd/agentd/admin.go` (middleware + tools handler)
- Test: `backend/cmd/agentd/admin_test.go`

- [ ] **Step 1: Export stores on Assembled**

In `assemble.go`, change the struct fields `sk *skill.Store` → keep, but ADD exported accessors used by handlers. Simplest: rename usage — add exported fields:

```go
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
```

Set `Cfg: cf, Sk: sk, Conns: conns` in the return; drop the old private `sk`/duplicate. Update `Close()` to use `a.Sk`, `a.Cfg`.

- [ ] **Step 2: Write failing requireAdmin test**

```go
package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// fakeChecker lets us test requireAdmin without OpenFGA.
type fakeChecker struct{ admins map[string]bool }

func (f fakeChecker) Check(_ context.Context, user, relation, object string) (bool, error) {
	return f.admins[user], nil
}

func TestRequireAdmin(t *testing.T) {
	chk := fakeChecker{admins: map[string]bool{"user:u_boss": true}}
	guarded := requireAdmin(chk, "mock-corp-001", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	// non-admin → 403
	r1 := httptest.NewRequest("GET", "/admin/roles", nil)
	r1.Header.Set("X-User-Id", "u_sales1")
	w1 := httptest.NewRecorder()
	guarded(w1, r1)
	if w1.Code != http.StatusForbidden {
		t.Errorf("non-admin got %d, want 403", w1.Code)
	}
	// admin → 200
	r2 := httptest.NewRequest("GET", "/admin/roles", nil)
	r2.Header.Set("X-User-Id", "u_boss")
	w2 := httptest.NewRecorder()
	guarded(w2, r2)
	if w2.Code != http.StatusOK {
		t.Errorf("admin got %d, want 200", w2.Code)
	}
}
```

- [ ] **Step 3: Run — verify FAIL**

Run: `wsl -e bash -lc 'cd /mnt/d/merchantAgent/backend && export PATH="$PATH:$HOME/.local/bin" && go test ./cmd/agentd/ -run TestRequireAdmin 2>&1 | head'`
Expected: build error `requireAdmin undefined`.

- [ ] **Step 4: Implement admin.go (middleware + tools handler)**

```go
package main

import (
	"context"
	"net/http"

	"github.com/merchantagent/backend/connector"
	"github.com/merchantagent/backend/runtime"
)

// adminChecker is the minimal authz surface requireAdmin needs (authz.Store fits).
type adminChecker interface {
	Check(ctx context.Context, user, relation, object string) (bool, error)
}

// requireAdmin gates an /admin/* handler: the caller (X-User-Id header, injected
// by the desktop from the current identity) must be tenant admin. DEMO: header
// is trusted; production derives it from a verified WeCom session.
func requireAdmin(chk adminChecker, tenant string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		uid := r.Header.Get("X-User-Id")
		if uid == "" {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "missing X-User-Id"})
			return
		}
		ok, err := chk.Check(r.Context(), "user:"+uid, "admin", "tenant:"+tenant)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		if !ok {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "admin only"})
			return
		}
		next(w, r)
	}
}

// handleTools returns the platform tool catalog (connector Specs) for the skill
// editor's tool picker. Read-only; still admin-gated.
func (s *server) handleTools(w http.ResponseWriter, r *http.Request) {
	type toolInfo struct {
		Name        string `json:"name"`
		Description string `json:"description"`
		DataDomain  string `json:"dataDomain,omitempty"`
	}
	out := []toolInfo{}
	for _, c := range s.asm.Conns {
		for _, t := range c.Tools() {
			sp := t.Spec()
			out = append(out, toolInfo{Name: sp.Name, Description: sp.Description, DataDomain: sp.DataDomain})
		}
	}
	writeJSON(w, http.StatusOK, out)
}

var _ = connector.Lookup // keep connector imported if unused elsewhere
var _ = runtime.EventSink(nil)
```

(Remove the two `var _` lines if those packages are already referenced — they're just import-guards; verify with build and delete if unused.)

- [ ] **Step 5: Wire config paths + routes in main.go**

In `main()`, add before `wire.Assemble`:

```go
	dataDir := envOr("DATA_DIR", "")
	configDB, skillDB := os.Getenv("CONFIG_DB"), os.Getenv("SKILL_DB")
	if configDB == "" && dataDir != "" {
		configDB = dataDir + "/config.db"
	}
	if skillDB == "" && dataDir != "" {
		skillDB = dataDir + "/skills.db"
	}
```

Pass into `wire.Config{... ConfigDB: configDB, SkillDB: skillDB}`.
In `routes()`, register (Go 1.22 patterns):

```go
	admin := func(h http.HandlerFunc) http.HandlerFunc { return requireAdmin(s.asm.Store, s.tenant, h) }
	mux.HandleFunc("GET /admin/tools", admin(s.handleTools))
	mux.HandleFunc("GET /admin/roles", admin(s.handleRolesList))
	mux.HandleFunc("POST /admin/roles", admin(s.handleRoleCreate))
	mux.HandleFunc("PUT /admin/roles/{id}", admin(s.handleRoleUpdate))
	mux.HandleFunc("DELETE /admin/roles/{id}", admin(s.handleRoleDelete))
	mux.HandleFunc("GET /admin/rules", admin(s.handleRulesGet))
	mux.HandleFunc("PUT /admin/rules", admin(s.handleRulesPut))
	mux.HandleFunc("GET /admin/skills", admin(s.handleSkillsList))
	mux.HandleFunc("GET /admin/templates", admin(s.handleTemplatesList))
	mux.HandleFunc("POST /admin/skills", admin(s.handleSkillCreate))
	mux.HandleFunc("PUT /admin/skills/{id}", admin(s.handleSkillUpdate))
	mux.HandleFunc("DELETE /admin/skills/{id}", admin(s.handleSkillDelete))
	mux.HandleFunc("GET /admin/domains", admin(s.handleDomainsList))
	mux.HandleFunc("POST /admin/domains/{d}/grants", admin(s.handleGrantAdd))
	mux.HandleFunc("DELETE /admin/domains/{d}/grants", admin(s.handleGrantRemove))
```

- [ ] **Step 6: Run — verify requireAdmin PASS** (handlers stubbed in Task 8; to compile now, add empty stubs or do Task 8 first). Recommended: implement Task 8 handlers, then run.

- [ ] **Step 7: Commit** (after Task 8 compiles)

### Task 8: admin CRUD handlers

**Files:**
- Create: `backend/cmd/agentd/admin_handlers.go`
- Test: `backend/cmd/agentd/admin_test.go` (append integration-style test, gated)

- [ ] **Step 1: Implement admin_handlers.go** (all handlers; each mutating one calls Reproject)

```go
package main

import (
	"encoding/json"
	"net/http"

	"github.com/merchantagent/backend/config"
	"github.com/merchantagent/backend/skill"
)

// reproject re-runs the projection after a config/skill write; on error the HTTP
// call reports 500 (DB already changed, but OpenFGA will re-sync on next write
// or restart — acceptable for the demo).
func (s *server) reproject(w http.ResponseWriter, r *http.Request) bool {
	if err := s.asm.Projector.Reproject(r.Context()); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "reproject: " + err.Error()})
		return false
	}
	return true
}

func decode(w http.ResponseWriter, r *http.Request, dst any) bool {
	if err := json.NewDecoder(r.Body).Decode(dst); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad json"})
		return false
	}
	return true
}

// ---- roles ----
func (s *server) handleRolesList(w http.ResponseWriter, r *http.Request) {
	roles, err := s.asm.Cfg.Roles(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, roles)
}

func (s *server) handleRoleCreate(w http.ResponseWriter, r *http.Request) {
	var role config.Role
	if !decode(w, r, &role) {
		return
	}
	if err := s.asm.Cfg.CreateRole(r.Context(), role); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if !s.reproject(w, r) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *server) handleRoleUpdate(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var body struct{ Label, Description string }
	if !decode(w, r, &body) {
		return
	}
	if err := s.asm.Cfg.UpdateRole(r.Context(), id, body.Label, body.Description); err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
		return
	}
	if !s.reproject(w, r) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *server) handleRoleDelete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	// Cascade: strip the role from skills (Gate A) + config grants (Gate B).
	if err := s.asm.Sk.RemoveRoleFromAll(r.Context(), s.tenant, id); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if err := s.asm.Cfg.DeleteRole(r.Context(), id); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if !s.reproject(w, r) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// ---- rules ----
func (s *server) handleRulesGet(w http.ResponseWriter, r *http.Request) {
	rules, err := s.asm.Cfg.Rules(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, rules)
}

func (s *server) handleRulesPut(w http.ResponseWriter, r *http.Request) {
	var rules []config.Rule
	if !decode(w, r, &rules) {
		return
	}
	if err := s.asm.Cfg.ReplaceRules(r.Context(), rules); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if !s.reproject(w, r) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// ---- skills ----
func (s *server) handleSkillsList(w http.ResponseWriter, r *http.Request) {
	skills, err := s.asm.Sk.List(r.Context(), s.tenant)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, skills)
}

func (s *server) handleTemplatesList(w http.ResponseWriter, r *http.Request) {
	t, err := s.asm.Sk.ListTemplates(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, t)
}

func (s *server) handleSkillCreate(w http.ResponseWriter, r *http.Request) {
	var body struct {
		TemplateID string      `json:"templateId"`
		Skill      skill.Skill `json:"skill"`
	}
	if !decode(w, r, &body) {
		return
	}
	if body.TemplateID != "" {
		if _, err := s.asm.Sk.CloneTemplate(r.Context(), s.tenant, body.TemplateID); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
	} else {
		body.Skill.TenantID = s.tenant
		if err := s.asm.Sk.Create(r.Context(), body.Skill); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
	}
	if !s.reproject(w, r) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *server) handleSkillUpdate(w http.ResponseWriter, r *http.Request) {
	var sk skill.Skill
	if !decode(w, r, &sk) {
		return
	}
	sk.TenantID = s.tenant
	sk.SkillID = r.PathValue("id")
	if err := s.asm.Sk.Update(r.Context(), sk); err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
		return
	}
	if !s.reproject(w, r) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *server) handleSkillDelete(w http.ResponseWriter, r *http.Request) {
	if err := s.asm.Sk.Delete(r.Context(), s.tenant, r.PathValue("id")); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if !s.reproject(w, r) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// ---- domains + grants ----
func (s *server) handleDomainsList(w http.ResponseWriter, r *http.Request) {
	domains, err := s.asm.Cfg.Domains(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	grants, err := s.asm.Cfg.Grants(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"domains": domains, "grants": grants})
}

func (s *server) handleGrantAdd(w http.ResponseWriter, r *http.Request) {
	var body struct{ Subject string }
	if !decode(w, r, &body) {
		return
	}
	if err := s.asm.Cfg.AddGrant(r.Context(), r.PathValue("d"), body.Subject); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if !s.reproject(w, r) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *server) handleGrantRemove(w http.ResponseWriter, r *http.Request) {
	var body struct{ Subject string }
	if !decode(w, r, &body) {
		return
	}
	if err := s.asm.Cfg.RemoveGrant(r.Context(), r.PathValue("d"), body.Subject); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if !s.reproject(w, r) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
```

- [ ] **Step 2: Add an `import "context"` to admin_test.go** (fakeChecker uses it) and run the unit test

Run: `wsl -e bash -lc 'cd /mnt/d/merchantAgent/backend && export GOPROXY=https://goproxy.cn,direct GOSUMDB=off PATH="$PATH:$HOME/.local/bin" && go build ./... && go test ./cmd/agentd/ -run TestRequireAdmin -v'`
Expected: build OK; TestRequireAdmin PASS.

- [ ] **Step 3: Write gated end-to-end admin test** (append to admin_test.go)

```go
func TestAdminRoleCreate_Projects(t *testing.T) {
	apiURL := os.Getenv("OPENFGA_API_URL")
	if apiURL == "" {
		apiURL = "http://localhost:18080"
	}
	asm, err := wire.Assemble(context.Background(), wire.Config{
		OpenFGAURL: apiURL, Tenant: "mock-corp-001",
		OrgFile: filepath.Join("..", "..", "testdata", "mock-org.yaml"),
		Provider: &provider.Fake{}, // LLM never called during admin CRUD
	})
	if err != nil {
		t.Skipf("assemble (OpenFGA up?): %v", err)
	}
	defer asm.Close()
	srv := &server{asm: asm, tenant: "mock-corp-001", sessions: map[string][]provider.Message{}, pending: map[string]chan fileResult{}}

	body := `{"roleId":"logistics","label":"物流"}`
	r := httptest.NewRequest("POST", "/admin/roles", strings.NewReader(body))
	r.Header.Set("X-User-Id", "u_boss")
	w := httptest.NewRecorder()
	srv.routes().ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("create role: %d %s", w.Code, w.Body.String())
	}
	roles, _ := asm.Cfg.Roles(context.Background())
	found := false
	for _, ro := range roles {
		if ro.RoleID == "logistics" {
			found = true
		}
	}
	if !found {
		t.Error("logistics role not persisted")
	}
}
```

Add imports to admin_test.go: `"os"`, `"path/filepath"`, `"strings"`, `"net/http"`, `"net/http/httptest"`, `"github.com/merchantagent/backend/provider"`, `"github.com/merchantagent/backend/wire"`. `&provider.Fake{}` is the scripted test provider (`backend/provider/fake.go`); its `Complete` is never called during admin CRUD, so no scripted steps are needed.

- [ ] **Step 4: Run gated test**

Run: `wsl -e bash -lc 'cd /mnt/d/merchantAgent/backend && export PATH="$PATH:$HOME/.local/bin" && go test ./cmd/agentd/ -v 2>&1 | tail -30'`
Expected: PASS (or SKIP if OpenFGA down).

- [ ] **Step 5: Commit**

```bash
git add backend/cmd/agentd/
git commit -m "feat(agentd): /admin/* CRUD handlers + requireAdmin + tools catalog"
```

---

## Phase M6d — Desktop UI

### Task 9: admin IPC channel (contract + preload + main proxy)

**Files:**
- Modify: `desktop/src/shared/contract.ts`
- Modify: `desktop/src/preload/index.ts`
- Modify: `desktop/src/main/agentd.ts` (add `adminRequest`)
- Modify: `desktop/src/main/ipc.ts` (register `admin` channel)

- [ ] **Step 1: Extend contract.ts**

```ts
// add to contract.ts
export interface AdminReq {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string; // e.g. "/admin/roles" or "/admin/skills/order360"
  userId: string; // current identity → injected as X-User-Id by main
  body?: unknown;
}
export type AdminResp =
  | { ok: true; data: unknown }
  | { ok: false; status: number; error: string };

// add to AgentAPI interface:
//   admin(req: AdminReq): Promise<AdminResp>;
// add to Channels:
//   admin: "agent:admin",
```

- [ ] **Step 2: Add adminRequest to agentd.ts**

```ts
// add to agentd.ts, export in `client`
async function adminRequest(req: {
  method: string; path: string; userId: string; body?: unknown;
}): Promise<{ ok: boolean; status: number; data?: unknown; error?: string }> {
  const res = await fetch(BASE + req.path, {
    method: req.method,
    headers: { "content-type": "application/json", "x-user-id": req.userId },
    body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
  });
  const text = await res.text();
  let parsed: unknown = undefined;
  try { parsed = text ? JSON.parse(text) : undefined; } catch { /* non-json */ }
  if (!res.ok) {
    const error = (parsed && typeof parsed === "object" && "error" in parsed)
      ? String((parsed as { error: unknown }).error) : text;
    return { ok: false, status: res.status, error };
  }
  return { ok: true, status: res.status, data: parsed };
}
// export: client = { base: BASE, login, chat, adminRequest };
```

- [ ] **Step 3: Register the IPC channel (ipc.ts) + preload**

ipc.ts — add inside `register`:

```ts
  ipcMain.handle(Channels.admin, async (_e, req: AdminReq): Promise<AdminResp> => {
    const r = await client.adminRequest(req);
    return r.ok ? { ok: true, data: r.data } : { ok: false, status: r.status, error: r.error ?? "error" };
  });
```

Add `AdminReq, AdminResp` to the ipc.ts contract import.

preload/index.ts — add to `api`:

```ts
  admin: (req) => ipcRenderer.invoke(Channels.admin, req),
```

- [ ] **Step 4: Typecheck**

Run: `cd desktop && npm run typecheck`
Expected: no errors (or run `npx tsc -p tsconfig.node.json --noEmit && npx tsc -p tsconfig.web.json --noEmit`).

- [ ] **Step 5: Commit**

```bash
git add desktop/src/shared/contract.ts desktop/src/preload/index.ts desktop/src/main/agentd.ts desktop/src/main/ipc.ts
git commit -m "feat(desktop): generic admin IPC channel with X-User-Id injection"
```

---

### Task 10: renderer admin client (typed helpers + browser mock)

**Files:**
- Create: `desktop/src/renderer/src/admin.ts`
- Test: `desktop/src/renderer/src/admin.test.ts`

- [ ] **Step 1: Write failing helper test** (vitest)

```ts
import { describe, it, expect, vi } from "vitest";
import { makeAdminClient } from "./admin";

describe("admin client", () => {
  it("listRoles unwraps AdminResp data", async () => {
    const admin = vi.fn().mockResolvedValue({ ok: true, data: [{ roleId: "sales", label: "销售" }] });
    const c = makeAdminClient(admin, "u_boss");
    const roles = await c.listRoles();
    expect(roles[0].roleId).toBe("sales");
    expect(admin).toHaveBeenCalledWith({ method: "GET", path: "/admin/roles", userId: "u_boss" });
  });

  it("throws on AdminResp error", async () => {
    const admin = vi.fn().mockResolvedValue({ ok: false, status: 403, error: "admin only" });
    const c = makeAdminClient(admin, "u_sales1");
    await expect(c.listRoles()).rejects.toThrow("admin only");
  });
});
```

- [ ] **Step 2: Run — verify FAIL**

Run: `cd desktop && npx vitest run src/renderer/src/admin.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement admin.ts**

```ts
// Typed admin client over the generic AdminReq IPC channel. Each helper unwraps
// AdminResp: returns data on ok, throws the server error otherwise.
import type { AdminReq, AdminResp } from "../../shared/contract";

export interface Role { roleId: string; label: string; description: string }
export interface Rule { match: string[]; roleId: string }
export interface Domain { domainId: string; label: string }
export interface Grant { domainId: string; subject: string }
export interface Skill {
  tenantId: string; skillId: string; name: string; description: string;
  playbookMd: string; allowedTools: string[]; dataDomains: string[];
  roles: string[]; sourceTemplateId?: string;
}
export interface ToolInfo { name: string; description: string; dataDomain?: string }

type AdminFn = (req: AdminReq) => Promise<AdminResp>;

export function makeAdminClient(admin: AdminFn, userId: string) {
  async function call<T>(method: AdminReq["method"], path: string, body?: unknown): Promise<T> {
    const resp = await admin({ method, path, userId, ...(body !== undefined ? { body } : {}) });
    if (!resp.ok) throw new Error(resp.error || `HTTP ${resp.status}`);
    return resp.data as T;
  }
  return {
    listTools: () => call<ToolInfo[]>("GET", "/admin/tools"),
    listRoles: () => call<Role[]>("GET", "/admin/roles"),
    createRole: (r: Role) => call<void>("POST", "/admin/roles", r),
    updateRole: (id: string, label: string, description: string) =>
      call<void>("PUT", `/admin/roles/${id}`, { label, description }),
    deleteRole: (id: string) => call<void>("DELETE", `/admin/roles/${id}`),
    getRules: () => call<Rule[]>("GET", "/admin/rules"),
    putRules: (rules: Rule[]) => call<void>("PUT", "/admin/rules", rules),
    listSkills: () => call<Skill[]>("GET", "/admin/skills"),
    listTemplates: () => call<Skill[]>("GET", "/admin/templates"),
    createSkill: (body: unknown) => call<void>("POST", "/admin/skills", body),
    updateSkill: (id: string, body: unknown) => call<void>("PUT", `/admin/skills/${id}`, body),
    deleteSkill: (id: string) => call<void>("DELETE", `/admin/skills/${id}`),
    listDomains: () => call<{ domains: Domain[]; grants: Grant[] }>("GET", "/admin/domains"),
    addGrant: (d: string, subject: string) => call<void>("POST", `/admin/domains/${d}/grants`, { subject }),
    removeGrant: (d: string, subject: string) => call<void>("DELETE", `/admin/domains/${d}/grants`, { subject }),
  };
}
export type AdminClient = ReturnType<typeof makeAdminClient>;
```

- [ ] **Step 4: Run — verify PASS**

Run: `cd desktop && npx vitest run src/renderer/src/admin.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add desktop/src/renderer/src/admin.ts desktop/src/renderer/src/admin.test.ts
git commit -m "feat(desktop): typed admin client over IPC channel"
```

---

### Task 11: AdminView + panes

**Files:**
- Create: `desktop/src/renderer/src/components/admin/AdminView.tsx`
- Create: `desktop/src/renderer/src/components/admin/RolesPane.tsx`
- Create: `desktop/src/renderer/src/components/admin/RulesPane.tsx`
- Create: `desktop/src/renderer/src/components/admin/SkillsPane.tsx`
- Create: `desktop/src/renderer/src/components/admin/AssignPane.tsx`
- Create: `desktop/src/renderer/src/components/admin/DomainsPane.tsx`
- Modify: `desktop/src/renderer/src/app.css` (append admin styles)

This task is UI wiring (no unit test — verified by typecheck + the manual acceptance run in Task 13). Keep panes small and focused; all data flows through the `AdminClient` from Task 10.

- [ ] **Step 1: AdminView shell (sub-nav + pane switch + admin-gate)**

```tsx
import { useState, useEffect } from "react";
import type { AdminClient } from "../../admin";
import { RolesPane } from "./RolesPane";
import { RulesPane } from "./RulesPane";
import { SkillsPane } from "./SkillsPane";
import { AssignPane } from "./AssignPane";
import { DomainsPane } from "./DomainsPane";

type Tab = "roles" | "rules" | "skills" | "assign" | "domains";
const TABS: { id: Tab; label: string }[] = [
  { id: "roles", label: "角色" }, { id: "rules", label: "职位映射" },
  { id: "skills", label: "技能" }, { id: "assign", label: "分配" },
  { id: "domains", label: "数据域" },
];

export function AdminView({ client }: { client: AdminClient }): JSX.Element {
  const [tab, setTab] = useState<Tab>("roles");
  const [denied, setDenied] = useState(false);

  // Admin gate: the server enforces it (403). Probe once so non-admins see a
  // friendly message instead of a broken page.
  useEffect(() => {
    client.listRoles().then(() => setDenied(false)).catch((e) =>
      setDenied(String(e).includes("admin") || String(e).includes("403")));
  }, [client]);

  if (denied) {
    return <div className="admin-denied">需要管理员权限。请在左下角切换到管理员身份（如"老板"）。</div>;
  }
  return (
    <div className="admin">
      <nav className="admin-nav">
        {TABS.map((t) => (
          <button key={t.id} className={"admin-tab" + (t.id === tab ? " active" : "")} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>
      <div className="admin-body">
        {tab === "roles" && <RolesPane client={client} />}
        {tab === "rules" && <RulesPane client={client} />}
        {tab === "skills" && <SkillsPane client={client} />}
        {tab === "assign" && <AssignPane client={client} />}
        {tab === "domains" && <DomainsPane client={client} />}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: RolesPane** (list + create + delete)

```tsx
import { useState, useEffect, useCallback } from "react";
import type { AdminClient, Role } from "../../admin";

export function RolesPane({ client }: { client: AdminClient }): JSX.Element {
  const [roles, setRoles] = useState<Role[]>([]);
  const [id, setId] = useState(""); const [label, setLabel] = useState("");
  const [err, setErr] = useState("");

  const load = useCallback(() => { client.listRoles().then(setRoles).catch((e) => setErr(String(e))); }, [client]);
  useEffect(load, [load]);

  const create = async () => {
    setErr("");
    try {
      await client.createRole({ roleId: id, label, description: "" });
      setId(""); setLabel(""); load();
    } catch (e) { setErr(String(e)); }
  };
  const del = async (rid: string) => { await client.deleteRole(rid); load(); };

  return (
    <div className="pane">
      <h3 className="pane-title">角色</h3>
      {err && <div className="pane-err">{err}</div>}
      <ul className="pane-list">
        {roles.map((r) => (
          <li key={r.roleId} className="pane-row">
            <span><b>{r.label}</b> <code>{r.roleId}</code></span>
            <button className="btn-danger" onClick={() => del(r.roleId)}>删除</button>
          </li>
        ))}
      </ul>
      <div className="pane-form">
        <input placeholder="role id (如 logistics)" value={id} onChange={(e) => setId(e.target.value)} />
        <input placeholder="显示名 (如 物流)" value={label} onChange={(e) => setLabel(e.target.value)} />
        <button className="btn-primary" onClick={create} disabled={!id || !label}>新建角色</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: SkillsPane** (list + clone template + edit roles/tools/domains/playbook)

```tsx
import { useState, useEffect, useCallback } from "react";
import type { AdminClient, Skill, ToolInfo, Role } from "../../admin";

export function SkillsPane({ client }: { client: AdminClient }): JSX.Element {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [edit, setEdit] = useState<Skill | null>(null);
  const [err, setErr] = useState("");

  const load = useCallback(() => {
    client.listSkills().then(setSkills).catch((e) => setErr(String(e)));
    client.listTools().then(setTools).catch(() => {});
    client.listRoles().then(setRoles).catch(() => {});
  }, [client]);
  useEffect(load, [load]);

  const save = async () => {
    if (!edit) return;
    setErr("");
    try {
      await client.updateSkill(edit.skillId, edit);
      setEdit(null); load();
    } catch (e) { setErr(String(e)); }
  };
  const toggle = (arr: string[], v: string): string[] =>
    arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];

  return (
    <div className="pane">
      <h3 className="pane-title">技能</h3>
      {err && <div className="pane-err">{err}</div>}
      <ul className="pane-list">
        {skills.map((s) => (
          <li key={s.skillId} className="pane-row">
            <span><b>{s.name}</b> <code>{s.skillId}</code></span>
            <button className="btn" onClick={() => setEdit({ ...s })}>编辑</button>
          </li>
        ))}
      </ul>
      {edit && (
        <div className="skill-editor">
          <label>名称<input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></label>
          <label>剧本(playbook)
            <textarea rows={5} value={edit.playbookMd} onChange={(e) => setEdit({ ...edit, playbookMd: e.target.value })} />
          </label>
          <fieldset><legend>工具</legend>
            {tools.map((t) => (
              <label key={t.name} className="chk">
                <input type="checkbox" checked={edit.allowedTools.includes(t.name)}
                  onChange={() => setEdit({ ...edit, allowedTools: toggle(edit.allowedTools, t.name) })} />
                {t.name}{t.dataDomain ? <span className="warn"> ⚠ {t.dataDomain}</span> : null}
              </label>
            ))}
          </fieldset>
          <fieldset><legend>data domains (声明，非授权)</legend>
            {["cost", "pricing"].map((d) => (
              <label key={d} className="chk">
                <input type="checkbox" checked={edit.dataDomains.includes(d)}
                  onChange={() => setEdit({ ...edit, dataDomains: toggle(edit.dataDomains, d) })} />{d}
              </label>
            ))}
          </fieldset>
          <fieldset><legend>可用角色 (闸 A：能力)</legend>
            {roles.map((r) => (
              <label key={r.roleId} className="chk">
                <input type="checkbox" checked={edit.roles.includes(r.roleId)}
                  onChange={() => setEdit({ ...edit, roles: toggle(edit.roles, r.roleId) })} />{r.label}
              </label>
            ))}
          </fieldset>
          <div className="pane-form">
            <button className="btn-primary" onClick={save}>保存</button>
            <button className="btn" onClick={() => setEdit(null)}>取消</button>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: RulesPane, AssignPane, DomainsPane** (compact CRUD, same shape as RolesPane)

RulesPane: `getRules()` → editable ordered rows (comma-joined `match` ↔ `string[]`, `roleId` `<select>` from `listRoles`), add/remove row, `putRules(rules)` on save.
AssignPane: two clearly separated tables. Table ① skill×role reuses `updateSkill(id, {...skill, roles})` (Gate A). Table ② domain×role calls `addGrant/removeGrant` with `subject = "role:<tenant>/<roleId>#assignee"` (Gate B). Render them under distinct headings "① 能力：技能 → 角色" / "② 数据：数据域 → 角色" with a one-line note "能力 ≠ 数据". Tenant id comes from the logged-in Principal (pass as a prop).
DomainsPane: `listDomains()` → list domains + their grants; add/remove grant by subject (free-text or role dropdown).

Each pane: same `useEffect(load)` + `pane-err` pattern as RolesPane. Every mutating call is awaited then re-loads (server already reprojected).

- [ ] **Step 5: Append admin CSS to app.css**

```css
/* ---------- Admin ---------- */
.admin { display: grid; grid-template-columns: 150px 1fr; height: 100%; min-height: 0; }
.admin-nav { display: flex; flex-direction: column; gap: 2px; padding: 10px 8px; border-right: 1px solid var(--border); }
.admin-tab { text-align: left; padding: 8px 10px; border: none; border-radius: 6px; background: transparent; color: var(--text-secondary); font-size: 13px; }
.admin-tab:hover { background: var(--bg-hover); color: var(--text-primary); }
.admin-tab.active { background: var(--bg-active); color: var(--text-primary); }
.admin-body { overflow-y: auto; padding: 18px 22px; min-height: 0; }
.admin-denied { display: grid; place-items: center; height: 100%; color: var(--text-tertiary); font-size: 13px; padding: 24px; text-align: center; }
.pane { max-width: 640px; }
.pane-title { font-size: 15px; font-weight: 600; margin: 0 0 12px; }
.pane-err { color: #f2a7a9; background: var(--red-soft); padding: 7px 10px; border-radius: 6px; font-size: 12.5px; margin-bottom: 10px; }
.pane-list { list-style: none; padding: 0; margin: 0 0 14px; display: flex; flex-direction: column; gap: 1px; }
.pane-row { display: flex; align-items: center; justify-content: space-between; padding: 8px 10px; border: 1px solid var(--border); border-radius: 6px; font-size: 13px; }
.pane-row code { color: var(--text-tertiary); font-size: 11.5px; }
.pane-form { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.pane input, .pane textarea, .pane select { background: var(--bg-input); border: 1px solid var(--border-strong); border-radius: 6px; color: var(--text-primary); font: inherit; font-size: 13px; padding: 6px 9px; }
.pane textarea { width: 100%; resize: vertical; }
.pane label { display: block; font-size: 12.5px; color: var(--text-secondary); margin-bottom: 8px; }
.btn, .btn-primary, .btn-danger { border: 1px solid var(--border-strong); border-radius: 6px; padding: 6px 12px; font-size: 12.5px; background: var(--bg-elevated); color: var(--text-primary); }
.btn-primary { background: var(--accent); border-color: transparent; color: #fff; }
.btn-primary:disabled { opacity: 0.4; }
.btn-danger { color: #f2a7a9; }
.skill-editor { border: 1px solid var(--border); border-radius: var(--radius); padding: 14px; margin-top: 10px; }
.skill-editor fieldset { border: 1px solid var(--border); border-radius: 6px; margin: 8px 0; padding: 8px 10px; }
.skill-editor legend { font-size: 11.5px; color: var(--text-tertiary); padding: 0 4px; }
.chk { display: inline-flex; align-items: center; gap: 5px; margin: 3px 10px 3px 0; font-size: 12.5px; }
.chk .warn { color: var(--amber); }
```

- [ ] **Step 6: Typecheck**

Run: `cd desktop && npm run typecheck`
Expected: no errors. (Fix any prop-type mismatches; panes take `{ client: AdminClient }`, AssignPane/DomainsPane also `{ tenantId: string }`.)

- [ ] **Step 7: Commit**

```bash
git add desktop/src/renderer/src/components/admin/ desktop/src/renderer/src/app.css
git commit -m "feat(desktop): AdminView + roles/rules/skills/assign/domains panes"
```

---

### Task 12: App integration — gear entry + view switch

**Files:**
- Modify: `desktop/src/renderer/src/App.tsx`
- Modify: `desktop/src/renderer/src/components/TopBar.tsx`
- Modify: `desktop/src/renderer/src/agent.ts` (browser mock for `admin`)

- [ ] **Step 1: Add mock admin to agent.ts** (so browser preview + tests don't need Electron)

In `mockAgent`, add:

```ts
  async admin(req) {
    // Minimal in-memory mock for UI dev/screenshots only.
    if (req.path === "/admin/roles" && req.method === "GET")
      return { ok: true, data: [{ roleId: "sales", label: "销售", description: "" }, { roleId: "manager_tier", label: "管理层", description: "" }] };
    if (req.path === "/admin/tools") return { ok: true, data: [] };
    if (req.method !== "GET") return { ok: true, data: { ok: true } };
    return { ok: true, data: [] };
  },
```

- [ ] **Step 2: TopBar — add a view toggle**

Add props `view: "chat" | "admin"` and `onToggleView: () => void`. Render a button next to the kbd-btn:

```tsx
        <button className="kbd-btn" onClick={onToggleView} title="管理配置">
          {view === "chat" ? "⚙ 配置" : "← 聊天"}
        </button>
```

- [ ] **Step 3: App.tsx — wire view state + admin client**

```tsx
import { useMemo } from "react";
import { AdminView } from "./components/admin/AdminView";
import { makeAdminClient } from "./admin";
// ...
const [view, setView] = useState<"chat" | "admin">("chat");
const adminClient = useMemo(() => makeAdminClient((req) => agent.admin(req), userId), [userId]);
```

Pass `view` + `onToggleView={() => setView((v) => (v === "chat" ? "admin" : "chat"))}` to `TopBar`. In `<main>`, swap body:

```tsx
        {view === "chat" ? (
          <>
            <ChatView messages={active.messages} onExample={send} />
            <Composer disabled={busy} onSend={send} />
          </>
        ) : (
          <AdminView client={adminClient} />
        )}
```

(AssignPane/DomainsPane need `tenantId` — pass `"mock-corp-001"` or thread the Principal from a login call. For M6 demo, hardcode the tenant constant `MOCK_TENANT = "mock-corp-001"` in App and pass down.)

- [ ] **Step 4: Typecheck + build + test**

Run: `cd desktop && npm run typecheck && npm test && npm run build`
Expected: typecheck clean; vitest PASS (admin.test.ts + existing agentd.test/fsguard.test); build emits `out/`.

- [ ] **Step 5: Commit**

```bash
git add desktop/src/renderer/src/App.tsx desktop/src/renderer/src/components/TopBar.tsx desktop/src/renderer/src/agent.ts
git commit -m "feat(desktop): chat/admin view switch + gear entry"
```

---

## Phase M6e — Acceptance + docs

### Task 13: full-stack acceptance + dev.env + memory

**Files:**
- Modify: `backend/dev.env` (add DATA_DIR / CONFIG_DB / SKILL_DB)
- Modify: `backend/e2e/scenarios_test.go` (only if it referenced seedScenario internals — verify no change needed)
- Update memory: deploy-local-topology (config.db/skills.db locations)

- [ ] **Step 1: Full backend suite (gated, OpenFGA up)**

Run: `cd backend && docker compose up -d` then
`wsl -e bash -lc 'cd /mnt/d/merchantAgent/backend && export GOPROXY=https://goproxy.cn,direct GOSUMDB=off PATH="$PATH:$HOME/.local/bin" && go build ./... && go test ./... 2>&1 | tail -40'`
Expected: ALL packages PASS (config, skill, authz, wire, cmd/agentd, e2e). The existing `e2e/scenarios_test.go` + `wire/live_test.go` (客户360 / 同问不同权) must still pass — this proves the DB-driven projection didn't break the runtime/guard loop. **If any e2e fails, STOP and diagnose** (most likely `demoFixtures` vs old `seedScenario` mismatch).

- [ ] **Step 2: Add persistence config to dev.env**

Append to `backend/dev.env` (paths per deploy topology — WSL home):

```
DATA_DIR=/home/alvin/merchantagent/data
# or set explicitly:
# CONFIG_DB=/home/alvin/merchantagent/data/config.db
# SKILL_DB=/home/alvin/merchantagent/data/skills.db
```

- [ ] **Step 3: Manual acceptance run — the live authz/revocation loop**

1. Rebuild agentd in WSL, restart it sourcing dev.env (see deploy-local-topology memory). Ensure `mkdir -p /home/alvin/merchantagent/data`.
2. Launch desktop. Switch identity to "计划员" (u_plan, role=planner). Ask "帮我看下订单 SO-1001 的进度" → currently **no order360 skill** for planner → answer is "不可得/无权".
3. Switch to "老板" (u_boss, admin). Open ⚙ 配置 → 技能 → edit `order360` → check role **planner** → 保存.
4. Switch back to "计划员" → ask again → now the skill loads and it answers with status (Gate A opened live via reproject).
5. As admin, uncheck planner → 保存. Planner asks again → back to "不可得". **Revocation is live** — the differential reconcile deleted the `usable_by` tuple.
6. (Gate B) As admin, 分配 → ② 数据域→角色 → grant `cost` to `planner`. Confirm planner still can't see cost UNTIL a skill exposing `query_order_financials` is also assigned (proves capability ≠ data stay independent).

Record outcomes; if step 5 doesn't revoke, the reconcile isn't deleting — check `ReadTuples` returns the tuple and `Reconcile` computes the delete.

- [ ] **Step 4: Update memory**

Append to `deploy-local-topology.md`: config now persists to `DATA_DIR` (`config.db` + `skills.db`); first run seeds, later runs preserve admin edits; OpenFGA still re-projected fresh on every startup by `wire.Projector`. Note the acceptance loop above as the M6 smoke test.

- [ ] **Step 5: Final commit + mark M6 done**

```bash
git add backend/dev.env docs/
git commit -m "chore: M6 dev.env persistence config + acceptance notes; mark M6 done"
```

---

## Self-Review (completed by plan author)

**Spec coverage** — every §: §2 data model → Tasks 1–2; §2 projection conventions → Task 3; skill CRUD/clone → Task 4; §3 `ReadTuples` → Task 5; §3 Projector/desired/Reproject/demoFixtures + Assemble rewire (repays P0 debt) → Task 6; §4 requireAdmin + tools + routes → Task 7; §4 CRUD endpoints (two gates separate) → Task 8; §5 IPC channel → Task 9; §5 typed client → Task 10; §5 AdminView + 5 panes (two gates separate in AssignPane) → Task 11; §5 view switch + gear + mock → Task 12; §6 tests are embedded per-task; §6 e2e guard + acceptance loop → Task 13.

**Placeholder scan** — no TBD/TODO. UI panes in Task 11 Step 4 (Rules/Assign/Domains) are described by shape rather than full code to keep the plan bounded; each states exact client calls, subject format, and the RolesPane pattern to copy. Acceptable: they are mechanical repetitions of a fully-shown pattern.

**Type consistency** — `config.Store` methods bind tenant internally: `Roles/Rules/Domains/Grants(ctx)`, `CreateRole/UpdateRole/DeleteRole`, `ReplaceRules`, `AddGrant/RemoveGrant`. `skill.Store`: `Create/Update/Delete/CloneTemplate/ListTemplates/RemoveRoleFromAll/OpenFile`. `authz.Store.ReadTuples(ctx)`. `wire.Projector` fields `store/idp/cfg/sk/tenant/mu`; methods `desired/Reproject`; helpers `demoFixtures/dedupSort`. `Assembled` exports `Projector/Cfg/Sk/Conns`. Contract `AdminReq{method,path,userId,body?}` / `AdminResp`. Admin client method names match handlers' routes. Verified consistent across tasks.

**Known follow-ups (out of M6 scope):** tag-derived roles unmanaged in UI (still auto-projected); reproject-after-DB-write is not transactional across the two stores (a reproject failure leaves DB ahead of OpenFGA until next write/restart — acceptable for demo, noted in Task 8 `reproject`).

