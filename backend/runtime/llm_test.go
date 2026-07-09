package runtime

import (
	"context"
	"testing"

	"github.com/merchantagent/backend/connector"
	"github.com/merchantagent/backend/connector/localfile"
	"github.com/merchantagent/backend/org"
	"github.com/merchantagent/backend/provider"
)

// fakeBridge canned-answers file requests (stands in for the desktop).
type fakeBridge struct{ readContent string }

func (f fakeBridge) RequestFile(_ context.Context, op, path, _ string) (string, error) {
	if op == "read" {
		return f.readContent, nil
	}
	return "written:" + path, nil
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

func (c stubConn) Name() string             { return "stub" }
func (c stubConn) Tools() []connector.Tool  { return c.tools }

type fakeResolver struct{ skills []SkillInfo }

func (f fakeResolver) UsableSkills(context.Context, org.Principal) ([]SkillInfo, error) {
	return f.skills, nil
}

func orderStatusTool() connector.Tool {
	return stubTool{
		spec: connector.ToolSpec{Name: "query_order_status", Description: "查进度",
			Params: []connector.ParamSpec{{Name: "orderId", Required: true}}, ResourceType: "order", ResourceArg: "orderId"},
		out: map[string]any{"orderId": "SO-1001", "status": "生产中"},
	}
}

func orderFinTool() connector.Tool {
	return stubTool{
		spec: connector.ToolSpec{Name: "query_order_financials", Description: "查利润",
			Params: []connector.ParamSpec{{Name: "orderId", Required: true}}, ResourceType: "order", ResourceArg: "orderId", DataDomain: "cost"},
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
		"user:u1|invoker|tool:t/query_order_status": true,
		"user:u1|viewer|order:t/SO-1001":            true,
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
		"user:u1|invoker|tool:t/query_order_financials": true,
		"user:u1|viewer|order:t/SO-1001":                true,
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
