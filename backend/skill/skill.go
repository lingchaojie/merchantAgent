// Package skill is the skill registry (design §3): the authorable capability
// unit = a scenario playbook + the tools it may call + the roles that may use it.
// Rows here are the single source that skill.Tuples projects into OpenFGA (which
// roles may use a skill, which tools it exposes), mirroring org→tuples. The
// runtime loads playbooks by progressive disclosure (M3); this package owns
// storage + projection only.
package skill

import (
	"context"
	"database/sql"
	_ "embed"
	"encoding/json"
	"fmt"
	"unicode"

	_ "modernc.org/sqlite"
)

//go:embed schema.sql
var schemaSQL string

//go:embed seed.sql
var seedSQL string

// Skill is a tenant's authored scenario playbook.
type Skill struct {
	TenantID       string   `json:"tenantId"`
	SkillID        string   `json:"skillId"`
	Name           string   `json:"name"`
	Description    string   `json:"description"`
	PlaybookMD     string   `json:"playbookMd"`
	AllowedTools   []string `json:"allowedTools"`
	DataDomains    []string `json:"dataDomains"` // advisory only (NOT a grant)
	Roles          []string `json:"roles"`       // role ids that may use it
	SourceTemplate string   `json:"sourceTemplateId,omitempty"`
}

// Template is a platform starter skill an admin clones from.
type Template struct {
	TemplateID     string   `json:"templateId"`
	Name           string   `json:"name"`
	Description    string   `json:"description"`
	PlaybookMD     string   `json:"playbookMd"`
	AllowedTools   []string `json:"allowedTools"`
	DataDomains    []string `json:"dataDomains"`
	SuggestedRoles []string `json:"suggestedRoles"`
}

// Store is the SQLite-backed registry. Writable (M6 admin CRUD builds on it).
type Store struct{ db *sql.DB }

// Open creates an in-memory registry and applies schema + seed.
func Open() (*Store, error) {
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		return nil, fmt.Errorf("open skill sqlite: %w", err)
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(schemaSQL); err != nil {
		db.Close()
		return nil, fmt.Errorf("skill schema: %w", err)
	}
	if _, err := db.Exec(seedSQL); err != nil {
		db.Close()
		return nil, fmt.Errorf("skill seed: %w", err)
	}
	return &Store{db: db}, nil
}

// OpenFile opens/creates a file-backed skill registry, seeding only a fresh DB
// so admin edits survive restart. Mirrors config.OpenFile.
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
	// Guard on templates, not skills: templates is populated only by seed and
	// has no CRUD, so it's a stable sentinel. Guarding on skills would re-run
	// seed.sql after an admin deletes every skill and crash on the templates
	// UNIQUE constraint.
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM templates`).Scan(&n); err != nil {
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

func (s *Store) Close() error { return s.db.Close() }

// List returns all skills for a tenant.
func (s *Store) List(ctx context.Context, tenantID string) ([]Skill, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT skill_id, name, description, playbook_md, allowed_tools, data_domains, roles, COALESCE(source_template_id,'')
		 FROM skills WHERE tenant_id = ? ORDER BY skill_id`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Skill
	for rows.Next() {
		sk := Skill{TenantID: tenantID}
		var tools, domains, roles string
		if err := rows.Scan(&sk.SkillID, &sk.Name, &sk.Description, &sk.PlaybookMD, &tools, &domains, &roles, &sk.SourceTemplate); err != nil {
			return nil, err
		}
		if err := jsonArr(tools, &sk.AllowedTools); err != nil {
			return nil, err
		}
		if err := jsonArr(domains, &sk.DataDomains); err != nil {
			return nil, err
		}
		if err := jsonArr(roles, &sk.Roles); err != nil {
			return nil, err
		}
		out = append(out, sk)
	}
	return out, rows.Err()
}

func jsonArr(s string, dst *[]string) error {
	if s == "" {
		return nil
	}
	return json.Unmarshal([]byte(s), dst)
}

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

// Create inserts a skill. The skill id must pass validID: it is embedded into the
// OpenFGA object string "skill:<tenant>/<skillId>", and OpenFGA rejects object ids
// containing whitespace, ':' or '#'. Without this guard a bad id would COMMIT here,
// then fail every Tuples/Reproject; boot-time Reproject failure is fatal (main.go
// log.Fatalf), so a persisted bad id bricks the next agentd restart.
func (s *Store) Create(ctx context.Context, sk Skill) error {
	if sk.SkillID == "" || sk.Name == "" {
		return fmt.Errorf("skill id and name required")
	}
	if !validID(sk.SkillID) {
		return fmt.Errorf("invalid skill id %q: no spaces, ':' or '#'", sk.SkillID)
	}
	return writeSkill(ctx, s.db, sk, true)
}

// validID reports whether s is usable as the id component of an OpenFGA object
// string ("skill:<tenant>/<id>"). It rejects an empty id or one containing
// whitespace, ':' or '#' — the characters that would break the type:id object
// form or fail OpenFGA's object-id validation. Structural only, no whitelist.
func validID(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r == ':' || r == '#' || unicode.IsSpace(r) {
			return false
		}
	}
	return true
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
// it thereafter (design §3.5). Returns the new skill id: templateId, or
// templateId + "-N" if that id is already taken.
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
