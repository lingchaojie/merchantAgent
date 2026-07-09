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
