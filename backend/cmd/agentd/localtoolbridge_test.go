package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/merchantagent/backend/connector"
)

type emittedLocalToolRequest struct {
	kind    string
	payload map[string]any
}

func TestLocalToolBridgeMatchingResultRoundTrip(t *testing.T) {
	s := &server{pendingTools: map[string]chan connector.LocalToolResponse{}}
	emitted := make(chan emittedLocalToolRequest, 1)
	bridge := &localToolBridge{srv: s, send: func(kind string, value any) {
		b, err := json.Marshal(value)
		if err != nil {
			t.Errorf("marshal emitted request: %v", err)
			return
		}
		var payload map[string]any
		if err := json.Unmarshal(b, &payload); err != nil {
			t.Errorf("decode emitted request: %v", err)
			return
		}
		emitted <- emittedLocalToolRequest{kind: kind, payload: payload}
	}}
	request := connector.LocalToolRequest{
		PackageID: "reference-manufacturing", PackageVersion: "1.0.0", ManifestDigest: "sha256:digest",
		Tool: "report_production_progress", TenantID: "mock-corp-001", UserID: "u_plan",
		DeviceID: "DESKTOP-01", RoleIDs: []string{"planner"}, SkillID: "production-progress",
		CallID: "c2", IdempotencyKey: "idem-1", Risk: connector.RiskLowWrite,
		RequiresConfirmation: true, Args: map[string]any{"orderId": "SO-1001"},
	}
	type invokeResult struct {
		response connector.LocalToolResponse
		err      error
	}
	result := make(chan invokeResult, 1)
	go func() {
		response, err := bridge.InvokeLocalTool(context.Background(), request)
		result <- invokeResult{response: response, err: err}
	}()

	event := <-emitted
	if event.kind != "local_tool_request" || event.payload["kind"] != "local_tool_request" {
		t.Fatalf("event=%+v", event)
	}
	reqID, _ := event.payload["reqId"].(string)
	if reqID == "" {
		t.Fatalf("missing reqId: %+v", event.payload)
	}
	for key, want := range map[string]any{
		"packageId": "reference-manufacturing", "packageVersion": "1.0.0", "manifestDigest": "sha256:digest",
		"tool": "report_production_progress", "tenantId": "mock-corp-001", "userId": "u_plan",
		"deviceId": "DESKTOP-01", "skillId": "production-progress", "callId": "c2",
		"idempotencyKey": "idem-1", "risk": "low_write", "requiresConfirmation": true,
	} {
		if got := event.payload[key]; got != want {
			t.Fatalf("payload[%q]=%v want=%v; payload=%+v", key, got, want, event.payload)
		}
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/chat/local-tool-result", s.handleLocalToolResult)
	ts := httptest.NewServer(mux)
	defer ts.Close()
	if status := postLocalToolResult(t, ts.URL, map[string]any{"reqId": "not-" + reqID}); status != http.StatusNotFound {
		t.Fatalf("wrong reqId status=%d", status)
	}
	select {
	case got := <-result:
		t.Fatalf("wrong reqId unblocked request: %+v", got)
	case <-time.After(20 * time.Millisecond):
	}

	response := map[string]any{
		"reqId": reqID,
		"data":  map[string]any{"orderId": "SO-1001", "completionRate": float64(80)},
		"meta": map[string]any{
			"status": "succeeded", "executionId": "exec-1", "idempotencyKey": "idem-1",
			"confirmed": true, "confirmedAt": "2026-07-12T10:00:00Z",
		},
	}
	if status := postLocalToolResult(t, ts.URL, response); status != http.StatusOK {
		t.Fatalf("matching reqId status=%d", status)
	}
	got := <-result
	if got.err != nil || got.response.Meta.ExecutionID != "exec-1" || got.response.Data["orderId"] != "SO-1001" {
		t.Fatalf("result=%+v", got)
	}
	if status := postLocalToolResult(t, ts.URL, response); status != http.StatusNotFound {
		t.Fatalf("expired reqId status=%d", status)
	}
}

func TestLocalToolBridgePreservesDesktopErrorStatus(t *testing.T) {
	s := &server{pendingTools: map[string]chan connector.LocalToolResponse{}}
	reqIDs := make(chan string, 1)
	bridge := &localToolBridge{srv: s, send: func(_ string, value any) {
		b, _ := json.Marshal(value)
		var payload struct {
			ReqID string `json:"reqId"`
		}
		_ = json.Unmarshal(b, &payload)
		reqIDs <- payload.ReqID
	}}
	result := make(chan error, 1)
	go func() {
		_, err := bridge.InvokeLocalTool(context.Background(), connector.LocalToolRequest{})
		result <- err
	}()
	reqID := <-reqIDs
	if !s.resolveLocalTool(reqID, connector.LocalToolResponse{
		Meta: connector.ExecutionMeta{Status: "source_conflict", ExecutionID: "exec-2"}, Error: "source_conflict",
	}) {
		t.Fatal("pending request not found")
	}
	var executionErr *connector.ExecutionError
	if err := <-result; !errors.As(err, &executionErr) || executionErr.Meta.Status != "source_conflict" {
		t.Fatalf("err=%v typed=%+v", err, executionErr)
	}
}

func TestLocalToolBridgeTimeoutIsUnknownExecution(t *testing.T) {
	s := &server{pendingTools: map[string]chan connector.LocalToolResponse{}}
	bridge := &localToolBridge{srv: s, timeout: time.Millisecond, send: func(string, any) {}}
	response, err := bridge.InvokeLocalTool(context.Background(), connector.LocalToolRequest{})
	var executionErr *connector.ExecutionError
	if !errors.As(err, &executionErr) || executionErr.Meta.Status != "unknown" {
		t.Fatalf("response=%+v err=%v typed=%+v", response, err, executionErr)
	}
	if response.Meta.Status != "unknown" {
		t.Fatalf("response=%+v", response)
	}
}

func postLocalToolResult(t *testing.T, baseURL string, payload map[string]any) int {
	t.Helper()
	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	response, err := http.Post(baseURL+"/chat/local-tool-result", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	return response.StatusCode
}
