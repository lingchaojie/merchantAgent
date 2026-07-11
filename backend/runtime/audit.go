// Package runtime is the deterministic agent loop: route intent → authorize
// (research/11 §6.1) → invoke connector tool → format answer, with a
// tamper-evident audit trail. It talks only to the connector interface and an
// authz Checker, so it's decoupled from both the specific ERP and OpenFGA.
package runtime

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sync"
	"time"
)

// AuditEntry is one recorded agent action. Entries are hash-chained: each
// entry's Hash covers the previous Hash, so any tampering breaks the chain.
type AuditEntry struct {
	Seq               int            `json:"seq"`
	Time              time.Time      `json:"time"`
	TenantID          string         `json:"tenantId"`
	UserID            string         `json:"userId"`
	Question          string         `json:"question"`
	SkillID           string         `json:"skillId,omitempty"`
	RoleIDs           []string       `json:"roleIds,omitempty"`
	DeviceID          string         `json:"deviceId,omitempty"`
	Tool              string         `json:"tool"`
	ToolCallID        string         `json:"toolCallId,omitempty"`
	ToolVersion       string         `json:"toolVersion,omitempty"`
	ExecutionLocation string         `json:"executionLocation,omitempty"`
	Risk              string         `json:"risk,omitempty"`
	Args              map[string]any `json:"args"`
	Decision          string         `json:"decision"` // "allow" | "deny"
	Status            string         `json:"status,omitempty"`
	Reason            string         `json:"reason"`
	ExecutionID       string         `json:"executionId,omitempty"`
	IdempotencyKey    string         `json:"idempotencyKey,omitempty"`
	Confirmed         bool           `json:"confirmed"`
	ConfirmedAt       string         `json:"confirmedAt,omitempty"`
	ResourceID        string         `json:"resourceId,omitempty"`
	Before            map[string]any `json:"before,omitempty"`
	After             map[string]any `json:"after,omitempty"`
	PrevHash          string         `json:"prevHash"`
	Hash              string         `json:"hash"`
}

// Appender records audit entries. *AuditLog (single chain) and *TenantAudit
// (one chain per tenant) both satisfy it, so the runtime is agnostic.
type Appender interface {
	Append(AuditEntry) error
}

// AuditLog is an in-memory hash-chained log (Phase 0; a real impl ships entries
// to a SIEM/append-only store).
type AuditLog struct {
	mu       sync.Mutex
	entries  []AuditEntry
	lastHash string
}

func NewAuditLog() *AuditLog { return &AuditLog{} }

// TenantAudit keeps one independent hash chain per tenant (design §7): a tenant
// is the isolation + "boss reviews audit" boundary, so chains must not interleave.
type TenantAudit struct {
	mu     sync.Mutex
	chains map[string]*AuditLog
}

func NewTenantAudit() *TenantAudit { return &TenantAudit{chains: map[string]*AuditLog{}} }

// Chain returns (creating if needed) the log for a tenant.
func (ta *TenantAudit) Chain(tenantID string) *AuditLog {
	ta.mu.Lock()
	defer ta.mu.Unlock()
	lg, ok := ta.chains[tenantID]
	if !ok {
		lg = NewAuditLog()
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
	cloned, err := cloneAuditEntry(e)
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
