package mockerp

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/merchantagent/backend/connector"
)

func load(t *testing.T) *ERP {
	t.Helper()
	e, err := Load(filepath.Join("..", "..", "testdata", "mock-erp.yaml"))
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	return e
}

func TestTools_SpecsAndAuthzFootprint(t *testing.T) {
	e := load(t)
	want := map[string]string{ // tool → data domain
		"query_order_status":     "",
		"query_order_financials": "cost",
		"check_material_kitting": "",
	}
	for _, tl := range e.Tools() {
		s := tl.Spec()
		dd, ok := want[s.Name]
		if !ok {
			t.Errorf("unexpected tool %q", s.Name)
			continue
		}
		if s.DataDomain != dd {
			t.Errorf("%s DataDomain = %q, want %q", s.Name, s.DataDomain, dd)
		}
		if s.ResourceType != "order" || s.ResourceArg != "orderId" {
			t.Errorf("%s resource footprint wrong: %+v", s.Name, s)
		}
	}
}

func TestStatusTool(t *testing.T) {
	e := load(t)
	tool, _ := connector.Lookup(e, "query_order_status")
	out, err := tool.Invoke(context.Background(), map[string]any{"orderId": "SO-1001"})
	if err != nil {
		t.Fatal(err)
	}
	if out["status"] != "生产中" {
		t.Errorf("status = %v", out["status"])
	}
	if _, ok := out["cost"]; ok {
		t.Error("status tool must not leak cost")
	}
}

func TestFinancialsTool_Profit(t *testing.T) {
	e := load(t)
	tool, _ := connector.Lookup(e, "query_order_financials")
	out, err := tool.Invoke(context.Background(), map[string]any{"orderId": "SO-1001"})
	if err != nil {
		t.Fatal(err)
	}
	if out["profit"] != 18000 { // 100000 - 82000
		t.Errorf("profit = %v, want 18000", out["profit"])
	}
}

func TestKittingTool_Shortage(t *testing.T) {
	e := load(t)
	tool, _ := connector.Lookup(e, "check_material_kitting")
	out, err := tool.Invoke(context.Background(), map[string]any{"orderId": "SO-1001"})
	if err != nil {
		t.Fatal(err)
	}
	if out["complete"] != false {
		t.Error("SO-1001 should be incomplete (螺栓 short 200)")
	}
	sh, _ := out["shortages"].([]map[string]any)
	if len(sh) != 1 || sh[0]["short"] != 200 {
		t.Errorf("shortages = %v", out["shortages"])
	}
}
