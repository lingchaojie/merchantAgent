package connector

import "context"

// ToolCatalog resolves the effective tool set for one point in time.
type ToolCatalog interface {
	Snapshot(context.Context) (map[string]Tool, error)
}

type staticCatalog struct {
	tools map[string]Tool
}

// NewStaticCatalog builds a catalog from connectors. Later connectors take
// precedence when they expose the same stable tool name.
func NewStaticCatalog(conns ...Connector) ToolCatalog {
	tools := make(map[string]Tool)
	for _, conn := range conns {
		if conn == nil {
			continue
		}
		for _, tool := range conn.Tools() {
			tools[tool.Spec().Name] = tool
		}
	}
	return staticCatalog{tools: tools}
}

func (c staticCatalog) Snapshot(context.Context) (map[string]Tool, error) {
	return cloneTools(c.tools), nil
}

type compositeCatalog struct {
	catalogs []ToolCatalog
}

// NewCompositeCatalog merges snapshots in order. Tools from later catalogs
// explicitly replace tools with the same name from earlier catalogs.
func NewCompositeCatalog(catalogs ...ToolCatalog) ToolCatalog {
	return compositeCatalog{catalogs: append([]ToolCatalog(nil), catalogs...)}
}

func (c compositeCatalog) Snapshot(ctx context.Context) (map[string]Tool, error) {
	tools := make(map[string]Tool)
	for _, catalog := range c.catalogs {
		if catalog == nil {
			continue
		}
		snapshot, err := catalog.Snapshot(ctx)
		if err != nil {
			return nil, err
		}
		for name, tool := range snapshot {
			tools[name] = tool
		}
	}
	return tools, nil
}

func cloneTools(tools map[string]Tool) map[string]Tool {
	clone := make(map[string]Tool, len(tools))
	for name, tool := range tools {
		clone[name] = tool
	}
	return clone
}
