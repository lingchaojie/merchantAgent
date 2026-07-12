package connectorregistry

import (
	"context"
	"database/sql"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"time"
	"unicode/utf8"

	"github.com/merchantagent/backend/connector"
	_ "modernc.org/sqlite"
)

//go:embed schema.sql
var schemaSQL string

var (
	digestPattern     = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
	routeIDPattern    = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`)
	versionPattern    = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$`)
	identifierPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`)
	fgaNamePattern    = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,63}$`)
)

type Store struct {
	db *sql.DB
}

func Open(path string) (*Store, error) {
	if path == "" {
		return nil, fmt.Errorf("open connector registry: path is required")
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("open connector registry sqlite: %w", err)
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(schemaSQL); err != nil {
		db.Close()
		return nil, fmt.Errorf("connector registry schema: %w", err)
	}
	return &Store{db: db}, nil
}

func (s *Store) Close() error {
	return s.db.Close()
}

func (s *Store) Submit(ctx context.Context, submission Submission) error {
	v := submission.Version
	if err := validateSubmission(v, submission.ActorID); err != nil {
		return err
	}
	contractJSON, err := json.Marshal(v.Contract)
	if err != nil {
		return fmt.Errorf("marshal public connector contract: %w", err)
	}
	checksJSON, err := json.Marshal(v.Checks)
	if err != nil {
		return fmt.Errorf("marshal connector check summary: %w", err)
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin connector submission: %w", err)
	}
	defer tx.Rollback()

	var existingVersion string
	err = tx.QueryRowContext(ctx, `SELECT version FROM connector_versions
		WHERE tenant_id = ? AND connector_id = ? AND (version = ? OR digest = ?)
		LIMIT 1`, v.TenantID, v.ConnectorID, v.Version, v.Digest).Scan(&existingVersion)
	switch {
	case err == nil:
		return fmt.Errorf("%w: %s/%s", ErrImmutableVersion, v.ConnectorID, existingVersion)
	case !errors.Is(err, sql.ErrNoRows):
		return fmt.Errorf("check immutable connector version: %w", err)
	}

	now := time.Now().UTC()
	stamp := now.Format(time.RFC3339Nano)
	_, err = tx.ExecContext(ctx, `INSERT INTO connector_versions (
		tenant_id, connector_id, version, digest, adapter, environment,
		public_contract_json, check_summary_json, implementation_credential_id,
		device_id, submitted_by, approved_by, status, created_at, updated_at
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?)`,
		v.TenantID, v.ConnectorID, v.Version, v.Digest, v.Adapter, v.Environment,
		string(contractJSON), string(checksJSON), v.ImplementationCredentialID,
		v.DeviceID, submission.ActorID, StatusPendingApproval, stamp, stamp)
	if err != nil {
		return fmt.Errorf("insert connector version: %w", err)
	}
	if err := insertLifecycleEvent(ctx, tx, v.TenantID, v.ConnectorID, v.Version, v.Digest, submission.ActorID, "", StatusPendingApproval, stamp); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit connector submission: %w", err)
	}
	return nil
}

func (s *Store) List(ctx context.Context, tenant string) ([]Version, error) {
	return s.list(ctx, tenant, "")
}

func (s *Store) Published(ctx context.Context, tenant string) ([]Version, error) {
	return s.list(ctx, tenant, StatusPublished)
}

func (s *Store) list(ctx context.Context, tenant string, status Status) ([]Version, error) {
	query := `SELECT tenant_id, connector_id, version, digest, adapter, environment,
		public_contract_json, check_summary_json, implementation_credential_id,
		device_id, submitted_by, approved_by, status, created_at, updated_at
		FROM connector_versions WHERE tenant_id = ?`
	args := []any{tenant}
	if status != "" {
		query += ` AND status = ?`
		args = append(args, status)
	}
	query += ` ORDER BY connector_id, version`

	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list connector versions: %w", err)
	}
	defer rows.Close()
	out := []Version{}
	for rows.Next() {
		var v Version
		var contractJSON, checksJSON, statusText, createdAt, updatedAt string
		if err := rows.Scan(
			&v.TenantID, &v.ConnectorID, &v.Version, &v.Digest, &v.Adapter, &v.Environment,
			&contractJSON, &checksJSON, &v.ImplementationCredentialID, &v.DeviceID,
			&v.SubmittedBy, &v.ApprovedBy, &statusText, &createdAt, &updatedAt,
		); err != nil {
			return nil, fmt.Errorf("scan connector version: %w", err)
		}
		v.Status = Status(statusText)
		if err := json.Unmarshal([]byte(contractJSON), &v.Contract); err != nil {
			return nil, fmt.Errorf("decode public connector contract: %w", err)
		}
		if err := json.Unmarshal([]byte(checksJSON), &v.Checks); err != nil {
			return nil, fmt.Errorf("decode connector check summary: %w", err)
		}
		v.CreatedAt, err = time.Parse(time.RFC3339Nano, createdAt)
		if err != nil {
			return nil, fmt.Errorf("decode connector created timestamp: %w", err)
		}
		v.UpdatedAt, err = time.Parse(time.RFC3339Nano, updatedAt)
		if err != nil {
			return nil, fmt.Errorf("decode connector updated timestamp: %w", err)
		}
		out = append(out, v)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list connector versions: %w", err)
	}
	return out, nil
}

func (s *Store) Transition(ctx context.Context, transition Transition) error {
	if transition.TenantID == "" || transition.ConnectorID == "" || transition.Version == "" || transition.Digest == "" || transition.ActorID == "" {
		return fmt.Errorf("%w: transition identity, digest, and actor are required", ErrInvalidVersion)
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin connector transition: %w", err)
	}
	defer tx.Rollback()

	var fromText, storedDigest string
	err = tx.QueryRowContext(ctx, `SELECT status, digest FROM connector_versions
		WHERE tenant_id = ? AND connector_id = ? AND version = ?`,
		transition.TenantID, transition.ConnectorID, transition.Version).Scan(&fromText, &storedDigest)
	if errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("%w: %s/%s", ErrVersionNotFound, transition.ConnectorID, transition.Version)
	}
	if err != nil {
		return fmt.Errorf("read connector transition state: %w", err)
	}
	if storedDigest != transition.Digest {
		return fmt.Errorf("%w: %s/%s", ErrDigestMismatch, transition.ConnectorID, transition.Version)
	}
	from := Status(fromText)
	if !legalTransition(from, transition.To) {
		return fmt.Errorf("%w: %s to %s", ErrIllegalTransition, from, transition.To)
	}

	now := time.Now().UTC().Format(time.RFC3339Nano)
	approvedBy := `approved_by`
	args := []any{transition.To, now}
	if transition.To == StatusPublished {
		approvedBy = `?`
		args = append(args, transition.ActorID)
	}
	args = append(args, transition.TenantID, transition.ConnectorID, transition.Version, transition.Digest, from)
	result, err := tx.ExecContext(ctx, `UPDATE connector_versions
		SET status = ?, updated_at = ?, approved_by = `+approvedBy+`
		WHERE tenant_id = ? AND connector_id = ? AND version = ? AND digest = ? AND status = ?`, args...)
	if err != nil {
		return fmt.Errorf("update connector lifecycle: %w", err)
	}
	if changed, err := result.RowsAffected(); err != nil || changed != 1 {
		if err != nil {
			return fmt.Errorf("read connector transition result: %w", err)
		}
		return fmt.Errorf("%w: concurrent state change", ErrIllegalTransition)
	}
	if err := insertLifecycleEvent(ctx, tx, transition.TenantID, transition.ConnectorID, transition.Version, transition.Digest, transition.ActorID, from, transition.To, now); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit connector transition: %w", err)
	}
	return nil
}

func insertLifecycleEvent(ctx context.Context, tx *sql.Tx, tenant, connectorID, version, digest, actor string, from, to Status, occurredAt string) error {
	_, err := tx.ExecContext(ctx, `INSERT INTO connector_lifecycle_events
		(tenant_id, connector_id, version, digest, actor_id, from_status, to_status, occurred_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, tenant, connectorID, version, digest, actor, from, to, occurredAt)
	if err != nil {
		return fmt.Errorf("append connector lifecycle event: %w", err)
	}
	return nil
}

func legalTransition(from, to Status) bool {
	switch from {
	case StatusPendingApproval:
		return to == StatusPublished || to == StatusRevoked
	case StatusPublished:
		return to == StatusSuspended || to == StatusRevoked
	case StatusSuspended:
		return to == StatusPublished || to == StatusRevoked
	default:
		return false
	}
}

func validateSubmission(v Version, actor string) error {
	if v.TenantID == "" || v.ConnectorID == "" || v.Version == "" || actor == "" {
		return invalidVersion("tenant, connector, version, and actor are required")
	}
	if !routeIDPattern.MatchString(v.TenantID) || !routeIDPattern.MatchString(v.ConnectorID) {
		return invalidVersion("tenant and connector IDs must be route-safe identifiers of at most 64 characters")
	}
	if !versionPattern.MatchString(v.Version) {
		return invalidVersion("version must be route-safe and at most 64 characters")
	}
	if v.ImplementationCredentialID == "" || v.DeviceID == "" {
		return invalidVersion("implementation credential and device are required")
	}
	if v.Adapter != "sqlserver" {
		return invalidVersion("adapter must be sqlserver")
	}
	if v.Environment != "test" && v.Environment != "preproduction" {
		return invalidVersion("environment must be test or preproduction")
	}
	if !digestPattern.MatchString(v.Digest) {
		return invalidVersion("digest must be sha256 followed by 64 lowercase hexadecimal characters")
	}
	if v.Checks.CheckerVersion == "" || v.Checks.RulesetVersion == "" || !digestPattern.MatchString(v.Checks.TestsDigest) {
		return invalidVersion("complete check metadata with a valid tests digest is required")
	}
	if len(v.Contract.Tools) == 0 {
		return invalidVersion("at least one tool is required")
	}
	toolNames := make(map[string]struct{}, len(v.Contract.Tools))
	for i, tool := range v.Contract.Tools {
		if err := validateToolContract(tool, toolNames); err != nil {
			return invalidVersion("tool %d: %v", i, err)
		}
	}
	return nil
}

func validateToolContract(tool ToolContract, toolNames map[string]struct{}) error {
	if tool.Name == "" || tool.Description == "" {
		return errors.New("name and description are required")
	}
	if !identifierPattern.MatchString(tool.Name) {
		return errors.New("name must be a provider-safe identifier of at most 64 characters")
	}
	if _, exists := toolNames[tool.Name]; exists {
		return fmt.Errorf("duplicate tool name %q", tool.Name)
	}
	toolNames[tool.Name] = struct{}{}
	if tool.ResourceType == "" || tool.ResourceKind == "" || tool.ResourceArg == "" || tool.ResourceRelation == "" || tool.DataDomain == "" {
		return errors.New("complete resource authorization metadata is required")
	}
	for label, value := range map[string]string{"resource type": tool.ResourceType, "resource relation": tool.ResourceRelation} {
		if !fgaNamePattern.MatchString(value) {
			return fmt.Errorf("%s must be an OpenFGA-safe identifier of at most 64 characters", label)
		}
	}
	for label, value := range map[string]string{
		"resource kind": tool.ResourceKind, "resource argument": tool.ResourceArg, "data domain": tool.DataDomain,
	} {
		if !identifierPattern.MatchString(value) {
			return fmt.Errorf("%s must be an authorization-safe identifier of at most 64 characters", label)
		}
	}
	switch tool.Risk {
	case connector.RiskRead:
		if tool.RequiresConfirmation {
			return errors.New("read tools cannot require confirmation")
		}
	case connector.RiskLowWrite:
		if !tool.RequiresConfirmation {
			return errors.New("low-write tools must require confirmation")
		}
	default:
		return fmt.Errorf("unsupported risk %q", tool.Risk)
	}
	if tool.TimeoutMS <= 0 {
		return errors.New("timeout must be positive")
	}
	if tool.MaxResults <= 0 || tool.MaxResults > 100 {
		return errors.New("max results must be between 1 and 100")
	}
	params := make(map[string]ParamContract, len(tool.Params))
	for _, param := range tool.Params {
		if param.Name == "" || param.Description == "" {
			return errors.New("parameter name and description are required")
		}
		if !identifierPattern.MatchString(param.Name) {
			return fmt.Errorf("parameter name %q is not provider-safe", param.Name)
		}
		if _, exists := params[param.Name]; exists {
			return fmt.Errorf("duplicate parameter %q", param.Name)
		}
		if err := validateParamContract(param); err != nil {
			return fmt.Errorf("parameter %q: %w", param.Name, err)
		}
		params[param.Name] = param
	}
	resourceParam, exists := params[tool.ResourceArg]
	if !exists || !resourceParam.Required {
		return errors.New("resource argument must name a required parameter")
	}
	if len(tool.ResultFields) == 0 {
		return errors.New("at least one result field is required")
	}
	fields := make(map[string]struct{}, len(tool.ResultFields))
	for _, field := range tool.ResultFields {
		if field == "" {
			return errors.New("result fields cannot be empty")
		}
		if !identifierPattern.MatchString(field) {
			return fmt.Errorf("result field %q is not provider-safe", field)
		}
		if _, exists := fields[field]; exists {
			return fmt.Errorf("duplicate result field %q", field)
		}
		fields[field] = struct{}{}
	}
	return nil
}

func validateParamContract(param ParamContract) error {
	if param.MinLength != nil && *param.MinLength < 0 || param.MaxLength != nil && *param.MaxLength < 0 {
		return errors.New("length constraints cannot be negative")
	}
	if param.MinLength != nil && param.MaxLength != nil && *param.MinLength > *param.MaxLength {
		return errors.New("minimum length exceeds maximum length")
	}
	if param.Minimum != nil && param.Maximum != nil && *param.Minimum > *param.Maximum {
		return errors.New("minimum exceeds maximum")
	}
	switch param.Type {
	case connector.ParamString:
		if param.Minimum != nil || param.Maximum != nil {
			return errors.New("string parameters cannot use numeric constraints")
		}
		for _, value := range param.Enum {
			text, ok := value.(string)
			if !ok {
				return errors.New("string enum contains a non-string value")
			}
			length := utf8.RuneCountInString(text)
			if param.MinLength != nil && length < *param.MinLength || param.MaxLength != nil && length > *param.MaxLength {
				return errors.New("string enum value is outside length constraints")
			}
		}
	case connector.ParamInteger:
		if param.MinLength != nil || param.MaxLength != nil {
			return errors.New("integer parameters cannot use length constraints")
		}
		for _, value := range param.Enum {
			n, ok := integerValue(value)
			if !ok {
				return errors.New("integer enum contains a non-integer value")
			}
			if param.Minimum != nil && n < int64(*param.Minimum) || param.Maximum != nil && n > int64(*param.Maximum) {
				return errors.New("integer enum value is outside numeric constraints")
			}
		}
	case connector.ParamBoolean:
		if param.MinLength != nil || param.MaxLength != nil || param.Minimum != nil || param.Maximum != nil {
			return errors.New("boolean parameters cannot use length or numeric constraints")
		}
		for _, value := range param.Enum {
			if _, ok := value.(bool); !ok {
				return errors.New("boolean enum contains a non-boolean value")
			}
		}
	default:
		return fmt.Errorf("unsupported type %q", param.Type)
	}
	return nil
}

func integerValue(value any) (int64, bool) {
	switch n := value.(type) {
	case int:
		return int64(n), true
	case int8:
		return int64(n), true
	case int16:
		return int64(n), true
	case int32:
		return int64(n), true
	case int64:
		return n, true
	case uint:
		if uint64(n) <= math.MaxInt64 {
			return int64(n), true
		}
	case uint8:
		return int64(n), true
	case uint16:
		return int64(n), true
	case uint32:
		return int64(n), true
	case uint64:
		if n <= math.MaxInt64 {
			return int64(n), true
		}
	case float64:
		if n >= math.MinInt64 && n <= math.MaxInt64 && n == math.Trunc(n) {
			return int64(n), true
		}
	}
	return 0, false
}

func invalidVersion(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrInvalidVersion, fmt.Sprintf(format, args...))
}
