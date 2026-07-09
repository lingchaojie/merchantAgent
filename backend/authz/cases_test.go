package authz

import (
	"context"
	"testing"
)

// canSeeProgress models the T3 "订单进度" tool: needs order#viewer only.
func canSeeProgress(t *testing.T, s *Store, user, orderID string) bool {
	t.Helper()
	ok, err := s.Check(context.Background(), "user:"+user, "viewer", "order:"+obj(orderID))
	if err != nil {
		t.Fatalf("check progress: %v", err)
	}
	return ok
}

// canSeeProfit models a tool touching the cost data-domain: the §6.1 intersection
// — allowed only if the user can view the order AND the cost data-domain.
func canSeeProfit(t *testing.T, s *Store, user, orderID string) bool {
	t.Helper()
	ctx := context.Background()
	orderOK, err := s.Check(ctx, "user:"+user, "viewer", "order:"+obj(orderID))
	if err != nil {
		t.Fatalf("check order: %v", err)
	}
	costOK, err := s.Check(ctx, "user:"+user, "viewer", "data_domain:"+obj("cost"))
	if err != nil {
		t.Fatalf("check cost: %v", err)
	}
	return orderOK && costOK
}

func TestAcceptance_SameQuestionDifferentPermissions(t *testing.T) {
	s := setup(t)

	// 1. Sales sees progress of their own order.
	if !canSeeProgress(t, s, "u_sales1", "SO-1001") {
		t.Error("sales should see progress of own order")
	}
	// 2. Sales does NOT see profit (cost data-domain filtered out).
	if canSeeProfit(t, s, "u_sales1", "SO-1001") {
		t.Error("sales must NOT see profit/cost")
	}
	// 3. Sales manager sees profit of dept orders (manager of d_sales).
	if !canSeeProfit(t, s, "u_smgr", "SO-1001") {
		t.Error("sales manager should see profit of dept order")
	}
	// 4. Boss sees profit of any order (manager of d_root inherits downward).
	if !canSeeProfit(t, s, "u_boss", "SO-1001") {
		t.Error("boss should see profit (root manager inherits down)")
	}
	// 5. Planner (not in sales dept) cannot even see the sales order's progress.
	if canSeeProgress(t, s, "u_plan", "SO-1001") {
		t.Error("planner must NOT see a sales-dept order")
	}
	// 6. Finance can view the cost data-domain.
	okCost, err := s.Check(context.Background(), "user:u_fin", "viewer", "data_domain:"+obj("cost"))
	if err != nil {
		t.Fatal(err)
	}
	if !okCost {
		t.Error("finance should view cost data-domain")
	}
}

// TestAcceptance_ListObjectsPrefilter proves filter-before-grounding: retrieval
// pre-filters to only the orders a user may see.
func TestAcceptance_ListObjectsPrefilter(t *testing.T) {
	s := setup(t)
	ctx := context.Background()

	salesOrders, err := s.ListObjects(ctx, "user:u_sales1", "viewer", "order")
	if err != nil {
		t.Fatal(err)
	}
	if len(salesOrders) != 2 {
		t.Errorf("sales should pre-filter to 2 orders, got %d: %v", len(salesOrders), salesOrders)
	}

	planOrders, err := s.ListObjects(ctx, "user:u_plan", "viewer", "order")
	if err != nil {
		t.Fatal(err)
	}
	if len(planOrders) != 0 {
		t.Errorf("planner should pre-filter to 0 orders, got %d: %v", len(planOrders), planOrders)
	}
}
