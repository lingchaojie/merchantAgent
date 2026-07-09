package crm

import (
	"context"
	"fmt"

	"github.com/merchantagent/backend/connector"
)

func argStr(args map[string]any, name string) (string, error) {
	v, ok := args[name].(string)
	if !ok || v == "" {
		return "", fmt.Errorf("missing %s", name)
	}
	return v, nil
}

// query_customer_contacts — contacts for a customer (by name).
type contactsTool struct{ c *CRM }

func (t *contactsTool) Spec() connector.ToolSpec {
	return connector.ToolSpec{
		Name:        "query_customer_contacts",
		Description: "按客户名查联系人（姓名/职务/电话）",
		Params:      []connector.ParamSpec{{Name: "customerName", Description: "客户名称", Required: true}},
	}
}
func (t *contactsTool) Invoke(ctx context.Context, args map[string]any) (map[string]any, error) {
	name, err := argStr(args, "customerName")
	if err != nil {
		return nil, err
	}
	rows, err := t.c.db.QueryContext(ctx,
		`SELECT person, title, phone FROM contacts WHERE customer_name = ? ORDER BY contact_id`, name)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	contacts := []map[string]any{}
	for rows.Next() {
		var person, title, phone string
		if err := rows.Scan(&person, &title, &phone); err != nil {
			return nil, err
		}
		contacts = append(contacts, map[string]any{"person": person, "title": title, "phone": phone})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return map[string]any{"customer": name, "contacts": contacts}, nil
}

// query_customer_followups — recent follow-up notes for a customer (by name).
type followupsTool struct{ c *CRM }

func (t *followupsTool) Spec() connector.ToolSpec {
	return connector.ToolSpec{
		Name:        "query_customer_followups",
		Description: "按客户名查跟进记录（日期/摘要），最近的在前",
		Params:      []connector.ParamSpec{{Name: "customerName", Description: "客户名称", Required: true}},
	}
}
func (t *followupsTool) Invoke(ctx context.Context, args map[string]any) (map[string]any, error) {
	name, err := argStr(args, "customerName")
	if err != nil {
		return nil, err
	}
	rows, err := t.c.db.QueryContext(ctx,
		`SELECT at_date, summary FROM follow_ups WHERE customer_name = ? ORDER BY at_date DESC`, name)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var at, summary string
		if err := rows.Scan(&at, &summary); err != nil {
			return nil, err
		}
		items = append(items, map[string]any{"date": at, "summary": summary})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return map[string]any{"customer": name, "followUps": items}, nil
}

// query_customer_opportunities — open sales opportunities for a customer.
type opportunitiesTool struct{ c *CRM }

func (t *opportunitiesTool) Spec() connector.ToolSpec {
	return connector.ToolSpec{
		Name:        "query_customer_opportunities",
		Description: "按客户名查销售商机（阶段/预估金额）",
		Params:      []connector.ParamSpec{{Name: "customerName", Description: "客户名称", Required: true}},
	}
}
func (t *opportunitiesTool) Invoke(ctx context.Context, args map[string]any) (map[string]any, error) {
	name, err := argStr(args, "customerName")
	if err != nil {
		return nil, err
	}
	rows, err := t.c.db.QueryContext(ctx,
		`SELECT stage, est_amount FROM opportunities WHERE customer_name = ? ORDER BY opp_id`, name)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var stage string
		var amount int
		if err := rows.Scan(&stage, &amount); err != nil {
			return nil, err
		}
		items = append(items, map[string]any{"stage": stage, "estAmount": amount})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return map[string]any{"customer": name, "opportunities": items}, nil
}
