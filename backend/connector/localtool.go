package connector

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
)

const ExecutionMetaKey = "__merchantagent_execution"

type InvocationMeta struct {
	TenantID string
	UserID   string
	SkillID  string
	CallID   string
	DeviceID string
	RoleIDs  []string
}

type LocalToolRequest struct {
	PackageID            string
	PackageVersion       string
	ManifestDigest       string
	Tool                 string
	TenantID             string
	UserID               string
	SkillID              string
	CallID               string
	DeviceID             string
	IdempotencyKey       string
	RoleIDs              []string
	Args                 map[string]any
	Risk                 RiskLevel
	RequiresConfirmation bool
}

type ExecutionMeta struct {
	Status          string         `json:"status"`
	ExecutionID     string         `json:"executionId"`
	IdempotencyKey  string         `json:"idempotencyKey"`
	SourceProfileID string         `json:"sourceProfileId,omitempty"`
	Environment     string         `json:"environment,omitempty"`
	ReadBackStatus  string         `json:"readBackStatus,omitempty"`
	DurationMS      int64          `json:"durationMs,omitempty"`
	ConfirmedAt     string         `json:"confirmedAt"`
	Confirmed       bool           `json:"confirmed"`
	Before          map[string]any `json:"before"`
	After           map[string]any `json:"after"`
}

type LocalToolResponse struct {
	Data  map[string]any `json:"data"`
	Meta  ExecutionMeta  `json:"meta"`
	Error string         `json:"error"`
}

type ExecutionError struct {
	Message string
	Meta    ExecutionMeta
}

func (e *ExecutionError) Error() string {
	if e.Message != "" {
		return e.Message
	}
	if e.Meta.Status != "" {
		return "local tool execution " + e.Meta.Status
	}
	return "local tool execution failed"
}

type LocalToolBridge interface {
	InvokeLocalTool(context.Context, LocalToolRequest) (LocalToolResponse, error)
}

type deviceIDKey struct{}
type invocationKey struct{}
type localToolBridgeKey struct{}

func WithDeviceID(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, deviceIDKey{}, id)
}

func DeviceIDFrom(ctx context.Context) string {
	id, _ := ctx.Value(deviceIDKey{}).(string)
	return id
}

func WithInvocation(ctx context.Context, m InvocationMeta) context.Context {
	return context.WithValue(ctx, invocationKey{}, m)
}

func InvocationFrom(ctx context.Context) (InvocationMeta, bool) {
	m, ok := ctx.Value(invocationKey{}).(InvocationMeta)
	return m, ok
}

// ExpectedIdempotencyKey binds one provider tool call to one local tool.
func ExpectedIdempotencyKey(invocation InvocationMeta, tool string) string {
	input := invocation.TenantID + "|" + invocation.UserID + "|" + invocation.CallID + "|" + tool
	sum := sha256.Sum256([]byte(input))
	return hex.EncodeToString(sum[:])
}

func WithLocalToolBridge(ctx context.Context, b LocalToolBridge) context.Context {
	return context.WithValue(ctx, localToolBridgeKey{}, b)
}

func LocalToolBridgeFrom(ctx context.Context) LocalToolBridge {
	b, _ := ctx.Value(localToolBridgeKey{}).(LocalToolBridge)
	return b
}

func AttachExecutionMeta(data map[string]any, meta ExecutionMeta) {
	if data != nil {
		data[ExecutionMetaKey] = meta
	}
}

func PopExecutionMeta(data map[string]any) ExecutionMeta {
	if data == nil {
		return ExecutionMeta{}
	}
	raw, ok := data[ExecutionMetaKey]
	delete(data, ExecutionMetaKey)
	if !ok {
		return ExecutionMeta{}
	}
	if meta, ok := raw.(ExecutionMeta); ok {
		return meta
	}
	b, err := json.Marshal(raw)
	if err != nil {
		return ExecutionMeta{}
	}
	var meta ExecutionMeta
	if json.Unmarshal(b, &meta) != nil {
		return ExecutionMeta{}
	}
	return meta
}
