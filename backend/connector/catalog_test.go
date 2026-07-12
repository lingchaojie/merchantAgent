package connector

import (
	"context"
	"errors"
	"testing"
)

type catalogTestTool struct{ name string }

func (t catalogTestTool) Spec() ToolSpec { return ToolSpec{Name: t.name} }
func (catalogTestTool) Invoke(context.Context, map[string]any) (map[string]any, error) {
	return nil, nil
}

type catalogTestConnector struct{ tools []Tool }

func (catalogTestConnector) Name() string    { return "test" }
func (c catalogTestConnector) Tools() []Tool { return c.tools }

type catalogStub struct {
	tools map[string]Tool
	err   error
}

func (c catalogStub) Snapshot(context.Context) (map[string]Tool, error) {
	return c.tools, c.err
}

func TestStaticCatalogSnapshotsAreImmutable(t *testing.T) {
	catalog := NewStaticCatalog(catalogTestConnector{tools: []Tool{catalogTestTool{name: "query_order_status"}}})
	first, err := catalog.Snapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	delete(first, "query_order_status")
	second, err := catalog.Snapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if second["query_order_status"] == nil {
		t.Fatal("mutating one snapshot changed the catalog")
	}
}

func TestCompositeCatalogUsesLaterCatalogPrecedence(t *testing.T) {
	static := catalogTestTool{name: "query_order_status"}
	published := catalogTestTool{name: "query_order_status"}
	catalog := NewCompositeCatalog(
		catalogStub{tools: map[string]Tool{"query_order_status": static}},
		catalogStub{tools: map[string]Tool{"query_order_status": published}},
	)
	got, err := catalog.Snapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if got["query_order_status"] != published {
		t.Fatalf("effective tool = %#v, want later catalog tool", got["query_order_status"])
	}
}

func TestCompositeCatalogFailsClosedOnCatalogError(t *testing.T) {
	want := errors.New("duplicate published tool")
	catalog := NewCompositeCatalog(
		catalogStub{tools: map[string]Tool{"static": catalogTestTool{name: "static"}}},
		catalogStub{err: want},
	)
	got, err := catalog.Snapshot(context.Background())
	if !errors.Is(err, want) || got != nil {
		t.Fatalf("Snapshot() = %v, %v; want nil, %v", got, err, want)
	}
}
