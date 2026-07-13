// Package runtime is the deterministic agent loop: route intent → authorize
// (research/11 §6.1) → invoke connector tool → format answer, with a
// tamper-evident audit trail. It talks only to the connector interface and an
// authz Checker, so it's decoupled from both the specific ERP and OpenFGA.
package runtime

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"sync"
	"time"
)

const auditIdentifierKeySize = 32

var connectorAuditMetricMaximum = map[string]int64{
	"completionRate": 100,
	"version":        math.MaxInt32,
}

// ConnectorAudit is the public, non-sensitive execution record for a desktop
// connector. Package and authorization identity are derived by the backend;
// private source implementation details are intentionally absent.
type ConnectorAudit struct {
	ConnectorID          string         `json:"connectorId"`
	Version              string         `json:"version"`
	Digest               string         `json:"digest"`
	Adapter              string         `json:"adapter"`
	SourceProfileID      string         `json:"sourceProfileId,omitempty"`
	Environment          string         `json:"environment"`
	DeviceID             string         `json:"deviceId"`
	ResourceKind         string         `json:"resourceKind"`
	ResourceID           string         `json:"resourceId"`
	ResourceRelation     string         `json:"resourceRelation"`
	ApprovalVersion      string         `json:"approvalVersion"`
	IdempotencyKeyID     string         `json:"idempotencyKeyId,omitempty"`
	RequestFingerprintID string         `json:"requestFingerprintId"`
	ExecutionStatus      string         `json:"executionStatus"`
	ReadBackStatus       string         `json:"readBackStatus,omitempty"`
	DurationMS           int64          `json:"durationMs"`
	Before               map[string]any `json:"before,omitempty"`
	After                map[string]any `json:"after,omitempty"`

	idempotencyKeyMaterial     []byte
	requestFingerprintMaterial []byte
}

// AuditEntry is one recorded agent action. Entries are hash-chained: each
// entry's Hash covers the previous Hash, so any tampering breaks the chain.
type AuditEntry struct {
	Seq               int             `json:"seq"`
	Time              time.Time       `json:"time"`
	TenantID          string          `json:"tenantId"`
	UserID            string          `json:"userId"`
	Question          string          `json:"question"`
	SkillID           string          `json:"skillId,omitempty"`
	RoleIDs           []string        `json:"roleIds,omitempty"`
	DeviceID          string          `json:"deviceId,omitempty"`
	Tool              string          `json:"tool"`
	ToolCallID        string          `json:"toolCallId,omitempty"`
	ToolVersion       string          `json:"toolVersion,omitempty"`
	ExecutionLocation string          `json:"executionLocation,omitempty"`
	Risk              string          `json:"risk,omitempty"`
	Args              map[string]any  `json:"args"`
	Decision          string          `json:"decision"` // "allow" | "deny"
	Status            string          `json:"status,omitempty"`
	Reason            string          `json:"reason"`
	ExecutionID       string          `json:"executionId,omitempty"`
	IdempotencyKey    string          `json:"idempotencyKey,omitempty"`
	Confirmed         bool            `json:"confirmed"`
	ConfirmedAt       string          `json:"confirmedAt,omitempty"`
	ResourceID        string          `json:"resourceId,omitempty"`
	Before            map[string]any  `json:"before,omitempty"`
	After             map[string]any  `json:"after,omitempty"`
	Connector         *ConnectorAudit `json:"connector,omitempty"`
	PrevHash          string          `json:"prevHash"`
	Hash              string          `json:"hash"`
}

// Appender records audit entries. *AuditLog (single chain) and *TenantAudit
// (one chain per tenant) both satisfy it, so the runtime is agnostic.
type Appender interface {
	Append(AuditEntry) error
}

// AuditLog is an in-memory hash-chained log (Phase 0; a real impl ships entries
// to a SIEM/append-only store).
type AuditLog struct {
	mu            sync.Mutex
	entries       []AuditEntry
	lastHash      string
	identifierKey []byte
}

func NewAuditLog() *AuditLog {
	return NewAuditLogWithIdentifierKey(randomAuditIdentifierKey())
}

// NewAuditLogWithIdentifierKey creates a log with a caller-supplied test key.
// Production callers use NewAuditLog so identifiers rotate with the process.
func NewAuditLogWithIdentifierKey(key []byte) *AuditLog {
	if len(key) != auditIdentifierKeySize {
		panic("audit identifier key must be 32 bytes")
	}
	return &AuditLog{identifierKey: append([]byte(nil), key...)}
}

// TenantAudit keeps one independent hash chain per tenant (design §7): a tenant
// is the isolation + "boss reviews audit" boundary, so chains must not interleave.
type TenantAudit struct {
	mu            sync.Mutex
	chains        map[string]*AuditLog
	identifierKey []byte
}

func NewTenantAudit() *TenantAudit {
	return NewTenantAuditWithIdentifierKey(randomAuditIdentifierKey())
}

// NewTenantAuditWithIdentifierKey creates deterministic tenant chains for tests.
func NewTenantAuditWithIdentifierKey(key []byte) *TenantAudit {
	if len(key) != auditIdentifierKeySize {
		panic("audit identifier key must be 32 bytes")
	}
	return &TenantAudit{chains: map[string]*AuditLog{}, identifierKey: append([]byte(nil), key...)}
}

// Chain returns (creating if needed) the log for a tenant.
func (ta *TenantAudit) Chain(tenantID string) *AuditLog {
	ta.mu.Lock()
	defer ta.mu.Unlock()
	lg, ok := ta.chains[tenantID]
	if !ok {
		lg = NewAuditLogWithIdentifierKey(ta.identifierKey)
		ta.chains[tenantID] = lg
	}
	return lg
}

// Append routes an entry to its tenant's chain (by entry.TenantID).
func (ta *TenantAudit) Append(e AuditEntry) error {
	return ta.Chain(e.TenantID).Append(e)
}

// Append records an entry, computing its hash over (prevHash + entry payload).
func (a *AuditLog) Append(e AuditEntry) error {
	prepared := e
	if e.Connector != nil {
		connector := *e.Connector
		connector.Before = filterConnectorAuditMap(connector.Before, nil)
		connector.After = filterConnectorAuditMap(connector.After, nil)
		connector.IdempotencyKeyID = deriveAuditIdentifier(a.identifierKey, e.TenantID, "idempotency", connector.idempotencyKeyMaterial)
		connector.RequestFingerprintID = deriveAuditIdentifier(a.identifierKey, e.TenantID, "request-fingerprint", connector.requestFingerprintMaterial)
		clear(e.Connector.idempotencyKeyMaterial)
		clear(e.Connector.requestFingerprintMaterial)
		e.Connector.idempotencyKeyMaterial = nil
		e.Connector.requestFingerprintMaterial = nil
		connector.idempotencyKeyMaterial = nil
		connector.requestFingerprintMaterial = nil
		prepared.Connector = &connector
		prepared.Before = filterConnectorAuditMap(e.Before, nil)
		prepared.After = filterConnectorAuditMap(e.After, nil)
	}
	cloned, err := cloneAuditEntry(prepared)
	if err != nil {
		return fmt.Errorf("copy audit entry: %w", err)
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	cloned.Seq = len(a.entries) + 1
	if cloned.Time.IsZero() {
		cloned.Time = time.Now().UTC()
	}
	cloned.PrevHash = a.lastHash
	cloned.Hash, err = hashEntry(cloned)
	if err != nil {
		return fmt.Errorf("hash audit entry: %w", err)
	}
	a.lastHash = cloned.Hash
	a.entries = append(a.entries, cloned)
	return nil
}

func filterConnectorAuditMap(values map[string]any, declared []string) map[string]any {
	if len(values) == 0 {
		return nil
	}
	allowed := connectorAuditMetricMaximum
	if len(declared) > 0 {
		allowed = make(map[string]int64, len(declared))
		for _, field := range declared {
			if maximum, fixed := connectorAuditMetricMaximum[field]; fixed {
				allowed[field] = maximum
			}
		}
	}
	filtered := make(map[string]any, len(allowed))
	for key, value := range values {
		maximum, ok := allowed[key]
		if !ok {
			continue
		}
		integer, ok := connectorAuditInteger(value)
		if ok && integer >= 0 && integer <= maximum {
			filtered[key] = int(integer)
		}
	}
	if len(filtered) == 0 {
		return nil
	}
	return filtered
}

func connectorAuditInteger(value any) (int64, bool) {
	switch number := value.(type) {
	case int:
		return int64(number), true
	case int8:
		return int64(number), true
	case int16:
		return int64(number), true
	case int32:
		return int64(number), true
	case int64:
		return number, true
	case uint:
		if uint64(number) <= math.MaxInt64 {
			return int64(number), true
		}
	case uint8:
		return int64(number), true
	case uint16:
		return int64(number), true
	case uint32:
		return int64(number), true
	case uint64:
		if number <= math.MaxInt64 {
			return int64(number), true
		}
	case float32:
		return finiteInteger(float64(number))
	case float64:
		return finiteInteger(number)
	}
	return 0, false
}

func finiteInteger(number float64) (int64, bool) {
	if math.IsNaN(number) || math.IsInf(number, 0) || math.Trunc(number) != number || number < math.MinInt64 || number > math.MaxInt64 {
		return 0, false
	}
	return int64(number), true
}

func randomAuditIdentifierKey() []byte {
	key := make([]byte, auditIdentifierKeySize)
	if _, err := rand.Read(key); err != nil {
		panic(fmt.Sprintf("generate audit identifier key: %v", err))
	}
	return key
}

func deriveAuditIdentifier(key []byte, tenantID, domain string, material []byte) string {
	if len(material) == 0 {
		return ""
	}
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(domain))
	_, _ = mac.Write([]byte{0})
	_, _ = mac.Write([]byte(tenantID))
	_, _ = mac.Write([]byte{0})
	_, _ = mac.Write(material)
	return "hmac-sha256:" + hex.EncodeToString(mac.Sum(nil))
}

// Entries returns a copy of the log.
func (a *AuditLog) Entries() []AuditEntry {
	a.mu.Lock()
	defer a.mu.Unlock()
	out := make([]AuditEntry, 0, len(a.entries))
	for _, entry := range a.entries {
		cloned, err := cloneAuditEntry(entry)
		if err != nil {
			return nil
		}
		out = append(out, cloned)
	}
	return out
}

// Verify recomputes the chain and reports whether it is intact.
func (a *AuditLog) Verify() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	prev := ""
	for _, e := range a.entries {
		if e.PrevHash != prev {
			return false
		}
		hash, err := hashEntry(e)
		if err != nil || e.Hash != hash {
			return false
		}
		prev = e.Hash
	}
	return true
}

// hashEntry hashes the entry payload excluding its own Hash field.
func hashEntry(e AuditEntry) (string, error) {
	e.Hash = ""
	b, err := json.Marshal(e)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:]), nil
}

func cloneAuditEntry(e AuditEntry) (AuditEntry, error) {
	b, err := json.Marshal(e)
	if err != nil {
		return AuditEntry{}, err
	}
	var cloned AuditEntry
	if err := json.Unmarshal(b, &cloned); err != nil {
		return AuditEntry{}, err
	}
	return cloned, nil
}
