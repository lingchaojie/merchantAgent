package authz

import (
	"context"
	"os"
	"testing"

	"github.com/merchantagent/backend/sync"
)

func TestReadTuples_RoundTrip(t *testing.T) {
	apiURL := os.Getenv("OPENFGA_API_URL")
	if apiURL == "" {
		apiURL = "http://localhost:18080"
	}
	ctx := context.Background()
	store, err := NewStore(ctx, apiURL, "readtuples-test")
	if err != nil {
		t.Skipf("OpenFGA not reachable (%v)", err)
	}
	want := []sync.Tuple{
		{User: "user:a", Relation: "member", Object: "tenant:t1"},
		{User: "user:b", Relation: "admin", Object: "tenant:t1"},
	}
	if err := store.ApplyDiff(ctx, sync.Diff{Writes: want}); err != nil {
		t.Fatal(err)
	}
	got, err := store.ReadTuples(ctx)
	if err != nil {
		t.Fatal(err)
	}
	set := map[string]bool{}
	for _, tp := range got {
		set[tp.String()] = true
	}
	for _, w := range want {
		if !set[w.String()] {
			t.Errorf("missing read-back tuple: %s (got %d tuples)", w.String(), len(got))
		}
	}
}
