// Package runtime is the deterministic agent loop: route intent → authorize
// (research/11 §6.1) → invoke connector tool → format answer, with a
// tamper-evident audit trail. It talks only to the connector interface and an
// authz Checker, so it's decoupled from both the specific ERP and OpenFGA.
package runtime

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sync"
	"time"
)

// AuditEntry is one recorded agent action. Entries are hash-chained: each
// entry's Hash covers the previous Hash, so any tampering breaks the chain.
type AuditEntry struct {
	Seq      int            `json:"seq"`
	Time     time.Time      `json:"time"`
	TenantID string         `json:"tenantId"`
	UserID   string         `json:"userId"`
	Question string         `json:"question"`
	Tool     string         `json:"tool"`
	Args     map[string]any `json:"args"`
	Decision string         `json:"decision"` // "allow" | "deny"
	Reason   string         `json:"reason"`
	PrevHash string         `json:"prevHash"`
	Hash     string         `json:"hash"`
}

// AuditLog is an in-memory hash-chained log (Phase 0; a real impl ships entries
// to a SIEM/append-only store).
type AuditLog struct {
	mu       sync.Mutex
	entries  []AuditEntry
	lastHash string
}

func NewAuditLog() *AuditLog { return &AuditLog{} }

// Append records an entry, computing its hash over (prevHash + entry payload).
func (a *AuditLog) Append(e AuditEntry) AuditEntry {
	a.mu.Lock()
	defer a.mu.Unlock()
	e.Seq = len(a.entries) + 1
	if e.Time.IsZero() {
		e.Time = time.Now().UTC()
	}
	e.PrevHash = a.lastHash
	e.Hash = hashEntry(e)
	a.lastHash = e.Hash
	a.entries = append(a.entries, e)
	return e
}

// Entries returns a copy of the log.
func (a *AuditLog) Entries() []AuditEntry {
	a.mu.Lock()
	defer a.mu.Unlock()
	out := make([]AuditEntry, len(a.entries))
	copy(out, a.entries)
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
		if e.Hash != hashEntry(e) {
			return false
		}
		prev = e.Hash
	}
	return true
}

// hashEntry hashes the entry payload excluding its own Hash field.
func hashEntry(e AuditEntry) string {
	e.Hash = ""
	b, _ := json.Marshal(e)
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}
