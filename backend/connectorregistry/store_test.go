package connectorregistry

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"testing"

	"github.com/merchantagent/backend/connector"
)

func TestStoreKeepsOnlyPublicContractAndImmutableDigest(t *testing.T) {
	store := openTestStore(t)
	v := validSubmittedVersion()
	if err := store.Submit(context.Background(), Submission{Version: v, ActorID: "impl-1"}); err != nil {
		t.Fatal(err)
	}
	got, err := store.List(context.Background(), "mock-corp-001")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Digest != v.Digest || got[0].Status != StatusPendingApproval {
		t.Fatalf("versions=%+v", got)
	}
	encoded, _ := json.Marshal(got)
	for _, secret := range []string{"SELECT ", "dbo.", "sql.internal", "credentialRef"} {
		if bytes.Contains(encoded, []byte(secret)) {
			t.Fatalf("public record leaked %q", secret)
		}
	}
	v.Contract.Tools[0].Description = "changed"
	if err := store.Submit(context.Background(), Submission{Version: v, ActorID: "impl-1"}); !errors.Is(err, ErrImmutableVersion) {
		t.Fatalf("resubmit error=%v", err)
	}
}

func TestStoreEnforcesLifecycle(t *testing.T) {
	store := openTestStore(t)
	v := validSubmittedVersion()
	requireNoError(t, store.Submit(context.Background(), Submission{Version: v, ActorID: "impl-1"}))
	requireNoError(t, store.Transition(context.Background(), Transition{TenantID: v.TenantID, ConnectorID: v.ConnectorID, Version: v.Version, Digest: v.Digest, To: StatusPublished, ActorID: "u_admin"}))
	if len(mustPublished(t, store, v.TenantID)) != 1 {
		t.Fatal("published version missing")
	}
	requireNoError(t, store.Transition(context.Background(), Transition{TenantID: v.TenantID, ConnectorID: v.ConnectorID, Version: v.Version, Digest: v.Digest, To: StatusSuspended, ActorID: "u_admin"}))
	if len(mustPublished(t, store, v.TenantID)) != 0 {
		t.Fatal("suspended version remained published")
	}
	requireNoError(t, store.Transition(context.Background(), Transition{TenantID: v.TenantID, ConnectorID: v.ConnectorID, Version: v.Version, Digest: v.Digest, To: StatusPublished, ActorID: "u_admin"}))
	requireNoError(t, store.Transition(context.Background(), Transition{TenantID: v.TenantID, ConnectorID: v.ConnectorID, Version: v.Version, Digest: v.Digest, To: StatusRevoked, ActorID: "u_admin"}))
	err := store.Transition(context.Background(), Transition{TenantID: v.TenantID, ConnectorID: v.ConnectorID, Version: v.Version, Digest: v.Digest, To: StatusPublished, ActorID: "u_admin"})
	if !errors.Is(err, ErrIllegalTransition) {
		t.Fatalf("revoked republish error=%v", err)
	}
}

func TestStoreRejectsInvalidPublicContracts(t *testing.T) {
	intPtr := func(v int) *int { return &v }
	tests := []struct {
		name   string
		mutate func(*Version)
	}{
		{"adapter", func(v *Version) { v.Adapter = "http" }},
		{"production environment", func(v *Version) { v.Environment = "production" }},
		{"digest", func(v *Version) { v.Digest = "sha256:" + string(bytes.Repeat([]byte("A"), 64)) }},
		{"connector path separator", func(v *Version) { v.ConnectorID = "finance/sql-orders" }},
		{"version path separator", func(v *Version) { v.Version = "1.0/0" }},
		{"provider-incompatible tool name", func(v *Version) { v.Contract.Tools[0].Name = "orders.query" }},
		{"provider-incompatible parameter name", func(v *Version) { v.Contract.Tools[0].Params[0].Name = "order/id" }},
		{"provider-incompatible result field", func(v *Version) { v.Contract.Tools[0].ResultFields[0] = "order id" }},
		{"authorization delimiter", func(v *Version) { v.Contract.Tools[0].ResourceRelation = "record:viewer" }},
		{"fga type identifier", func(v *Version) { v.Contract.Tools[0].ResourceType = "1record" }},
		{"fga relation identifier", func(v *Version) { v.Contract.Tools[0].ResourceRelation = "record-viewer" }},
		{"unknown parameter type", func(v *Version) { v.Contract.Tools[0].Params[0].Type = connector.ParamType("number") }},
		{"string numeric constraint", func(v *Version) { v.Contract.Tools[0].Params[0].Minimum = intPtr(1) }},
		{"contradictory string bounds", func(v *Version) {
			v.Contract.Tools[0].Params[0].MinLength = intPtr(10)
			v.Contract.Tools[0].Params[0].MaxLength = intPtr(2)
		}},
		{"read confirmation", func(v *Version) { v.Contract.Tools[0].RequiresConfirmation = true }},
		{"write without confirmation", func(v *Version) {
			v.Contract.Tools[0].Risk = connector.RiskLowWrite
			v.Contract.Tools[0].RequiresConfirmation = false
		}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			store := openTestStore(t)
			v := validSubmittedVersion()
			tc.mutate(&v)
			if err := store.Submit(context.Background(), Submission{Version: v, ActorID: "impl-1"}); !errors.Is(err, ErrInvalidVersion) {
				t.Fatalf("error=%v", err)
			}
		})
	}
}

func TestStoreUsesUnicodeCodePointsForStringBounds(t *testing.T) {
	store := openTestStore(t)
	v := validSubmittedVersion()
	maxLength := 2
	v.Contract.Tools[0].Params[0].MaxLength = &maxLength
	v.Contract.Tools[0].Params[0].Enum = []any{"订单"}
	if err := store.Submit(context.Background(), Submission{Version: v, ActorID: "impl-1"}); err != nil {
		t.Fatal(err)
	}
}

func TestStoreAppendsLifecycleEvents(t *testing.T) {
	store := openTestStore(t)
	v := validSubmittedVersion()
	ctx := context.Background()
	requireNoError(t, store.Submit(ctx, Submission{Version: v, ActorID: "impl-1"}))
	requireNoError(t, store.Transition(ctx, Transition{TenantID: v.TenantID, ConnectorID: v.ConnectorID, Version: v.Version, Digest: v.Digest, To: StatusPublished, ActorID: "u_admin"}))
	requireNoError(t, store.Transition(ctx, Transition{TenantID: v.TenantID, ConnectorID: v.ConnectorID, Version: v.Version, Digest: v.Digest, To: StatusSuspended, ActorID: "u_admin"}))

	rows, err := store.db.QueryContext(ctx, `SELECT actor_id, from_status, to_status, digest FROM connector_lifecycle_events ORDER BY event_id`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	want := []struct {
		actor, from, to string
	}{
		{"impl-1", "", string(StatusPendingApproval)},
		{"u_admin", string(StatusPendingApproval), string(StatusPublished)},
		{"u_admin", string(StatusPublished), string(StatusSuspended)},
	}
	var i int
	for rows.Next() {
		var actor, from, to, digest string
		if err := rows.Scan(&actor, &from, &to, &digest); err != nil {
			t.Fatal(err)
		}
		if i >= len(want) || actor != want[i].actor || from != want[i].from || to != want[i].to || digest != v.Digest {
			t.Fatalf("event %d = %q %q %q %q", i, actor, from, to, digest)
		}
		i++
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if i != len(want) {
		t.Fatalf("event count=%d want=%d", i, len(want))
	}
}

func openTestStore(t *testing.T) *Store {
	t.Helper()
	store, err := Open(filepath.Join(t.TempDir(), "connectors.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Error(err)
		}
	})
	return store
}

func validSubmittedVersion() Version {
	minLength, maxLength := 1, 64
	return Version{
		TenantID:                   "mock-corp-001",
		ConnectorID:                "sql-orders",
		Version:                    "1.0.0",
		Digest:                     "sha256:" + string(bytes.Repeat([]byte("a"), 64)),
		Adapter:                    "sqlserver",
		Environment:                "test",
		ImplementationCredentialID: "implementation-credential-01",
		DeviceID:                   "device-01",
		Contract: PublicContract{Tools: []ToolContract{{
			Name:             "query_order_status",
			Description:      "Query the public status of an order",
			ResourceType:     "business_record",
			ResourceKind:     "order",
			ResourceArg:      "orderId",
			ResourceRelation: "viewer",
			DataDomain:       "operations",
			Params: []ParamContract{{
				Name:        "orderId",
				Description: "Order identifier",
				Type:        connector.ParamString,
				Required:    true,
				MinLength:   &minLength,
				MaxLength:   &maxLength,
			}},
			ResultFields:         []string{"orderId", "status", "version"},
			Risk:                 connector.RiskRead,
			RequiresConfirmation: false,
			TimeoutMS:            10_000,
			MaxResults:           100,
		}}},
		Checks: CheckSummary{
			CheckerVersion: "1.0.0",
			RulesetVersion: "m7.1-sql-v1",
			TestsDigest:    "sha256:" + string(bytes.Repeat([]byte("b"), 64)),
		},
	}
}

func mustPublished(t *testing.T, store *Store, tenant string) []Version {
	t.Helper()
	got, err := store.Published(context.Background(), tenant)
	if err != nil {
		t.Fatal(err)
	}
	return got
}

func requireNoError(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}
