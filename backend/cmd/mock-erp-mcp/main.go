// Command mock-erp-mcp exposes the mock ERP connector as a real MCP server over
// stdio (official modelcontextprotocol/go-sdk). This demonstrates the "connector
// = MCP transport binding" layering: the same connector.Tool set the in-process
// runtime uses is here published to any MCP host. A real ERP connector swaps in
// behind the same interface.
//
// Run: go run ./cmd/mock-erp-mcp   (speaks MCP JSON-RPC on stdin/stdout)
package main

import (
	"context"
	"log"
	"os"

	"github.com/merchantagent/backend/connector"
	"github.com/merchantagent/backend/connector/mockerp"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// orderArgs is the shared input schema (all Phase 0 tools take an order id).
type orderArgs struct {
	OrderID string `json:"orderId" jsonschema:"the order id, e.g. SO-1001"`
}

func main() {
	path := os.Getenv("MOCK_ERP_FILE")
	if path == "" {
		path = "testdata/mock-erp.yaml"
	}
	erp, err := mockerp.Load(path)
	if err != nil {
		log.Fatalf("load mock erp: %v", err)
	}

	srv := mcp.NewServer(&mcp.Implementation{Name: "mock-erp", Version: "0.1.0"}, nil)
	for _, tool := range erp.Tools() {
		registerTool(srv, tool)
	}

	if err := srv.Run(context.Background(), &mcp.StdioTransport{}); err != nil {
		log.Fatalf("mcp server: %v", err)
	}
}

// registerTool binds one connector.Tool as an MCP tool. The closure captures the
// tool; the handler bridges MCP's typed input to the connector's arg map and
// returns the tool's result as structured output.
func registerTool(srv *mcp.Server, tool connector.Tool) {
	spec := tool.Spec()
	handler := func(ctx context.Context, _ *mcp.CallToolRequest, in orderArgs) (*mcp.CallToolResult, map[string]any, error) {
		out, err := tool.Invoke(ctx, map[string]any{"orderId": in.OrderID})
		if err != nil {
			return nil, nil, err
		}
		return nil, out, nil
	}
	mcp.AddTool(srv, &mcp.Tool{Name: spec.Name, Description: spec.Description}, handler)
}
