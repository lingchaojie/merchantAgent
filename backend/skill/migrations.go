package skill

import (
	"database/sql"
	"embed"
	"fmt"
	"io/fs"
	"path"
	"sort"
	"strconv"
	"strings"
)

//go:embed migrations/*.sql
var migrationFiles embed.FS

type migration struct {
	version int
	path    string
}

func applyMigrations(db *sql.DB) error {
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
		version INTEGER PRIMARY KEY
	)`); err != nil {
		return fmt.Errorf("create skill migrations table: %w", err)
	}

	paths, err := fs.Glob(migrationFiles, "migrations/*.sql")
	if err != nil {
		return fmt.Errorf("list skill migrations: %w", err)
	}
	migrations := make([]migration, 0, len(paths))
	for _, file := range paths {
		prefix, _, ok := strings.Cut(path.Base(file), "_")
		if !ok {
			return fmt.Errorf("invalid skill migration filename %q", file)
		}
		version, err := strconv.Atoi(prefix)
		if err != nil {
			return fmt.Errorf("invalid skill migration version in %q: %w", file, err)
		}
		migrations = append(migrations, migration{version: version, path: file})
	}
	sort.Slice(migrations, func(i, j int) bool { return migrations[i].version < migrations[j].version })
	for i := 1; i < len(migrations); i++ {
		if migrations[i-1].version == migrations[i].version {
			return fmt.Errorf("duplicate skill migration version %d", migrations[i].version)
		}
	}

	for _, m := range migrations {
		var applied bool
		if err := db.QueryRow(`SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version = ?)`, m.version).Scan(&applied); err != nil {
			return fmt.Errorf("check skill migration %d: %w", m.version, err)
		}
		if applied {
			continue
		}
		body, err := migrationFiles.ReadFile(m.path)
		if err != nil {
			return fmt.Errorf("read skill migration %d: %w", m.version, err)
		}
		tx, err := db.Begin()
		if err != nil {
			return fmt.Errorf("begin skill migration %d: %w", m.version, err)
		}
		if _, err := tx.Exec(string(body)); err != nil {
			tx.Rollback()
			return fmt.Errorf("apply skill migration %d: %w", m.version, err)
		}
		if _, err := tx.Exec(`INSERT INTO schema_migrations(version) VALUES (?)`, m.version); err != nil {
			tx.Rollback()
			return fmt.Errorf("record skill migration %d: %w", m.version, err)
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("commit skill migration %d: %w", m.version, err)
		}
	}
	return nil
}
