package org

import "context"

// Kind identifies the identity-source implementation.
type Kind string

const (
	KindWeCom    Kind = "wecom"
	KindDingTalk Kind = "dingtalk"
	KindFeishu   Kind = "feishu"
	KindAD       Kind = "ad"
	KindMock     Kind = "mock"
)

// LoginContext carries whatever a given IdP needs to authenticate (an OAuth
// code, a QR ticket, or — for mock — a chosen user id). Kept opaque so the
// adapter interface stays provider-agnostic.
type LoginContext struct {
	TenantID string
	// Raw provider-specific credential. For WeCom this is the OAuth `code`;
	// for mock it's the user id to log in as.
	Credential string
}

// ChangeOp is the kind of incremental org change.
type ChangeOp string

const (
	OpUpsertUser ChangeOp = "upsertUser"
	OpRemoveUser ChangeOp = "removeUser"
	OpUpsertDept ChangeOp = "upsertDept"
	OpRemoveDept ChangeOp = "removeDept"
	OpUpsertTag  ChangeOp = "upsertTag"
)

// Change is one incremental org mutation delivered by a callback/poll.
type Change struct {
	Op     ChangeOp
	User   *User
	Dept   *Dept
	Tag    *Tag
	UserID string // for removeUser
	DeptID string // for removeDept
}

// Cursor is an opaque pagination/position token for incremental fetches.
type Cursor string

// ChangeSet is a page of changes plus the cursor to resume from.
type ChangeSet struct {
	Changes []Change
	Next    Cursor
}

// Adapter is the pluggable identity-source seam. WeCom/DingTalk/Feishu/AD/mock
// each implement it; nothing above this interface knows which IdP is in use.
type Adapter interface {
	Kind() Kind

	// Authenticate turns an IdP login result into our session Principal.
	Authenticate(ctx context.Context, lc LoginContext) (Principal, error)

	// FetchSnapshot pulls the full org (on authorization / first config / full
	// reconciliation).
	FetchSnapshot(ctx context.Context, tenantID string) (Snapshot, error)

	// FetchChanges pulls incremental org changes since a cursor (callback/poll
	// driven). Implementations may return an empty set + same cursor if none.
	FetchChanges(ctx context.Context, tenantID string, since Cursor) (ChangeSet, error)
}
