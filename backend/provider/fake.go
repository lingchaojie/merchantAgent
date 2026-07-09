package provider

import (
	"context"
	"encoding/json"
	"fmt"
)

// Fake is a scripted provider for hermetic tests: it returns queued messages in
// order, ignoring the request. This lets the runtime loop (tool calls,
// progressive disclosure, streaming, audit) be tested with zero network/LLM.
type Fake struct {
	Steps []Message
	calls int
	// Requests captures each request the loop made (for assertions).
	Requests []Request
}

// Complete returns the next scripted message.
func (f *Fake) Complete(_ context.Context, req Request) (Message, error) {
	f.Requests = append(f.Requests, req)
	if f.calls >= len(f.Steps) {
		return Message{}, fmt.Errorf("fake provider: no scripted step %d", f.calls)
	}
	m := f.Steps[f.calls]
	f.calls++
	return m, nil
}

// Text is a helper to script a final assistant message.
func Text(s string) Message { return Message{Role: "assistant", Content: s} }

// Call is a helper to script an assistant message requesting one tool call.
func Call(id, name string, args map[string]any) Message {
	b, _ := json.Marshal(args)
	return Message{Role: "assistant", ToolCalls: []ToolCall{{
		ID: id, Type: "function", Function: FunctionCall{Name: name, Arguments: string(b)},
	}}}
}
