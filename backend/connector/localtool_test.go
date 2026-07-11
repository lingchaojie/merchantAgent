package connector

import (
	"context"
	"testing"
)

type stubLocalToolBridge struct{}

func (stubLocalToolBridge) InvokeLocalTool(context.Context, LocalToolRequest) (LocalToolResponse, error) {
	return LocalToolResponse{}, nil
}

func TestExecutionMetaAttachPop(t *testing.T) {
	data := map[string]any{"status": "production"}
	meta := ExecutionMeta{Status: "succeeded", ExecutionID: "exec-1"}
	AttachExecutionMeta(data, meta)

	got := PopExecutionMeta(data)
	if got.ExecutionID != "exec-1" || got.Status != "succeeded" {
		t.Fatalf("meta=%+v", got)
	}
	if _, exists := data[ExecutionMetaKey]; exists {
		t.Fatal("reserved metadata leaked")
	}
}

func TestPopExecutionMetaAcceptsJSONShape(t *testing.T) {
	data := map[string]any{
		ExecutionMetaKey: map[string]any{
			"status":         "failed",
			"executionId":    "exec-2",
			"idempotencyKey": "idem-2",
			"confirmed":      true,
			"confirmedAt":    "2026-07-12T10:00:00Z",
			"before":         map[string]any{"version": float64(1)},
			"after":          map[string]any{"version": float64(2)},
		},
	}

	got := PopExecutionMeta(data)
	if got.ExecutionID != "exec-2" || got.IdempotencyKey != "idem-2" || !got.Confirmed {
		t.Fatalf("meta=%+v", got)
	}
	if got.Before["version"] != float64(1) || got.After["version"] != float64(2) {
		t.Fatalf("before/after=%v/%v", got.Before, got.After)
	}
	if _, exists := data[ExecutionMetaKey]; exists {
		t.Fatal("reserved metadata leaked")
	}
}

func TestLocalToolContextRoundTrip(t *testing.T) {
	bridge := stubLocalToolBridge{}
	invocation := InvocationMeta{
		TenantID: "tenant-1", UserID: "user-1", SkillID: "skill-1", CallID: "call-1",
		DeviceID: "device-1", RoleIDs: []string{"planner"},
	}
	ctx := WithDeviceID(context.Background(), "device-from-chat")
	ctx = WithInvocation(ctx, invocation)
	ctx = WithLocalToolBridge(ctx, bridge)

	if got := DeviceIDFrom(ctx); got != "device-from-chat" {
		t.Fatalf("deviceID=%q", got)
	}
	got, ok := InvocationFrom(ctx)
	if !ok || got.CallID != "call-1" || got.RoleIDs[0] != "planner" {
		t.Fatalf("invocation=%+v ok=%v", got, ok)
	}
	if LocalToolBridgeFrom(ctx) == nil {
		t.Fatal("local tool bridge missing")
	}
}
