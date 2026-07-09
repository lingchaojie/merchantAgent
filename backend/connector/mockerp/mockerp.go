// Package mockerp is a Phase 0 stand-in for a real ERP connector. It reads
// orders + BOMs from testdata/mock-erp.yaml and exposes them as tools. A real
// Kingdee/用友 connector (clean API) or a DB-wrapped read-only connector
// replaces this behind the same connector.Connector interface.
package mockerp

import (
	"fmt"
	"os"

	"github.com/merchantagent/backend/connector"
	"gopkg.in/yaml.v3"
)

type Order struct {
	OrderID     string `yaml:"orderId"`
	OwnerUserID string `yaml:"ownerUserId"`
	OwnerDeptID string `yaml:"ownerDeptId"`
	Customer    string `yaml:"customer"`
	Status      string `yaml:"status"`
	PromiseDate string `yaml:"promiseDate"`
	Cost        int    `yaml:"cost"`
	Price       int    `yaml:"price"`
}

type BomItem struct {
	Material string `yaml:"material"`
	Required int    `yaml:"required"`
	OnHand   int    `yaml:"onHand"`
}

type data struct {
	Orders []Order              `yaml:"orders"`
	Boms   map[string][]BomItem `yaml:"boms"`
}

// ERP is the mock connector.
type ERP struct {
	orders map[string]Order
	boms   map[string][]BomItem
}

// Load reads the mock ERP fixture file.
func Load(path string) (*ERP, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read mock erp: %w", err)
	}
	var d data
	if err := yaml.Unmarshal(b, &d); err != nil {
		return nil, fmt.Errorf("parse mock erp: %w", err)
	}
	e := &ERP{orders: map[string]Order{}, boms: d.Boms}
	for _, o := range d.Orders {
		e.orders[o.OrderID] = o
	}
	return e, nil
}

func (e *ERP) Name() string { return "mock-erp" }

func (e *ERP) Tools() []connector.Tool {
	return []connector.Tool{
		&statusTool{e}, &financialsTool{e}, &kittingTool{e},
	}
}

// order looks up an order or returns a not-found error.
func (e *ERP) order(id string) (Order, error) {
	o, ok := e.orders[id]
	if !ok {
		return Order{}, fmt.Errorf("order %q not found", id)
	}
	return o, nil
}
