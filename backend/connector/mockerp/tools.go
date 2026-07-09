package mockerp

import (
	"context"
	"fmt"

	"github.com/merchantagent/backend/connector"
)

// argOrderID pulls the "orderId" argument.
func argOrderID(args map[string]any) (string, error) {
	v, ok := args["orderId"].(string)
	if !ok || v == "" {
		return "", fmt.Errorf("missing orderId")
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
func (t *statusTool) Invoke(_ context.Context, args map[string]any) (map[string]any, error) {
	id, err := argOrderID(args)
	if err != nil {
		return nil, err
	}
	o, err := t.e.order(id)
	if err != nil {
		return nil, err
	}
	return map[string]any{"orderId": o.OrderID, "customer": o.Customer, "status": o.Status, "promiseDate": o.PromiseDate}, nil
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
func (t *financialsTool) Invoke(_ context.Context, args map[string]any) (map[string]any, error) {
	id, err := argOrderID(args)
	if err != nil {
		return nil, err
	}
	o, err := t.e.order(id)
	if err != nil {
		return nil, err
	}
	return map[string]any{"orderId": o.OrderID, "cost": o.Cost, "price": o.Price, "profit": o.Price - o.Cost}, nil
}

// check_material_kitting — 齐套/欠料清单 (M2), non-sensitive.
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
func (t *kittingTool) Invoke(_ context.Context, args map[string]any) (map[string]any, error) {
	id, err := argOrderID(args)
	if err != nil {
		return nil, err
	}
	if _, err := t.e.order(id); err != nil {
		return nil, err
	}
	var shortages []map[string]any
	complete := true
	for _, b := range t.e.boms[id] {
		if b.OnHand < b.Required {
			complete = false
			shortages = append(shortages, map[string]any{"material": b.Material, "short": b.Required - b.OnHand})
		}
	}
	return map[string]any{"orderId": id, "complete": complete, "shortages": shortages}, nil
}
