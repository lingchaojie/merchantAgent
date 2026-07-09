package org

import (
	"context"
	"fmt"
	"os"

	"gopkg.in/yaml.v3"
)

// MockAdapter is the Phase 0 identity source. It reads a normalized Snapshot
// from a YAML file (see testdata/mock-org.yaml) so the whole stack runs locally
// with no WeCom, no ICP-filed domain, no OAuth round-trip. Authenticate simply
// logs in as the requested user id if that user exists and is active.
//
// A real WeComAdapter will implement the same interface by mapping
// getuserinfo3rd / user/get / department/list into Snapshot — nothing above
// this seam changes.
type MockAdapter struct {
	snap Snapshot
}

// NewMockAdapterFromFile loads a mock org snapshot from a YAML file.
func NewMockAdapterFromFile(path string) (*MockAdapter, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read mock org: %w", err)
	}
	var s Snapshot
	if err := yaml.Unmarshal(b, &s); err != nil {
		return nil, fmt.Errorf("parse mock org: %w", err)
	}
	if s.TenantID == "" {
		return nil, fmt.Errorf("mock org missing tenantId")
	}
	return &MockAdapter{snap: s}, nil
}

func (m *MockAdapter) Kind() Kind { return KindMock }

func (m *MockAdapter) Authenticate(_ context.Context, lc LoginContext) (Principal, error) {
	for _, u := range m.snap.Users {
		if u.UserID == lc.Credential {
			if u.Status != StatusActive {
				return Principal{}, fmt.Errorf("user %q not active", u.UserID)
			}
			return Principal{TenantID: m.snap.TenantID, UserID: u.UserID, DisplayName: u.Name}, nil
		}
	}
	return Principal{}, fmt.Errorf("mock user %q not found", lc.Credential)
}

func (m *MockAdapter) FetchSnapshot(_ context.Context, tenantID string) (Snapshot, error) {
	if tenantID != "" && tenantID != m.snap.TenantID {
		return Snapshot{}, fmt.Errorf("unknown tenant %q", tenantID)
	}
	return m.snap, nil
}

// FetchChanges: the mock is static, so it reports no incremental changes.
func (m *MockAdapter) FetchChanges(_ context.Context, _ string, since Cursor) (ChangeSet, error) {
	return ChangeSet{Next: since}, nil
}
