package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/merchantagent/backend/provider"
	"github.com/merchantagent/backend/runtime"
	"github.com/merchantagent/backend/wire"
)

// TestBridge_LocalFileRoundTrip is the M4b end-to-end proof: a stand-in desktop
// client drives the real server + real LLM, handling file_request events with
// real temp files. It proves the reverse bridge chains read → query → write.
// Opt-in: skips without LLM_API_KEY / OpenFGA.
func TestBridge_LocalFileRoundTrip(t *testing.T) {
	key := os.Getenv("LLM_API_KEY")
	if key == "" {
		t.Skip("set LLM_API_KEY (source backend/dev.env) for the M4b bridge test")
	}
	fga := envOr("OPENFGA_API_URL", "http://localhost:18080")
	tenant := "mock-corp-001"
	prov := provider.NewOpenAI(envOr("LLM_BASE_URL", "https://www.linx2.ai"), key, envOr("LLM_MODEL", "gpt-5.5"))

	asm, err := wire.Assemble(context.Background(), wire.Config{
		OpenFGAURL: fga, Tenant: tenant,
		OrgFile:  filepath.Join("..", "..", "testdata", "mock-org.yaml"),
		Provider: prov,
	})
	if err != nil {
		t.Skipf("assemble (is OpenFGA up?): %v", err)
	}
	defer asm.Close()

	s := &server{asm: asm, tenant: tenant, sessions: map[string][]provider.Message{}, pending: map[string]chan fileResult{}}
	ts := httptest.NewServer(s.routes())
	defer ts.Close()

	// Workspace with a seed file naming an order.
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "orders.txt"), []byte("请处理订单 SO-1001"), 0o600); err != nil {
		t.Fatal(err)
	}

	final := driveChat(t, ts.URL, dir, "u_sales1",
		"读取工作区文件 orders.txt 得到订单号，用技能查询它的进度和交期，然后把一句话结论写入 result.txt")
	t.Logf("final: %s", final)

	// The result file must have been written via the write bridge.
	out, err := os.ReadFile(filepath.Join(dir, "result.txt"))
	if err != nil {
		t.Fatalf("result.txt not written (write bridge failed): %v", err)
	}
	if len(bytes.TrimSpace(out)) == 0 {
		t.Error("result.txt is empty")
	}
	t.Logf("result.txt: %s", out)

	// Audit proves the chain: local file read + order query + local file write.
	entries := asm.Audit.Chain(tenant).Entries()
	for _, want := range []string{"read_local_file", "query_order_status", "write_local_file"} {
		if !auditHasTool(entries, want) {
			t.Errorf("audit missing %q; entries=%+v", want, entries)
		}
	}
}

func auditHasTool(entries []runtime.AuditEntry, tool string) bool {
	for _, e := range entries {
		if e.Tool == tool {
			return true
		}
	}
	return false
}

// driveChat acts as the desktop client: POST /chat, stream SSE, and handle
// file_request events with real files in dir, POSTing results back so the
// blocked backend tool resumes. Returns the final answer text.
func driveChat(t *testing.T, baseURL, dir, userID, question string) string {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"sessionId": "s1", "userId": userID, "question": question})
	resp, err := http.Post(baseURL+"/chat", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("chat post: %v", err)
	}
	defer resp.Body.Close()

	final := ""
	var kind, data string
	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 64*1024), 1<<20)
	for sc.Scan() {
		line := sc.Text()
		switch {
		case strings.HasPrefix(line, "event:"):
			kind = strings.TrimSpace(line[6:])
		case strings.HasPrefix(line, "data:"):
			data = strings.TrimSpace(line[5:])
		case line == "": // blank line ends an event block → dispatch
			if kind == "file_request" {
				handleFileReq(t, baseURL, dir, data)
			}
			if kind == "done" || kind == "final" {
				var m map[string]any
				_ = json.Unmarshal([]byte(data), &m)
				if s, ok := m["text"].(string); ok && s != "" {
					final = s
				}
			}
			kind, data = "", ""
		}
	}
	return final
}

// handleFileReq performs one file op in dir (jailed to its basename) and posts
// the result back to /chat/file-result.
func handleFileReq(t *testing.T, baseURL, dir, data string) {
	t.Helper()
	var m struct {
		ReqID   string `json:"reqId"`
		Op      string `json:"op"`
		Path    string `json:"path"`
		Content string `json:"content"`
	}
	if err := json.Unmarshal([]byte(data), &m); err != nil {
		t.Errorf("bad file_request: %v", err)
		return
	}
	res := map[string]string{"reqId": m.ReqID}
	full := filepath.Join(dir, filepath.Base(m.Path)) // simple jail (stands in for fsguard)
	switch m.Op {
	case "read":
		b, err := os.ReadFile(full)
		if err != nil {
			res["error"] = err.Error()
		} else {
			res["content"] = string(b)
		}
	case "write":
		if err := os.WriteFile(full, []byte(m.Content), 0o600); err != nil {
			res["error"] = err.Error()
		} else {
			res["content"] = "written " + m.Path
		}
	default:
		res["error"] = "unknown op " + m.Op
	}
	rb, _ := json.Marshal(res)
	r, err := http.Post(baseURL+"/chat/file-result", "application/json", bytes.NewReader(rb))
	if err != nil {
		t.Errorf("file-result post: %v", err)
		return
	}
	r.Body.Close()
}
