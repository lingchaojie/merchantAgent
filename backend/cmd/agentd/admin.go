package main

import (
	"context"
	"net/http"
	"sort"

	"github.com/merchantagent/backend/connector"
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
		Name                 string `json:"name"`
		Description          string `json:"description"`
		DataDomain           string `json:"dataDomain,omitempty"`
		PackageID            string `json:"packageId"`
		Version              string `json:"version"`
		Execution            string `json:"execution"`
		Risk                 string `json:"risk"`
		RequiresConfirmation bool   `json:"requiresConfirmation"`
	}
	catalog := s.asm.Catalog
	if catalog == nil {
		catalog = connector.NewStaticCatalog(s.asm.Conns...)
	}
	tools, err := catalog.Snapshot(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	byName := make(map[string]toolInfo, len(tools))
	for _, t := range tools {
		sp := t.Spec().WithDefaults()
		byName[sp.Name] = toolInfo{
			Name:                 sp.Name,
			Description:          sp.Description,
			DataDomain:           sp.DataDomain,
			PackageID:            sp.PackageID,
			Version:              sp.Version,
			Execution:            string(sp.Execution),
			Risk:                 string(sp.Risk),
			RequiresConfirmation: sp.RequiresConfirmation,
		}
	}
	names := make([]string, 0, len(byName))
	for name := range byName {
		names = append(names, name)
	}
	sort.Strings(names)
	out := make([]toolInfo, 0, len(names))
	for _, name := range names {
		out = append(out, byName[name])
	}
	writeJSON(w, http.StatusOK, out)
}
