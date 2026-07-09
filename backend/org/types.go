// Package org defines the normalized organization model that every identity
// provider (WeCom, DingTalk, Feishu, AD, mock) is mapped into. Keeping this
// provider-agnostic is the seam that lets us swap identity sources without
// touching the permission model or sync logic.
package org

// Status is the normalized member status across IdPs.
type Status string

const (
	StatusActive   Status = "active"
	StatusDisabled Status = "disabled"
	StatusQuit     Status = "quit"
)

// Principal is the authenticated caller: a stable user identity within a tenant.
// UserID is the WeCom open_userid (provider-global stable id); mock uses its own.
type Principal struct {
	TenantID    string
	UserID      string
	DisplayName string
}

// User is a normalized directory member. PII (name/mobile/email) is optional and
// never relied upon for authorization — roles come from dept + leader + tags.
type User struct {
	UserID          string   `yaml:"userId"`
	Name            string   `yaml:"name,omitempty"`
	Status          Status   `yaml:"status"`
	DeptIDs         []string `yaml:"deptIds"`
	MainDeptID      string   `yaml:"mainDeptId,omitempty"`
	PositionText    string   `yaml:"positionText,omitempty"` // FREE TEXT — never an enum
	LeaderInDeptIDs []string `yaml:"leaderInDeptIds"`
	TagIDs          []string `yaml:"tagIds"`
}

// Dept is a node in the department tree (WeCom department + parentid).
type Dept struct {
	DeptID   string `yaml:"deptId"`
	Name     string `yaml:"name"`
	ParentID string `yaml:"parentId,omitempty"`
	Order    int    `yaml:"order,omitempty"`
}

// Tag is a WeCom label used as an ad-hoc role group.
type Tag struct {
	TagID         string   `yaml:"tagId"`
	Name          string   `yaml:"name"`
	MemberUserIDs []string `yaml:"memberUserIds"`
}

// Snapshot is the full normalized org state pulled from an IdP.
type Snapshot struct {
	TenantID    string   `yaml:"tenantId"`
	Admins      []string `yaml:"admins"`
	Departments []Dept   `yaml:"departments"`
	Users       []User   `yaml:"users"`
	Tags        []Tag    `yaml:"tags"`
}
