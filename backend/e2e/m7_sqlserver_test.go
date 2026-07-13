package e2e

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/merchantagent/backend/connector"
	"github.com/merchantagent/backend/connectorregistry"
	"github.com/merchantagent/backend/org"
	"github.com/merchantagent/backend/provider"
	"github.com/merchantagent/backend/runtime"
	"github.com/merchantagent/backend/sync"
	"github.com/merchantagent/backend/wire"
)

const m71AuditSecretCanary = "m71-private-audit-canary"

func TestM71SQLServerVertical(t *testing.T) {
	h := newM71Harness(t)
	h.SubmitAndPublishSQLConnector("sql-orders", "1.0.0")
	h.As("u_sales1").Query("ORD-1001").
		ExpectFields("orderId", "workOrderId", "status", "promiseDate", "completionRate", "note", "version").
		RejectField("cost")
	h.As("u_sales1").ReportProgress("ORD-1001", 60, 4).ExpectDeniedBeforeDesktop()
	h.As("u_prod1").ReportProgress("ORD-1001", 60, 4).Confirm().ExpectSucceededVersion(5)
	h.As("u_sales1").Query("ORD-1001").ExpectCompletionRate(60)
	h.Suspend("sql-orders", "1.0.0")
	h.As("u_sales1").Query("ORD-1001").ExpectApprovalRevokedWithoutRestart()
	h.ExpectAuditChainValidAndSecretFree()
}

type m71Harness struct {
	t        *testing.T
	ctx      context.Context
	asm      *wire.Assembled
	provider *provider.Fake
	bridge   *m71DesktopBridge
	version  connectorregistry.Version
}

func newM71Harness(t *testing.T) *m71Harness {
	t.Helper()
	if os.Getenv("M7_SQLSERVER_TEST") != "1" {
		t.Skip("set M7_SQLSERVER_TEST=1 to run the M7.1 vertical")
	}
	apiURL := os.Getenv("OPENFGA_API_URL")
	if apiURL == "" {
		apiURL = "http://localhost:18080"
	}
	ensureM71OpenFGA(t, apiURL)
	fake := &provider.Fake{}
	asm, err := wire.Assemble(context.Background(), wire.Config{
		OpenFGAURL: apiURL,
		Tenant:     tenant,
		OrgFile:    filepath.Join("..", "testdata", "mock-org.yaml"),
		Provider:   fake,
	})
	if err != nil {
		t.Fatalf("assemble M7.1 backend: %v", err)
	}
	t.Cleanup(asm.Close)
	if err := asm.Store.ApplyDiff(context.Background(), sync.Diff{Writes: []sync.Tuple{
		{User: "user:u_sales1", Relation: "owner", Object: "business_record:" + tenant + "/order/ORD-1001"},
		{User: "user:u_prod1", Relation: "assignee", Object: "role:" + tenant + "/planner"},
		{User: "user:u_prod1", Relation: "operator", Object: "business_record:" + tenant + "/order/ORD-1001"},
		{User: "tenant:" + tenant, Relation: "tenant", Object: "data_domain:" + tenant + "/operations"},
		{User: "role:" + tenant + "/sales#assignee", Relation: "viewer", Object: "data_domain:" + tenant + "/operations"},
		{User: "role:" + tenant + "/planner#assignee", Relation: "viewer", Object: "data_domain:" + tenant + "/operations"},
	}}); err != nil {
		t.Fatalf("seed deterministic production user: %v", err)
	}
	return &m71Harness{
		t: t, ctx: connector.WithDeviceID(context.Background(), "device-m71"), asm: asm, provider: fake,
		bridge: &m71DesktopBridge{completionRate: 45, version: 4},
	}
}

func ensureM71OpenFGA(t *testing.T, apiURL string) {
	t.Helper()
	if isOpenFGA(apiURL) {
		return
	}
	command := exec.Command("docker", "compose", "up", "-d", "openfga")
	command.Dir = ".."
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("start OpenFGA: %v: %s", err, strings.TrimSpace(string(output)))
	}
	deadline := time.Now().Add(45 * time.Second)
	for time.Now().Before(deadline) {
		if isOpenFGA(apiURL) {
			return
		}
		time.Sleep(250 * time.Millisecond)
	}
	t.Fatalf("OpenFGA did not become ready at %s", apiURL)
}

func (h *m71Harness) SubmitAndPublishSQLConnector(id, version string) {
	h.t.Helper()
	h.version = m71Version(id, version)
	if err := h.asm.Registry.Submit(h.ctx, connectorregistry.Submission{Version: h.version, ActorID: "implementation-m71"}); err != nil {
		h.t.Fatal(err)
	}
	if err := h.asm.Registry.Transition(h.ctx, connectorregistry.Transition{
		TenantID: tenant, ConnectorID: id, Version: version, Digest: h.version.Digest,
		ActorID: "u_boss", To: connectorregistry.StatusPublished,
	}); err != nil {
		h.t.Fatal(err)
	}
}

func (h *m71Harness) As(userID string) *m71Actor {
	return &m71Actor{h: h, principal: org.Principal{TenantID: tenant, UserID: userID}}
}

func (h *m71Harness) Suspend(id, version string) {
	h.t.Helper()
	if err := h.asm.Registry.Transition(h.ctx, connectorregistry.Transition{
		TenantID: tenant, ConnectorID: id, Version: version, Digest: h.version.Digest,
		ActorID: "u_boss", To: connectorregistry.StatusSuspended,
	}); err != nil {
		h.t.Fatal(err)
	}
}

func (h *m71Harness) ExpectAuditChainValidAndSecretFree() {
	h.t.Helper()
	chain := h.asm.Audit.Chain(tenant)
	if !chain.Verify() {
		h.t.Fatal("M7.1 audit hash chain is invalid")
	}
	encoded, err := json.Marshal(chain.Entries())
	if err != nil {
		h.t.Fatal(err)
	}
	text := string(encoded)
	if len(h.bridge.devices) == 0 {
		h.t.Fatal("desktop bridge received no connector requests")
	}
	for _, deviceID := range h.bridge.devices {
		if deviceID != h.version.DeviceID {
			h.t.Fatalf("desktop bridge device = %q, want registry device %q", deviceID, h.version.DeviceID)
		}
	}
	for _, secret := range []string{"SELECT", "UPDATE", "dbo.", "sql.internal", "S3cret", "credentialRef", "internal_cost", m71AuditSecretCanary} {
		if strings.Contains(strings.ToLower(text), strings.ToLower(secret)) {
			h.t.Fatalf("audit leaked %q: %s", secret, text)
		}
	}
	for _, public := range []string{`"connectorId":"sql-orders"`, `"adapter":"sqlserver"`, `"sourceProfileId":"erp-test"`, `"environment":"test"`, `"requestFingerprintId":"hmac-sha256:`} {
		if !strings.Contains(text, public) {
			h.t.Fatalf("audit missing public connector metadata %s: %s", public, text)
		}
	}
	for _, entry := range chain.Entries() {
		if entry.Connector != nil && (entry.DeviceID != h.version.DeviceID || entry.Connector.DeviceID != h.version.DeviceID) {
			h.t.Fatalf("connector audit device is not registry-owned: %+v", entry)
		}
	}
}

type m71Actor struct {
	h         *m71Harness
	principal org.Principal
}

type m71QueryExpectation struct {
	actor  *m71Actor
	result map[string]any
	err    error
}

func (a *m71Actor) Query(orderID string) *m71QueryExpectation {
	a.h.provider.Steps = append(a.h.provider.Steps,
		provider.Call("load-read-"+a.principal.UserID, "load_skill", map[string]any{"skillId": "order-status"}),
		provider.Call("query-"+a.principal.UserID, "query_order_status", map[string]any{"orderId": orderID}),
		provider.Text("query complete"),
	)
	var result map[string]any
	ctx := connector.WithLocalToolBridge(a.h.ctx, a.h.bridge)
	_, _, err := a.h.asm.Agent.Ask(ctx, a.principal, nil, "query order status", func(event runtime.Event) {
		if event.Kind == "tool_result" && event.Tool == "query_order_status" {
			result = event.Data
		}
	})
	return &m71QueryExpectation{actor: a, result: result, err: err}
}

func (e *m71QueryExpectation) ExpectFields(fields ...string) *m71QueryExpectation {
	e.actor.h.t.Helper()
	if e.err != nil {
		e.actor.h.t.Fatalf("query failed: %v", e.err)
	}
	for _, field := range fields {
		if _, ok := e.result[field]; !ok {
			e.actor.h.t.Fatalf("query result missing %q: %+v; audit=%+v", field, e.result, e.actor.h.asm.Audit.Chain(tenant).Entries())
		}
	}
	return e
}

func (e *m71QueryExpectation) RejectField(field string) {
	e.actor.h.t.Helper()
	if _, ok := e.result[field]; ok {
		e.actor.h.t.Fatalf("query result exposed %q: %+v", field, e.result)
	}
}

func (e *m71QueryExpectation) ExpectCompletionRate(rate int) {
	e.actor.h.t.Helper()
	if e.err != nil || e.result["completionRate"] != rate {
		e.actor.h.t.Fatalf("completion rate result=%+v err=%v, want %d", e.result, e.err, rate)
	}
}

func (e *m71QueryExpectation) ExpectApprovalRevokedWithoutRestart() {
	e.actor.h.t.Helper()
	if !errors.Is(e.err, runtime.ErrToolUnavailable) {
		e.actor.h.t.Fatalf("query after suspension error=%v, want ErrToolUnavailable", e.err)
	}
}

type m71WriteExpectation struct {
	actor         *m71Actor
	orderID       string
	rate, version int
	bridgeBefore  int
	result        map[string]any
	err           error
}

func (a *m71Actor) ReportProgress(orderID string, rate, version int) *m71WriteExpectation {
	return &m71WriteExpectation{actor: a, orderID: orderID, rate: rate, version: version, bridgeBefore: a.h.bridge.calls}
}

func (e *m71WriteExpectation) execute() {
	if e.result != nil || e.err != nil {
		return
	}
	e.actor.h.provider.Steps = append(e.actor.h.provider.Steps,
		provider.Call("load-write-"+e.actor.principal.UserID, "load_skill", map[string]any{"skillId": "production-progress"}),
		provider.Call("write-"+e.actor.principal.UserID, "report_production_progress", map[string]any{
			"orderId": e.orderID, "workOrderId": "WO-2001", "completionRate": e.rate, "expectedVersion": e.version,
		}),
		provider.Text("write complete"),
	)
	ctx := connector.WithLocalToolBridge(e.actor.h.ctx, e.actor.h.bridge)
	_, _, e.err = e.actor.h.asm.Agent.Ask(ctx, e.actor.principal, nil, "report production progress", func(event runtime.Event) {
		if event.Kind == "tool_result" && event.Tool == "report_production_progress" {
			e.result = event.Data
		}
	})
}

func (e *m71WriteExpectation) ExpectDeniedBeforeDesktop() {
	e.actor.h.t.Helper()
	e.execute()
	if e.err != nil {
		e.actor.h.t.Fatalf("authorization denial returned error: %v", e.err)
	}
	if e.actor.h.bridge.calls != e.bridgeBefore {
		e.actor.h.t.Fatalf("denied write reached desktop bridge: calls %d -> %d", e.bridgeBefore, e.actor.h.bridge.calls)
	}
}

func (e *m71WriteExpectation) Confirm() *m71WriteExpectation {
	e.execute()
	return e
}

func (e *m71WriteExpectation) ExpectSucceededVersion(version int) {
	e.actor.h.t.Helper()
	if e.err != nil || e.result["version"] != version {
		e.actor.h.t.Fatalf("write result=%+v err=%v, want version %d; audit=%+v", e.result, e.err, version, e.actor.h.asm.Audit.Chain(tenant).Entries())
	}
	if e.actor.h.bridge.calls != e.bridgeBefore+1 {
		e.actor.h.t.Fatalf("confirmed write bridge calls=%d, want %d", e.actor.h.bridge.calls, e.bridgeBefore+1)
	}
}

type m71DesktopBridge struct {
	completionRate int
	version        int
	calls          int
	devices        []string
}

func (b *m71DesktopBridge) InvokeLocalTool(_ context.Context, request connector.LocalToolRequest) (connector.LocalToolResponse, error) {
	b.calls++
	b.devices = append(b.devices, request.DeviceID)
	base := connector.ExecutionMeta{
		Status: "succeeded", ExecutionID: fmt.Sprintf("desktop-%d", b.calls),
		IdempotencyKey: request.IdempotencyKey, SourceProfileID: "erp-test", Environment: "test",
		ReadBackStatus: "not_applicable", DurationMS: 12,
	}
	data := m71Order(b.completionRate, b.version)
	data["cost"] = 999
	switch request.Tool {
	case "query_order_status":
		return connector.LocalToolResponse{Data: data, Meta: base}, nil
	case "report_production_progress":
		before := m71Order(b.completionRate, b.version)
		rate := m71Int(request.Args["completionRate"])
		expected := m71Int(request.Args["expectedVersion"])
		if expected != b.version {
			base.Status = "source_conflict"
			return connector.LocalToolResponse{Meta: base, Error: "source_conflict"}, nil
		}
		b.completionRate, b.version = rate, b.version+1
		after := m71Order(b.completionRate, b.version)
		after["internal_cost"] = m71AuditSecretCanary
		base.Confirmed, base.ConfirmedAt, base.Before, base.After = true, "2026-07-13T10:00:00Z", before, after
		base.ReadBackStatus = "succeeded"
		return connector.LocalToolResponse{Data: after, Meta: base}, nil
	default:
		return connector.LocalToolResponse{Meta: base, Error: "tool_not_installed"}, nil
	}
}

func m71Int(value any) int {
	switch n := value.(type) {
	case int:
		return n
	case float64:
		return int(n)
	default:
		return 0
	}
}

func m71Order(rate, version int) map[string]any {
	return map[string]any{
		"orderId": "ORD-1001", "workOrderId": "WO-2001", "status": "in_production",
		"promiseDate": "2026-07-20", "completionRate": rate, "note": "line stable", "version": version,
	}
}

func m71Version(id, version string) connectorregistry.Version {
	min, max := 1, 64
	stringParam := func(name string, required bool) connectorregistry.ParamContract {
		return connectorregistry.ParamContract{Name: name, Description: name, Type: connector.ParamString, Required: required, MinLength: &min, MaxLength: &max}
	}
	integerParam := func(name string) connectorregistry.ParamContract {
		return connectorregistry.ParamContract{Name: name, Description: name, Type: connector.ParamInteger, Required: true}
	}
	fields := []string{"orderId", "workOrderId", "status", "promiseDate", "completionRate", "note", "version"}
	return connectorregistry.Version{
		TenantID: tenant, ConnectorID: id, Version: version,
		Digest: "sha256:" + strings.Repeat("a", 64), Adapter: "sqlserver", Environment: "test",
		ImplementationCredentialID: "implementation-m71", DeviceID: "device-m71",
		Checks: connectorregistry.CheckSummary{CheckerVersion: "1.0.0", RulesetVersion: "m7.1-sql-v1", TestsDigest: "sha256:" + strings.Repeat("b", 64)},
		Contract: connectorregistry.PublicContract{Tools: []connectorregistry.ToolContract{
			{
				Name: "query_order_status", Description: "Query order status", Execution: connector.ExecutionDesktop,
				ResourceType: "business_record", ResourceKind: "order", ResourceArg: "orderId", ResourceRelation: "viewer", DataDomain: "operations",
				Params: []connectorregistry.ParamContract{stringParam("orderId", true)}, ResultFields: append([]string(nil), fields...),
				Risk: connector.RiskRead, TimeoutMS: 10_000, MaxResults: 1,
			},
			{
				Name: "report_production_progress", Description: "Report production progress", Execution: connector.ExecutionDesktop,
				ResourceType: "business_record", ResourceKind: "order", ResourceArg: "orderId", ResourceRelation: "operator", DataDomain: "operations",
				Params:       []connectorregistry.ParamContract{stringParam("orderId", true), stringParam("workOrderId", true), integerParam("completionRate"), integerParam("expectedVersion"), stringParam("note", false)},
				ResultFields: append([]string(nil), fields...), Risk: connector.RiskLowWrite, RequiresConfirmation: true, TimeoutMS: 10_000, MaxResults: 1,
			},
		}},
	}
}
