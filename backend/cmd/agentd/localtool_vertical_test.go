package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/merchantagent/backend/connector"
	"github.com/merchantagent/backend/connector/clientexec"
	"github.com/merchantagent/backend/provider"
	"github.com/merchantagent/backend/runtime"
	"github.com/merchantagent/backend/wire"
)

const localToolVerticalTenant = "mock-corp-001"

type verticalSSEEvent struct {
	Kind string
	Data map[string]any
}

func TestLocalToolVerticalReadWriteReadAndRoleDenial(t *testing.T) {
	fake := &provider.Fake{Steps: []provider.Message{
		provider.Call("planner-load-read", "load_skill", map[string]any{"skillId": "order-status"}),
		provider.Call("planner-read-60", "query_order_status", map[string]any{"orderId": "SO-1001"}),
		provider.Call("planner-load-write", "load_skill", map[string]any{"skillId": "production-progress"}),
		provider.Call("planner-write-80", "report_production_progress", map[string]any{
			"orderId": "SO-1001", "workOrderId": "WO-1001", "completionRate": 80, "expectedVersion": 1,
		}),
		provider.Call("planner-read-80", "query_order_status", map[string]any{"orderId": "SO-1001"}),
		provider.Text("SO-1001 progress updated from 60% to 80%."),
		provider.Call("sales-load", "load_skill", map[string]any{"skillId": "order-status"}),
		provider.Call("sales-write", "report_production_progress", map[string]any{
			"orderId": "SO-1001", "workOrderId": "WO-1001", "completionRate": 90, "expectedVersion": 2,
		}),
		provider.Text("You do not have permission to update production progress."),
	}}
	asm, err := wire.Assemble(context.Background(), wire.Config{
		OpenFGAURL: envOr("OPENFGA_API_URL", "http://localhost:18080"),
		Tenant:     localToolVerticalTenant,
		OrgFile:    filepath.Join("..", "..", "testdata", "mock-org.yaml"),
		Provider:   fake,
	})
	if err != nil {
		if _, required := os.LookupEnv("OPENFGA_API_URL"); required {
			t.Fatalf("assemble with required OpenFGA: %v", err)
		}
		t.Skipf("assemble (is OpenFGA up?): %v", err)
	}
	defer asm.Close()

	s := &server{
		asm: asm, tenant: localToolVerticalTenant,
		sessions: map[string][]provider.Message{}, pending: map[string]chan fileResult{},
		pendingTools: map[string]chan connector.LocalToolResponse{},
	}
	ts := httptest.NewServer(s.routes())
	defer ts.Close()

	plannerEvents := driveLocalToolVerticalChat(t, ts.URL, "planner-session", "u_plan", func(request map[string]any) map[string]any {
		assertVerticalLocalRequest(t, request, "u_plan", []string{"planner"})
		callID := requireString(t, request, "callId")
		idempotencyKey := requireString(t, request, "idempotencyKey")
		response := map[string]any{
			"reqId": request["reqId"],
			"meta": map[string]any{
				"status": "succeeded", "executionId": "desktop-" + callID,
				"idempotencyKey": idempotencyKey, "confirmed": false,
			},
		}
		switch callID {
		case "planner-read-60":
			response["data"] = verticalOrderStatus(60, 1)
		case "planner-write-80":
			before, after := verticalOrderStatus(60, 1), verticalOrderStatus(80, 2)
			response["data"] = after
			response["meta"] = map[string]any{
				"status": "succeeded", "executionId": "desktop-" + callID,
				"idempotencyKey": idempotencyKey, "confirmed": true,
				"confirmedAt": "2026-07-12T10:00:00Z", "before": before, "after": after,
			}
		case "planner-read-80":
			response["data"] = verticalOrderStatus(80, 2)
		default:
			t.Fatalf("unexpected local call id %q", callID)
		}
		return response
	})

	if got := eventText(plannerEvents, "done"); got != "SO-1001 progress updated from 60% to 80%." {
		t.Fatalf("planner final = %q", got)
	}
	requests := eventsOfKind(plannerEvents, "local_tool_request")
	if got, want := len(requests), 3; got != want {
		t.Fatalf("planner local requests = %d, want %d", got, want)
	}
	if rates := localRequestResponseRates(plannerEvents); !reflect.DeepEqual(rates, []float64{60, 80, 80}) {
		t.Fatalf("planner progress sequence = %v, want [60 80 80]", rates)
	}

	salesEvents := driveLocalToolVerticalChat(t, ts.URL, "sales-session", "u_sales1", func(request map[string]any) map[string]any {
		t.Fatalf("sales request escaped the role gate: %+v", request)
		return nil
	})
	if got := len(eventsOfKind(salesEvents, "local_tool_request")); got != 0 {
		t.Fatalf("sales local requests = %d, want 0", got)
	}

	chain := asm.Audit.Chain(localToolVerticalTenant)
	if !chain.Verify() {
		t.Fatal("local tool audit chain failed verification")
	}
	entries := chain.Entries()
	assertVerticalAudit(t, entries, "planner-read-60", "u_plan", "allow", "succeeded")
	write := assertVerticalAudit(t, entries, "planner-write-80", "u_plan", "allow", "succeeded")
	if !write.Confirmed || write.Before["completionRate"] != float64(60) || write.After["completionRate"] != float64(80) {
		t.Fatalf("write audit metadata = %+v", write)
	}
	assertVerticalAudit(t, entries, "planner-read-80", "u_plan", "allow", "succeeded")
	assertVerticalAudit(t, entries, "sales-write", "u_sales1", "deny", "denied")
}

func driveLocalToolVerticalChat(t *testing.T, baseURL, sessionID, userID string, desktop func(map[string]any) map[string]any) []verticalSSEEvent {
	t.Helper()
	body, err := json.Marshal(map[string]string{
		"sessionId": sessionID, "userId": userID, "deviceId": "DESKTOP-01", "question": "local tool vertical acceptance",
	})
	if err != nil {
		t.Fatal(err)
	}
	response, err := http.Post(baseURL+"/chat", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("chat post: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("chat status = %d", response.StatusCode)
	}

	var events []verticalSSEEvent
	var kind string
	var data strings.Builder
	scanner := bufio.NewScanner(response.Body)
	for scanner.Scan() {
		line := scanner.Text()
		switch {
		case strings.HasPrefix(line, "event:"):
			kind = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
		case strings.HasPrefix(line, "data:"):
			data.WriteString(strings.TrimSpace(strings.TrimPrefix(line, "data:")))
		case line == "" && kind != "":
			var payload map[string]any
			if err := json.Unmarshal([]byte(data.String()), &payload); err != nil {
				t.Fatalf("decode %s event: %v", kind, err)
			}
			events = append(events, verticalSSEEvent{Kind: kind, Data: payload})
			if kind == "local_tool_request" {
				postVerticalLocalToolResult(t, baseURL, desktop(payload))
			}
			kind = ""
			data.Reset()
		}
	}
	if err := scanner.Err(); err != nil {
		t.Fatalf("scan SSE: %v", err)
	}
	return events
}

func postVerticalLocalToolResult(t *testing.T, baseURL string, response map[string]any) {
	t.Helper()
	body, err := json.Marshal(response)
	if err != nil {
		t.Fatal(err)
	}
	result, err := http.Post(baseURL+"/chat/local-tool-result", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("post local tool result: %v", err)
	}
	defer result.Body.Close()
	if result.StatusCode != http.StatusOK {
		t.Fatalf("local tool result status = %d", result.StatusCode)
	}
}

func assertVerticalLocalRequest(t *testing.T, request map[string]any, userID string, roleIDs []string) {
	t.Helper()
	for key, want := range map[string]any{
		"packageId": clientexec.PackageID, "packageVersion": clientexec.PackageVersion,
		"manifestDigest": clientexec.ManifestDigest(), "tenantId": localToolVerticalTenant,
		"userId": userID, "deviceId": "DESKTOP-01",
	} {
		if got := request[key]; got != want {
			t.Fatalf("local request %s = %v, want %v; request=%+v", key, got, want, request)
		}
	}
	gotRoles, ok := request["roleIds"].([]any)
	if !ok || len(gotRoles) != len(roleIDs) {
		t.Fatalf("local request roleIds = %#v, want %v", request["roleIds"], roleIDs)
	}
	for i, want := range roleIDs {
		if gotRoles[i] != want {
			t.Fatalf("local request roleIds = %#v, want %v", request["roleIds"], roleIDs)
		}
	}
}

func verticalOrderStatus(completionRate, version float64) map[string]any {
	return map[string]any{
		"orderId": "SO-1001", "workOrderId": "WO-1001", "status": "in_production",
		"promiseDate": "2026-07-20", "completionRate": completionRate, "note": "vertical-test", "version": version,
	}
}

func eventText(events []verticalSSEEvent, kind string) string {
	for i := len(events) - 1; i >= 0; i-- {
		if events[i].Kind == kind {
			text, _ := events[i].Data["text"].(string)
			return text
		}
	}
	return ""
}

func eventsOfKind(events []verticalSSEEvent, kind string) []verticalSSEEvent {
	var matches []verticalSSEEvent
	for _, event := range events {
		if event.Kind == kind {
			matches = append(matches, event)
		}
	}
	return matches
}

func localRequestResponseRates(events []verticalSSEEvent) []float64 {
	var rates []float64
	for _, event := range events {
		if event.Kind != "tool_result" {
			continue
		}
		if rate, ok := event.Data["data"].(map[string]any)["completionRate"].(float64); ok {
			rates = append(rates, rate)
		}
	}
	return rates
}

func requireString(t *testing.T, values map[string]any, key string) string {
	t.Helper()
	value, ok := values[key].(string)
	if !ok || value == "" {
		t.Fatalf("missing %s in %+v", key, values)
	}
	return value
}

func assertVerticalAudit(t *testing.T, entries []runtime.AuditEntry, callID, userID, decision, status string) runtime.AuditEntry {
	t.Helper()
	for _, entry := range entries {
		if entry.ToolCallID == callID {
			if entry.UserID != userID || entry.Decision != decision || entry.Status != status {
				t.Fatalf("audit %s = %+v, want user=%s decision=%s status=%s", callID, entry, userID, decision, status)
			}
			return entry
		}
	}
	t.Fatalf("audit missing call %s; entries=%s", callID, fmt.Sprint(entries))
	return runtime.AuditEntry{}
}
