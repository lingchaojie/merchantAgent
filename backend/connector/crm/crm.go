// Package crm is a SQLite-backed mock CRM connector (Phase 1). It is a SEPARATE
// system from ERP (separate connector + DB), so the runtime composing both proves
// cross-system aggregation (design §5.1, 客户360). Same read-only discipline as
// erp: parameterized SELECTs only, query_only after seed.
package crm

import (
	"database/sql"
	_ "embed"
	"fmt"

	"github.com/merchantagent/backend/connector"
	_ "modernc.org/sqlite"
)

//go:embed schema.sql
var schemaSQL string

//go:embed seed.sql
var seedSQL string

// CRM is the connector.
type CRM struct {
	db *sql.DB
}

// Open creates an in-memory CRM, applies schema + seed, then locks it read-only.
func Open() (*CRM, error) {
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		return nil, fmt.Errorf("open crm sqlite: %w", err)
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(schemaSQL); err != nil {
		db.Close()
		return nil, fmt.Errorf("crm schema: %w", err)
	}
	if _, err := db.Exec(seedSQL); err != nil {
		db.Close()
		return nil, fmt.Errorf("crm seed: %w", err)
	}
	if _, err := db.Exec("PRAGMA query_only = ON"); err != nil {
		db.Close()
		return nil, fmt.Errorf("crm query_only: %w", err)
	}
	return &CRM{db: db}, nil
}

func (c *CRM) Close() error { return c.db.Close() }

func (c *CRM) Name() string { return "mock-crm" }

func (c *CRM) Tools() []connector.Tool {
	return []connector.Tool{
		&contactsTool{c}, &followupsTool{c}, &opportunitiesTool{c},
	}
}
