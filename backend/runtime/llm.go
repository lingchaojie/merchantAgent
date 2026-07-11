package runtime

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/merchantagent/backend/connector"
	"github.com/merchantagent/backend/org"
	"github.com/merchantagent/backend/provider"
)

// SkillInfo is the minimal skill shape the loop needs (prompt index + load).
type SkillInfo struct {
	ID           string
	Name         string
	Description  string
	PlaybookMD   string
	AllowedTools []string
	DataDomains  []string
}

// SkillResolver returns the skills a principal MAY use (already filtered by
// usable_by). Used for the prompt index and to gate load_skill. The guard still
// re-checks every tool call, so this is not the security boundary — only the
// pre-filter / progressive-disclosure surface (design §4).
type SkillResolver interface {
	UsableSkills(ctx context.Context, p org.Principal) ([]SkillInfo, error)
}

// Event is a streamed step of one turn (agentd relays these over SSE).
type Event struct {
	Kind string         `json:"kind"` // assistant|tool_call|tool_result|denied|final|skill_loaded
	Text string         `json:"text,omitempty"`
	Tool string         `json:"tool,omitempty"`
	Data map[string]any `json:"data,omitempty"`
}

// EventSink receives events during a turn (nil = ignore).
type EventSink func(Event)

func (s EventSink) emit(e Event) {
	if s != nil {
		s(e)
	}
}

const loadSkillTool = "load_skill"

// LLMAgent is the Phase 1 orchestrator: an LLM tool-calling loop with
// progressive disclosure (skill index resident, playbooks loaded on demand),
// the guard enforced on every tool call, and hash-chained audit. Replaces the
// deterministic KeywordRouter (design §4).
type LLMAgent struct {
	prov    provider.Provider
	guard   *Guard
	skills  SkillResolver
	audit   Appender
	tenant  string
	tools   map[string]connector.Tool // name → tool, across all connectors
	ambient map[string]connector.Tool // always-on tools (local files); no guard
	maxIter int
}

// WithAmbient registers ambient tools (e.g. local files): offered from the start,
// not skill-gated and not OpenFGA-guarded — they self-gate on the client
// (fsguard + user confirmation), a different regime from enterprise data.
func (a *LLMAgent) WithAmbient(tools ...connector.Tool) *LLMAgent {
	if a.ambient == nil {
		a.ambient = map[string]connector.Tool{}
	}
	for _, t := range tools {
		a.ambient[t.Spec().Name] = t
	}
	return a
}

// NewLLMAgent wires the loop over a set of connectors (ERP + CRM + …). audit may
// be a single *AuditLog or a *TenantAudit (per-tenant chains).
func NewLLMAgent(prov provider.Provider, conns []connector.Connector, g *Guard, sr SkillResolver, audit Appender, tenant string) *LLMAgent {
	tools := map[string]connector.Tool{}
	for _, c := range conns {
		for _, t := range c.Tools() {
			tools[t.Spec().Name] = t
		}
	}
	return &LLMAgent{prov: prov, guard: g, skills: sr, audit: audit, tenant: tenant, tools: tools, maxIter: 8}
}

// loadSkillDef advertises the meta-tool that reveals a skill's playbook + unlocks
// its tools (progressive disclosure, design §4.3).
func loadSkillDef() provider.ToolDef {
	return provider.ToolDef{Type: "function", Function: provider.FunctionSpec{
		Name:        loadSkillTool,
		Description: "加载一个技能(skill)的操作剧本并解锁其工具。先根据技能索引判断该用哪个，再调用它。",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"skillId": map[string]any{"type": "string", "description": "要加载的技能 id"},
			},
			"required": []string{"skillId"},
		},
	}}
}

// toolDef converts a connector ToolSpec into an OpenAI tool definition.
func toolDef(spec connector.ToolSpec) provider.ToolDef {
	props := map[string]any{}
	var required []string
	for _, p := range spec.Params {
		typ := p.Type
		if typ == "" {
			typ = connector.ParamString
		}
		props[p.Name] = map[string]any{"type": string(typ), "description": p.Description}
		if p.Required {
			required = append(required, p.Name)
		}
	}
	return provider.ToolDef{Type: "function", Function: provider.FunctionSpec{
		Name:        spec.Name,
		Description: spec.Description,
		Parameters:  map[string]any{"type": "object", "properties": props, "required": required},
	}}
}

// buildSystemPrompt assembles the 5 layers (design §4.2). The skill INDEX is
// resident; playbook bodies are appended only as skills get loaded. visibleDomains
// is the caller's data-domain visibility (layer-5 boundary note) so the model
// decides deterministically instead of guessing from the role name.
func (a *LLMAgent) buildSystemPrompt(p org.Principal, index []SkillInfo, visibleDomains []string) string {
	var b strings.Builder
	// 1. platform base — the ironclad rules.
	b.WriteString("你是企业智能助手。铁律：只使用系统提供给你的工具；不要猜测或编造数据；" +
		"若某信息无权限或工具不可用，如实说明不可得，不要暴露记录是否存在。\n\n")
	// 2. tenant.
	fmt.Fprintf(&b, "【企业】租户 %s（贸易/制造业）。\n", p.TenantID)
	// 3. role/caller.
	fmt.Fprintf(&b, "【当前用户】%s（id=%s）。按其岗位权限作答。\n", p.DisplayName, p.UserID)
	// 4. skill index (progressive disclosure — names + one-liners only).
	b.WriteString("\n【可用技能索引】（需要时用 load_skill 加载其剧本再操作）：\n")
	for _, s := range index {
		fmt.Fprintf(&b, "- %s：%s\n", s.ID, s.Description)
	}
	if len(index) == 0 {
		b.WriteString("- （无）\n")
	}
	// 5. boundary note (advisory, for UX/efficiency — NOT the security boundary;
	// the guard re-checks every call). Tells the model which sensitive domains the
	// caller may see, so it won't waste a call that would be denied.
	if len(visibleDomains) > 0 {
		labels := make([]string, len(visibleDomains))
		for i, d := range visibleDomains {
			labels[i] = domainLabel(d)
		}
		fmt.Fprintf(&b, "\n【数据权限】你有权查看的敏感数据域：%s。工具涉及的敏感数据只要在此范围内，即可正常调用；超出此范围的敏感数据不要调用，如实告知用户需更高权限。\n", strings.Join(labels, "、"))
	} else {
		b.WriteString("\n【数据权限】你没有任何敏感数据域的查看权限。凡涉及成本、利润、定价、底价等敏感数据的工具一律不要调用，直接如实告知用户该信息需更高权限。\n")
	}
	b.WriteString("\n只有已加载技能所暴露的工具可调用。请用中文简洁作答。")
	return b.String()
}

// domainLabel maps a data-domain id to a Chinese label that matches the wording
// in tool descriptions (so the model can align "cost" with 成本数据域).
func domainLabel(d string) string {
	switch d {
	case "cost":
		return "成本(cost)"
	case "pricing":
		return "定价/售价(pricing)"
	case "finance":
		return "财务(finance)"
	case "margin":
		return "毛利(margin)"
	}
	return d
}

// visibleDomains returns the sensitive data domains the caller may view, from the
// union declared across their usable skills (advisory boundary note).
func (a *LLMAgent) visibleDomains(ctx context.Context, p org.Principal, index []SkillInfo) []string {
	seen, order := map[string]bool{}, []string{}
	for _, s := range index {
		for _, d := range s.DataDomains {
			if !seen[d] {
				seen[d] = true
				order = append(order, d)
			}
		}
	}
	var visible []string
	for _, d := range order {
		if ok, err := a.guard.CanViewDomain(ctx, p.UserID, d); err == nil && ok {
			visible = append(visible, d)
		}
	}
	return visible
}

// Ask runs one turn for a principal, returning the final text and the updated
// message history (for multi-turn sessions). Events stream via sink.
func (a *LLMAgent) Ask(ctx context.Context, p org.Principal, history []provider.Message, question string, sink EventSink) (string, []provider.Message, error) {
	index, err := a.skills.UsableSkills(ctx, p)
	if err != nil {
		return "", history, fmt.Errorf("resolve skills: %w", err)
	}
	byID := map[string]SkillInfo{}
	for _, s := range index {
		byID[s.ID] = s
	}

	msgs := history
	if len(msgs) == 0 {
		vis := a.visibleDomains(ctx, p, index)
		msgs = append(msgs, provider.Message{Role: "system", Content: a.buildSystemPrompt(p, index, vis)})
	}
	msgs = append(msgs, provider.Message{Role: "user", Content: question})

	// Tools start with load_skill + any ambient tools (local files); loading a
	// skill unlocks its connector tools.
	available := map[string]bool{}
	toolDefs := []provider.ToolDef{loadSkillDef()}
	ambientNames := make([]string, 0, len(a.ambient))
	for n := range a.ambient {
		ambientNames = append(ambientNames, n)
	}
	sort.Strings(ambientNames) // deterministic tool order
	for _, n := range ambientNames {
		available[n] = true
		toolDefs = append(toolDefs, toolDef(a.ambient[n].Spec()))
	}

	for iter := 0; iter < a.maxIter; iter++ {
		out, err := a.prov.Complete(ctx, provider.Request{Messages: msgs, Tools: toolDefs})
		if err != nil {
			return "", msgs, fmt.Errorf("llm complete: %w", err)
		}
		msgs = append(msgs, out)

		if len(out.ToolCalls) == 0 {
			sink.emit(Event{Kind: "final", Text: out.Content})
			return out.Content, msgs, nil
		}
		if out.Content != "" {
			sink.emit(Event{Kind: "assistant", Text: out.Content})
		}

		for _, tc := range out.ToolCalls {
			result := a.dispatch(ctx, p, tc, byID, available, &toolDefs, sink)
			msgs = append(msgs, provider.Message{Role: "tool", ToolCallID: tc.ID, Content: result})
		}
	}
	return "", msgs, fmt.Errorf("max iterations (%d) exceeded", a.maxIter)
}

// dispatch executes one tool call (load_skill or a connector tool) and returns
// the tool-result content to feed back to the model.
func (a *LLMAgent) dispatch(ctx context.Context, p org.Principal, tc provider.ToolCall,
	byID map[string]SkillInfo, available map[string]bool, toolDefs *[]provider.ToolDef, sink EventSink) string {

	args := map[string]any{}
	_ = json.Unmarshal([]byte(tc.Function.Arguments), &args)
	name := tc.Function.Name
	sink.emit(Event{Kind: "tool_call", Tool: name, Data: args})

	// Progressive disclosure: load_skill reveals a playbook + unlocks its tools.
	if name == loadSkillTool {
		id, _ := args["skillId"].(string)
		sk, ok := byID[id]
		if !ok {
			return fmt.Sprintf("技能 %q 不可用（不在你的可用技能内）。", id)
		}
		for _, tn := range sk.AllowedTools {
			if !available[tn] {
				if tool, found := a.tools[tn]; found {
					available[tn] = true
					*toolDefs = append(*toolDefs, toolDef(tool.Spec()))
				}
			}
		}
		sink.emit(Event{Kind: "skill_loaded", Tool: id})
		return fmt.Sprintf("已加载技能「%s」。剧本：\n%s\n可用工具：%s",
			sk.Name, sk.PlaybookMD, strings.Join(sk.AllowedTools, ", "))
	}

	// Ambient tool (local files): no skill gate, no OpenFGA guard — it self-gates
	// on the client (fsguard + confirmation). Audited as an ambient action.
	if at, ok := a.ambient[name]; ok {
		if err := connector.ValidateArgs(at.Spec(), args); err != nil {
			return fmt.Sprintf("工具参数无效：%v", err)
		}
		a.record(p, name, args, Decision{Allowed: true, Reason: "ambient (client-gated)"})
		data, err := at.Invoke(ctx, args)
		if err != nil {
			return fmt.Sprintf("本地文件操作失败：%v", err)
		}
		sink.emit(Event{Kind: "tool_result", Tool: name, Data: data})
		b, _ := json.Marshal(data)
		return string(b)
	}

	// A connector tool. Must be unlocked by a loaded skill first.
	tool, found := a.tools[name]
	if !found || !available[name] {
		return fmt.Sprintf("工具 %q 尚未通过技能解锁或不存在。", name)
	}
	spec := tool.Spec()
	if err := connector.ValidateArgs(spec, args); err != nil {
		return fmt.Sprintf("工具参数无效：%v", err)
	}

	dec, err := a.guard.Authorize(ctx, p, spec, args)
	if err != nil {
		return fmt.Sprintf("鉴权错误：%v", err)
	}
	a.record(p, name, args, dec)
	if !dec.Allowed {
		sink.emit(Event{Kind: "denied", Tool: name})
		return "无权限执行该操作（" + dec.Reason + "）。请如实告知用户此项不可得。"
	}
	data, err := tool.Invoke(ctx, args)
	if err != nil {
		return fmt.Sprintf("工具执行出错：%v", err)
	}
	sink.emit(Event{Kind: "tool_result", Tool: name, Data: data})
	b, _ := json.Marshal(data)
	return string(b)
}

// UsedToolNames returns the connector tool names (for tests/introspection).
func (a *LLMAgent) UsedToolNames() []string {
	names := make([]string, 0, len(a.tools))
	for n := range a.tools {
		names = append(names, n)
	}
	return names
}

// record appends an audit entry for a tool decision (nil-safe).
func (a *LLMAgent) record(p org.Principal, tool string, args map[string]any, d Decision) {
	if a.audit == nil {
		return
	}
	decision := "allow"
	if !d.Allowed {
		decision = "deny"
	}
	a.audit.Append(AuditEntry{
		TenantID: p.TenantID, UserID: p.UserID, Tool: tool, Args: args,
		Decision: decision, Reason: d.Reason,
	})
}
