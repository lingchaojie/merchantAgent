# Desktop-Local Enterprise Tools Vertical Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove that a role-authorized cloud Agent can invoke signed, versioned enterprise tools on an employee's Windows App to read and safely update a local reference ERP database, with confirmation, idempotency, verification, revocation, and tenant audit.

**Architecture:** Reuse the existing M4 SSE reverse bridge: connector proxies remain registered in cloud `agentd`, pass the existing Skill/OpenFGA guard, and emit a `local_tool_request` to Electron. The Electron main process verifies the bundled capability package, asks for confirmation on low-risk writes, executes parameterized SQLite operations, and posts a structured result back; `agentd` strips execution metadata before grounding the LLM and records it in the tenant audit chain.

**Tech Stack:** Go 1.25, OpenFGA, modernc SQLite (backend stores), Electron 33, Node/TypeScript 5, React 18, Vitest 2, `better-sqlite3`, SSE/HTTP reverse bridge.

## Global Constraints

- Follow `docs/superpowers/specs/2026-07-12-enterprise-agent-platform-design.md` as the authoritative scope.
- Windows App local execution is the primary path; do not implement the optional enterprise gateway or cloud API connector here.
- Keep Skill instructions, executable tools, credentials, and authorization as separate internal concerns.
- Never expose arbitrary SQL/table CRUD to the model; only `query_order_status` and `report_production_progress` are in this slice.
- Cloud may receive the question and allowlisted result fields; database credentials, complete tables, unrelated fields, and SQL stay local.
- Read tools need no confirmation. `report_production_progress` is a low-risk write and requires a local confirmation, idempotency key, optimistic concurrency, and read-back verification.
- High-risk writes, real WeCom OAuth, real customer databases, self-service connector authoring, background execution, and centralized gateways remain out of scope.
- The reference capability is bundled and versioned with the Windows App. Dynamic marketplace install/update/rollback is part of the later real-connector tooling project; this slice proves signed-package verification, version rejection, Skill assignment, and immediate revocation.
- The existing dirty worktree contains user-owned changes; stage and commit only files named by the current task.
- Use TDD for every task. Each task ends in a focused commit only after its stated tests pass.

## File Structure

### Backend

- `backend/connector/connector.go`: generic parameter, execution-location, risk, package, and result-contract metadata.
- `backend/connector/validate.go`: model-argument validation independent of any industry.
- `backend/connector/localtool.go`: context-carried invocation metadata, local bridge interface, structured execution metadata, and typed execution errors.
- `backend/connector/clientexec/reference.go`: cloud-side proxy connector for the two reference desktop tools.
- `backend/connector/clientexec/reference_manifest.json`: canonical capability payload used by both Go and Electron signing/verification.
- `backend/cmd/agentd/localtoolbridge.go`: SSE request/response rendezvous for desktop tools.
- `backend/cmd/agentd/handlers.go`, `main.go`: attach bridge and expose `/chat/local-tool-result`.
- `backend/runtime/llm.go`, `audit.go`: attach invocation metadata, strip reserved execution metadata before LLM grounding, and audit final execution status.
- `backend/authz/model.fga`, `backend/wire/projector.go`: let production operators view the reference order while capability authorization still controls writes.
- `backend/skill/migrations.go`, `backend/skill/migrations/002_local_enterprise_tools.sql`: add reference Skills/templates once without resurrecting administrator-deleted rows.
- `backend/wire/assemble.go`: register desktop proxy connector after mock ERP/CRM so it owns the duplicate `query_order_status` name.

### Desktop

- `desktop/src/shared/contract.ts`: typed `local_tool_request` SSE and result shapes.
- `desktop/src/main/local-tools/store.ts`: persistent reference ERP SQLite store and parameterized read/write methods.
- `desktop/src/main/local-tools/package.ts`: signed capability manifest validation and version/digest checks.
- `desktop/src/main/local-tools/executor.ts`: allowlisted dispatch, confirmation, error mapping, and response metadata.
- `desktop/src/main/agentd.ts`, `ipc.ts`, `index.ts`: execute local tool requests and post results to `agentd`.
- `desktop/resources/capabilities/reference-manufacturing.cap.json`: signed reference capability package.
- `desktop/resources/capabilities/reference-public.pem`: public key used by the local package verifier.
- `desktop/scripts/generate-reference-capability.mjs`: reproducibly generate the reference payload, ephemeral signing key, public key, and signature; never persist the private key.
- `desktop/src/renderer/src/types.ts`, `components/ResultCard.tsx`: execution status and production-progress result presentation.
- `desktop/src/renderer/src/admin.ts`, `components/admin/SkillsPane.tsx`: display execution location, version, and risk in the existing tool picker while preserving role assignment as Gate A.

---

### Task 1: Extend the Generic Tool Contract and Validate Model Arguments

**Files:**
- Modify: `backend/connector/connector.go`
- Create: `backend/connector/validate.go`
- Create: `backend/connector/validate_test.go`
- Modify: `backend/runtime/llm.go`
- Modify: `backend/runtime/llm_test.go`

**Interfaces:**
- Produces: `connector.ParamType`, `ExecutionLocation`, `RiskLevel`, expanded `ToolSpec`, and `ValidateArgs(ToolSpec, map[string]any) error`.
- Consumed by: Tasks 2, 4, 5, 7, and 8.

- [ ] **Step 1: Add failing contract-validation tests**

```go
func TestValidateArgs(t *testing.T) {
	spec := ToolSpec{Params: []ParamSpec{
		{Name: "orderId", Type: ParamString, Required: true},
		{Name: "completionRate", Type: ParamInteger, Required: true},
	}}
	for _, tc := range []struct {
		name string
		args map[string]any
		want string
	}{
		{"valid", map[string]any{"orderId": "SO-1001", "completionRate": float64(80)}, ""},
		{"missing", map[string]any{"orderId": "SO-1001"}, "missing required argument completionRate"},
		{"wrong type", map[string]any{"orderId": "SO-1001", "completionRate": "80"}, "completionRate must be integer"},
		{"unknown", map[string]any{"orderId": "SO-1001", "completionRate": float64(80), "sql": "DROP"}, "unknown argument sql"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := ValidateArgs(spec, tc.args)
			if tc.want == "" && err != nil { t.Fatal(err) }
			if tc.want != "" && (err == nil || !strings.Contains(err.Error(), tc.want)) {
				t.Fatalf("err=%v want %q", err, tc.want)
			}
		})
	}
}
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
wsl.exe -e bash -lc 'cd /mnt/d/merchantAgent/.worktrees/m6-completion/backend && go test ./connector -run TestValidateArgs -count=1'
```

Expected: FAIL because `ParamType` and `ValidateArgs` do not exist.

- [ ] **Step 3: Add exact metadata types to `connector.go`**

```go
type ParamType string
const (
	ParamString  ParamType = "string"
	ParamInteger ParamType = "integer"
	ParamBoolean ParamType = "boolean"
)

type ExecutionLocation string
const (
	ExecutionServer  ExecutionLocation = "server"
	ExecutionDesktop ExecutionLocation = "desktop"
)

type RiskLevel string
const (
	RiskRead      RiskLevel = "read"
	RiskLowWrite  RiskLevel = "low_write"
	RiskHighWrite RiskLevel = "high_write"
)

type ParamSpec struct {
	Name        string
	Description string
	Type        ParamType
	Required    bool
}

type ToolSpec struct {
	PackageID           string
	Version             string
	ManifestDigest      string
	Name                 string
	Description          string
	Params               []ParamSpec
	ResourceType         string
	ResourceKind         string
	ResourceArg          string
	DataDomain           string
	Execution            ExecutionLocation
	Risk                 RiskLevel
	RequiresConfirmation bool
	ResultFields         []string
}
```

Treat empty `ParamSpec.Type`, `ToolSpec.Execution`, and `ToolSpec.Risk` as `string`, `server`, and `read` respectively. `ResourceKind` is optional for legacy/non-generic resource types; Task 3 migrates order tools to `ResourceType:"business_record", ResourceKind:"order"`.

- [ ] **Step 4: Implement strict argument validation**

```go
func ValidateArgs(spec ToolSpec, args map[string]any) error {
	params := map[string]ParamSpec{}
	for _, p := range spec.Params { params[p.Name] = p }
	for name := range args {
		if _, ok := params[name]; !ok { return fmt.Errorf("unknown argument %s", name) }
	}
	for _, p := range spec.Params {
		v, ok := args[p.Name]
		if !ok || v == nil || (p.Type == ParamString && v == "") {
			if p.Required { return fmt.Errorf("missing required argument %s", p.Name) }
			continue
		}
		typ := p.Type
		if typ == "" { typ = ParamString }
		switch typ {
		case ParamString:
			if _, ok := v.(string); !ok { return fmt.Errorf("%s must be string", p.Name) }
		case ParamInteger:
			n, ok := v.(float64)
			if !ok || n != math.Trunc(n) { return fmt.Errorf("%s must be integer", p.Name) }
		case ParamBoolean:
			if _, ok := v.(bool); !ok { return fmt.Errorf("%s must be boolean", p.Name) }
		default:
			return fmt.Errorf("unsupported parameter type %q", typ)
		}
	}
	return nil
}
```

- [ ] **Step 5: Make the provider schema and dispatch use the declared type**

In `toolDef`, emit `string` when type is empty and the exact declared type otherwise. In `dispatch`, call `connector.ValidateArgs(spec, args)` before `guard.Authorize` and return `工具参数无效：...` on failure.

```go
typ := p.Type
if typ == "" { typ = connector.ParamString }
props[p.Name] = map[string]any{"type": string(typ), "description": p.Description}
```

- [ ] **Step 6: Run focused and runtime tests and verify GREEN**

```powershell
wsl.exe -e bash -lc 'cd /mnt/d/merchantAgent/.worktrees/m6-completion/backend && go test ./connector ./runtime -count=1'
```

Expected: PASS, including a new runtime test proving unknown `sql` is rejected before guard/invoke.

- [ ] **Step 7: Commit Task 1**

```powershell
git add backend/connector/connector.go backend/connector/validate.go backend/connector/validate_test.go backend/runtime/llm.go backend/runtime/llm_test.go
git commit -m "feat(connector): define typed enterprise tool contracts"
```

---

### Task 2: Add the Backend Desktop-Tool Reverse Bridge and Proxy Connector

**Files:**
- Create: `backend/connector/localtool.go`
- Create: `backend/connector/localtool_test.go`
- Create: `backend/connector/clientexec/reference.go`
- Create: `backend/connector/clientexec/reference_manifest.json`
- Create: `backend/connector/clientexec/reference_test.go`
- Create: `backend/cmd/agentd/localtoolbridge.go`
- Create: `backend/cmd/agentd/localtoolbridge_test.go`
- Modify: `backend/cmd/agentd/main.go`
- Modify: `backend/cmd/agentd/handlers.go`

**Interfaces:**
- Produces: `connector.InvocationMeta`, `LocalToolRequest`, `ExecutionMeta`, `LocalToolResponse`, `LocalToolBridge`, `WithLocalToolBridge`, `WithInvocation`, `PopExecutionMeta`, and `clientexec.NewReference()`.
- HTTP/SSE contract: `local_tool_request` and `POST /chat/local-tool-result`.
- Consumed by: Tasks 3, 6, 7, and 9.

- [ ] **Step 1: Write failing context/metadata round-trip tests**

```go
func TestExecutionMetaAttachPop(t *testing.T) {
	data := map[string]any{"status": "生产中"}
	meta := ExecutionMeta{Status: "succeeded", ExecutionID: "exec-1"}
	AttachExecutionMeta(data, meta)
	got := PopExecutionMeta(data)
	if got.ExecutionID != "exec-1" { t.Fatalf("meta=%+v", got) }
	if _, exists := data[ExecutionMetaKey]; exists { t.Fatal("reserved metadata leaked") }
}
```

```go
func TestReferenceProgressToolUsesDesktopBridge(t *testing.T) {
	bridge := &fakeLocalBridge{response: connector.LocalToolResponse{
		Data: map[string]any{"orderId":"SO-1001", "completionRate":80},
		Meta: connector.ExecutionMeta{Status:"succeeded", ExecutionID:"exec-1"},
	}}
	ctx := connector.WithLocalToolBridge(context.Background(), bridge)
	ctx = connector.WithInvocation(ctx, connector.InvocationMeta{TenantID:"t", UserID:"u_plan", SkillID:"production-progress", CallID:"c1"})
	tool, _ := connector.Lookup(clientexec.NewReference(), "report_production_progress")
	out, err := tool.Invoke(ctx, map[string]any{"orderId":"SO-1001", "workOrderId":"WO-1001", "completionRate":float64(80), "expectedVersion":float64(1), "note":"等待质检"})
	if err != nil { t.Fatal(err) }
	if bridge.request.Tool != "report_production_progress" || bridge.request.IdempotencyKey == "" { t.Fatalf("request=%+v", bridge.request) }
	if connector.PopExecutionMeta(out).ExecutionID != "exec-1" { t.Fatalf("out=%+v", out) }
}
```

- [ ] **Step 2: Run the connector tests and verify RED**

```powershell
wsl.exe -e bash -lc 'cd /mnt/d/merchantAgent/.worktrees/m6-completion/backend && go test ./connector ./connector/clientexec -count=1'
```

Expected: FAIL because the local bridge and reference connector do not exist.

- [ ] **Step 3: Implement the generic local-tool context contract**

```go
const ExecutionMetaKey = "__merchantagent_execution"

type InvocationMeta struct { TenantID, UserID, SkillID, CallID, DeviceID string; RoleIDs []string }
type LocalToolRequest struct {
	PackageID, PackageVersion, ManifestDigest string
	Tool, TenantID, UserID, SkillID, CallID, DeviceID, IdempotencyKey string
	RoleIDs []string
	Args map[string]any
	Risk RiskLevel
	RequiresConfirmation bool
}
type ExecutionMeta struct {
	Status, ExecutionID, IdempotencyKey, ConfirmedAt string
	Confirmed bool
	Before, After map[string]any
}
type LocalToolResponse struct { Data map[string]any; Meta ExecutionMeta; Error string }
type LocalToolBridge interface { InvokeLocalTool(context.Context, LocalToolRequest) (LocalToolResponse, error) }

func WithDeviceID(ctx context.Context, id string) context.Context
func DeviceIDFrom(ctx context.Context) string
func WithInvocation(ctx context.Context, m InvocationMeta) context.Context
func InvocationFrom(ctx context.Context) (InvocationMeta, bool)
func WithLocalToolBridge(ctx context.Context, b LocalToolBridge) context.Context
func LocalToolBridgeFrom(ctx context.Context) LocalToolBridge
func AttachExecutionMeta(data map[string]any, meta ExecutionMeta)
func PopExecutionMeta(data map[string]any) ExecutionMeta
```

Use private context-key types. `PopExecutionMeta` must delete the reserved key and accept both a stored `ExecutionMeta` and a JSON-shaped `map[string]any` for test/transport resilience.

- [ ] **Step 4: Implement the reference proxy connector**

Create one canonical, compact JSON payload in `reference_manifest.json` containing package ID, version, both tool names, parameter schemas, result fields, execution location, risk, and confirmation requirement. Embed the raw bytes in Go and compute the digest from those exact bytes:

```go
//go:embed reference_manifest.json
var referenceManifest []byte

const (
	PackageID = "reference-manufacturing"
	PackageVersion = "1.0.0"
)

func ManifestDigest() string {
	sum := sha256.Sum256(referenceManifest)
	return "sha256:" + hex.EncodeToString(sum[:])
}
```

`query_order_status` declares desktop/read/no confirmation and allowlists `orderId`, `workOrderId`, `status`, `promiseDate`, `completionRate`, `note`, and `version`.

`report_production_progress` declares desktop/low-write/confirmation with parameters `orderId:string`, `workOrderId:string`, `completionRate:integer`, `expectedVersion:integer`, and optional `note:string`. Both use `ResourceType:"business_record"`, `ResourceKind:"order"`, and `ResourceArg:"orderId"`, so authorization checks `business_record:<tenant>/order/<orderId>` before the request leaves the cloud.

The proxy `Invoke` must require a bridge and invocation metadata, derive the idempotency key as SHA-256 of `tenant|user|callID|tool`, use `ManifestDigest()` in the request, carry device and role IDs, call the bridge, preserve any typed response error/status, attach response metadata under `ExecutionMetaKey`, and return only the local response data plus reserved metadata.

- [ ] **Step 5: Implement server rendezvous and endpoint**

Add `pendingTools map[string]chan connector.LocalToolResponse` to `server`. `localToolBridge.InvokeLocalTool` must register a random request ID, emit this exact SSE shape, wait at most 120 seconds, and remove the pending entry in `defer`:

```json
{
  "kind":"local_tool_request",
  "reqId":"...",
  "packageId":"reference-manufacturing",
  "packageVersion":"1.0.0",
  "manifestDigest":"...",
  "tool":"report_production_progress",
  "tenantId":"mock-corp-001",
  "userId":"u_plan",
  "deviceId":"DESKTOP-01",
  "roleIds":["planner"],
  "skillId":"production-progress",
  "callId":"c2",
  "idempotencyKey":"...",
  "risk":"low_write",
  "requiresConfirmation":true,
  "args":{}
}
```

`POST /chat/local-tool-result` accepts `reqId`, `data`, `meta`, and `error`. Map timeout to a typed execution error with status `unknown`; map a desktop-provided error status without losing it.

- [ ] **Step 6: Attach both bridges in `/chat`**

```go
ctx := connector.WithFileBridge(r.Context(), &fileBridge{srv: s, send: send})
ctx = connector.WithLocalToolBridge(ctx, &localToolBridge{srv: s, send: send})
```

Register the new result route and initialize `pendingTools` in `main` and every test server fixture.

Extend the `/chat` request body with `deviceId`, set it on context with `connector.WithDeviceID`, and treat an empty value as `unknown-device` for non-desktop tests. The desktop main process will begin supplying the real mock device ID in Task 6.

- [ ] **Step 7: Run focused bridge tests and verify GREEN**

```powershell
wsl.exe -e bash -lc 'cd /mnt/d/merchantAgent/.worktrees/m6-completion/backend && go test ./connector ./connector/clientexec ./cmd/agentd -run "LocalTool|ReferenceProgress" -count=1'
```

Expected: PASS; the server test must prove one emitted request unblocks only when the matching `reqId` result is posted, and an expired ID returns HTTP 404.

- [ ] **Step 8: Commit Task 2**

```powershell
git add backend/connector/localtool.go backend/connector/localtool_test.go backend/connector/clientexec backend/cmd/agentd/localtoolbridge.go backend/cmd/agentd/localtoolbridge_test.go backend/cmd/agentd/main.go backend/cmd/agentd/handlers.go
git commit -m "feat(agentd): bridge authorized tools to the desktop"
```

---

### Task 3: Migrate to Industry-Neutral Business Records and Seed Role-Scoped Skills

**Files:**
- Modify: `backend/authz/model.fga`
- Modify: `backend/authz/acceptance_test.go`
- Modify: `backend/authz/cases_test.go`
- Modify: `backend/connector/erp/tools.go`
- Modify: `backend/connector/mockerp/tools.go`
- Modify: `backend/runtime/guard.go`
- Modify: `backend/runtime/runtime_test.go`
- Modify: `backend/runtime/llm_test.go`
- Modify: `backend/e2e/e2e_test.go`
- Modify: `backend/e2e/scenarios_test.go`
- Modify: `backend/wire/projector.go`
- Modify: `backend/wire/projector_test.go`
- Create: `backend/skill/migrations.go`
- Create: `backend/skill/migrations/002_local_enterprise_tools.sql`
- Modify: `backend/skill/skill.go`
- Modify: `backend/skill/skill_test.go`
- Modify: `backend/wire/assemble.go`
- Modify: `backend/wire/integration_test.go`

**Interfaces:**
- Produces: generic `business_record#operator`, `order-status` and `production-progress` Skills, and a desktop proxy registered after ERP/CRM.
- Consumes: `clientexec.NewReference()` and metadata from Tasks 1-2.
- Consumed by: Tasks 7-9.

- [ ] **Step 1: Add failing migration and authorization tests**

Add tests that prove:

```go
func TestOpenFileAppliesLocalToolMigrationOnce(t *testing.T) {
	path := filepath.Join(t.TempDir(), "skills.db")
	s, _ := OpenFile(path)
	assertSkillRoles(t, s, "order-status", []string{"sales","planner","manager_tier"})
	assertSkillRoles(t, s, "production-progress", []string{"planner","manager_tier"})
	s.Delete(context.Background(), "mock-corp-001", "production-progress")
	s.Close()
	s, _ = OpenFile(path)
	defer s.Close()
	assertSkillMissing(t, s, "production-progress")
}
```

In `wire/integration_test.go`, prove `u_plan` is viewer of `business_record:mock-corp-001/order/SO-1001`, invoker of `report_production_progress`, and `u_sales1` is not an invoker of that write tool.

- [ ] **Step 2: Run focused tests and verify RED**

```powershell
wsl.exe -e bash -lc 'cd /mnt/d/merchantAgent/.worktrees/m6-completion/backend && OPENFGA_API_URL=http://localhost:18080 go test ./skill ./wire -run "LocalToolMigration|ProductionProgressAuthorization" -count=1'
```

Expected: FAIL because the migration, operator relation, and Skills do not exist.

- [ ] **Step 3: Replace the platform-specific `order` object with generic `business_record`**

```fga
type business_record
  relations
    define tenant: [tenant]
    define owner_dept: [department]
    define owner: [user]
    define operator: [user, department#member]
    define viewer: owner or operator or member from owner_dept or manager from owner_dept
```

Update `Guard.Authorize` so `ResourceKind` scopes the generic record ID:

```go
id, ok := args[spec.ResourceArg].(string)
if !ok || id == "" { return Decision{false, "missing resource id arg " + spec.ResourceArg}, nil }
if spec.ResourceKind != "" { id = spec.ResourceKind + "/" + id }
ok, err := g.chk.Check(ctx, user, "viewer", g.obj(spec.ResourceType, id))
```

Migrate every ERP/mock-ERP order tool to `ResourceType:"business_record", ResourceKind:"order"`. Replace all order fixture/test object strings with `business_record:<tenant>/order/<id>`; do not keep a second legacy `order` authorization type.

Add this production fixture for `SO-1001`:

```go
{User: "department:" + o("d_prod") + "#member", Relation: "operator", Object: "business_record:" + tenant + "/order/SO-1001"},
```

Capability authorization remains separate: this makes production able to view the record but does not grant the write tool.

- [ ] **Step 4: Add a once-only skill migration mechanism**

Create `schema_migrations(version INTEGER PRIMARY KEY)` during open. Embed `migrations/*.sql`, sort by numeric prefix, and execute each unapplied migration plus its version insert in one transaction.

Migration `002_local_enterprise_tools.sql` must `INSERT OR IGNORE` the `order-status` and `production-progress` templates and tenant Skills with the exact roles above. The production playbook must require a status query first, pass the returned `version` as `expectedVersion`, summarize the proposed change, then call the write tool only after the client confirmation gate.

Because version `2` is recorded, deleting a migrated Skill later must not resurrect it on reopen.

- [ ] **Step 5: Register the desktop connector last**

```go
conns := []connector.Connector{e, c, clientexec.NewReference()}
```

Document that last registration intentionally makes the desktop proxy own `query_order_status`. Keep the mock ERP connector for financial/kitting/customer tools. Add a unit assertion that `Agent.ToolSpec("query_order_status").Execution == connector.ExecutionDesktop`; expose `ToolSpec(name) (connector.ToolSpec, bool)` rather than inspecting private maps.

- [ ] **Step 6: Run skill, authz, and wire tests and verify GREEN**

```powershell
wsl.exe -e bash -lc 'cd /mnt/d/merchantAgent/.worktrees/m6-completion/backend && OPENFGA_API_URL=http://localhost:18080 go test ./skill ./authz ./wire -count=1'
```

Expected: PASS. Existing skill deletion persistence tests must remain green.

- [ ] **Step 7: Commit Task 3**

```powershell
git add backend/authz/model.fga backend/authz/acceptance_test.go backend/authz/cases_test.go backend/connector/erp/tools.go backend/connector/mockerp/tools.go backend/runtime/guard.go backend/runtime/runtime_test.go backend/runtime/llm_test.go backend/e2e/e2e_test.go backend/e2e/scenarios_test.go backend/wire/projector.go backend/wire/projector_test.go backend/skill/migrations.go backend/skill/migrations backend/skill/skill.go backend/skill/skill_test.go backend/wire/assemble.go backend/wire/integration_test.go
git commit -m "feat(skill): add role-scoped desktop enterprise skills"
```

---

### Task 4: Build the Persistent Desktop Reference ERP Store

**Files:**
- Modify: `desktop/package.json`
- Modify: `desktop/package-lock.json`
- Modify: `desktop/electron.vite.config.ts`
- Create: `desktop/src/main/local-tools/store.ts`
- Create: `desktop/src/main/local-tools/store.test.ts`

**Interfaces:**
- Produces: `ReferenceEnterpriseStore`, `queryOrderStatus(orderId)`, and `reportProductionProgress(input)`.
- Consumed by: Task 5.

- [ ] **Step 1: Add `better-sqlite3` and native-module build configuration**

Run from `desktop`:

```powershell
npm install better-sqlite3
npm install --save-dev @types/better-sqlite3
```

Set `build.npmRebuild` to `true`, add `asarUnpack: ["node_modules/better-sqlite3/**/*"]`, and use Electron Vite's `externalizeDepsPlugin()` for the main process so the native module is not bundled into JavaScript.

- [ ] **Step 2: Write failing store tests**

Cover all exact cases:

```ts
it("reads only allowlisted order progress fields", () => {
  expect(store.queryOrderStatus("SO-1001")).toEqual({
    orderId: "SO-1001", workOrderId: "WO-1001", status: "生产中",
    promiseDate: "2026-07-20", completionRate: 60, note: "装配中", version: 1,
  });
});

it("writes once, verifies, and returns the saved idempotent result", () => {
  const input = { orderId:"SO-1001", workOrderId:"WO-1001", completionRate:80,
    expectedVersion:1, note:"等待质检", idempotencyKey:"idem-1" };
  const first = store.reportProductionProgress(input);
  const second = store.reportProductionProgress(input);
  expect(first).toEqual(second);
  expect(store.queryOrderStatus("SO-1001").version).toBe(2);
});

it("rejects stale versions", () => {
  expect(() => store.reportProductionProgress({ ...input, idempotencyKey:"idem-2", expectedVersion:0 }))
    .toThrowError(/source_conflict/);
});
```

Also test completion rates below 0/above 100, unknown order/work-order pairs, persistence across close/reopen, and that `cost`, `price`, database path, and SQL never appear in returned JSON.

- [ ] **Step 3: Run the store tests and verify RED**

```powershell
cd desktop
npx vitest run src/main/local-tools/store.test.ts
```

Expected: FAIL because the store does not exist.

- [ ] **Step 4: Implement schema and one-time seed**

Use parameterized statements only. Schema:

```sql
CREATE TABLE IF NOT EXISTS orders (
  order_id TEXT PRIMARY KEY, status TEXT NOT NULL, promise_date TEXT NOT NULL,
  cost INTEGER NOT NULL, price INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS work_orders (
  work_order_id TEXT PRIMARY KEY, order_id TEXT NOT NULL UNIQUE,
  completion_rate INTEGER NOT NULL, note TEXT NOT NULL, version INTEGER NOT NULL,
  FOREIGN KEY(order_id) REFERENCES orders(order_id)
);
CREATE TABLE IF NOT EXISTS tool_idempotency (
  idempotency_key TEXT PRIMARY KEY, tool_name TEXT NOT NULL,
  result_json TEXT NOT NULL, created_at TEXT NOT NULL
);
```

Seed `SO-1001`/`WO-1001` at 60%, version 1 only when the order is absent.

- [ ] **Step 5: Implement transactional write and read-back**

Within one `better-sqlite3` transaction:

1. Return stored JSON if the idempotency key already exists for the same tool.
2. Select the current row and reject mismatched order/work-order or version with error code `source_conflict`.
3. Run `UPDATE work_orders SET completion_rate=?, note=?, version=version+1 WHERE work_order_id=? AND version=?`.
4. Read back the joined row.
5. Persist the exact result JSON under the idempotency key.
6. Return `{data, before, after}` with allowlisted fields only.

- [ ] **Step 6: Run store tests, node typecheck, and verify GREEN**

```powershell
cd desktop
npx vitest run src/main/local-tools/store.test.ts
npm run typecheck:node
```

Expected: PASS.

- [ ] **Step 7: Commit Task 4**

```powershell
git add desktop/package.json desktop/package-lock.json desktop/electron.vite.config.ts desktop/src/main/local-tools/store.ts desktop/src/main/local-tools/store.test.ts
git commit -m "feat(desktop): add persistent local reference ERP"
```

---

### Task 5: Verify the Capability Package and Dispatch Local Tools

**Files:**
- Create: `desktop/scripts/generate-reference-capability.mjs`
- Create: `desktop/resources/capabilities/reference-manufacturing.cap.json`
- Create: `desktop/resources/capabilities/reference-public.pem`
- Create: `desktop/src/main/local-tools/package.ts`
- Create: `desktop/src/main/local-tools/package.test.ts`
- Create: `desktop/src/main/local-tools/executor.ts`
- Create: `desktop/src/main/local-tools/executor.test.ts`
- Modify: `desktop/package.json`

**Interfaces:**
- Produces: `verifyCapabilityPackage(path, publicKeyPath)`, `LocalDataSource`, `LocalToolExecutor.execute(request, confirm)`, and typed desktop `LocalToolResponse`.
- Consumes: Task 4 store and Task 2 request/response field names.
- Consumed by: Task 6.

- [ ] **Step 1: Write failing package integrity tests**

```ts
it("accepts the signed reference package", () => {
  expect(loadReferencePackage().manifest).toMatchObject({
    packageId: "reference-manufacturing", version: "1.0.0",
    tools: [{ name: "query_order_status" }, { name: "report_production_progress" }],
  });
});

it.each(["payload", "signature", "version", "manifestDigest"])("rejects tampered %s", (field) => {
  expect(() => verifyCapabilityPackage(tamperedPackage(field), publicKey)).toThrow(/package_integrity/);
});
```

- [ ] **Step 2: Run package tests and verify RED**

```powershell
cd desktop
npx vitest run src/main/local-tools/package.test.ts
```

Expected: FAIL because the verifier/package do not exist.

- [ ] **Step 3: Generate a signed reference package without persisting a private key**

The generation script must:

1. Read the canonical bytes from `../backend/connector/clientexec/reference_manifest.json` without parsing/re-serializing them.
2. Generate an ephemeral Ed25519 key pair with `generateKeyPairSync("ed25519")`.
3. Sign the UTF-8 payload with `crypto.sign(null, payload, privateKey)`.
4. Write `{payload: base64, signature: base64, manifestDigest: "sha256:<hex>"}` and the public PEM.
5. Never write or log the private key.

Add script `capability:generate` and run it once. Check in only the script, signed package, and public key. Production signing infrastructure remains outside this reference slice.

- [ ] **Step 4: Implement verification before parsing**

`verifyCapabilityPackage` must verify Ed25519 signature over the raw decoded payload, verify SHA-256 digest, parse JSON only after signature success, require exact package ID/version, reject `high_write`, and build a map by tool name. Error codes must be `package_integrity`, `package_version`, or `tool_not_installed`. A test must compare the desktop-computed digest with the Go `clientexec.ManifestDigest()` value exposed through the backend tool catalog, so the one canonical payload cannot drift silently.

- [ ] **Step 5: Write failing executor tests**

Prove:

- read dispatch does not call `confirm`;
- low-write dispatch shows a preview containing order/work-order, before and proposed values;
- cancellation returns error status `cancelled` and does not mutate SQLite;
- successful write returns `succeeded`, execution ID, idempotency key, `confirmed:true`, before, and after;
- duplicate idempotency returns the same result;
- unknown tool, mismatched version/digest, invalid arguments, missing datasource, invalid credentials, and source conflict map to their distinct error statuses.

- [ ] **Step 6: Run executor tests and verify RED**

```powershell
cd desktop
npx vitest run src/main/local-tools/executor.test.ts
```

Expected: FAIL because `LocalToolExecutor` does not exist.

- [ ] **Step 7: Implement allowlisted dispatch**

```ts
export type Confirm = (preview: WritePreview) => Promise<boolean>;
export interface LocalDataSource {
  queryOrderStatus(orderId: string): OrderStatus;
  reportProductionProgress(input: ProgressWrite): ProgressWriteResult;
}

export class LocalToolExecutor {
  constructor(private pkg: VerifiedPackage, private store: LocalDataSource) {}
  async execute(req: LocalToolRequest, confirm: Confirm): Promise<LocalToolResponse> {
    const executionId = crypto.randomUUID();
    const base = { executionId, idempotencyKey: req.idempotencyKey, confirmed: false };
    try {
      const tool = this.pkg.requireTool(req.packageId, req.packageVersion, req.manifestDigest, req.tool);
      tool.validate(req.args);
      if (req.tool === "query_order_status") {
        const data = this.store.queryOrderStatus(String(req.args.orderId));
        return { data, meta: { ...base, status: "succeeded" } };
      }
      if (req.tool === "report_production_progress") {
        const before = this.store.queryOrderStatus(String(req.args.orderId));
        const approved = await confirm({
          orderId: String(req.args.orderId), workOrderId: String(req.args.workOrderId),
          before, proposed: { completionRate: Number(req.args.completionRate), note: String(req.args.note ?? "") },
        });
        if (!approved) return { meta: { ...base, status: "cancelled", before } };
        const confirmedAt = new Date().toISOString();
        const written = this.store.reportProductionProgress({
          orderId: String(req.args.orderId), workOrderId: String(req.args.workOrderId),
          completionRate: Number(req.args.completionRate), expectedVersion: Number(req.args.expectedVersion),
          note: String(req.args.note ?? ""), idempotencyKey: req.idempotencyKey,
        });
        return { data: written.data, meta: { ...base, status: "succeeded", confirmed: true,
          confirmedAt, before: written.before, after: written.after } };
      }
      return { meta: { ...base, status: "failed" }, error: "tool_not_installed" };
    } catch (error) {
      const code = localErrorCode(error);
      const status = code === "source_conflict" ? "source_conflict" : "failed";
      return { meta: { ...base, status }, error: code };
    }
  }
}
```

Do not add a generic fallback or dynamic function lookup. Use an explicit `switch` over the two tool names.

- [ ] **Step 8: Run package/executor tests and verify GREEN**

```powershell
cd desktop
npx vitest run src/main/local-tools/package.test.ts src/main/local-tools/executor.test.ts
npm run typecheck:node
```

Expected: PASS.

- [ ] **Step 9: Commit Task 5**

```powershell
git add desktop/scripts/generate-reference-capability.mjs desktop/resources/capabilities desktop/src/main/local-tools/package.ts desktop/src/main/local-tools/package.test.ts desktop/src/main/local-tools/executor.ts desktop/src/main/local-tools/executor.test.ts desktop/package.json desktop/package-lock.json
git commit -m "feat(desktop): verify and execute signed capability packages"
```

---

### Task 6: Wire SSE Requests into Electron and Require Local Confirmation

**Files:**
- Modify: `desktop/src/shared/contract.ts`
- Modify: `desktop/src/main/agentd.ts`
- Modify: `desktop/src/main/agentd.test.ts`
- Modify: `desktop/src/main/ipc.ts`
- Create: `desktop/src/main/ipc.localtools.test.ts`
- Modify: `desktop/src/main/index.ts`
- Modify: `desktop/package.json`

**Interfaces:**
- Consumes: `LocalToolExecutor` from Task 5 and the exact Task 2 SSE/HTTP schema.
- Produces: a working Electron main-process local execution path.
- Consumed by: Tasks 7 and 9.

- [ ] **Step 1: Add exact shared wire types**

Extend `ChatEvent.kind` with `local_tool_request` and `tool_state`, and add:

```ts
export interface LocalToolRequest {
  reqId: string; packageId: string; packageVersion: string; manifestDigest: string;
  tool: string; tenantId: string; userId: string; deviceId: string; roleIds: string[];
  skillId: string; callId: string;
  idempotencyKey: string; risk: "read" | "low_write" | "high_write";
  requiresConfirmation: boolean; args: Record<string, unknown>;
}
export interface ExecutionMeta {
  status: "succeeded" | "failed" | "cancelled" | "source_conflict" | "unknown";
  executionId: string; idempotencyKey: string; confirmed: boolean; confirmedAt?: string;
  before?: Record<string, unknown>; after?: Record<string, unknown>;
}
export interface LocalToolResponse {
  data?: Record<string, unknown>; meta: ExecutionMeta; error?: string;
}
```

The Electron main process, not the renderer, adds `deviceId` using `os.hostname()` for this mock slice. Pass it to `client.chat`, include it in each local tool result/request correlation, and never trust a renderer-supplied device ID.

- [ ] **Step 2: Add failing SSE handler tests**

Extend `agentd.test.ts` with a `local_tool_request` stream and assert that `client.chat` invokes the local handler once and posts to `/chat/local-tool-result` with `reqId`, `data`, `meta`, and `error`. Add a handler-throw case that still posts `status:"failed"` instead of terminating the SSE reader.

- [ ] **Step 3: Run the agentd tests and verify RED**

```powershell
cd desktop
npx vitest run src/main/agentd.test.ts
```

Expected: FAIL because `client.chat` handles only file requests.

- [ ] **Step 4: Generalize `client.chat` with a local-tool callback**

Keep the existing file callback. Add `LocalToolRequestHandler`, branch on `local_tool_request`, await the handler, and always post a structured result. Do not forward the local request payload to the renderer because confirmation occurs in the privileged main process.

- [ ] **Step 5: Add failing confirmation-dialog integration tests**

Inject a fake executor and mock `dialog.showMessageBox`. Assert exact behavior:

```ts
expect(dialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
  type: "warning", buttons: ["取消", "确认写入"], defaultId: 0, cancelId: 0,
  message: "确认更新生产进度",
}));
```

Cancellation must return `cancelled`; confirmation must call the executor write once.

- [ ] **Step 6: Initialize the local executor in Electron main**

At `app.whenReady`, create:

```ts
const dataDir = app.getPath("userData");
const store = new ReferenceEnterpriseStore(path.join(dataDir, "reference-enterprise.db"));
const pkg = verifyCapabilityPackage(resourcePackagePath(), resourcePublicKeyPath());
const executor = new LocalToolExecutor(pkg, store);
register(new Sandbox(root), executor);
```

Close the store on `before-quit`. Add both capability files to `build.extraResources`. In dev, resolve them from `desktop/resources/capabilities`; in packaged builds, resolve from `process.resourcesPath/capabilities`.

- [ ] **Step 7: Run desktop bridge tests, typecheck, and verify GREEN**

```powershell
cd desktop
npx vitest run src/main/agentd.test.ts src/main/ipc.localtools.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit Task 6**

```powershell
git add desktop/src/shared/contract.ts desktop/src/main/agentd.ts desktop/src/main/agentd.test.ts desktop/src/main/ipc.ts desktop/src/main/ipc.localtools.test.ts desktop/src/main/index.ts desktop/package.json
git commit -m "feat(desktop): execute confirmed enterprise tools locally"
```

---

### Task 7: Record Skill, Execution Lifecycle, and Local Results in Tenant Audit

**Files:**
- Modify: `backend/runtime/audit.go`
- Modify: `backend/runtime/llm.go`
- Modify: `backend/runtime/llm_test.go`
- Modify: `backend/runtime/runtime_test.go`
- Modify: `backend/cmd/agentd/handlers.go`
- Modify: `backend/wire/resolver.go`
- Modify: `backend/wire/resolver_test.go`
- Modify: `desktop/src/renderer/src/types.ts`
- Modify: `desktop/src/renderer/src/components/ResultCard.tsx`
- Create: `desktop/src/renderer/src/types.test.ts`
- Create: `desktop/src/renderer/src/local-tools-ui.test.tsx`

**Interfaces:**
- Consumes: invocation/execution metadata from Tasks 2 and 6.
- Produces: auditable final states and user-visible local execution progress/result cards.
- Consumed by: Task 9.

- [ ] **Step 1: Write failing runtime audit tests**

Script a fake provider through `load_skill -> report_production_progress -> final` and a fake local bridge response. Assert one audit entry contains:

```go
AuditEntry{
	SkillID:"production-progress", RoleIDs:[]string{"planner"}, DeviceID:"DESKTOP-01",
	Tool:"report_production_progress",
	ToolVersion:"1.0.0", ExecutionLocation:"desktop", Risk:"low_write",
	Decision:"allow", Status:"succeeded", ExecutionID:"exec-1",
	IdempotencyKey:"...", Confirmed:true, ConfirmedAt:"2026-07-12T10:00:00Z",
	ResourceID:"SO-1001", Before:map[string]any{"completionRate":float64(60)},
	After:map[string]any{"completionRate":float64(80)},
}
```

Add denial, `source_conflict`, explicit failure, cancellation, and timeout/`unknown` tests. Verify the hash chain after every case.

- [ ] **Step 2: Run runtime tests and verify RED**

```powershell
wsl.exe -e bash -lc 'cd /mnt/d/merchantAgent/.worktrees/m6-completion/backend && go test ./runtime -run "LocalExecutionAudit|AuditChain" -count=1'
```

Expected: FAIL because audit fields and final-state recording do not exist.

- [ ] **Step 3: Track which loaded Skill unlocked each tool**

Replace the boolean-only unlock state with `unlockedBy map[string]string`. When loading a Skill, set the tool's Skill ID if it has not already been set. Pass that Skill ID and provider tool-call ID via `connector.WithInvocation` immediately around `tool.Invoke`.

- [ ] **Step 4: Record one final audit entry per connector call**

Add a `runtime.RoleResolver` interface and `Resolver.RoleIDs(ctx, principal)` using OpenFGA `ListObjects(user:<id>, assignee, role)`; sort the returned role IDs. Resolve roles once per turn, read the device ID from `connector.DeviceIDFrom(ctx)`, and include both in `connector.InvocationMeta` and every audit entry.

Extend `AuditEntry` with the fields asserted above. For connector calls:

1. Validate and authorize.
2. On deny, append status `denied`.
3. Invoke the tool.
4. Pop reserved execution metadata before emitting `tool_result` or serializing content for the LLM.
5. Append `succeeded`, `failed`, `cancelled`, `source_conflict`, or `unknown` with metadata.

Do not expose `Before`, `After`, execution IDs, or reserved metadata to the LLM tool result unless fields are part of the tool's `ResultFields` allowlist.

- [ ] **Step 5: Restrict audit reads to self or tenant administrator**

Require `X-User-Id` on `GET /audit`. Check `tenant#admin` through OpenFGA: administrators receive the full tenant chain; non-admin members receive only entries whose `UserID` matches the caller. Return 401 without identity and 403 for inactive/non-tenant users. Add handler tests proving sales cannot read production/boss entries and `u_boss` can read all entries.

- [ ] **Step 6: Emit user-visible execution states without exposing request internals**

Add runtime events `tool_state` with `Data:{"status":"executing"}` before the local proxy blocks and the final status after response. `foldEvent` maps them to Chinese status text. Add `report_production_progress` to `TOOL_LABEL` and render a compact result card with work order, completion rate, note, and verified status.

- [ ] **Step 7: Run backend and renderer tests and verify GREEN**

```powershell
wsl.exe -e bash -lc 'cd /mnt/d/merchantAgent/.worktrees/m6-completion/backend && go test ./runtime ./cmd/agentd -count=1'
cd desktop
npx vitest run src/renderer/src/local-tools-ui.test.tsx src/renderer/src/types.test.ts
npm run typecheck
```

Expected: PASS. `types.test.ts` owns `foldEvent` status-state coverage; `local-tools-ui.test.tsx` owns progress result-card markup.

- [ ] **Step 8: Commit Task 7**

```powershell
git add backend/runtime/audit.go backend/runtime/llm.go backend/runtime/llm_test.go backend/runtime/runtime_test.go backend/cmd/agentd/handlers.go backend/wire/resolver.go backend/wire/resolver_test.go desktop/src/renderer/src/types.ts desktop/src/renderer/src/types.test.ts desktop/src/renderer/src/components/ResultCard.tsx desktop/src/renderer/src/local-tools-ui.test.tsx
git commit -m "feat(audit): record desktop tool execution lifecycle"
```

---

### Task 8: Expose Execution Metadata in the Admin Tool Picker

**Files:**
- Modify: `backend/cmd/agentd/admin.go`
- Modify: `backend/cmd/agentd/admin_test.go`
- Modify: `desktop/src/renderer/src/admin.ts`
- Modify: `desktop/src/renderer/src/components/admin/SkillsPane.tsx`
- Modify: `desktop/src/renderer/src/components/admin/SkillsPane.test.tsx`
- Modify: `desktop/src/renderer/src/mock-admin.ts`
- Modify: `desktop/src/renderer/src/mock-admin.test.ts`
- Modify: `desktop/src/renderer/src/app.css`

**Interfaces:**
- Produces: deduplicated `ToolInfo` with package, version, execution, risk, and confirmation metadata.
- Preserves: existing administrator-only Skill-to-role assignment and independent data-domain Gate B.

- [ ] **Step 1: Add failing admin catalog tests**

Backend expected shape for `query_order_status`:

```json
{
  "name":"query_order_status",
  "description":"查询订单及本地生产进度（不含成本利润）",
  "packageId":"reference-manufacturing",
  "version":"1.0.0",
  "execution":"desktop",
  "risk":"read",
  "requiresConfirmation":false
}
```

Assert only one row exists despite ERP/client connector duplicate names and the last registered connector wins. Renderer markup must visibly label `本地执行`, `低风险写入`, and `需确认` for the progress tool.

- [ ] **Step 2: Run focused tests and verify RED**

```powershell
wsl.exe -e bash -lc 'cd /mnt/d/merchantAgent/.worktrees/m6-completion/backend && go test ./cmd/agentd -run TestAdminTools -count=1'
cd desktop
npx vitest run src/renderer/src/components/admin/SkillsPane.test.tsx src/renderer/src/mock-admin.test.ts
```

Expected: FAIL because the catalog lacks metadata and duplicate resolution.

- [ ] **Step 3: Deduplicate and enrich `/admin/tools`**

Build a `map[string]toolInfo` while iterating connectors in registration order, then sort names before responding. Include `packageId`, `version`, `execution`, `risk`, and `requiresConfirmation`. Empty execution/risk normalize to `server`/`read`.

- [ ] **Step 4: Render metadata without adding a new authorization control**

Expand `ToolInfo` and show compact text next to the tool name. The checkbox remains only `skill.allowedTools`; role assignment remains the existing `roles` field and Assign pane. Do not auto-grant a role or data domain when a tool is selected.

- [ ] **Step 5: Run admin tests, typecheck, and verify GREEN**

```powershell
wsl.exe -e bash -lc 'cd /mnt/d/merchantAgent/.worktrees/m6-completion/backend && go test ./cmd/agentd -run "AdminTools|RequireAdmin" -count=1'
cd desktop
npx vitest run src/renderer/src/components/admin/SkillsPane.test.tsx src/renderer/src/mock-admin.test.ts
npm run typecheck:web
```

Expected: PASS.

- [ ] **Step 6: Commit Task 8**

```powershell
git add backend/cmd/agentd/admin.go backend/cmd/agentd/admin_test.go desktop/src/renderer/src/admin.ts desktop/src/renderer/src/components/admin/SkillsPane.tsx desktop/src/renderer/src/components/admin/SkillsPane.test.tsx desktop/src/renderer/src/mock-admin.ts desktop/src/renderer/src/mock-admin.test.ts desktop/src/renderer/src/app.css
git commit -m "feat(admin): identify desktop and write-risk tools"
```

---

### Task 9: Prove the Full Vertical Slice and Update Operational Documentation

**Files:**
- Create: `backend/cmd/agentd/localtool_vertical_test.go`
- Create: `desktop/src/main/local-tools/vertical.test.ts`
- Modify: `backend/e2e/scenarios_test.go`
- Modify: `docs/实现进度.md`
- Modify: `docs/本地部署指南.md`
- Modify: `desktop/README.md`
- Modify: `backend/README.md`

**Interfaces:**
- Consumes: every prior task.
- Produces: deterministic acceptance evidence plus a manual real-LLM/Windows acceptance script.

- [ ] **Step 1: Add a deterministic backend bridge vertical test**

Use `provider.Fake` to script:

```text
load_skill(order-status)
query_order_status(SO-1001)
load_skill(production-progress)
report_production_progress(SO-1001, WO-1001, 80, version 1)
query_order_status(SO-1001)
final
```

Drive the real `/chat` SSE endpoint with a fake desktop handler that returns 60% for the first query, a confirmed 80% write with before/after metadata, then 80% for the final query. Assert request package/version/digest, role gate, final text, and verified audit chain.

Add a separate sales call where the fake provider attempts `report_production_progress`; assert no `local_tool_request` is emitted and audit status is `denied`.

- [ ] **Step 2: Add a deterministic desktop store/executor vertical test**

With a temp SQLite file and real signed reference package:

1. Query and assert 60%.
2. Confirm update to 80%.
3. Query and assert 80%/version 2.
4. Repeat the same idempotency key and assert version stays 2.
5. Cancel a second write and assert state stays 80%.
6. Tamper package version/signature and assert no store call occurs.

- [ ] **Step 3: Run deterministic vertical tests and require GREEN**

```powershell
wsl.exe -e bash -lc 'cd /mnt/d/merchantAgent/.worktrees/m6-completion/backend && OPENFGA_API_URL=http://localhost:18080 go test ./cmd/agentd ./e2e -run "LocalToolVertical|SameQuestionDifferentRights" -count=1 -v'
cd desktop
npx vitest run src/main/local-tools/vertical.test.ts
```

Expected: PASS. A failure is a release blocker and must be returned to the earlier task that owns the mismatched contract before continuing to the full verification matrix.

- [ ] **Step 4: Run the complete automated verification matrix**

```powershell
wsl.exe -e bash -lc 'cd /mnt/d/merchantAgent/.worktrees/m6-completion/backend && go test -count=1 ./...'
wsl.exe -e bash -lc 'cd /mnt/d/merchantAgent/.worktrees/m6-completion/backend && OPENFGA_API_URL=http://localhost:18080 go test -count=1 ./...'
cd desktop
npm test
npm run typecheck
npm run build
npm run dist:dir
```

Expected: every command exits 0; no skipped OpenFGA tests in the second backend run; desktop production directory contains the capability package, public key, and rebuilt `better-sqlite3` binary.

- [ ] **Step 5: Perform the Windows manual acceptance**

1. Start OpenFGA and WSL `agentd` using the documented commands.
2. Delete only the reference desktop DB (not config/skill stores) to reset progress to 60%.
3. Start the unpacked Windows App.
4. As `u_sales1`, query `SO-1001`; verify 60% and no cost.
5. As `u_sales1`, ask to update progress; verify capability denial and no local confirmation.
6. As `u_plan`, query then update to 80%; verify preview and confirm.
7. Switch back to `u_sales1`; verify 80%.
8. As `u_boss`, inspect audit and verify query, deny, confirmation, write, and read-back entries.
9. Disable `production-progress` for planner in the existing Assign pane; verify immediate revocation.
10. Capture desktop and 390px-width screenshots and verify no overlap or horizontal overflow.

- [ ] **Step 6: Update documentation with evidence and boundaries**

Document exact startup/reset paths, local DB location, capability resource paths, supported tools, known mock identity status, and the fact that this proves the execution topology but is not a real customer connector. Update `docs/实现进度.md` only after Step 4 and Step 5 evidence exists.

- [ ] **Step 7: Commit Task 9**

```powershell
git add backend/cmd/agentd/localtool_vertical_test.go backend/e2e/scenarios_test.go desktop/src/main/local-tools/vertical.test.ts docs/实现进度.md docs/本地部署指南.md desktop/README.md backend/README.md
git commit -m "test: verify desktop-local enterprise tool vertical"
```

## Plan Self-Review Checklist

- [x] Spec coverage: desktop execution, Skill/role gating, data boundary, confirmation, idempotency, conflict, timeout/unknown, signature/version rejection, audit, revocation, and cross-role read-after-write each map to a task and an acceptance test.
- [x] Scope: no real WeCom, real customer DB, gateway, high-risk write, self-service SQL, or second industry implementation was added.
- [x] Type consistency: `LocalToolRequest`, `LocalToolResponse`, `ExecutionMeta`, status strings, package IDs, versions, digest fields, and tool argument names match across Go and TypeScript tasks.
- [x] Security: no raw SQL, credential, private signing key, or non-allowlisted result field crosses the bridge.
- [x] Placeholder scan: no placeholder markers, cross-task shorthand, or undefined follow-up implementation remains in task steps.
