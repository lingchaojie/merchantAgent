// Package connector is the abstraction over enterprise systems. Any system —
// a clean-API ERP, a no-API DB wrapped as read-only queries, or a UI-automation
// fallback — is exposed as a Connector with Tools. The agent runtime only ever
// talks to this interface; MCP is just one transport binding of it (see
// cmd/mock-erp-mcp). This is the "connector seam" from research/10 §4.4.
package connector

import "context"

type ParamType string

const (
	ParamString  ParamType = "string"
	ParamInteger ParamType = "integer"
	ParamBoolean ParamType = "boolean"
)

type ExecutionLocation string

const (
	ExecutionServer  ExecutionLocation = "server"
	ExecutionDesktop ExecutionLocation = "desktop"
)

type RiskLevel string

const (
	RiskRead      RiskLevel = "read"
	RiskLowWrite  RiskLevel = "low_write"
	RiskHighWrite RiskLevel = "high_write"
)

// ParamSpec describes one tool parameter (for schema + LLM/router use).
type ParamSpec struct {
	Name        string
	Description string
	Type        ParamType
	Required    bool
}

// ToolSpec declares a tool AND its authorization footprint. The runtime guard
// (runtime/guard.go) uses the authz fields to enforce research/11 §6.1:
//   - ResourceType+ResourceArg → record-level data authz (can this user view the
//     specific resource, e.g. order:<tenant>/<id>).
//   - DataDomain → sensitivity authz (can this user view e.g. the cost domain).
//
// Empty authz fields mean "not applicable" (e.g. a tool touching no sensitive
// domain leaves DataDomain empty).
type ToolSpec struct {
	PackageID            string
	Version              string
	ManifestDigest       string
	Name                 string
	Description          string
	Params               []ParamSpec
	ResourceType         string
	ResourceKind         string
	ResourceArg          string
	DataDomain           string
	Execution            ExecutionLocation
	Risk                 RiskLevel
	RequiresConfirmation bool
	ResultFields         []string
}

// WithDefaults returns a copy with legacy metadata defaults applied.
func (s ToolSpec) WithDefaults() ToolSpec {
	if s.Execution == "" {
		s.Execution = ExecutionServer
	}
	if s.Risk == "" {
		s.Risk = RiskRead
	}
	return s
}

// Tool is a single callable capability.
type Tool interface {
	Spec() ToolSpec
	// Invoke runs the tool. args are validated against Spec().Params by the
	// caller. The result is a JSON-serializable map.
	Invoke(ctx context.Context, args map[string]any) (map[string]any, error)
}

// Connector groups the tools exposed by one enterprise system.
type Connector interface {
	Name() string
	Tools() []Tool
}

// Lookup finds a tool by name across a connector.
func Lookup(c Connector, name string) (Tool, bool) {
	for _, t := range c.Tools() {
		if t.Spec().Name == name {
			return t, true
		}
	}
	return nil, false
}
