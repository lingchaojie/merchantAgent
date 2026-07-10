package main

import (
	"context"
	"net/http"
)

// adminChecker is the minimal authz surface requireAdmin needs (authz.Store fits).
type adminChecker interface {
	Check(ctx context.Context, user, relation, object string) (bool, error)
}

// requireAdmin gates an /admin/* handler: the caller (X-User-Id header, injected
// by the desktop from the current identity) must be tenant admin. DEMO: header
// is trusted; production derives it from a verified WeCom session.
func requireAdmin(chk adminChecker, tenant string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		uid := r.Header.Get("X-User-Id")
		if uid == "" {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "missing X-User-Id"})
			return
		}
		ok, err := chk.Check(r.Context(), "user:"+uid, "admin", "tenant:"+tenant)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		if !ok {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "admin only"})
			return
		}
		next(w, r)
	}
}

// handleTools returns the platform tool catalog (connector Specs) for the skill
// editor's tool picker. Read-only; still admin-gated.
func (s *server) handleTools(w http.ResponseWriter, r *http.Request) {
	type toolInfo struct {
		Name        string `json:"name"`
		Description string `json:"description"`
		DataDomain  string `json:"dataDomain,omitempty"`
	}
	out := []toolInfo{}
	for _, c := range s.asm.Conns {
		for _, t := range c.Tools() {
			sp := t.Spec()
			out = append(out, toolInfo{Name: sp.Name, Description: sp.Description, DataDomain: sp.DataDomain})
		}
	}
	writeJSON(w, http.StatusOK, out)
}
