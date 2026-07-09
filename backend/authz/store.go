// Package authz wraps OpenFGA: it loads the model, seeds a store, and exposes
// the runtime checks the agent uses (Check for tool/data authz, ListObjects for
// filter-before-grounding). It also hosts the Syncer that turns an org snapshot
// into tuples. It imports org + sync (one direction; neither imports authz).
package authz

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"

	openfga "github.com/openfga/go-sdk"
	fgaclient "github.com/openfga/go-sdk/client"
	"github.com/openfga/language/pkg/go/transformer"

	"github.com/merchantagent/backend/sync"
)

//go:embed model.fga
var modelDSL string

// Store is a thin OpenFGA client bound to one store + authorization model.
type Store struct {
	c       *fgaclient.OpenFgaClient
	storeID string
	modelID string
}

// NewStore connects to an OpenFGA instance at apiURL, creates a fresh store,
// transforms model.fga (DSL) to JSON, and writes it. Returns the ready Store.
func NewStore(ctx context.Context, apiURL, storeName string) (*Store, error) {
	c, err := fgaclient.NewSdkClient(&fgaclient.ClientConfiguration{ApiUrl: apiURL})
	if err != nil {
		return nil, fmt.Errorf("new fga client: %w", err)
	}
	cs, err := c.CreateStore(ctx).Body(fgaclient.ClientCreateStoreRequest{Name: storeName}).Execute()
	if err != nil {
		return nil, fmt.Errorf("create store: %w", err)
	}
	storeID := cs.GetId()
	if err := c.SetStoreId(storeID); err != nil {
		return nil, err
	}

	jsonModel, err := transformer.TransformDSLToJSON(modelDSL)
	if err != nil {
		return nil, fmt.Errorf("transform model dsl: %w", err)
	}
	var body openfga.WriteAuthorizationModelRequest
	if err := json.Unmarshal([]byte(jsonModel), &body); err != nil {
		return nil, fmt.Errorf("unmarshal model json: %w", err)
	}
	wm, err := c.WriteAuthorizationModel(ctx).Body(body).Execute()
	if err != nil {
		return nil, fmt.Errorf("write model: %w", err)
	}
	modelID := wm.GetAuthorizationModelId()
	if err := c.SetAuthorizationModelId(modelID); err != nil {
		return nil, err
	}
	return &Store{c: c, storeID: storeID, modelID: modelID}, nil
}

// ApplyDiff writes and deletes tuples to move OpenFGA toward the desired state.
func (s *Store) ApplyDiff(ctx context.Context, d sync.Diff) error {
	req := fgaclient.ClientWriteRequest{}
	for _, t := range d.Writes {
		req.Writes = append(req.Writes, openfga.TupleKey{User: t.User, Relation: t.Relation, Object: t.Object})
	}
	for _, t := range d.Deletes {
		req.Deletes = append(req.Deletes, openfga.TupleKeyWithoutCondition{User: t.User, Relation: t.Relation, Object: t.Object})
	}
	if len(req.Writes) == 0 && len(req.Deletes) == 0 {
		return nil
	}
	// OpenFGA caps tuples per Write call; a real impl batches. Phase 0 fixtures
	// are small enough for one call.
	_, err := s.c.Write(ctx).Body(req).Execute()
	if err != nil {
		return fmt.Errorf("write tuples: %w", err)
	}
	return nil
}

// Check answers "does user have relation on object?" — used for tool + data authz.
func (s *Store) Check(ctx context.Context, user, relation, object string) (bool, error) {
	resp, err := s.c.Check(ctx).Body(fgaclient.ClientCheckRequest{User: user, Relation: relation, Object: object}).Execute()
	if err != nil {
		return false, fmt.Errorf("check: %w", err)
	}
	return resp.GetAllowed(), nil
}

// ListObjects returns the object ids of a type the user has a relation to —
// the pre-filter that powers permission-aware retrieval (filter-before-grounding).
func (s *Store) ListObjects(ctx context.Context, user, relation, typ string) ([]string, error) {
	resp, err := s.c.ListObjects(ctx).Body(fgaclient.ClientListObjectsRequest{User: user, Relation: relation, Type: typ}).Execute()
	if err != nil {
		return nil, fmt.Errorf("list objects: %w", err)
	}
	return resp.GetObjects(), nil
}
