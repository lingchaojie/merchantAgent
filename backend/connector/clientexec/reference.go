package clientexec

import (
	"context"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"errors"
	"fmt"

	"github.com/merchantagent/backend/connector"
)

const (
	PackageID      = "reference-manufacturing"
	PackageVersion = "1.0.0"
)

//go:embed reference_manifest.json
var referenceManifest []byte

func ManifestDigest() string {
	sum := sha256.Sum256(referenceManifest)
	return "sha256:" + hex.EncodeToString(sum[:])
}

type reference struct{}

func NewReference() connector.Connector { return reference{} }

func (reference) Name() string { return PackageID }

func (reference) Tools() []connector.Tool {
	return []connector.Tool{
		proxyTool{spec: connector.ToolSpec{
			PackageID:      PackageID,
			Version:        PackageVersion,
			ManifestDigest: ManifestDigest(),
			Name:           "query_order_status",
			Description:    "查询订单及本地生产进度（不含成本利润）",
			Params: []connector.ParamSpec{
				{Name: "orderId", Description: "订单号", Type: connector.ParamString, Required: true},
			},
			ResourceType: "business_record",
			ResourceKind: "order",
			ResourceArg:  "orderId",
			Execution:    connector.ExecutionDesktop,
			Risk:         connector.RiskRead,
			ResultFields: []string{"orderId", "workOrderId", "status", "promiseDate", "completionRate", "note", "version"},
		}},
		proxyTool{spec: connector.ToolSpec{
			PackageID:      PackageID,
			Version:        PackageVersion,
			ManifestDigest: ManifestDigest(),
			Name:           "report_production_progress",
			Description:    "更新订单的本地生产进度",
			Params: []connector.ParamSpec{
				{Name: "orderId", Description: "订单号", Type: connector.ParamString, Required: true},
				{Name: "workOrderId", Description: "工单号", Type: connector.ParamString, Required: true},
				{Name: "completionRate", Description: "完成百分比", Type: connector.ParamInteger, Required: true},
				{Name: "expectedVersion", Description: "预期记录版本", Type: connector.ParamInteger, Required: true},
				{Name: "note", Description: "进度备注", Type: connector.ParamString},
			},
			ResourceType:         "business_record",
			ResourceKind:         "order",
			ResourceArg:          "orderId",
			Execution:            connector.ExecutionDesktop,
			Risk:                 connector.RiskLowWrite,
			RequiresConfirmation: true,
			ResultFields:         []string{"orderId", "workOrderId", "status", "promiseDate", "completionRate", "note", "version"},
		}},
	}
}

type proxyTool struct {
	spec connector.ToolSpec
}

func (t proxyTool) Spec() connector.ToolSpec { return t.spec }

func (t proxyTool) Invoke(ctx context.Context, args map[string]any) (map[string]any, error) {
	bridge := connector.LocalToolBridgeFrom(ctx)
	if bridge == nil {
		return nil, fmt.Errorf("desktop local tool bridge unavailable")
	}
	invocation, ok := connector.InvocationFrom(ctx)
	if !ok {
		return nil, fmt.Errorf("local tool invocation metadata missing")
	}
	keyInput := invocation.TenantID + "|" + invocation.UserID + "|" + invocation.CallID + "|" + t.spec.Name
	keySum := sha256.Sum256([]byte(keyInput))
	response, err := bridge.InvokeLocalTool(ctx, connector.LocalToolRequest{
		PackageID:            t.spec.PackageID,
		PackageVersion:       t.spec.Version,
		ManifestDigest:       t.spec.ManifestDigest,
		Tool:                 t.spec.Name,
		TenantID:             invocation.TenantID,
		UserID:               invocation.UserID,
		SkillID:              invocation.SkillID,
		CallID:               invocation.CallID,
		DeviceID:             invocation.DeviceID,
		IdempotencyKey:       hex.EncodeToString(keySum[:]),
		RoleIDs:              invocation.RoleIDs,
		Args:                 args,
		Risk:                 t.spec.Risk,
		RequiresConfirmation: t.spec.RequiresConfirmation,
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
