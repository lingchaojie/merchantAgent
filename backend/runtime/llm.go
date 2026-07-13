package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

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

// RoleResolver returns the role ids assigned to a principal. The runtime calls
// it once at turn start and carries the sorted snapshot through every invocation.
type RoleResolver interface {
	RoleIDs(ctx context.Context, p org.Principal) ([]string, error)
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

var ErrToolUnavailable = errors.New("tool unavailable")

// LLMAgent is the Phase 1 orchestrator: an LLM tool-calling loop with
// progressive disclosure (skill index resident, playbooks loaded on demand),
// the guard enforced on every tool call, and hash-chained audit. Replaces the
// deterministic KeywordRouter (design §4).
type LLMAgent struct {
	prov    provider.Provider
	guard   *Guard
	skills  SkillResolver
	roles   RoleResolver
	audit   Appender
	tenant  string
	catalog connector.ToolCatalog
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

// WithCatalog adds a dynamic source after the existing catalog. The added
// catalog therefore wins when both expose the same stable tool name.
func (a *LLMAgent) WithCatalog(catalog connector.ToolCatalog) *LLMAgent {
	if catalog == nil {
		return a
	}
	if a.catalog == nil && len(a.tools) > 0 {
		a.catalog = runtimeStaticCatalog{tools: a.tools}
	}
	a.catalog = connector.NewCompositeCatalog(a.catalog, catalog)
	return a
}

// NewLLMAgent wires the loop over a set of connectors (ERP + CRM + …). audit may
// be a single *AuditLog or a *TenantAudit (per-tenant chains).
func NewLLMAgent(prov provider.Provider, conns []connector.Connector, g *Guard, sr SkillResolver, audit Appender, tenant string) *LLMAgent {
	catalog := connector.NewStaticCatalog(conns...)
	tools, _ := catalog.Snapshot(context.Background())
	rr, _ := sr.(RoleResolver)
	return &LLMAgent{prov: prov, guard: g, skills: sr, roles: rr, audit: audit, tenant: tenant, tools: tools, catalog: catalog, maxIter: 8}
}

type runtimeStaticCatalog struct {
	tools map[string]connector.Tool
}

func (c runtimeStaticCatalog) Snapshot(context.Context) (map[string]connector.Tool, error) {
	tools := make(map[string]connector.Tool, len(c.tools))
	for name, tool := range c.tools {
		tools[name] = tool
	}
	return tools, nil
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
		property := map[string]any{"type": string(typ), "description": p.Description}
		if p.MinLength != nil {
			property["minLength"] = *p.MinLength
		}
		if p.MaxLength != nil {
			property["maxLength"] = *p.MaxLength
		}
		if p.Minimum != nil {
			property["minimum"] = *p.Minimum
		}
		if p.Maximum != nil {
			property["maximum"] = *p.Maximum
		}
		if len(p.Enum) > 0 {
			property["enum"] = append([]any(nil), p.Enum...)
		}
		props[p.Name] = property
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
	turnTools, err := a.toolSnapshot(ctx)
	if err != nil {
		return "", history, fmt.Errorf("resolve tool catalog: %w", err)
	}
	index, err := a.skills.UsableSkills(ctx, p)
	if err != nil {
		return "", history, fmt.Errorf("resolve skills: %w", err)
	}
	byID := map[string]SkillInfo{}
	for _, s := range index {
		byID[s.ID] = s
	}
	roleIDs := []string(nil)
	if a.roles != nil {
		roleIDs, err = a.roles.RoleIDs(ctx, p)
		if err != nil {
			return "", history, fmt.Errorf("resolve roles: %w", err)
		}
		sort.Strings(roleIDs)
	}
	turn := turnMeta{RoleIDs: append([]string(nil), roleIDs...), DeviceID: connector.DeviceIDFrom(ctx)}

	msgs := history
	if len(msgs) == 0 {
		vis := a.visibleDomains(ctx, p, index)
		msgs = append(msgs, provider.Message{Role: "system", Content: a.buildSystemPrompt(p, index, vis)})
	}
	msgs = append(msgs, provider.Message{Role: "user", Content: question})

	// Tools start with load_skill + any ambient tools (local files); loading a
	// skill unlocks its connector tools.
	unlockedBy := map[string]string{}
	toolDefs := []provider.ToolDef{loadSkillDef()}
	ambientNames := make([]string, 0, len(a.ambient))
	for n := range a.ambient {
		ambientNames = append(ambientNames, n)
	}
	sort.Strings(ambientNames) // deterministic tool order
	for _, n := range ambientNames {
		unlockedBy[n] = ""
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
			name := tc.Function.Name
			if name != loadSkillTool {
				if _, ambient := a.ambient[name]; !ambient {
					if _, available := turnTools[name]; !available {
						return "", msgs, fmt.Errorf("%w: %s", ErrToolUnavailable, name)
					}
				}
			}
			result := a.dispatchWithTools(ctx, p, tc, byID, unlockedBy, &toolDefs, turn, sink, turnTools)
			msgs = append(msgs, provider.Message{Role: "tool", ToolCallID: tc.ID, Content: result})
		}
	}
	return "", msgs, fmt.Errorf("max iterations (%d) exceeded", a.maxIter)
}

type turnMeta struct {
	RoleIDs  []string
	DeviceID string
}

// dispatch executes one tool call (load_skill or a connector tool) and returns
// the tool-result content to feed back to the model.
func (a *LLMAgent) dispatch(ctx context.Context, p org.Principal, tc provider.ToolCall,
	byID map[string]SkillInfo, unlockedBy map[string]string, toolDefs *[]provider.ToolDef, turn turnMeta, sink EventSink) string {
	tools, _ := a.toolSnapshot(ctx)
	return a.dispatchWithTools(ctx, p, tc, byID, unlockedBy, toolDefs, turn, sink, tools)
}

func (a *LLMAgent) dispatchWithTools(ctx context.Context, p org.Principal, tc provider.ToolCall,
	byID map[string]SkillInfo, unlockedBy map[string]string, toolDefs *[]provider.ToolDef, turn turnMeta, sink EventSink,
	turnTools map[string]connector.Tool) string {

	name := tc.Function.Name
	sink.emit(Event{Kind: "tool_call", Tool: name})
	installedTool, installed := turnTools[name]
	args := map[string]any{}
	if err := json.Unmarshal([]byte(tc.Function.Arguments), &args); err != nil || args == nil {
		if installed {
			skillID := unlockedBy[name]
			spec := installedTool.Spec()
			_ = a.record(p, spec, nil, Decision{Allowed: false, Reason: "invalid tool arguments JSON"}, skillID, tc.ID, turn, "failed", connector.ExecutionMeta{})
			a.emitToolState(sink, spec, name, "failed")
		}
		return "工具参数无效：JSON 格式错误"
	}

	// Progressive disclosure: load_skill reveals a playbook + unlocks its tools.
	if name == loadSkillTool {
		id, _ := args["skillId"].(string)
		sk, ok := byID[id]
		if !ok {
			return fmt.Sprintf("技能 %q 不可用（不在你的可用技能内）。", id)
		}
		for _, tn := range sk.AllowedTools {
			if _, unlocked := unlockedBy[tn]; !unlocked {
				if tool, found := turnTools[tn]; found {
					unlockedBy[tn] = sk.ID
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
		data, err := at.Invoke(ctx, args)
		if err != nil {
			_ = a.record(p, at.Spec(), args, Decision{Allowed: true, Reason: "ambient (client-gated)"}, "", tc.ID, turn, executionStatus(err, connector.ExecutionMeta{}), connector.ExecutionMeta{})
			return fmt.Sprintf("本地文件操作失败：%v", err)
		}
		if err := a.record(p, at.Spec(), args, Decision{Allowed: true, Reason: "ambient (client-gated)"}, "", tc.ID, turn, "succeeded", connector.ExecutionMeta{}); err != nil {
			return "审计记录失败，未返回工具结果"
		}
		sink.emit(Event{Kind: "tool_result", Tool: name, Data: data})
		b, _ := json.Marshal(data)
		return string(b)
	}

	// A connector tool. Must be unlocked by a loaded skill first.
	tool, found := installedTool, installed
	skillID, unlocked := unlockedBy[name]
	if !found {
		return fmt.Sprintf("工具 %q 尚未通过技能解锁或不存在。", name)
	}
	spec := tool.Spec()
	if !unlocked || skillID == "" {
		decision := Decision{Allowed: false, Reason: "tool not unlocked by an authorized skill"}
		_ = a.record(p, spec, args, decision, "", tc.ID, turn, "denied", connector.ExecutionMeta{})
		sink.emit(Event{Kind: "denied", Tool: name})
		return fmt.Sprintf("tool %q is not unlocked by an authorized skill", name)
	}
	if err := connector.ValidateArgs(spec, args); err != nil {
		_ = a.record(p, spec, args, Decision{Allowed: false, Reason: "invalid tool arguments"}, skillID, tc.ID, turn, "failed", connector.ExecutionMeta{})
		a.emitToolState(sink, spec, name, "failed")
		return fmt.Sprintf("工具参数无效：%v", err)
	}

	dec, err := a.guard.Authorize(ctx, p, spec, args)
	if err != nil {
		_ = a.record(p, spec, args, Decision{Allowed: false, Reason: "authorization backend error"}, skillID, tc.ID, turn, "failed", connector.ExecutionMeta{})
		a.emitToolState(sink, spec, name, "failed")
		return fmt.Sprintf("鉴权错误：%v", err)
	}
	if !dec.Allowed {
		_ = a.record(p, spec, args, dec, skillID, tc.ID, turn, "denied", connector.ExecutionMeta{})
		sink.emit(Event{Kind: "denied", Tool: name})
		return "无权限执行该操作（" + dec.Reason + "）。请如实告知用户此项不可得。"
	}
	invocation := connector.InvocationMeta{
		TenantID: p.TenantID, UserID: p.UserID, SkillID: skillID, CallID: tc.ID,
		DeviceID: turn.DeviceID, RoleIDs: append([]string(nil), turn.RoleIDs...),
	}
	invokeCtx := connector.WithInvocation(ctx, invocation)
	if spec.WithDefaults().Execution == connector.ExecutionDesktop {
		sink.emit(Event{Kind: "tool_state", Tool: name, Data: map[string]any{"status": "executing"}})
	}
	data, err := invokeSafely(tool, invokeCtx, args)
	meta := connector.PopExecutionMeta(data)
	status := executionStatus(err, meta)
	auditDecision := dec
	if spec.WithDefaults().Execution == connector.ExecutionDesktop {
		var metaErr error
		meta, status, metaErr = validateDesktopExecution(spec, invocation, meta, err)
		if metaErr != nil {
			auditDecision.Reason = metaErr.Error()
		}
	}
	if auditErr := a.record(p, spec, args, auditDecision, skillID, tc.ID, turn, status, meta); auditErr != nil {
		a.emitToolState(sink, spec, name, "failed")
		return "审计记录失败，未返回工具结果"
	}
	if spec.WithDefaults().Execution == connector.ExecutionDesktop {
		sink.emit(Event{Kind: "tool_state", Tool: name, Data: map[string]any{"status": status}})
	}
	if err != nil {
		return fmt.Sprintf("工具执行出错：%v", err)
	}
	if status != "succeeded" {
		return fmt.Sprintf("工具执行未成功：%s", status)
	}
	public := filterResult(data, spec.ResultFields, spec.WithDefaults().Execution == connector.ExecutionDesktop)
	sink.emit(Event{Kind: "tool_result", Tool: name, Data: public})
	b, _ := json.Marshal(public)
	return string(b)
}

// UsedToolNames returns the connector tool names (for tests/introspection).
func (a *LLMAgent) UsedToolNames() []string {
	tools, _ := a.toolSnapshot(context.Background())
	names := make([]string, 0, len(tools))
	for n := range tools {
		names = append(names, n)
	}
	return names
}

// ToolSpec exposes the effective registered tool contract. When connectors
// publish the same name, this is the spec from the last registered connector.
func (a *LLMAgent) ToolSpec(name string) (connector.ToolSpec, bool) {
	tools, err := a.toolSnapshot(context.Background())
	if err != nil {
		return connector.ToolSpec{}, false
	}
	tool, ok := tools[name]
	if !ok {
		return connector.ToolSpec{}, false
	}
	return tool.Spec().WithDefaults(), true
}

func (a *LLMAgent) toolSnapshot(ctx context.Context) (map[string]connector.Tool, error) {
	if a.catalog != nil {
		return a.catalog.Snapshot(ctx)
	}
	tools := make(map[string]connector.Tool, len(a.tools))
	for name, tool := range a.tools {
		tools[name] = tool
	}
	return tools, nil
}

// record appends an audit entry for a tool decision (nil-safe).
func (a *LLMAgent) record(p org.Principal, spec connector.ToolSpec, args map[string]any, d Decision, skillID, toolCallID string, turn turnMeta, status string, meta connector.ExecutionMeta) error {
	if a.audit == nil {
		return nil
	}
	decision := "allow"
	if !d.Allowed {
		decision = "deny"
	}
	spec = spec.WithDefaults()
	resourceID, _ := args[spec.ResourceArg].(string)
	before, after := meta.Before, meta.After
	deviceID := turn.DeviceID
	if spec.Adapter != "" && spec.DeviceID != "" {
		deviceID = spec.DeviceID
	}
	var connectorAudit *ConnectorAudit
	if spec.Execution == connector.ExecutionDesktop && spec.Adapter != "" {
		before = filterConnectorAuditMap(meta.Before, spec.ResultFields)
		after = filterConnectorAuditMap(meta.After, spec.ResultFields)
		connectorAudit = buildConnectorAudit(spec, args, resourceID, deviceID, status, meta, before, after)
	}
	return a.audit.Append(AuditEntry{
		TenantID: p.TenantID, UserID: p.UserID, SkillID: skillID,
		RoleIDs: append([]string(nil), turn.RoleIDs...), DeviceID: deviceID,
		Tool: spec.Name, ToolCallID: toolCallID, ToolVersion: spec.Version, ExecutionLocation: string(spec.Execution), Risk: string(spec.Risk),
		Args: args, Decision: decision, Status: status, Reason: d.Reason,
		ExecutionID: meta.ExecutionID, IdempotencyKey: meta.IdempotencyKey,
		Confirmed: meta.Confirmed, ConfirmedAt: meta.ConfirmedAt, ResourceID: resourceID,
		Before: before, After: after, Connector: connectorAudit,
	})
}

func buildConnectorAudit(spec connector.ToolSpec, args map[string]any, resourceID, deviceID, status string, meta connector.ExecutionMeta, before, after map[string]any) *ConnectorAudit {
	request, _ := json.Marshal(struct {
		Tool string         `json:"tool"`
		Args map[string]any `json:"args"`
	}{Tool: spec.Name, Args: args})
	return &ConnectorAudit{
		ConnectorID: spec.PackageID, Version: spec.Version, Digest: spec.ManifestDigest,
		Adapter: spec.Adapter, SourceProfileID: meta.SourceProfileID, Environment: spec.Environment,
		DeviceID: deviceID, ResourceKind: spec.ResourceKind, ResourceID: resourceID,
		ResourceRelation: spec.ResourceRelation, ApprovalVersion: spec.Version,
		idempotencyKeyMaterial: []byte(meta.IdempotencyKey), requestFingerprintMaterial: request,
		ExecutionStatus: status, ReadBackStatus: meta.ReadBackStatus, DurationMS: meta.DurationMS,
		Before: before, After: after,
	}
}

func (a *LLMAgent) emitToolState(sink EventSink, spec connector.ToolSpec, tool, status string) {
	if spec.WithDefaults().Execution == connector.ExecutionDesktop {
		sink.emit(Event{Kind: "tool_state", Tool: tool, Data: map[string]any{"status": status}})
	}
}

func invokeSafely(tool connector.Tool, ctx context.Context, args map[string]any) (data map[string]any, err error) {
	defer func() {
		if recover() != nil {
			data = nil
			err = errors.New("connector panic")
		}
	}()
	return tool.Invoke(ctx, args)
}

func executionStatus(err error, meta connector.ExecutionMeta) string {
	if err != nil {
		switch meta.Status {
		case "failed", "cancelled", "source_conflict", "unknown":
			return meta.Status
		}
		if errors.Is(err, context.Canceled) {
			return "cancelled"
		}
		if errors.Is(err, context.DeadlineExceeded) {
			return "unknown"
		}
		return "failed"
	}
	switch meta.Status {
	case "", "succeeded":
		return "succeeded"
	case "failed", "cancelled", "source_conflict", "unknown":
		return meta.Status
	default:
		return "unknown"
	}
}

func validateDesktopExecution(spec connector.ToolSpec, invocation connector.InvocationMeta, meta connector.ExecutionMeta, invokeErr error) (connector.ExecutionMeta, string, error) {
	expectedKey := connector.ExpectedIdempotencyKey(invocation, spec.Name)
	transportTerminal := ""
	switch {
	case errors.Is(invokeErr, context.Canceled):
		transportTerminal = "cancelled"
	case errors.Is(invokeErr, context.DeadlineExceeded):
		transportTerminal = "unknown"
	case invokeErr != nil && strings.TrimSpace(meta.ExecutionID) == "" && (meta.Status == "cancelled" || meta.Status == "unknown"):
		transportTerminal = meta.Status
	}
	if transportTerminal != "" {
		return connector.ExecutionMeta{Status: transportTerminal, IdempotencyKey: expectedKey}, transportTerminal,
			errors.New("local bridge ended before execution identity was available")
	}
	invalid := func(reason string) (connector.ExecutionMeta, string, error) {
		status := "unknown"
		if invokeErr != nil {
			status = "failed"
		}
		return connector.ExecutionMeta{Status: status, IdempotencyKey: expectedKey}, status, errors.New(reason)
	}
	if meta.IdempotencyKey == "" {
		return invalid("execution metadata missing idempotency key")
	}
	if meta.IdempotencyKey != expectedKey {
		return invalid("execution metadata idempotency mismatch")
	}
	if strings.TrimSpace(meta.ExecutionID) == "" {
		return invalid("execution metadata missing execution id")
	}
	if meta.DurationMS < 0 {
		return invalid("execution metadata has invalid duration")
	}
	if spec.Adapter != "" {
		if !publicAuditIdentifier(meta.SourceProfileID) {
			return invalid("execution metadata has invalid source profile")
		}
		if meta.Environment != spec.Environment || (meta.Environment != "test" && meta.Environment != "preproduction") {
			return invalid("execution metadata environment mismatch")
		}
		switch meta.ReadBackStatus {
		case "not_applicable", "not_attempted", "succeeded", "failed", "unknown":
		default:
			return invalid("execution metadata has invalid read-back status")
		}
	}
	switch meta.Status {
	case "succeeded", "failed", "cancelled", "source_conflict", "unknown":
	default:
		return invalid("execution metadata has invalid status")
	}
	if invokeErr != nil && meta.Status == "succeeded" {
		return invalid("execution metadata contradicts invocation error")
	}
	if meta.ConfirmedAt != "" {
		if _, err := time.Parse(time.RFC3339, meta.ConfirmedAt); err != nil {
			return invalid("execution metadata has invalid confirmation time")
		}
	}
	if meta.Status == "succeeded" && spec.RequiresConfirmation {
		if !meta.Confirmed {
			return invalid("execution metadata missing confirmation")
		}
		if meta.ConfirmedAt == "" {
			return invalid("execution metadata missing confirmation time")
		}
	}
	return meta, meta.Status, nil
}

func publicAuditIdentifier(value string) bool {
	if value == "" || len(value) > 128 {
		return false
	}
	if !asciiAlphaNumeric(value[0]) {
		return false
	}
	for index := 1; index < len(value); index++ {
		character := value[index]
		if !(asciiAlphaNumeric(character) || character == '.' || character == '_' || character == '-') {
			return false
		}
	}
	return true
}

func asciiAlphaNumeric(character byte) bool {
	return character >= 'a' && character <= 'z' ||
		character >= 'A' && character <= 'Z' ||
		character >= '0' && character <= '9'
}

func filterResult(data map[string]any, fields []string, enforceAllowlist bool) map[string]any {
	if data == nil {
		return map[string]any{}
	}
	if len(fields) == 0 && !enforceAllowlist {
		return data
	}
	allowed := make(map[string]bool, len(fields))
	for _, field := range fields {
		allowed[field] = true
	}
	out := make(map[string]any, len(fields))
	for key, value := range data {
		if allowed[key] && key != connector.ExecutionMetaKey {
			out[key] = value
		}
	}
	return out
}
