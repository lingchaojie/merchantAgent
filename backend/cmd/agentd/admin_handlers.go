package main

import (
	"encoding/json"
	"net/http"

	"github.com/merchantagent/backend/config"
	"github.com/merchantagent/backend/skill"
)

// reproject re-runs the projection after a config/skill write; on error the HTTP
// call reports 500 (DB already changed, but OpenFGA will re-sync on next write
// or restart — acceptable for the demo).
func (s *server) reproject(w http.ResponseWriter, r *http.Request) bool {
	if err := s.asm.Projector.Reproject(r.Context()); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "reproject: " + err.Error()})
		return false
	}
	return true
}

func decode(w http.ResponseWriter, r *http.Request, dst any) bool {
	if err := json.NewDecoder(r.Body).Decode(dst); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad json"})
		return false
	}
	return true
}

// ---- roles ----
func (s *server) handleRolesList(w http.ResponseWriter, r *http.Request) {
	roles, err := s.asm.Cfg.Roles(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, roles)
}

func (s *server) handleRoleCreate(w http.ResponseWriter, r *http.Request) {
	var role config.Role
	if !decode(w, r, &role) {
		return
	}
	if err := s.asm.Cfg.CreateRole(r.Context(), role); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if !s.reproject(w, r) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *server) handleRoleUpdate(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var body struct{ Label, Description string }
	if !decode(w, r, &body) {
		return
	}
	if err := s.asm.Cfg.UpdateRole(r.Context(), id, body.Label, body.Description); err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
		return
	}
	if !s.reproject(w, r) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *server) handleRoleDelete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	// Cascade: strip the role from skills (Gate A) + config grants (Gate B).
	if err := s.asm.Sk.RemoveRoleFromAll(r.Context(), s.tenant, id); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if err := s.asm.Cfg.DeleteRole(r.Context(), id); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if !s.reproject(w, r) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// ---- rules ----
func (s *server) handleRulesGet(w http.ResponseWriter, r *http.Request) {
	rules, err := s.asm.Cfg.Rules(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, rules)
}

func (s *server) handleRulesPut(w http.ResponseWriter, r *http.Request) {
	var rules []config.Rule
	if !decode(w, r, &rules) {
		return
	}
	if err := s.asm.Cfg.ReplaceRules(r.Context(), rules); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if !s.reproject(w, r) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// ---- skills ----
func (s *server) handleSkillsList(w http.ResponseWriter, r *http.Request) {
	skills, err := s.asm.Sk.List(r.Context(), s.tenant)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, skills)
}

func (s *server) handleTemplatesList(w http.ResponseWriter, r *http.Request) {
	t, err := s.asm.Sk.ListTemplates(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, t)
}

func (s *server) handleSkillCreate(w http.ResponseWriter, r *http.Request) {
	var body struct {
		TemplateID string      `json:"templateId"`
		Skill      skill.Skill `json:"skill"`
	}
	if !decode(w, r, &body) {
		return
	}
	if body.TemplateID != "" {
		if _, err := s.asm.Sk.CloneTemplate(r.Context(), s.tenant, body.TemplateID); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
	} else {
		body.Skill.TenantID = s.tenant
		if err := s.asm.Sk.Create(r.Context(), body.Skill); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
	}
	if !s.reproject(w, r) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *server) handleSkillUpdate(w http.ResponseWriter, r *http.Request) {
	var sk skill.Skill
	if !decode(w, r, &sk) {
		return
	}
	sk.TenantID = s.tenant
	sk.SkillID = r.PathValue("id")
	if err := s.asm.Sk.Update(r.Context(), sk); err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
		return
	}
	if !s.reproject(w, r) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *server) handleSkillDelete(w http.ResponseWriter, r *http.Request) {
	if err := s.asm.Sk.Delete(r.Context(), s.tenant, r.PathValue("id")); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if !s.reproject(w, r) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// ---- domains + grants ----
func (s *server) handleDomainsList(w http.ResponseWriter, r *http.Request) {
	domains, err := s.asm.Cfg.Domains(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	grants, err := s.asm.Cfg.Grants(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"domains": domains, "grants": grants})
}

func (s *server) handleGrantAdd(w http.ResponseWriter, r *http.Request) {
	var body struct{ Subject string }
	if !decode(w, r, &body) {
		return
	}
	if err := s.asm.Cfg.AddGrant(r.Context(), r.PathValue("d"), body.Subject); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if !s.reproject(w, r) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *server) handleGrantRemove(w http.ResponseWriter, r *http.Request) {
	var body struct{ Subject string }
	if !decode(w, r, &body) {
		return
	}
	if err := s.asm.Cfg.RemoveGrant(r.Context(), r.PathValue("d"), body.Subject); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if !s.reproject(w, r) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
