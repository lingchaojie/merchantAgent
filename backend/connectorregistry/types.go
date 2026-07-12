// Package connectorregistry stores the public contracts and approval lifecycle
// for locally implemented enterprise connectors. Private implementation data is
// intentionally absent from every type in this package.
package connectorregistry

import (
	"errors"
	"time"

	"github.com/merchantagent/backend/connector"
)

var (
	ErrInvalidVersion    = errors.New("invalid connector version")
	ErrImmutableVersion  = errors.New("connector version is immutable")
	ErrIllegalTransition = errors.New("illegal connector lifecycle transition")
	ErrVersionNotFound   = errors.New("connector version not found")
	ErrDigestMismatch    = errors.New("connector digest mismatch")
)

type Status string

const (
	StatusPendingApproval Status = "pending_admin_approval"
	StatusPublished       Status = "published"
	StatusSuspended       Status = "suspended"
	StatusRevoked         Status = "revoked"
)

type ParamContract struct {
	Name        string              `json:"name"`
	Description string              `json:"description"`
	Type        connector.ParamType `json:"type"`
	Required    bool                `json:"required"`
	MinLength   *int                `json:"minLength,omitempty"`
	MaxLength   *int                `json:"maxLength,omitempty"`
	Minimum     *int                `json:"minimum,omitempty"`
	Maximum     *int                `json:"maximum,omitempty"`
	Enum        []any               `json:"enum,omitempty"`
}

type ToolContract struct {
	Name                 string              `json:"name"`
	Description          string              `json:"description"`
	ResourceType         string              `json:"resourceType"`
	ResourceKind         string              `json:"resourceKind"`
	ResourceArg          string              `json:"resourceArg"`
	ResourceRelation     string              `json:"resourceRelation"`
	DataDomain           string              `json:"dataDomain"`
	Params               []ParamContract     `json:"params"`
	ResultFields         []string            `json:"resultFields"`
	Risk                 connector.RiskLevel `json:"risk"`
	RequiresConfirmation bool                `json:"requiresConfirmation"`
	TimeoutMS            int                 `json:"timeoutMS"`
	MaxResults           int                 `json:"maxResults"`
}

type PublicContract struct {
	Tools []ToolContract `json:"tools"`
}

type CheckSummary struct {
	CheckerVersion string `json:"checkerVersion"`
	RulesetVersion string `json:"rulesetVersion"`
	TestsDigest    string `json:"testsDigest"`
}

type Version struct {
	TenantID                   string         `json:"tenantId"`
	ConnectorID                string         `json:"connectorId"`
	Version                    string         `json:"version"`
	Digest                     string         `json:"digest"`
	Adapter                    string         `json:"adapter"`
	Environment                string         `json:"environment"`
	Contract                   PublicContract `json:"contract"`
	Checks                     CheckSummary   `json:"checks"`
	ImplementationCredentialID string         `json:"implementationCredentialId"`
	DeviceID                   string         `json:"deviceId"`
	SubmittedBy                string         `json:"submittedBy"`
	ApprovedBy                 string         `json:"approvedBy,omitempty"`
	Status                     Status         `json:"status"`
	CreatedAt                  time.Time      `json:"createdAt"`
	UpdatedAt                  time.Time      `json:"updatedAt"`
}

type Submission struct {
	Version Version
	ActorID string
}

type Transition struct {
	TenantID    string
	ConnectorID string
	Version     string
	Digest      string
	ActorID     string
	To          Status
}
