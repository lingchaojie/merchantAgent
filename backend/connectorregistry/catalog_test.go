package connectorregistry

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/merchantagent/backend/connector"
)

func TestPublishedCatalogChangesWithoutRestart(t *testing.T) {
	ctx := context.Background()
	store := openTestStore(t)
	v := validSubmittedVersion()
	requireNoError(t, store.Submit(ctx, Submission{Version: v, ActorID: "impl-1"}))
	catalog := NewPublishedCatalog(store, v.TenantID)
	if got, _ := catalog.Snapshot(ctx); len(got) != 0 {
		t.Fatalf("pending tools=%v", got)
	}
	requireNoError(t, store.Transition(ctx, Transition{TenantID: v.TenantID, ConnectorID: v.ConnectorID, Version: v.Version, Digest: v.Digest, To: StatusPublished, ActorID: "u_admin"}))
	if got, _ := catalog.Snapshot(ctx); got["query_order_status"] == nil {
		t.Fatal("published tool missing")
	}
	requireNoError(t, store.Transition(ctx, Transition{TenantID: v.TenantID, ConnectorID: v.ConnectorID, Version: v.Version, Digest: v.Digest, To: StatusSuspended, ActorID: "u_admin"}))
	if got, _ := catalog.Snapshot(ctx); len(got) != 0 {
		t.Fatalf("suspended tools=%v", got)
	}
}

type publishedVersionsStub struct {
	versions []Version
	err      error
}

func (s publishedVersionsStub) Published(context.Context, string) ([]Version, error) {
	return s.versions, s.err
}

type capturingLocalBridge struct {
	req connector.LocalToolRequest
}

func (b *capturingLocalBridge) InvokeLocalTool(_ context.Context, req connector.LocalToolRequest) (connector.LocalToolResponse, error) {
	b.req = req
	return connector.LocalToolResponse{Data: map[string]any{"status": "ready"}, Meta: connector.ExecutionMeta{Status: "succeeded"}}, nil
}

func TestPublishedCatalogMapsPublicContractAndInvokesApprovedDigest(t *testing.T) {
	v := validSubmittedVersion()
	catalog := NewPublishedCatalog(publishedVersionsStub{versions: []Version{v}}, v.TenantID)
	tools, err := catalog.Snapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	tool := tools["query_order_status"]
	if tool == nil {
		t.Fatal("published tool missing")
	}
	spec := tool.Spec()
	if spec.PackageID != v.ConnectorID || spec.Version != v.Version || spec.ManifestDigest != v.Digest || spec.Execution != connector.ExecutionDesktop {
		t.Fatalf("published spec identity = %+v", spec)
	}
	param := spec.Params[0]
	if param.MinLength == nil || *param.MinLength != 1 || param.MaxLength == nil || *param.MaxLength != 64 {
		t.Fatalf("published parameter constraints = %+v", param)
	}

	bridge := &capturingLocalBridge{}
	ctx := connector.WithInvocation(context.Background(), connector.InvocationMeta{
		TenantID: v.TenantID, UserID: "u1", SkillID: "orders", CallID: "call-1", DeviceID: "device-01", RoleIDs: []string{"planner"},
	})
	ctx = connector.WithLocalToolBridge(ctx, bridge)
	data, err := tool.Invoke(ctx, map[string]any{"orderId": "SO-1001"})
	if err != nil {
		t.Fatal(err)
	}
	if bridge.req.PackageID != v.ConnectorID || bridge.req.PackageVersion != v.Version || bridge.req.ManifestDigest != v.Digest || bridge.req.Tool != "query_order_status" {
		t.Fatalf("local request identity = %+v", bridge.req)
	}
	if bridge.req.IdempotencyKey != connector.ExpectedIdempotencyKey(connector.InvocationMeta{TenantID: v.TenantID, UserID: "u1", CallID: "call-1"}, "query_order_status") {
		t.Fatalf("idempotency key = %q", bridge.req.IdempotencyKey)
	}
	if connector.PopExecutionMeta(data).Status != "succeeded" {
		t.Fatalf("execution metadata not attached: %v", data)
	}
}

func TestPublishedCatalogRejectsDuplicateToolNamesAcrossVersions(t *testing.T) {
	first := validSubmittedVersion()
	second := validSubmittedVersion()
	second.ConnectorID = "sql-orders-v2"
	second.Version = "2.0.0"
	second.Digest = "sha256:" + strings.Repeat("c", 64)
	catalog := NewPublishedCatalog(publishedVersionsStub{versions: []Version{first, second}}, first.TenantID)
	tools, err := catalog.Snapshot(context.Background())
	if err == nil || tools != nil || !strings.Contains(err.Error(), "duplicate") {
		t.Fatalf("Snapshot() = %v, %v; want duplicate error", tools, err)
	}
}

func TestPublishedCatalogPropagatesStoreErrors(t *testing.T) {
	want := errors.New("registry unavailable")
	catalog := NewPublishedCatalog(publishedVersionsStub{err: want}, "t")
	tools, err := catalog.Snapshot(context.Background())
	if !errors.Is(err, want) || tools != nil {
		t.Fatalf("Snapshot() = %v, %v; want nil, %v", tools, err, want)
	}
}
