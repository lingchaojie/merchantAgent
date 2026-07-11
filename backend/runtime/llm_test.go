package runtime

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/merchantagent/backend/connector"
	"github.com/merchantagent/backend/connector/clientexec"
	"github.com/merchantagent/backend/connector/localfile"
	"github.com/merchantagent/backend/org"
	"github.com/merchantagent/backend/provider"
)

func TestToolSpecReportsLastRegisteredConnector(t *testing.T) {
	agent := NewLLMAgent(nil, []connector.Connector{
		stubConn{tools: []connector.Tool{orderStatusTool()}},
		clientexec.NewReference(),
	}, nil, nil, nil, "t")
	spec, ok := agent.ToolSpec("query_order_status")
	if !ok {
		t.Fatal("query_order_status missing")
	}
	if spec.Execution != connector.ExecutionDesktop {
		t.Fatalf("query_order_status execution = %q, want desktop", spec.Execution)
	}
}

func TestToolDefUsesDeclaredParamTypes(t *testing.T) {
	def := toolDef(connector.ToolSpec{Params: []connector.ParamSpec{
		{Name: "name"},
		{Name: "completionRate", Type: connector.ParamInteger},
		{Name: "confirmed", Type: connector.ParamBoolean},
	}})
	properties := def.Function.Parameters["properties"].(map[string]any)
	for name, want := range map[string]string{
		"name":           "string",
		"completionRate": "integer",
		"confirmed":      "boolean",
	} {
		property := properties[name].(map[string]any)
		if got := property["type"]; got != want {
			t.Errorf("%s type = %v, want %q", name, got, want)
		}
	}
}

type countingChecker struct{ calls int }

func (c *countingChecker) Check(context.Context, string, string, string) (bool, error) {
	c.calls++
	return true, nil
}

type countingTool struct {
	spec        connector.ToolSpec
	invocations int
}

func (t *countingTool) Spec() connector.ToolSpec { return t.spec }
func (t *countingTool) Invoke(context.Context, map[string]any) (map[string]any, error) {
	t.invocations++
	return map[string]any{"ok": true}, nil
}

func TestDispatchRejectsUnknownArgsBeforeGuardAndInvoke(t *testing.T) {
	tool := &countingTool{spec: connector.ToolSpec{
		Name:   "update_order",
		Params: []connector.ParamSpec{{Name: "orderId", Required: true}},
	}}
	checker := &countingChecker{}
	agent := &LLMAgent{
		guard: NewGuard(checker, "t"),
		tools: map[string]connector.Tool{"update_order": tool},
	}
	unlockedBy := map[string]string{"update_order": "test-skill"}
	var toolDefs []provider.ToolDef
	result := agent.dispatch(
		context.Background(),
		org.Principal{TenantID: "t", UserID: "u1"},
		provider.Call("c1", "update_order", map[string]any{"orderId": "SO-1001", "sql": "DROP"}).ToolCalls[0],
		nil,
		unlockedBy,
		&toolDefs,
		turnMeta{},
		nil,
	)

	if !strings.Contains(result, "unknown argument sql") {
		t.Fatalf("result = %q, want unknown argument error", result)
	}
	if checker.calls != 0 {
		t.Errorf("guard checker called %d times, want 0", checker.calls)
	}
	if tool.invocations != 0 {
		t.Errorf("tool invoked %d times, want 0", tool.invocations)
	}
}

// fakeBridge canned-answers file requests (stands in for the desktop).
type fakeBridge struct{ readContent string }

func (f fakeBridge) RequestFile(_ context.Context, op, path, _ string) (string, error) {
	if op == "read" {
		return f.readContent, nil
	}
	return "written:" + path, nil
}

type countingBridge struct{ calls int }

func (b *countingBridge) RequestFile(context.Context, string, string, string) (string, error) {
	b.calls++
	return "written", nil
}

func TestDispatchRejectsUnknownAmbientArgsBeforeBridge(t *testing.T) {
	bridge := &countingBridge{}
	agent := (&LLMAgent{}).WithAmbient(localfile.Tools()...)
	var toolDefs []provider.ToolDef
	result := agent.dispatch(
		connector.WithFileBridge(context.Background(), bridge),
		org.Principal{TenantID: "t", UserID: "u1"},
		provider.Call("c1", "write_local_file", map[string]any{
			"path": "notes.txt", "content": "hello", "sql": "DROP",
		}).ToolCalls[0],
		nil,
		map[string]string{"write_local_file": ""},
		&toolDefs,
		turnMeta{},
		nil,
	)

	if !strings.Contains(result, "unknown argument sql") {
		t.Fatalf("result = %q, want unknown argument error", result)
	}
	if bridge.calls != 0 {
		t.Errorf("file bridge called %d times, want 0", bridge.calls)
	}
}

// Ambient local-file tool: offered from the start (no skill load), no guard, and
// round-trips through the FileBridge on the context.
func TestLLM_AmbientLocalFile(t *testing.T) {
	steps := []provider.Message{
		provider.Call("c1", "read_local_file", map[string]any{"path": "notes.txt"}),
		provider.Text("已读取本地文件。"),
	}
	fp := &provider.Fake{Steps: steps}
	ag := NewLLMAgent(fp, nil, NewGuard(fakeChecker{}, "t"), fakeResolver{}, NewAuditLog(), "t").
		WithAmbient(localfile.Tools()...)

	ctx := connector.WithFileBridge(context.Background(), fakeBridge{readContent: "待办：跟进 SO-1001"})
	var results []Event
	sink := func(e Event) {
		if e.Kind == "tool_result" {
			results = append(results, e)
		}
	}
	final, _, err := ag.Ask(ctx, org.Principal{TenantID: "t", UserID: "u1"}, nil, "读一下 notes.txt", sink)
	if err != nil {
		t.Fatal(err)
	}
	if final != "已读取本地文件。" {
		t.Errorf("final = %q", final)
	}
	// read_local_file must be offered in the FIRST request (ambient, no load_skill).
	if !hasTool(fp.Requests[0].Tools, "read_local_file") {
		t.Error("read_local_file must be offered from the start (ambient)")
	}
	if len(results) != 1 || results[0].Data["content"] != "待办：跟进 SO-1001" {
		t.Errorf("expected tool_result with bridged content, got %+v", results)
	}
}

// --- stubs ---

type stubTool struct {
	spec connector.ToolSpec
	out  map[string]any
}

func (s stubTool) Spec() connector.ToolSpec { return s.spec }
func (s stubTool) Invoke(context.Context, map[string]any) (map[string]any, error) {
	return s.out, nil
}

type stubConn struct{ tools []connector.Tool }

func (c stubConn) Name() string            { return "stub" }
func (c stubConn) Tools() []connector.Tool { return c.tools }

type fakeResolver struct{ skills []SkillInfo }

func (f fakeResolver) UsableSkills(context.Context, org.Principal) ([]SkillInfo, error) {
	return f.skills, nil
}

type localAuditResolver struct {
	skills    []SkillInfo
	roles     []string
	roleCalls int
}

func (r *localAuditResolver) UsableSkills(context.Context, org.Principal) ([]SkillInfo, error) {
	return r.skills, nil
}

func (r *localAuditResolver) RoleIDs(context.Context, org.Principal) ([]string, error) {
	r.roleCalls++
	return append([]string(nil), r.roles...), nil
}

type localAuditTool struct {
	spec       connector.ToolSpec
	data       map[string]any
	err        error
	invocation connector.InvocationMeta
	calls      int
}

func (t *localAuditTool) Spec() connector.ToolSpec { return t.spec }

func (t *localAuditTool) Invoke(ctx context.Context, _ map[string]any) (map[string]any, error) {
	t.calls++
	t.invocation, _ = connector.InvocationFrom(ctx)
	out := map[string]any{}
	for k, v := range t.data {
		out[k] = v
	}
	return out, t.err
}

func localAuditSpec() connector.ToolSpec {
	return connector.ToolSpec{
		PackageID: "reference-manufacturing", Version: "1.0.0",
		Name: "report_production_progress", Description: "更新生产进度",
		Params: []connector.ParamSpec{
			{Name: "orderId", Required: true},
			{Name: "workOrderId", Required: true},
			{Name: "completionRate", Type: connector.ParamInteger, Required: true},
			{Name: "expectedVersion", Type: connector.ParamInteger, Required: true},
		},
		ResourceType: "business_record", ResourceKind: "order", ResourceArg: "orderId",
		Execution: connector.ExecutionDesktop, Risk: connector.RiskLowWrite,
		ResultFields: []string{"orderId", "workOrderId", "completionRate", "note", "version"},
	}
}

func localAuditAgent(t *testing.T, tool *localAuditTool, chk Checker) (*LLMAgent, *AuditLog, *provider.Fake, *localAuditResolver) {
	t.Helper()
	fp := &provider.Fake{Steps: []provider.Message{
		provider.Call("load-1", "load_skill", map[string]any{"skillId": "production-progress"}),
		provider.Call("exec-1", "report_production_progress", map[string]any{
			"orderId": "SO-1001", "workOrderId": "WO-1001", "completionRate": 80, "expectedVersion": 1,
		}),
		provider.Text("进度已更新。"),
	}}
	resolver := &localAuditResolver{
		skills: []SkillInfo{{
			ID: "production-progress", Name: "生产进度", PlaybookMD: "更新进度",
			AllowedTools: []string{"report_production_progress"},
		}},
		roles: []string{"sales", "planner"},
	}
	audit := NewAuditLog()
	agent := NewLLMAgent(fp, []connector.Connector{stubConn{tools: []connector.Tool{tool}}}, NewGuard(chk, "t"), resolver, audit, "t")
	return agent, audit, fp, resolver
}

func TestLLM_LocalExecutionAuditSucceededAndRedacted(t *testing.T) {
	meta := connector.ExecutionMeta{
		Status: "succeeded", ExecutionID: "desktop-exec-1", IdempotencyKey: "idem-1",
		Confirmed: true, ConfirmedAt: "2026-07-12T10:00:00Z",
		Before: map[string]any{"completionRate": float64(60)},
		After:  map[string]any{"completionRate": float64(80)},
	}
	tool := &localAuditTool{spec: localAuditSpec(), data: map[string]any{
		"orderId": "SO-1001", "workOrderId": "WO-1001", "completionRate": float64(80),
		"note": "等待质检", "version": float64(2), "internalSql": "UPDATE production",
		connector.ExecutionMetaKey: meta,
	}}
	chk := fakeChecker{allow: map[string]bool{
		"user:u1|invoker|tool:t/report_production_progress": true,
		"user:u1|viewer|business_record:t/order/SO-1001":    true,
	}}
	agent, audit, fp, resolver := localAuditAgent(t, tool, chk)
	ctx := connector.WithDeviceID(context.Background(), "DESKTOP-01")
	var events []Event
	if _, _, err := agent.Ask(ctx, org.Principal{TenantID: "t", UserID: "u1"}, nil, "更新进度", func(e Event) {
		events = append(events, e)
	}); err != nil {
		t.Fatal(err)
	}

	if resolver.roleCalls != 1 {
		t.Fatalf("RoleIDs called %d times, want once per turn", resolver.roleCalls)
	}
	wantInvocation := connector.InvocationMeta{
		TenantID: "t", UserID: "u1", SkillID: "production-progress", CallID: "exec-1",
		DeviceID: "DESKTOP-01", RoleIDs: []string{"planner", "sales"},
	}
	if !reflect.DeepEqual(tool.invocation, wantInvocation) {
		t.Fatalf("invocation = %+v, want %+v", tool.invocation, wantInvocation)
	}
	entries := audit.Entries()
	if len(entries) != 1 {
		t.Fatalf("audit entries = %d, want 1: %+v", len(entries), entries)
	}
	e := entries[0]
	if e.SkillID != "production-progress" || !reflect.DeepEqual(e.RoleIDs, []string{"planner", "sales"}) || e.DeviceID != "DESKTOP-01" ||
		e.Tool != "report_production_progress" || e.ToolVersion != "1.0.0" || e.ExecutionLocation != "desktop" || e.Risk != "low_write" ||
		e.Decision != "allow" || e.Status != "succeeded" || e.ExecutionID != "desktop-exec-1" || e.IdempotencyKey != "idem-1" ||
		!e.Confirmed || e.ConfirmedAt != "2026-07-12T10:00:00Z" || e.ResourceID != "SO-1001" ||
		!reflect.DeepEqual(e.Before, meta.Before) || !reflect.DeepEqual(e.After, meta.After) {
		t.Fatalf("audit entry missing lifecycle metadata: %+v", e)
	}
	if !audit.Verify() {
		t.Fatal("audit chain did not verify")
	}

	var result map[string]any
	var states []string
	for _, event := range events {
		if event.Kind == "tool_result" {
			result = event.Data
		}
		if event.Kind == "tool_state" {
			states = append(states, event.Data["status"].(string))
		}
	}
	if !reflect.DeepEqual(states, []string{"executing", "succeeded"}) {
		t.Fatalf("tool states = %v", states)
	}
	if _, ok := result[connector.ExecutionMetaKey]; ok {
		t.Fatalf("reserved metadata leaked to renderer: %+v", result)
	}
	if _, ok := result["internalSql"]; ok {
		t.Fatalf("non-allowlisted field leaked to renderer: %+v", result)
	}
	lastRequest := fp.Requests[len(fp.Requests)-1]
	for _, message := range lastRequest.Messages {
		if message.Role == "tool" && (strings.Contains(message.Content, "desktop-exec-1") || strings.Contains(message.Content, "internalSql") || strings.Contains(message.Content, "before")) {
			t.Fatalf("private execution metadata leaked to provider: %s", message.Content)
		}
	}
}

func TestLLM_LocalExecutionAuditTerminalStates(t *testing.T) {
	cases := []struct {
		name         string
		allowed      bool
		meta         connector.ExecutionMeta
		err          error
		wantStatus   string
		wantDecision string
		wantCalls    int
	}{
		{name: "denied", allowed: false, wantStatus: "denied", wantDecision: "deny", wantCalls: 0},
		{name: "source conflict", allowed: true, meta: connector.ExecutionMeta{Status: "source_conflict", ExecutionID: "e-conflict"}, err: &connector.ExecutionError{Message: "source_conflict", Meta: connector.ExecutionMeta{Status: "source_conflict", ExecutionID: "e-conflict"}}, wantStatus: "source_conflict", wantDecision: "allow", wantCalls: 1},
		{name: "explicit failure", allowed: true, meta: connector.ExecutionMeta{Status: "failed", ExecutionID: "e-failed"}, err: &connector.ExecutionError{Message: "failed", Meta: connector.ExecutionMeta{Status: "failed", ExecutionID: "e-failed"}}, wantStatus: "failed", wantDecision: "allow", wantCalls: 1},
		{name: "cancelled", allowed: true, meta: connector.ExecutionMeta{Status: "cancelled", ExecutionID: "e-cancelled"}, err: &connector.ExecutionError{Message: "cancelled", Meta: connector.ExecutionMeta{Status: "cancelled", ExecutionID: "e-cancelled"}}, wantStatus: "cancelled", wantDecision: "allow", wantCalls: 1},
		{name: "timeout unknown", allowed: true, meta: connector.ExecutionMeta{Status: "unknown", IdempotencyKey: "idem-timeout"}, err: errors.New("desktop execution timeout"), wantStatus: "unknown", wantDecision: "allow", wantCalls: 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			data := map[string]any{connector.ExecutionMetaKey: tc.meta}
			tool := &localAuditTool{spec: localAuditSpec(), data: data, err: tc.err}
			allow := map[string]bool{}
			if tc.allowed {
				allow["user:u1|invoker|tool:t/report_production_progress"] = true
				allow["user:u1|viewer|business_record:t/order/SO-1001"] = true
			}
			agent, audit, _, _ := localAuditAgent(t, tool, fakeChecker{allow: allow})
			_, _, _ = agent.Ask(connector.WithDeviceID(context.Background(), "DESKTOP-01"), org.Principal{TenantID: "t", UserID: "u1"}, nil, "更新进度", nil)
			entries := audit.Entries()
			if len(entries) != 1 || entries[0].Status != tc.wantStatus || entries[0].Decision != tc.wantDecision {
				t.Fatalf("audit = %+v, want one %s/%s entry", entries, tc.wantDecision, tc.wantStatus)
			}
			if tool.calls != tc.wantCalls {
				t.Fatalf("tool calls = %d, want %d", tool.calls, tc.wantCalls)
			}
			if !audit.Verify() {
				t.Fatal("audit chain did not verify")
			}
		})
	}
}

func TestLLM_LocalExecutionWithoutResultAllowlistReturnsNoData(t *testing.T) {
	tool := &localAuditTool{spec: localAuditSpec(), data: map[string]any{
		"orderId": "SO-1001", "executionId": "must-not-leak",
		connector.ExecutionMetaKey: connector.ExecutionMeta{Status: "succeeded"},
	}}
	tool.spec.ResultFields = nil
	chk := fakeChecker{allow: map[string]bool{
		"user:u1|invoker|tool:t/report_production_progress": true,
		"user:u1|viewer|business_record:t/order/SO-1001":    true,
	}}
	agent, _, fp, _ := localAuditAgent(t, tool, chk)
	var result map[string]any
	if _, _, err := agent.Ask(context.Background(), org.Principal{TenantID: "t", UserID: "u1"}, nil, "更新进度", func(e Event) {
		if e.Kind == "tool_result" {
			result = e.Data
		}
	}); err != nil {
		t.Fatal(err)
	}
	if len(result) != 0 {
		t.Fatalf("desktop result without allowlist leaked data: %+v", result)
	}
	lastRequest := fp.Requests[len(fp.Requests)-1]
	for _, message := range lastRequest.Messages {
		if message.Role == "tool" && message.ToolCallID == "exec-1" && message.Content != "{}" {
			t.Fatalf("provider received unallowlisted desktop result: %s", message.Content)
		}
	}
}

func TestLLM_LocalExecutionFailedMetadataWithoutErrorDoesNotEmitResult(t *testing.T) {
	tool := &localAuditTool{spec: localAuditSpec(), data: map[string]any{
		"orderId": "SO-1001", "completionRate": float64(80),
		connector.ExecutionMetaKey: connector.ExecutionMeta{Status: "failed", ExecutionID: "e-failed"},
	}}
	chk := fakeChecker{allow: map[string]bool{
		"user:u1|invoker|tool:t/report_production_progress": true,
		"user:u1|viewer|business_record:t/order/SO-1001":    true,
	}}
	agent, audit, _, _ := localAuditAgent(t, tool, chk)
	emittedResult := false
	if _, _, err := agent.Ask(context.Background(), org.Principal{TenantID: "t", UserID: "u1"}, nil, "更新进度", func(e Event) {
		emittedResult = emittedResult || e.Kind == "tool_result"
	}); err != nil {
		t.Fatal(err)
	}
	if emittedResult {
		t.Fatal("failed execution metadata emitted a tool result")
	}
	if entries := audit.Entries(); len(entries) != 1 || entries[0].Status != "failed" {
		t.Fatalf("audit = %+v, want one failed entry", entries)
	}
}

func orderStatusTool() connector.Tool {
	return stubTool{
		spec: connector.ToolSpec{Name: "query_order_status", Description: "查进度",
			Params: []connector.ParamSpec{{Name: "orderId", Required: true}}, ResourceType: "business_record", ResourceKind: "order", ResourceArg: "orderId"},
		out: map[string]any{"orderId": "SO-1001", "status": "生产中"},
	}
}

func orderFinTool() connector.Tool {
	return stubTool{
		spec: connector.ToolSpec{Name: "query_order_financials", Description: "查利润",
			Params: []connector.ParamSpec{{Name: "orderId", Required: true}}, ResourceType: "business_record", ResourceKind: "order", ResourceArg: "orderId", DataDomain: "cost"},
		out: map[string]any{"orderId": "SO-1001", "profit": 18000},
	}
}

func newLLM(t *testing.T, steps []provider.Message, chk Checker) (*LLMAgent, *AuditLog, *provider.Fake) {
	t.Helper()
	fp := &provider.Fake{Steps: steps}
	conns := []connector.Connector{stubConn{tools: []connector.Tool{orderStatusTool(), orderFinTool()}}}
	res := fakeResolver{skills: []SkillInfo{{
		ID: "order360", Name: "订单360", Description: "查订单全景",
		PlaybookMD: "先查状态", AllowedTools: []string{"query_order_status", "query_order_financials"},
	}}}
	audit := NewAuditLog()
	ag := NewLLMAgent(fp, conns, NewGuard(chk, "t"), res, audit, "t")
	return ag, audit, fp
}

// Happy path: load skill → call status → final answer.
func TestLLM_ProgressiveDisclosure_HappyPath(t *testing.T) {
	chk := fakeChecker{allow: map[string]bool{
		"user:u1|invoker|tool:t/query_order_status":      true,
		"user:u1|viewer|business_record:t/order/SO-1001": true,
	}}
	steps := []provider.Message{
		provider.Call("c1", "load_skill", map[string]any{"skillId": "order360"}),
		provider.Call("c2", "query_order_status", map[string]any{"orderId": "SO-1001"}),
		provider.Text("订单 SO-1001 生产中。"),
	}
	ag, audit, fp := newLLM(t, steps, chk)
	final, _, err := ag.Ask(context.Background(), org.Principal{TenantID: "t", UserID: "u1", DisplayName: "小王"}, nil, "SO-1001 怎么样", nil)
	if err != nil {
		t.Fatal(err)
	}
	if final != "订单 SO-1001 生产中。" {
		t.Errorf("final = %q", final)
	}
	// Progressive disclosure: the status tool must NOT be offered until the skill
	// is loaded. Request 1 (before load) has only load_skill; request 2 (after)
	// includes query_order_status.
	if n := len(fp.Requests[0].Tools); n != 1 || fp.Requests[0].Tools[0].Function.Name != "load_skill" {
		t.Errorf("req0 tools = %d, want only load_skill", n)
	}
	if !hasTool(fp.Requests[1].Tools, "query_order_status") {
		t.Error("after load_skill, query_order_status must be offered")
	}
	if len(audit.Entries()) != 1 || audit.Entries()[0].Decision != "allow" {
		t.Errorf("audit = %+v", audit.Entries())
	}
}

// Deny path: skill loaded, but guard denies financials (no cost domain).
func TestLLM_GuardDeniesWithinLoadedSkill(t *testing.T) {
	chk := fakeChecker{allow: map[string]bool{
		"user:u1|invoker|tool:t/query_order_financials":  true,
		"user:u1|viewer|business_record:t/order/SO-1001": true,
		// cost domain absent → deny
	}}
	steps := []provider.Message{
		provider.Call("c1", "load_skill", map[string]any{"skillId": "order360"}),
		provider.Call("c2", "query_order_financials", map[string]any{"orderId": "SO-1001"}),
		provider.Text("利润需要经理权限，暂不可得。"),
	}
	ag, audit, _ := newLLM(t, steps, chk)
	var denied bool
	sink := func(e Event) {
		if e.Kind == "denied" {
			denied = true
		}
	}
	_, _, err := ag.Ask(context.Background(), org.Principal{TenantID: "t", UserID: "u1"}, nil, "利润多少", sink)
	if err != nil {
		t.Fatal(err)
	}
	if !denied {
		t.Error("expected a denied event for financials (no cost domain)")
	}
	if len(audit.Entries()) != 1 || audit.Entries()[0].Decision != "deny" {
		t.Errorf("audit should record one deny, got %+v", audit.Entries())
	}
}

func hasTool(defs []provider.ToolDef, name string) bool {
	for _, d := range defs {
		if d.Function.Name == name {
			return true
		}
	}
	return false
}
