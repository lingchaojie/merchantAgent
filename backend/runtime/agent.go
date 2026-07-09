package runtime

import (
	"context"
	"fmt"
	"regexp"
	"strings"

	"github.com/merchantagent/backend/connector"
	"github.com/merchantagent/backend/org"
)

// IntentRouter maps a natural-language question to a tool call. Phase 0 uses a
// deterministic keyword router (no LLM needed → verifiable). The interface lets
// an LLM-backed router drop in later without changing the runtime.
type IntentRouter interface {
	Route(question string) (tool string, args map[string]any, ok bool)
}

var orderRe = regexp.MustCompile(`[A-Za-z]{1,4}-?\d{3,}`)

// KeywordRouter is a deterministic router for the Phase 0 scenarios.
type KeywordRouter struct{}

func (KeywordRouter) Route(q string) (string, map[string]any, bool) {
	id := orderRe.FindString(q)
	args := map[string]any{}
	if id != "" {
		args["orderId"] = id
	}
	switch {
	case containsAny(q, "利润", "成本", "毛利", "profit", "cost"):
		return "query_order_financials", args, id != ""
	case containsAny(q, "齐套", "欠料", "缺料", "备料", "kitting"):
		return "check_material_kitting", args, id != ""
	case containsAny(q, "进度", "交期", "状态", "什么时候", "progress", "status"):
		return "query_order_status", args, id != ""
	}
	return "", nil, false
}

func containsAny(s string, subs ...string) bool {
	for _, sub := range subs {
		if strings.Contains(s, sub) {
			return true
		}
	}
	return false
}

// Answer is the runtime's response.
type Answer struct {
	Text   string         `json:"text"`
	Tool   string         `json:"tool,omitempty"`
	Data   map[string]any `json:"data,omitempty"`
	Denied bool           `json:"denied,omitempty"`
}

// Agent ties router + guard + connector + audit into one deterministic loop.
type Agent struct {
	conn   connector.Connector
	guard  *Guard
	router IntentRouter
	audit  *AuditLog
}

func NewAgent(c connector.Connector, g *Guard, r IntentRouter, a *AuditLog) *Agent {
	if r == nil {
		r = KeywordRouter{}
	}
	return &Agent{conn: c, guard: g, router: r, audit: a}
}

// Ask runs one turn as the given principal. The guard runs BEFORE the tool, so a
// denied call never touches the enterprise system or the LLM context.
func (a *Agent) Ask(ctx context.Context, p org.Principal, question string) (Answer, error) {
	toolName, args, ok := a.router.Route(question)
	if !ok {
		return Answer{Text: "没听懂，请说明订单号与要查的内容（进度/齐套/利润）。"}, nil
	}
	tool, found := connector.Lookup(a.conn, toolName)
	if !found {
		return Answer{}, fmt.Errorf("unknown tool %q", toolName)
	}
	spec := tool.Spec()

	dec, err := a.guard.Authorize(ctx, p, spec, args)
	if err != nil {
		return Answer{}, err
	}
	a.record(p, question, toolName, args, dec)
	if !dec.Allowed {
		// Don't leak resource existence; give a uniform refusal.
		return Answer{Text: "抱歉，你没有权限查看该信息。", Tool: toolName, Denied: true}, nil
	}

	data, err := tool.Invoke(ctx, args)
	if err != nil {
		return Answer{}, fmt.Errorf("invoke %s: %w", toolName, err)
	}
	return Answer{Text: format(toolName, data), Tool: toolName, Data: data}, nil
}

func (a *Agent) record(p org.Principal, q, tool string, args map[string]any, d Decision) {
	if a.audit == nil {
		return
	}
	decision := "allow"
	if !d.Allowed {
		decision = "deny"
	}
	a.audit.Append(AuditEntry{
		TenantID: p.TenantID, UserID: p.UserID, Question: q,
		Tool: tool, Args: args, Decision: decision, Reason: d.Reason,
	})
}

// format renders a tool result into a short human answer.
func format(tool string, d map[string]any) string {
	switch tool {
	case "query_order_status":
		return fmt.Sprintf("订单 %v（%v）：状态 %v，交期 %v。", d["orderId"], d["customer"], d["status"], d["promiseDate"])
	case "query_order_financials":
		return fmt.Sprintf("订单 %v：成本 %v，售价 %v，利润 %v。", d["orderId"], d["cost"], d["price"], d["profit"])
	case "check_material_kitting":
		if d["complete"] == true {
			return fmt.Sprintf("订单 %v：已齐套。", d["orderId"])
		}
		return fmt.Sprintf("订单 %v：未齐套，欠料 %v。", d["orderId"], d["shortages"])
	}
	return fmt.Sprintf("%v", d)
}
