package org

import (
	"context"
	"path/filepath"
	"testing"
)

func loadMock(t *testing.T) *MockAdapter {
	t.Helper()
	a, err := NewMockAdapterFromFile(filepath.Join("..", "testdata", "mock-org.yaml"))
	if err != nil {
		t.Fatalf("load mock org: %v", err)
	}
	return a
}

func TestMockAdapter_Snapshot(t *testing.T) {
	a := loadMock(t)
	s, err := a.FetchSnapshot(context.Background(), "mock-corp-001")
	if err != nil {
		t.Fatal(err)
	}
	if s.TenantID != "mock-corp-001" {
		t.Errorf("tenant = %q", s.TenantID)
	}
	if len(s.Users) != 5 || len(s.Departments) != 4 {
		t.Errorf("got %d users / %d depts, want 5 / 4", len(s.Users), len(s.Departments))
	}
}

func TestMockAdapter_Authenticate(t *testing.T) {
	a := loadMock(t)
	p, err := a.Authenticate(context.Background(), LoginContext{Credential: "u_smgr"})
	if err != nil {
		t.Fatal(err)
	}
	if p.UserID != "u_smgr" || p.TenantID != "mock-corp-001" {
		t.Errorf("principal = %+v", p)
	}
	if _, err := a.Authenticate(context.Background(), LoginContext{Credential: "ghost"}); err == nil {
		t.Error("expected error for unknown user")
	}
}
