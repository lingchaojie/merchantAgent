package main

import (
	"context"
	"time"

	"github.com/merchantagent/backend/connector"
)

const defaultLocalToolTimeout = 120 * time.Second

type localToolBridge struct {
	srv     *server
	send    func(kind string, v any)
	timeout time.Duration
}

func (b *localToolBridge) InvokeLocalTool(ctx context.Context, req connector.LocalToolRequest) (connector.LocalToolResponse, error) {
	id := newReqID()
	ch := make(chan connector.LocalToolResponse, 1)
	b.srv.mu.Lock()
	if b.srv.pendingTools == nil {
		b.srv.pendingTools = map[string]chan connector.LocalToolResponse{}
	}
	b.srv.pendingTools[id] = ch
	b.srv.mu.Unlock()
	defer func() {
		b.srv.mu.Lock()
		delete(b.srv.pendingTools, id)
		b.srv.mu.Unlock()
	}()

	b.send("local_tool_request", map[string]any{
		"kind":                 "local_tool_request",
		"reqId":                id,
		"packageId":            req.PackageID,
		"packageVersion":       req.PackageVersion,
		"manifestDigest":       req.ManifestDigest,
		"tool":                 req.Tool,
		"tenantId":             req.TenantID,
		"userId":               req.UserID,
		"deviceId":             req.DeviceID,
		"roleIds":              req.RoleIDs,
		"skillId":              req.SkillID,
		"callId":               req.CallID,
		"idempotencyKey":       req.IdempotencyKey,
		"risk":                 req.Risk,
		"requiresConfirmation": req.RequiresConfirmation,
		"args":                 req.Args,
	})

	timeout := b.timeout
	if timeout <= 0 {
		timeout = defaultLocalToolTimeout
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case response := <-ch:
		if response.Error != "" {
			return response, &connector.ExecutionError{Message: response.Error, Meta: response.Meta}
		}
		return response, nil
	case <-ctx.Done():
		return connector.LocalToolResponse{}, ctx.Err()
	case <-timer.C:
		meta := connector.ExecutionMeta{Status: "unknown", IdempotencyKey: req.IdempotencyKey}
		response := connector.LocalToolResponse{Meta: meta, Error: "local tool request timed out (no client response)"}
		return response, &connector.ExecutionError{Message: response.Error, Meta: meta}
	}
}

func (s *server) resolveLocalTool(reqID string, response connector.LocalToolResponse) bool {
	s.mu.Lock()
	ch := s.pendingTools[reqID]
	s.mu.Unlock()
	if ch == nil {
		return false
	}
	ch <- response
	return true
}
