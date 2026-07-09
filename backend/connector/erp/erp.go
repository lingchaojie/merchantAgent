// Package erp is a SQLite-backed mock ERP connector (Phase 1). It replaces the
// Phase 0 YAML mockerp with a real relational store the tools query via
// PARAMETERIZED READ-ONLY SQL — never LLM-authored SQL (design §5.2). A real
// Kingdee/用友 connector (clean API) or an on-prem read-only DB gateway swaps in
// behind the same connector.Connector interface (design §9).
package erp

import (
	"database/sql"
	_ "embed"
	"fmt"

	"github.com/merchantagent/backend/connector"
	_ "modernc.org/sqlite" // pure-Go driver (no cgo → clean Windows builds)
)

//go:embed schema.sql
var schemaSQL string

//go:embed seed.sql
var seedSQL string

// ERP is the connector. It owns an in-memory SQLite DB seeded at Open and put
// into query_only mode so tool code can only read (defense in depth on top of
// "tools issue parameterized SELECTs only").
type ERP struct {
	db *sql.DB
}

// Open creates an in-memory ERP, applies schema + seed, then locks it read-only.
// The single connection is kept (MaxOpenConns=1) so ":memory:" state persists.
func Open() (*ERP, error) {
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		return nil, fmt.Errorf("open erp sqlite: %w", err)
	}
	db.SetMaxOpenConns(1) // in-memory DB lives on one connection
	if _, err := db.Exec(schemaSQL); err != nil {
		db.Close()
		return nil, fmt.Errorf("erp schema: %w", err)
	}
	if _, err := db.Exec(seedSQL); err != nil {
		db.Close()
		return nil, fmt.Errorf("erp seed: %w", err)
	}
	// Read-only from here on: any INSERT/UPDATE/DELETE now errors.
	if _, err := db.Exec("PRAGMA query_only = ON"); err != nil {
		db.Close()
		return nil, fmt.Errorf("erp query_only: %w", err)
	}
	return &ERP{db: db}, nil
}

func (e *ERP) Close() error { return e.db.Close() }

func (e *ERP) Name() string { return "mock-erp" }

func (e *ERP) Tools() []connector.Tool {
	return []connector.Tool{
		&statusTool{e}, &financialsTool{e}, &kittingTool{e}, &customerOrdersTool{e},
	}
}
