package clientexec

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"testing"

	"github.com/merchantagent/backend/connector"
)

type fakeLocalBridge struct {
	request  connector.LocalToolRequest
	response connector.LocalToolResponse
	err      error
}

func (b *fakeLocalBridge) InvokeLocalTool(_ context.Context, req connector.LocalToolRequest) (connector.LocalToolResponse, error) {
	b.request = req
	return b.response, b.err
}

func TestReferenceToolSpecs(t *testing.T) {
	ref := NewReference()
	query, ok := connector.Lookup(ref, "query_order_status")
	if !ok {
		t.Fatal("query_order_status missing")
	}
	progress, ok := connector.Lookup(ref, "report_production_progress")
	if !ok {
		t.Fatal("report_production_progress missing")
	}

	querySpec := query.Spec()
	if querySpec.PackageID != PackageID || querySpec.Version != PackageVersion || querySpec.ManifestDigest != ManifestDigest() {
		t.Fatalf("query package metadata=%+v", querySpec)
	}
	if querySpec.Execution != connector.ExecutionDesktop || querySpec.Risk != connector.RiskRead || querySpec.RequiresConfirmation {
		t.Fatalf("query execution metadata=%+v", querySpec)
	}
	if querySpec.ResourceType != "business_record" || querySpec.ResourceKind != "order" || querySpec.ResourceArg != "orderId" {
		t.Fatalf("query authorization metadata=%+v", querySpec)
	}
	wantQueryFields := []string{"orderId", "workOrderId", "status", "promiseDate", "completionRate", "note", "version"}
	if !sameStrings(querySpec.ResultFields, wantQueryFields) {
		t.Fatalf("query result fields=%v", querySpec.ResultFields)
	}

	progressSpec := progress.Spec()
	if progressSpec.Execution != connector.ExecutionDesktop || progressSpec.Risk != connector.RiskLowWrite || !progressSpec.RequiresConfirmation {
		t.Fatalf("progress execution metadata=%+v", progressSpec)
	}
	if progressSpec.ResourceType != "business_record" || progressSpec.ResourceKind != "order" || progressSpec.ResourceArg != "orderId" {
		t.Fatalf("progress authorization metadata=%+v", progressSpec)
	}
	if len(progressSpec.Params) != 5 || progressSpec.Params[2].Type != connector.ParamInteger || progressSpec.Params[4].Required {
		t.Fatalf("progress params=%+v", progressSpec.Params)
	}
}

func TestManifestDigestUsesEmbeddedCanonicalBytes(t *testing.T) {
	sum := sha256.Sum256(referenceManifest)
	want := "sha256:" + hex.EncodeToString(sum[:])
	if got := ManifestDigest(); got != want {
		t.Fatalf("digest=%q want=%q", got, want)
	}
}

func TestReferenceProgressToolUsesDesktopBridge(t *testing.T) {
	bridge := &fakeLocalBridge{response: connector.LocalToolResponse{
		Data: map[string]any{"orderId": "SO-1001", "completionRate": float64(80)},
		Meta: connector.ExecutionMeta{Status: "succeeded", ExecutionID: "exec-1"},
	}}
	ctx := connector.WithLocalToolBridge(context.Background(), bridge)
	ctx = connector.WithInvocation(ctx, connector.InvocationMeta{
		TenantID: "t", UserID: "u_plan", SkillID: "production-progress", CallID: "c1",
		DeviceID: "DESKTOP-01", RoleIDs: []string{"planner"},
	})
	tool, _ := connector.Lookup(NewReference(), "report_production_progress")
	args := map[string]any{
		"orderId": "SO-1001", "workOrderId": "WO-1001", "completionRate": float64(80),
		"expectedVersion": float64(1), "note": "waiting for QA",
	}
	out, err := tool.Invoke(ctx, args)
	if err != nil {
		t.Fatal(err)
	}
	wantIdempotency := sha256.Sum256([]byte("t|u_plan|c1|report_production_progress"))
	if bridge.request.IdempotencyKey != hex.EncodeToString(wantIdempotency[:]) {
		t.Fatalf("idempotencyKey=%q", bridge.request.IdempotencyKey)
	}
	if bridge.request.Tool != "report_production_progress" || bridge.request.ManifestDigest != ManifestDigest() {
		t.Fatalf("request=%+v", bridge.request)
	}
	if bridge.request.DeviceID != "DESKTOP-01" || len(bridge.request.RoleIDs) != 1 || bridge.request.RoleIDs[0] != "planner" {
		t.Fatalf("request identity=%+v", bridge.request)
	}
	if bridge.request.Args["orderId"] != "SO-1001" || !bridge.request.RequiresConfirmation {
		t.Fatalf("request args/risk=%+v", bridge.request)
	}
	if connector.PopExecutionMeta(out).ExecutionID != "exec-1" {
		t.Fatalf("out=%+v", out)
	}
}

func TestReferenceToolRequiresBridgeAndInvocation(t *testing.T) {
	tool, _ := connector.Lookup(NewReference(), "query_order_status")
	if _, err := tool.Invoke(context.Background(), map[string]any{"orderId": "SO-1001"}); err == nil {
		t.Fatal("missing bridge accepted")
	}
	ctx := connector.WithLocalToolBridge(context.Background(), &fakeLocalBridge{})
	if _, err := tool.Invoke(ctx, map[string]any{"orderId": "SO-1001"}); err == nil {
		t.Fatal("missing invocation accepted")
	}
}

func TestReferenceToolPreservesDesktopErrorStatus(t *testing.T) {
	bridge := &fakeLocalBridge{response: connector.LocalToolResponse{
		Data:  map[string]any{"orderId": "SO-1001"},
		Meta:  connector.ExecutionMeta{Status: "source_conflict", ExecutionID: "exec-2"},
		Error: "source_conflict",
	}}
	ctx := connector.WithLocalToolBridge(context.Background(), bridge)
	ctx = connector.WithInvocation(ctx, connector.InvocationMeta{TenantID: "t", UserID: "u", CallID: "c"})
	tool, _ := connector.Lookup(NewReference(), "query_order_status")

	out, err := tool.Invoke(ctx, map[string]any{"orderId": "SO-1001"})
	var executionErr *connector.ExecutionError
	if !errors.As(err, &executionErr) || executionErr.Meta.Status != "source_conflict" {
		t.Fatalf("err=%v typed=%+v", err, executionErr)
	}
	if connector.PopExecutionMeta(out).ExecutionID != "exec-2" {
		t.Fatalf("out=%+v", out)
	}
}

func TestReferenceToolAttachesMetadataFromTypedBridgeError(t *testing.T) {
	wantErr := &connector.ExecutionError{
		Message: "desktop failed",
		Meta:    connector.ExecutionMeta{Status: "failed", ExecutionID: "exec-3"},
	}
	bridge := &fakeLocalBridge{err: wantErr}
	ctx := connector.WithLocalToolBridge(context.Background(), bridge)
	ctx = connector.WithInvocation(ctx, connector.InvocationMeta{TenantID: "t", UserID: "u", CallID: "c"})
	tool, _ := connector.Lookup(NewReference(), "query_order_status")

	out, err := tool.Invoke(ctx, map[string]any{"orderId": "SO-1001"})
	if !errors.Is(err, wantErr) {
		t.Fatalf("err=%v", err)
	}
	if meta := connector.PopExecutionMeta(out); meta.Status != "failed" || meta.ExecutionID != "exec-3" {
		t.Fatalf("meta=%+v", meta)
	}
}

func sameStrings(got, want []string) bool {
	if len(got) != len(want) {
		return false
	}
	for i := range got {
		if got[i] != want[i] {
			return false
		}
	}
	return true
}
