package main

import (
	"encoding/json"
	"net/http"

	"github.com/merchantagent/backend/org"
)

// handleLogin: Phase 0 mock login — pick a mock user id and get a Principal.
// Production replaces this with WeCom OAuth (see research/10 §3, §08).
func (s *server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var req struct {
		UserID string `json:"userId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad json"})
		return
	}
	p, err := s.idp.Authenticate(r.Context(), org.LoginContext{Credential: req.UserID})
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, p)
}

// handleAsk: run one agent turn.
// SECURITY (demo): trusts req.UserID. Production derives the principal from a
// verified session, never the request body.
func (s *server) handleAsk(w http.ResponseWriter, r *http.Request) {
	var req struct {
		TenantID string `json:"tenantId"`
		UserID   string `json:"userId"`
		Question string `json:"question"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad json"})
		return
	}
	// Re-authenticate the claimed user against the IdP so an unknown/quit user
	// can't be spoofed (still a demo — real auth is session-based).
	p, err := s.idp.Authenticate(r.Context(), org.LoginContext{Credential: req.UserID})
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": err.Error()})
		return
	}
	ans, err := s.agent.Ask(r.Context(), p, req.Question)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, ans)
}

// handleAudit: return the hash-chained audit log + whether it verifies.
func (s *server) handleAudit(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"verified": s.audit.Verify(),
		"entries":  s.audit.Entries(),
	})
}
