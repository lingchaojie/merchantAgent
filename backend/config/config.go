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
	"strings"
	"unicode"

	_ "modernc.org/sqlite"
)

//go:embed schema.sql
var schemaSQL string

//go:embed seed.sql
var seedSQL string

// Role is an admin-defined role a user or department can be assigned.
type Role struct {
	RoleID      string `json:"roleId"`
	Label       string `json:"label"`
	Description string `json:"description"`
}

// Rule maps a position title to a role: if any Match substring occurs in the
// title, RoleID applies. Evaluation order is the slice/row position (first
// match wins); there is no explicit ordinal field on the struct.
type Rule struct {
	Match  []string `json:"match"`
	RoleID string   `json:"roleId"`
}

// Domain is an admin-defined data domain that data-domain grants gate access to.
type Domain struct {
	DomainID string `json:"domainId"`
	Label    string `json:"label"`
}

// Grant gives a subject access to a data domain (subject is a full OpenFGA subject string).
type Grant struct {
	DomainID string `json:"domainId"`
	Subject  string `json:"subject"`
}

// Store is the SQLite-backed config registry for a single tenant.
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
		// Guard on data_domains, not roles: admins can delete every role (see
		// DeleteRole), so an empty roles table is a legitimate post-edit state,
		// not a fresh DB — re-seeding then would UNIQUE-crash on the still-
		// populated data_domains/domain_grants. data_domains has no admin CRUD
		// (only its grants are editable, never the domain rows), so it's a stable
		// seed-only sentinel that's never emptied.
		var n int
		if err := db.QueryRow(`SELECT COUNT(*) FROM data_domains WHERE tenant_id = ?`, tenant).Scan(&n); err != nil {
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

// CreateRole inserts a role. The role id must pass validID: it is embedded into
// the OpenFGA object string "role:<tenant>/<roleId>", and OpenFGA rejects object
// ids containing whitespace, ':' or '#'. Without this guard a bad id would COMMIT
// here, then fail every Reproject; boot-time Reproject failure is fatal (main.go
// log.Fatalf), so a persisted bad id bricks the next agentd restart — the same
// rationale as validSubject on grants.
func (s *Store) CreateRole(ctx context.Context, r Role) error {
	if r.RoleID == "" || r.Label == "" {
		return fmt.Errorf("role id and label required")
	}
	if !validID(r.RoleID) {
		return fmt.Errorf("invalid role id %q: no spaces, ':' or '#'", r.RoleID)
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

// DeleteRole removes the role and cascades the config-owned references: it drops
// its data-domain grants and its position->role rules (a dangling rule would, on
// the next reproject, re-assign matching users to a now-deleted role and
// resurrect its authz edges). Removing the role from every skill's roles list is
// handled by the caller (agentd) via the skill store.
func (s *Store) DeleteRole(ctx context.Context, id string) error {
	subj := fmt.Sprintf("role:%s/%s#assignee", s.tenant, id)
	if _, err := s.db.ExecContext(ctx, `DELETE FROM domain_grants WHERE tenant_id=? AND subject=?`, s.tenant, subj); err != nil {
		return err
	}
	if _, err := s.db.ExecContext(ctx, `DELETE FROM role_rules WHERE tenant_id=? AND role_id=?`, s.tenant, id); err != nil {
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
	if err := validSubject(subject); err != nil {
		return err
	}
	_, err := s.db.ExecContext(ctx,
		`INSERT OR IGNORE INTO domain_grants (tenant_id, domain_id, subject) VALUES (?,?,?)`,
		s.tenant, domain, subject)
	return err
}

// validSubject checks the structural OpenFGA subject shape "type:id[#relation]":
// a non-empty type before the colon, a non-empty id after it, and (if a "#" is
// present) a non-empty relation. This is the store-level choke point that keeps a
// malformed subject from persisting — a bad grant would otherwise fail every
// Reproject, and boot-time Reproject failure is fatal (bricks a restart). We do
// NOT whitelist the type here; just the shape.
func validSubject(subject string) error {
	id := subject
	if h := strings.IndexByte(id, '#'); h >= 0 {
		if h == len(id)-1 {
			return fmt.Errorf("invalid subject %q: empty relation after #", subject)
		}
		id = id[:h]
	}
	typ, rest, ok := strings.Cut(id, ":")
	if !ok || typ == "" || rest == "" {
		return fmt.Errorf("invalid subject %q: want type:id[#relation]", subject)
	}
	return nil
}

// validID reports whether s is usable as the id component of an OpenFGA object
// string ("role:<tenant>/<id>"). It rejects an empty id or one containing
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

func (s *Store) RemoveGrant(ctx context.Context, domain, subject string) error {
	_, err := s.db.ExecContext(ctx,
		`DELETE FROM domain_grants WHERE tenant_id=? AND domain_id=? AND subject=?`,
		s.tenant, domain, subject)
	return err
}
