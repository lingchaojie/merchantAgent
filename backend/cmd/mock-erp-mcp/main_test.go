package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// TestMCPServer_Smoke builds the server binary, spawns it over stdio, and
// exercises it as a real MCP client: initialize → tools/list → tools/call.
// Proves the connector→MCP binding actually works end to end.
func TestMCPServer_Smoke(t *testing.T) {
	if _, err := exec.LookPath("go"); err != nil {
		t.Skip("go toolchain not available")
	}
	bin := filepath.Join(t.TempDir(), "mock-erp-mcp")
	build := exec.Command("go", "build", "-o", bin, ".")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build: %v\n%s", err, out)
	}
	erpFile, _ := filepath.Abs(filepath.Join("..", "..", "testdata", "mock-erp.yaml"))

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	cmd := exec.Command(bin)
	cmd.Env = append(os.Environ(), "MOCK_ERP_FILE="+erpFile)
	client := mcp.NewClient(&mcp.Implementation{Name: "test", Version: "0"}, nil)
	cs, err := client.Connect(ctx, &mcp.CommandTransport{Command: cmd}, nil)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer cs.Close()

	tools, err := cs.ListTools(ctx, nil)
	if err != nil {
		t.Fatalf("list tools: %v", err)
	}
	if len(tools.Tools) != 3 {
		t.Errorf("got %d tools, want 3", len(tools.Tools))
	}

	res, err := cs.CallTool(ctx, &mcp.CallToolParams{
		Name:      "query_order_status",
		Arguments: map[string]any{"orderId": "SO-1001"},
	})
	if err != nil {
		t.Fatalf("call tool: %v", err)
	}
	if res.IsError {
		t.Fatalf("tool returned error: %+v", res.Content)
	}
	sc, ok := res.StructuredContent.(map[string]any)
	if !ok || sc["status"] != "生产中" {
		t.Errorf("unexpected structured content: %#v", res.StructuredContent)
	}
}
