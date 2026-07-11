package erp

import (
	"context"
	"testing"

	"github.com/merchantagent/backend/connector"
)

func open(t *testing.T) *ERP {
	t.Helper()
	e, err := Open()
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { e.Close() })
	return e
}

func TestTools_AuthzFootprint(t *testing.T) {
	want := map[string]string{ // tool → data domain
		"query_order_status":     "",
		"query_order_financials": "cost",
		"check_material_kitting": "",
		"query_customer_orders":  "",
	}
	e := open(t)
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
		if s.ResourceArg != "" && (s.ResourceType != "business_record" || s.ResourceKind != "order") {
			t.Errorf("%s resource footprint wrong: %+v", s.Name, s)
		}
	}
}

func TestStatusTool_ContractPreserved(t *testing.T) {
	e := open(t)
	tool, _ := connector.Lookup(e, "query_order_status")
	out, err := tool.Invoke(context.Background(), map[string]any{"orderId": "SO-1001"})
	if err != nil {
		t.Fatal(err)
	}
	if out["status"] != "生产中" || out["customer"] != "A公司" {
		t.Errorf("SO-1001 = %v", out)
	}
	if _, ok := out["cost"]; ok {
		t.Error("status tool must not leak cost")
	}
}

func TestFinancialsTool_Profit(t *testing.T) {
	e := open(t)
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
	e := open(t)
	tool, _ := connector.Lookup(e, "check_material_kitting")
	out, err := tool.Invoke(context.Background(), map[string]any{"orderId": "SO-1001"})
	if err != nil {
		t.Fatal(err)
	}
	if out["complete"] != false {
		t.Error("SO-1001 should be incomplete (螺栓 short 200)")
	}
	sh, _ := out["shortages"].([]map[string]any)
	if len(sh) != 1 || sh[0]["short"] != 200 || sh[0]["material"] != "M-螺栓" {
		t.Errorf("shortages = %v", out["shortages"])
	}
}

func TestCustomerOrders_360(t *testing.T) {
	e := open(t)
	tool, _ := connector.Lookup(e, "query_customer_orders")
	out, err := tool.Invoke(context.Background(), map[string]any{"customerName": "A公司"})
	if err != nil {
		t.Fatal(err)
	}
	orders, _ := out["orders"].([]map[string]any)
	if len(orders) != 2 { // SO-1001, SO-1002
		t.Errorf("A公司 orders = %v, want 2", out["orders"])
	}
}

func TestReadOnly_WritesRejected(t *testing.T) {
	e := open(t)
	if _, err := e.db.Exec(`INSERT INTO orders (order_id, customer_id, owner_user_id, owner_dept_id, status, promise_date, cost, price)
		VALUES ('X','C-A','u','d','x','2026-01-01',1,1)`); err == nil {
		t.Error("expected write to be rejected under query_only")
	}
}
