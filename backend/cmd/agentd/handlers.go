package main

import (
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/merchantagent/backend/connector"
	"github.com/merchantagent/backend/org"
	"github.com/merchantagent/backend/runtime"
)

// handleLogin: demo mock login — pick a mock user id, get a Principal.
// Production replaces this with WeCom OAuth (research/10 §3).
func (s *server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var req struct {
		UserID string `json:"userId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad json"})
		return
	}
	p, err := s.asm.IDP.Authenticate(r.Context(), org.LoginContext{Credential: req.UserID})
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, p)
}

// handleChat runs one LLM turn and STREAMS events over SSE. Per-session history
// is kept server-side keyed by sessionId (design §7).
//
// SECURITY (demo): trusts req.UserID. Production derives the principal from a
// verified session, never the request body.
func (s *server) handleChat(w http.ResponseWriter, r *http.Request) {
	var req struct {
		SessionID string `json:"sessionId"`
		UserID    string `json:"userId"`
		Question  string `json:"question"`
		DeviceID  string `json:"deviceId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad json"})
		return
	}
	p, err := s.asm.IDP.Authenticate(r.Context(), org.LoginContext{Credential: req.UserID})
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": err.Error()})
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "streaming unsupported"})
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	send := func(kind string, v any) {
		b, _ := json.Marshal(v)
		fmt.Fprintf(w, "event: %s\ndata: %s\n\n", kind, b)
		flusher.Flush()
	}
	sink := runtime.EventSink(func(e runtime.Event) { send(e.Kind, e) })

	s.mu.Lock()
	history := s.sessions[req.SessionID]
	s.mu.Unlock()

	// Attach the reverse file bridge so local-file tools round-trip to this
	// client over the SSE stream (design §2, M4b).
	deviceID := req.DeviceID
	if deviceID == "" {
		deviceID = "unknown-device"
	}
	ctx := connector.WithDeviceID(r.Context(), deviceID)
	ctx = connector.WithFileBridge(ctx, &fileBridge{srv: s, send: send})
	ctx = connector.WithLocalToolBridge(ctx, &localToolBridge{srv: s, send: send})
	final, updated, err := s.asm.Agent.Ask(ctx, p, history, req.Question, sink)
	if err != nil {
		send("error", map[string]string{"error": err.Error()})
		return
	}
	s.mu.Lock()
	s.sessions[req.SessionID] = updated
	s.mu.Unlock()
	send("done", map[string]string{"text": final})
}

// handleAudit returns the hash-chained audit log for a tenant (?tenant=…,
// defaults to the server's tenant) and whether it verifies.
func (s *server) handleAudit(w http.ResponseWriter, r *http.Request) {
	tenant := r.URL.Query().Get("tenant")
	if tenant == "" {
		tenant = s.tenant
	}
	chain := s.asm.Audit.Chain(tenant)
	writeJSON(w, http.StatusOK, map[string]any{
		"tenant":   tenant,
		"verified": chain.Verify(),
		"entries":  chain.Entries(),
	})
}

// handleFileResult receives the desktop's reply to a file_request and unblocks
// the waiting local-file tool (design §2, M4b reverse bridge).
func (s *server) handleFileResult(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ReqID   string `json:"reqId"`
		Content string `json:"content"`
		Error   string `json:"error"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad json"})
		return
	}
	if !s.resolveFile(req.ReqID, fileResult{content: req.Content, err: req.Error}) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "unknown or expired reqId"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *server) handleLocalToolResult(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	var req struct {
		ReqID string                  `json:"reqId"`
		Data  map[string]any          `json:"data"`
		Meta  connector.ExecutionMeta `json:"meta"`
		Error string                  `json:"error"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad json"})
		return
	}
	response := connector.LocalToolResponse{Data: req.Data, Meta: req.Meta, Error: req.Error}
	if !s.resolveLocalTool(req.ReqID, response) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "unknown or expired reqId"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
