// Package config is the M6 admin-editable authorization config (roles, position
// -> role rules, data domains, and data-domain grants). Rows here are a source
// of truth that wire.Projector projects into OpenFGA tuples, mirroring org sync
// and the skill registry. Persisted to a file DB so admin edits survive restart;
// seeded once on a fresh DB and never clobbered thereafter.
package config

import (
	"database/sql"
	_ "embed"
	"fmt"

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
