// Package provider is the LLM seam (design §4.5): an OpenAI-compatible chat
// interface with tool calling, behind which any model (Claude/Qwen/GPT via a
// gateway) can be swapped by config. The runtime depends only on this interface,
// so it stays model-agnostic and hermetically testable via a scripted fake.
package provider

import "context"

// Message is one chat message (OpenAI wire shape).
type Message struct {
	Role       string     `json:"role"` // system|user|assistant|tool
	Content    string     `json:"content"`
	ToolCalls  []ToolCall `json:"tool_calls,omitempty"`
	ToolCallID string     `json:"tool_call_id,omitempty"` // set on role=tool
}

// ToolCall is a model-requested function invocation.
type ToolCall struct {
	ID       string       `json:"id"`
	Type     string       `json:"type"` // "function"
	Function FunctionCall `json:"function"`
}

type FunctionCall struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"` // JSON object as a string
}

// ToolDef advertises a callable tool to the model.
type ToolDef struct {
	Type     string       `json:"type"` // "function"
	Function FunctionSpec `json:"function"`
}

type FunctionSpec struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	Parameters  map[string]any `json:"parameters"` // JSON Schema
}

// Request is one completion turn.
type Request struct {
	Messages []Message
	Tools    []ToolDef
}

// Provider turns a request into the assistant's next message (which may carry
// tool calls). Streaming is layered on top by the runtime via events; the
// provider itself is a simple request→message call.
type Provider interface {
	Complete(ctx context.Context, req Request) (Message, error)
}
