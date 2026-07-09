package erp

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/merchantagent/backend/connector"
)

// argStr pulls a required string argument.
func argStr(args map[string]any, name string) (string, error) {
	v, ok := args[name].(string)
	if !ok || v == "" {
		return "", fmt.Errorf("missing %s", name)
	}
	return v, nil
}

// query_order_status — non-sensitive progress info (no data domain).
type statusTool struct{ e *ERP }

func (t *statusTool) Spec() connector.ToolSpec {
	return connector.ToolSpec{
		Name:         "query_order_status",
		Description:  "查询订单进度/交期（不含成本利润）",
		Params:       []connector.ParamSpec{{Name: "orderId", Description: "订单号", Required: true}},
		ResourceType: "order",
		ResourceArg:  "orderId",
	}
}
func (t *statusTool) Invoke(ctx context.Context, args map[string]any) (map[string]any, error) {
	id, err := argStr(args, "orderId")
	if err != nil {
		return nil, err
	}
	var customer, status, promise string
	err = t.e.db.QueryRowContext(ctx,
		`SELECT c.name, o.status, o.promise_date FROM orders o
		 JOIN customers c ON c.customer_id = o.customer_id WHERE o.order_id = ?`, id).
		Scan(&customer, &status, &promise)
	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("order %q not found", id)
	}
	if err != nil {
		return nil, err
	}
	return map[string]any{"orderId": id, "customer": customer, "status": status, "promiseDate": promise}, nil
}

// query_order_financials — touches the sensitive "cost" data domain.
type financialsTool struct{ e *ERP }

func (t *financialsTool) Spec() connector.ToolSpec {
	return connector.ToolSpec{
		Name:         "query_order_financials",
		Description:  "查询订单成本/售价/利润（高敏，成本数据域）",
		Params:       []connector.ParamSpec{{Name: "orderId", Description: "订单号", Required: true}},
		ResourceType: "order",
		ResourceArg:  "orderId",
		DataDomain:   "cost",
	}
}
func (t *financialsTool) Invoke(ctx context.Context, args map[string]any) (map[string]any, error) {
	id, err := argStr(args, "orderId")
	if err != nil {
		return nil, err
	}
	var cost, price int
	err = t.e.db.QueryRowContext(ctx,
		`SELECT cost, price FROM orders WHERE order_id = ?`, id).Scan(&cost, &price)
	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("order %q not found", id)
	}
	if err != nil {
		return nil, err
	}
	return map[string]any{"orderId": id, "cost": cost, "price": price, "profit": price - cost}, nil
}

// check_material_kitting — 齐套/欠料清单, non-sensitive.
type kittingTool struct{ e *ERP }

func (t *kittingTool) Spec() connector.ToolSpec {
	return connector.ToolSpec{
		Name:         "check_material_kitting",
		Description:  "检查订单齐套情况，列出欠料清单",
		Params:       []connector.ParamSpec{{Name: "orderId", Description: "订单号", Required: true}},
		ResourceType: "order",
		ResourceArg:  "orderId",
	}
}
func (t *kittingTool) Invoke(ctx context.Context, args map[string]any) (map[string]any, error) {
	id, err := argStr(args, "orderId")
	if err != nil {
		return nil, err
	}
	var exists int
	if err := t.e.db.QueryRowContext(ctx, `SELECT 1 FROM orders WHERE order_id = ?`, id).Scan(&exists); err == sql.ErrNoRows {
		return nil, fmt.Errorf("order %q not found", id)
	} else if err != nil {
		return nil, err
	}
	rows, err := t.e.db.QueryContext(ctx,
		`SELECT material, required - on_hand AS short FROM boms
		 WHERE order_id = ? AND on_hand < required ORDER BY material`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	shortages := []map[string]any{}
	for rows.Next() {
		var m string
		var short int
		if err := rows.Scan(&m, &short); err != nil {
			return nil, err
		}
		shortages = append(shortages, map[string]any{"material": m, "short": short})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return map[string]any{"orderId": id, "complete": len(shortages) == 0, "shortages": shortages}, nil
}

// query_customer_orders — all orders for a customer (by name), non-sensitive
// fields only. Feeds the cross-system 客户360 scenario (join with CRM by name).
type customerOrdersTool struct{ e *ERP }

func (t *customerOrdersTool) Spec() connector.ToolSpec {
	return connector.ToolSpec{
		Name:        "query_customer_orders",
		Description: "按客户名查该客户的订单列表（进度/交期，不含成本利润）",
		Params:      []connector.ParamSpec{{Name: "customerName", Description: "客户名称", Required: true}},
		// List tool: record-level pre-filtering is a runtime concern (M3), so no
		// single ResourceArg here. Non-sensitive fields only ⇒ no DataDomain.
	}
}
func (t *customerOrdersTool) Invoke(ctx context.Context, args map[string]any) (map[string]any, error) {
	name, err := argStr(args, "customerName")
	if err != nil {
		return nil, err
	}
	rows, err := t.e.db.QueryContext(ctx,
		`SELECT o.order_id, o.status, o.promise_date FROM orders o
		 JOIN customers c ON c.customer_id = o.customer_id
		 WHERE c.name = ? ORDER BY o.order_id`, name)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	orders := []map[string]any{}
	for rows.Next() {
		var oid, status, promise string
		if err := rows.Scan(&oid, &status, &promise); err != nil {
			return nil, err
		}
		orders = append(orders, map[string]any{"orderId": oid, "status": status, "promiseDate": promise})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return map[string]any{"customer": name, "orders": orders}, nil
}
