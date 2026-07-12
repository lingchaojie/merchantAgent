package connectorregistry

import (
	"context"
	"errors"
	"fmt"

	"github.com/merchantagent/backend/connector"
)

type publishedStore interface {
	Published(context.Context, string) ([]Version, error)
}

type publishedCatalog struct {
	store  publishedStore
	tenant string
}

// NewPublishedCatalog resolves the currently published public contracts as
// desktop proxy tools. Each Snapshot re-reads lifecycle state from the store.
func NewPublishedCatalog(store publishedStore, tenant string) connector.ToolCatalog {
	return publishedCatalog{store: store, tenant: tenant}
}

func (c publishedCatalog) Snapshot(ctx context.Context) (map[string]connector.Tool, error) {
	versions, err := c.store.Published(ctx, c.tenant)
	if err != nil {
		return nil, fmt.Errorf("resolve published connectors: %w", err)
	}
	tools := make(map[string]connector.Tool)
	for _, version := range versions {
		for _, contract := range version.Contract.Tools {
			if _, exists := tools[contract.Name]; exists {
				return nil, fmt.Errorf("duplicate published tool name %q", contract.Name)
			}
			tools[contract.Name] = publishedTool{spec: toolSpec(version, contract)}
		}
	}
	return tools, nil
}

func toolSpec(version Version, contract ToolContract) connector.ToolSpec {
	params := make([]connector.ParamSpec, len(contract.Params))
	for i, param := range contract.Params {
		params[i] = connector.ParamSpec{
			Name: param.Name, Description: param.Description, Type: param.Type, Required: param.Required,
			MinLength: param.MinLength, MaxLength: param.MaxLength, Minimum: param.Minimum, Maximum: param.Maximum,
			Enum: append([]any(nil), param.Enum...),
		}
	}
	return connector.ToolSpec{
		PackageID: version.ConnectorID, Version: version.Version, ManifestDigest: version.Digest,
		Name: contract.Name, Description: contract.Description, Params: params,
		ResourceType: contract.ResourceType, ResourceKind: contract.ResourceKind, ResourceArg: contract.ResourceArg,
		ResourceRelation: contract.ResourceRelation, DataDomain: contract.DataDomain,
		Execution: connector.ExecutionDesktop, Risk: contract.Risk, RequiresConfirmation: contract.RequiresConfirmation,
		ResultFields: append([]string(nil), contract.ResultFields...),
	}
}

type publishedTool struct {
	spec connector.ToolSpec
}

func (t publishedTool) Spec() connector.ToolSpec { return t.spec }

func (t publishedTool) Invoke(ctx context.Context, args map[string]any) (map[string]any, error) {
	bridge := connector.LocalToolBridgeFrom(ctx)
	if bridge == nil {
		return nil, fmt.Errorf("desktop local tool bridge unavailable")
	}
	invocation, ok := connector.InvocationFrom(ctx)
	if !ok {
		return nil, fmt.Errorf("local tool invocation metadata missing")
	}
	response, err := bridge.InvokeLocalTool(ctx, connector.LocalToolRequest{
		PackageID: t.spec.PackageID, PackageVersion: t.spec.Version, ManifestDigest: t.spec.ManifestDigest,
		Tool: t.spec.Name, TenantID: invocation.TenantID, UserID: invocation.UserID, SkillID: invocation.SkillID,
		CallID: invocation.CallID, DeviceID: invocation.DeviceID,
		IdempotencyKey: connector.ExpectedIdempotencyKey(invocation, t.spec.Name), RoleIDs: append([]string(nil), invocation.RoleIDs...),
		Args: args, Risk: t.spec.Risk, RequiresConfirmation: t.spec.RequiresConfirmation,
	})
	var executionErr *connector.ExecutionError
	if errors.As(err, &executionErr) {
		response.Meta = executionErr.Meta
	}
	data := response.Data
	if data == nil {
		data = map[string]any{}
	}
	connector.AttachExecutionMeta(data, response.Meta)
	if err != nil {
		return data, err
	}
	if response.Error != "" {
		return data, &connector.ExecutionError{Message: response.Error, Meta: response.Meta}
	}
	return data, nil
}
