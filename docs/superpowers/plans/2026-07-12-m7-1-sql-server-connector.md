# M7.1 SQL Server Connector Vertical Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the M7.1 non-production SQL Server vertical so an implementation engineer can create and test a local encrypted Connector, an enterprise admin can approve its public contract, and authorized employees can read and safely update manufacturing records through the existing Agent flow.

**Architecture:** The backend stores only immutable public Tool Contracts and lifecycle state, and resolves published tools from a dynamic catalog on every Agent turn. Electron main owns implementation credentials, signing keys, DPAPI-encrypted packages, Windows Credential Manager secrets, T-SQL validation, SQL Server access, idempotency recovery, and raw test results; the ordinary chat renderer receives only allowlisted results. The existing reverse desktop bridge remains the execution transport, so Skill, OpenFGA record authorization, confirmation, and audit stay in the current flow.

**Tech Stack:** Go 1.25, `modernc.org/sqlite`, Electron 33, React 18, TypeScript 5, `mssql@12.7.0`, `@types/mssql@12.3.0`, `node-sql-parser@5.4.0`, `keytar@7.9.0`, Electron `safeStorage`, Vitest 2, Microsoft SQL Server 2022 CU20 test container.

## Global Constraints

- M7.1 supports Microsoft SQL Server only; HTTP, OAuth, multi-device offline distribution, production identity, production data sources, arbitrary code plugins, and general MCP servers remain out of scope.
- Every source profile has `environment: "test" | "preproduction"`; there is no production value or bypass.
- Cloud records contain public contracts, digests, attestation metadata, lifecycle state, and approval audit only; SQL, schema/table/view names, database addresses, credentials, test inputs, and raw responses never enter backend requests or storage.
- SQL safety uses a T-SQL AST parser at draft validation and immediately before every execution; parse failure is denial, and regex or keyword scanning is never the primary safety boundary.
- Read operations are one `SELECT`, explicit columns, fixed identifiers, at most 100 rows, and a default 10 second timeout.
- Write operations are one single-table `UPDATE` with fixed columns, resource ID plus version concurrency predicates, exactly one affected row, native Windows confirmation, local persistent idempotency, same-transaction read-back, and no automatic write retry.
- `INSERT`, `DELETE`, `MERGE`, `EXEC`, DDL, transaction-control statements, temporary tables, dynamic identifiers, stored procedures, and cross-database references are rejected.
- Installed private payloads are encrypted with Electron `safeStorage` and protected by the target Windows user ACL; service credentials are stored through Windows Credential Manager and are entered in the target employee Windows profile.
- `keytar@7.9.0` is isolated behind `CredentialVault` because it is mature but no longer actively developed; Windows packaging must rebuild the native module, and actual Credential Manager read/write is a release gate so the binding can be replaced without changing Connector logic.
- Raw SQL test responses exist only in the isolated Workbench session and are cleared on result close, draft switch, credential expiry, Workbench close, and application exit.
- A package digest binds the public contract and private implementation. Any SQL, mapping, field, risk, checker version, or read-back change creates a new version and requires a new approval.
- Publication, suspension, and revocation affect the next Agent turn without restarting `agentd` or the Windows application.
- Published SQL tools reuse the existing `local_tool_request` reverse bridge; M7.1 adds no second desktop execution transport.
- Existing Tool IDs and Agent schemas remain `query_order_status(orderId)` and `report_production_progress(orderId, workOrderId, completionRate, expectedVersion, note?)`.
- All implementation follows TDD: observe the named RED failure, add only the scoped implementation, observe GREEN, then make the focused commit.

---

## File And Interface Map

### Backend

- `backend/connectorregistry/types.go`: public contract, attestation, lifecycle, and validation types; contains no local implementation fields.
- `backend/connectorregistry/schema.sql`: immutable Connector version and lifecycle event tables.
- `backend/connectorregistry/store.go`: SQLite persistence and legal state transitions.
- `backend/connectorregistry/attestation.go`: platform implementation credential and device signature verification.
- `backend/connectorregistry/catalog.go`: converts currently published contracts into desktop proxy tools.
- `backend/connector/catalog.go`: concurrency-safe `ToolCatalog` interface plus static/composite implementations.
- `backend/cmd/implementation-credential/main.go`: platform-operator CLI that issues short-lived implementation credentials for one tenant/device/public key.
- `backend/cmd/agentd/connector_handlers.go`: credential-authenticated submission, member-visible approval status, and admin lifecycle endpoints.
- `backend/runtime/llm.go`: takes one catalog snapshot per Agent turn instead of caching startup tools.
- `backend/runtime/audit.go`: adds non-sensitive Connector execution metadata.
- `backend/wire/assemble.go`: opens the registry and composes static and published catalogs.

### Desktop Main Process

- `desktop/src/main/connectors/schema.ts`: exact local package, profile, operation, public contract, and error types.
- `desktop/src/main/connectors/canonical.ts`: deterministic JSON and digest helpers shared by signing and verification.
- `desktop/src/main/connectors/implementation-credential.ts`: verifies platform credential scope, tenant, device, expiry, and signing key.
- `desktop/src/main/connectors/device-identity.ts`: creates and DPAPI-protects the local Ed25519 implementation key.
- `desktop/src/main/connectors/package-store.ts`: validates, signs, encrypts, installs, decrypts, and removes `.ma-connector` versions.
- `desktop/src/main/connectors/credential-vault.ts`: narrow Windows Credential Manager wrapper.
- `desktop/src/main/connectors/sql-policy.ts`: T-SQL AST allowlist and parameter/identifier enforcement.
- `desktop/src/main/connectors/sql-adapter.ts`: SQL Server pool, read execution, transactional write, projection, and error normalization.
- `desktop/src/main/connectors/ledger.ts`: local `pending | succeeded | unknown` write ledger and recovery evidence.
- `desktop/src/main/connectors/runtime.ts`: validates approved package/digest and dispatches published local tools.
- `desktop/src/main/connectors/workbench-service.ts`: implementation session, draft editing/testing, ephemeral raw result, validation, and submission.
- `desktop/src/main/connectors/workbench-window.ts`: isolated BrowserWindow and lifecycle cleanup.

### Desktop Contracts And Renderers

- `desktop/src/shared/connector-contract.ts`: Workbench-only and admin lifecycle IPC request/response types.
- `desktop/src/shared/contract.ts`: adds only the minimal `workbench` entry points to `AgentAPI`; no SQL or secret getter is exposed to ordinary chat code.
- `desktop/src/preload/workbench.ts`: dedicated Workbench preload allowlist.
- `desktop/src/renderer/workbench.html` and `desktop/src/renderer/src/workbench/*`: isolated implementation UI and ephemeral raw result view.
- `desktop/src/renderer/src/components/admin/ConnectorsPane.tsx`: public contract review, publish, suspend, and revoke.
- `desktop/src/renderer/src/components/admin/SkillsPane.tsx`: lists only currently published Connector tools for Skill assignment.

### Test And Acceptance Assets

- `desktop/src/main/connectors/*.test.ts`: package, credential, parser, adapter, ledger, runtime, and data-boundary unit tests.
- `backend/connectorregistry/*_test.go`: store, attestation, catalog, and lifecycle tests.
- `backend/e2e/m7_sqlserver_test.go`: backend-to-desktop contract and immediate revocation acceptance.
- `test/sqlserver/init.sql`: deterministic manufacturing test schema and rows.
- `test/sqlserver/docker-compose.yml`: pinned SQL Server 2022 CU20 non-production fixture.
- `test/sqlserver/generate-tls.sh` and `test/sqlserver/mssql.conf`: local test CA/server certificate generation and SQL Server TLS configuration.
- `docs/acceptance/m7-1-sql-server.md`: repeatable Windows/WSL acceptance record.

### Task 1: Public Connector Registry Store

**Files:**
- Create: `backend/connectorregistry/types.go`
- Create: `backend/connectorregistry/schema.sql`
- Create: `backend/connectorregistry/store.go`
- Create: `backend/connectorregistry/store_test.go`

**Interfaces:**
- Consumes: `connector.ParamSpec`, `connector.RiskLevel`, and `connector.ExecutionDesktop` from `backend/connector/connector.go`.
- Produces: `Open(path string) (*Store, error)`, `(*Store).Submit(context.Context, Submission) error`, `(*Store).List(context.Context, tenant string) ([]Version, error)`, `(*Store).Published(context.Context, tenant string) ([]Version, error)`, `(*Store).Transition(context.Context, Transition) error`, and `(*Store).Close() error`.

- [ ] **Step 1: Write the failing store tests**

```go
func TestStoreKeepsOnlyPublicContractAndImmutableDigest(t *testing.T) {
	store := openTestStore(t)
	v := validSubmittedVersion()
	if err := store.Submit(context.Background(), Submission{Version: v, ActorID: "impl-1"}); err != nil { t.Fatal(err) }
	got, err := store.List(context.Background(), "mock-corp-001")
	if err != nil { t.Fatal(err) }
	if len(got) != 1 || got[0].Digest != v.Digest || got[0].Status != StatusPendingApproval { t.Fatalf("versions=%+v", got) }
	encoded, _ := json.Marshal(got)
	for _, secret := range []string{"SELECT ", "dbo.", "sql.internal", "credentialRef"} {
		if bytes.Contains(encoded, []byte(secret)) { t.Fatalf("public record leaked %q", secret) }
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
	if len(mustPublished(t, store, v.TenantID)) != 1 { t.Fatal("published version missing") }
	requireNoError(t, store.Transition(context.Background(), Transition{TenantID: v.TenantID, ConnectorID: v.ConnectorID, Version: v.Version, Digest: v.Digest, To: StatusSuspended, ActorID: "u_admin"}))
	if len(mustPublished(t, store, v.TenantID)) != 0 { t.Fatal("suspended version remained published") }
	requireNoError(t, store.Transition(context.Background(), Transition{TenantID: v.TenantID, ConnectorID: v.ConnectorID, Version: v.Version, Digest: v.Digest, To: StatusPublished, ActorID: "u_admin"}))
	requireNoError(t, store.Transition(context.Background(), Transition{TenantID: v.TenantID, ConnectorID: v.ConnectorID, Version: v.Version, Digest: v.Digest, To: StatusRevoked, ActorID: "u_admin"}))
	err := store.Transition(context.Background(), Transition{TenantID: v.TenantID, ConnectorID: v.ConnectorID, Version: v.Version, Digest: v.Digest, To: StatusPublished, ActorID: "u_admin"})
	if !errors.Is(err, ErrIllegalTransition) { t.Fatalf("revoked republish error=%v", err) }
}
```

- [ ] **Step 2: Run the tests and observe RED**

Run: `wsl.exe -e bash -lc 'cd /mnt/d/merchantAgent/.worktrees/desktop-local-tools/backend && go test ./connectorregistry -run TestStore -v'`

Expected: FAIL with `package github.com/merchantagent/backend/connectorregistry is not in std` or undefined `Open`, `Submission`, and lifecycle types.

- [ ] **Step 3: Implement the public domain types and schema**

```go
type Status string

const (
	StatusPendingApproval Status = "pending_admin_approval"
	StatusPublished       Status = "published"
	StatusSuspended       Status = "suspended"
	StatusRevoked         Status = "revoked"
)

type ParamContract struct {
	Name, Description string
	Type connector.ParamType
	Required bool
	MinLength, MaxLength, Minimum, Maximum *int
	Enum []any
}
type ToolContract struct {
	Name, Description, ResourceType, ResourceKind, ResourceArg, ResourceRelation, DataDomain string
	Params []ParamContract
	ResultFields []string
	Risk connector.RiskLevel
	RequiresConfirmation bool
	TimeoutMS, MaxResults int
}

type PublicContract struct { Tools []ToolContract }
type CheckSummary struct { CheckerVersion, RulesetVersion, TestsDigest string }
type Version struct {
	TenantID, ConnectorID, Version, Digest, Adapter, Environment string
	Contract PublicContract
	Checks CheckSummary
	ImplementationCredentialID, DeviceID, SubmittedBy, ApprovedBy string
	Status Status
	CreatedAt, UpdatedAt time.Time
}
type Submission struct { Version Version; ActorID string }
type Transition struct { TenantID, ConnectorID, Version, Digest, ActorID string; To Status }
```

Create `connector_versions` with primary key `(tenant_id, connector_id, version)`, JSON columns only for `public_contract_json` and `check_summary_json`, a unique `(tenant_id, connector_id, digest)`, and timestamps. Create append-only `connector_lifecycle_events` with actor, from/to state, digest, and timestamp. `Submit` must validate `adapter == "sqlserver"`, `environment` in `test|preproduction`, digest format `sha256:<64 lowercase hex>`, closed parameter constraints, `read`/`low_write` confirmation consistency, and must reject unknown JSON fields at the HTTP boundary in Task 2. Legal transitions are pending to published/revoked, published to suspended/revoked, and suspended to published/revoked; revoked is terminal.

- [ ] **Step 4: Run the registry tests and package suite**

Run: `wsl.exe -e bash -lc 'cd /mnt/d/merchantAgent/.worktrees/desktop-local-tools/backend && go test ./connectorregistry ./connector -v'`

Expected: PASS for both packages, including immutable digest and illegal transition cases.

- [ ] **Step 5: Commit**

```bash
git add backend/connectorregistry/types.go backend/connectorregistry/schema.sql backend/connectorregistry/store.go backend/connectorregistry/store_test.go
git commit -m "feat: add public connector registry"
```

### Task 2: Implementation Credential And Lifecycle HTTP API

**Files:**
- Create: `backend/connectorregistry/attestation.go`
- Create: `backend/connectorregistry/attestation_test.go`
- Create: `backend/cmd/implementation-credential/main.go`
- Create: `backend/cmd/implementation-credential/main_test.go`
- Create: `backend/cmd/agentd/connector_handlers.go`
- Create: `backend/cmd/agentd/connector_handlers_test.go`
- Modify: `backend/cmd/agentd/main.go`
- Modify: `backend/wire/assemble.go`
- Modify: `backend/wire/integration_test.go`

**Interfaces:**
- Consumes: `connectorregistry.Store` from Task 1 and the existing `requireAdmin` middleware.
- Produces: `CredentialVerifier.Verify(now time.Time, encoded string) (ImplementationClaims, error)`, `VerifySubmission(now time.Time, claims ImplementationClaims, version Version, signedAt time.Time, signature string) error`, `POST /implementation/connectors`, `GET /connectors/{id}/versions/{version}/approval`, `GET /admin/connectors`, `POST /admin/connectors/{id}/versions/{version}/publish`, `.../suspend`, and `.../revoke`.

- [ ] **Step 1: Write failing credential and handler tests**

```go
func TestVerifySubmissionBindsTenantDeviceExpiryAndDigest(t *testing.T) {
	now := time.Date(2026, 7, 12, 10, 0, 0, 0, time.UTC)
	credential, devicePrivate := signedFixtureCredential(t, now, "mock-corp-001", "device-01")
	claims, err := fixtureVerifier(t).Verify(now, credential)
	if err != nil { t.Fatal(err) }
	v := validSubmittedVersion()
	v.DeviceID = "device-01"
	sig := signDigest(t, devicePrivate, v.Digest)
	if err := fixtureVerifier(t).VerifySubmission(now, claims, v, now, sig); err != nil { t.Fatal(err) }
	v.TenantID = "other-tenant"
	if err := fixtureVerifier(t).VerifySubmission(now, claims, v, now, sig); !errors.Is(err, ErrAttestationScope) { t.Fatalf("error=%v", err) }
}

func TestConnectorRoutesSeparateImplementerAndAdminAuthority(t *testing.T) {
	s := connectorTestServer(t)
	publicBody := signedSubmissionBody(t)
	resp := requestJSON(t, s, http.MethodPost, "/implementation/connectors", publicBody, map[string]string{"Authorization": "Implementation "+fixtureCredential(t)})
	if resp.Code != http.StatusCreated { t.Fatalf("submit=%d %s", resp.Code, resp.Body.String()) }
	resp = requestJSON(t, s, http.MethodPost, "/admin/connectors/sql-orders/versions/1.0.0/publish", nil, map[string]string{"X-User-Id": "u_impl1"})
	if resp.Code != http.StatusForbidden { t.Fatalf("implementer publish=%d", resp.Code) }
	resp = requestJSON(t, s, http.MethodPost, "/admin/connectors/sql-orders/versions/1.0.0/publish", nil, map[string]string{"X-User-Id": "u_admin"})
	if resp.Code != http.StatusOK { t.Fatalf("admin publish=%d %s", resp.Code, resp.Body.String()) }
}
```

- [ ] **Step 2: Run the focused tests and observe RED**

Run: `wsl.exe -e bash -lc 'cd /mnt/d/merchantAgent/.worktrees/desktop-local-tools/backend && go test ./connectorregistry ./cmd/agentd ./cmd/implementation-credential -run "TestVerifySubmission|TestConnectorRoutes" -v'`

Expected: FAIL because attestation verifier, issuer command, and Connector routes do not exist.

- [ ] **Step 3: Implement signed implementation credentials and submission attestation**

```go
type ImplementationClaims struct {
	CredentialID string   `json:"credentialId"`
	TenantID     string   `json:"tenantId"`
	DeviceID     string   `json:"deviceId"`
	DeviceKey    string   `json:"devicePublicKeyPem"`
	Scopes       []string `json:"scopes"`
	IssuedAt     int64    `json:"issuedAt"`
	ExpiresAt    int64    `json:"expiresAt"`
}

type CredentialVerifier struct { PlatformPublicKey ed25519.PublicKey }

func (v CredentialVerifier) Verify(now time.Time, encoded string) (ImplementationClaims, error)
func (v CredentialVerifier) VerifySubmission(now time.Time, claims ImplementationClaims, version Version, signedAt time.Time, signature string) error
```

Use canonical JSON payload plus Ed25519 signature in a base64url envelope. Require exactly the scopes `connector:draft`, `connector:test`, and `connector:submit` for submission. The issuer CLI accepts `-tenant`, `-device`, `-device-public-key`, `-expires`, and `-platform-private-key`; it writes the credential to stdout and never writes private key material. Submission signing input is `merchantagent.connector.submit.v1\n<tenant>\n<device>\n<connector>\n<version>\n<digest>\n<signedAt>`. Require `signedAt` inside the credential interval and no more than five minutes in the future.

- [ ] **Step 4: Implement strict HTTP boundaries**

`POST /implementation/connectors` accepts only this body and uses `json.Decoder.DisallowUnknownFields()`:

```go
type submitConnectorRequest struct {
	Version   connectorregistry.Version `json:"version"`
	SignedAt  string                    `json:"signedAt"`
	Signature string                    `json:"implementationSignature"`
}
```

The handler derives the actor, tenant, device, and public key only from the verified credential, overwrites no claim from request data, rejects any contract JSON containing keys outside the public `Version` shape, and never logs the body. The approval-status endpoint authenticates the existing mock tenant member through `X-User-Id` and returns only connector/version/digest/status for that member's tenant. Admin lifecycle handlers use the existing admin middleware, require the URL version and stored digest to match, and append lifecycle events through `Store.Transition`. Add `ConnectorDB string` to `wire.Config`, `Registry *connectorregistry.Store` to `wire.Assembled`, open `DATA_DIR/connectors.db`, close it in `Assembled.Close`, and load the platform verification key from `IMPLEMENTATION_PUBLIC_KEY_FILE`; there is no development fallback key in production code.

- [ ] **Step 5: Run handler, registry, and command tests**

Run: `wsl.exe -e bash -lc 'cd /mnt/d/merchantAgent/.worktrees/desktop-local-tools/backend && go test ./connectorregistry ./cmd/agentd ./cmd/implementation-credential -v'`

Expected: PASS; expired, wrong-device, cross-tenant, unknown-field, implementer-publish, and digest-mismatch tests all fail closed.

- [ ] **Step 6: Commit**

```bash
git add backend/connectorregistry/attestation.go backend/connectorregistry/attestation_test.go backend/cmd/implementation-credential backend/cmd/agentd/connector_handlers.go backend/cmd/agentd/connector_handlers_test.go backend/cmd/agentd/main.go backend/wire/assemble.go backend/wire/integration_test.go
git commit -m "feat: add connector approval lifecycle api"
```

### Task 3: Dynamic Published Tool Catalog

**Files:**
- Create: `backend/connector/catalog.go`
- Create: `backend/connector/catalog_test.go`
- Modify: `backend/connector/connector.go`
- Modify: `backend/connector/validate.go`
- Modify: `backend/connector/validate_test.go`
- Create: `backend/connectorregistry/catalog.go`
- Create: `backend/connectorregistry/catalog_test.go`
- Modify: `backend/runtime/llm.go`
- Modify: `backend/runtime/llm_test.go`
- Modify: `backend/cmd/agentd/admin.go`
- Modify: `backend/wire/assemble.go`
- Modify: `backend/wire/integration_test.go`

**Interfaces:**
- Consumes: `Store.Published`, existing `connector.Tool`, `connector.LocalToolBridge`, and `runtime.LLMAgent`.
- Produces: `connector.ToolCatalog`, `connector.NewStaticCatalog`, `connector.NewCompositeCatalog`, `connectorregistry.NewPublishedCatalog`, and `(*LLMAgent).WithCatalog`.

- [ ] **Step 1: Write the failing immediate-publication tests**

```go
func TestPublishedCatalogChangesWithoutRestart(t *testing.T) {
	ctx := context.Background()
	store := openTestStore(t)
	v := validSubmittedVersion()
	requireNoError(t, store.Submit(ctx, Submission{Version: v, ActorID: "impl-1"}))
	catalog := NewPublishedCatalog(store, v.TenantID)
	if got, _ := catalog.Snapshot(ctx); len(got) != 0 { t.Fatalf("pending tools=%v", got) }
	requireNoError(t, store.Transition(ctx, publishTransition(v)))
	if got, _ := catalog.Snapshot(ctx); got["query_order_status"] == nil { t.Fatal("published tool missing") }
	requireNoError(t, store.Transition(ctx, suspendTransition(v)))
	if got, _ := catalog.Snapshot(ctx); len(got) != 0 { t.Fatalf("suspended tools=%v", got) }
}

func TestAgentSnapshotsToolsForEachTurn(t *testing.T) {
	catalog := &mutableCatalog{}
	agent := NewLLMAgent(fakeProviderFor("query_order_status"), nil, nil, nil, NewAuditLog(), "t").WithCatalog(catalog)
	catalog.set(proxyToolSpec("query_order_status"))
	_, _, err := agent.Ask(context.Background(), principal(), nil, "status", nil)
	if err != nil { t.Fatal(err) }
	catalog.clear()
	_, _, err = agent.Ask(context.Background(), principal(), nil, "status", nil)
	if !errors.Is(err, ErrToolUnavailable) { t.Fatalf("revoked turn error=%v", err) }
}
```

- [ ] **Step 2: Run the catalog/runtime tests and observe RED**

Run: `wsl.exe -e bash -lc 'cd /mnt/d/merchantAgent/.worktrees/desktop-local-tools/backend && go test ./connector ./connectorregistry ./runtime -run "TestPublishedCatalog|TestAgentSnapshots" -v'`

Expected: FAIL with undefined `ToolCatalog`, `NewPublishedCatalog`, and `WithCatalog`.

- [ ] **Step 3: Implement catalog interfaces and the published desktop proxy**

```go
type ToolCatalog interface {
	Snapshot(context.Context) (map[string]Tool, error)
}

func NewStaticCatalog(conns ...Connector) ToolCatalog
func NewCompositeCatalog(catalogs ...ToolCatalog) ToolCatalog

func NewPublishedCatalog(store interface {
	Published(context.Context, string) ([]connectorregistry.Version, error)
}, tenant string) connector.ToolCatalog
```

The published proxy `Spec()` maps only public fields into `connector.ToolSpec` with `ExecutionDesktop`, `PackageID=ConnectorID`, `Version`, and `ManifestDigest=Digest`. Extend `connector.ParamSpec`, `ValidateArgs`, and `toolDef` with the optional constraints below, rejecting contradictory constraints at contract submission:

```go
type ParamSpec struct {
	Name, Description string
	Type ParamType
	Required bool
	MinLength, MaxLength, Minimum, Maximum *int
	Enum []any
}
```

Its `Invoke` builds the existing `LocalToolRequest`, including the approved digest, and calls `LocalToolBridgeFrom(ctx)`. Duplicate tool names inside the published registry are a catalog error. `NewCompositeCatalog` uses explicit later-catalog precedence so the published SQL implementation can replace the M6 reference proxy for the same stable Tool ID without changing the Skill or Agent schema.

- [ ] **Step 4: Make one immutable catalog snapshot govern an Agent turn**

Add `catalog connector.ToolCatalog` to `LLMAgent`. `NewLLMAgent` wraps existing connectors in `NewStaticCatalog`; `WithCatalog` composes static and dynamic sources. At the start of `Ask`, obtain `turnTools, err := a.catalog.Snapshot(ctx)` once, use it for provider tool definitions, guard lookup, dispatch, and `ToolSpec`. A suspend/revoke during a running turn does not mutate that turn, while the next `Ask` observes it.

- [ ] **Step 5: Wire the registry and preserve existing tools**

Use the registry already owned by `wire.Assembled` and compose server/static connectors with `NewPublishedCatalog`. Change `/admin/tools` to read the live catalog so unpublished, suspended, and revoked tools cannot be assigned to Skills.

- [ ] **Step 6: Run runtime and wire suites**

Run: `wsl.exe -e bash -lc 'cd /mnt/d/merchantAgent/.worktrees/desktop-local-tools/backend && go test ./connector ./connectorregistry ./runtime ./wire ./cmd/agentd -v'`

Expected: PASS, including existing static connector precedence and new next-turn publication/revocation behavior.

- [ ] **Step 7: Commit**

```bash
git add backend/connector/catalog.go backend/connector/catalog_test.go backend/connector/connector.go backend/connector/validate.go backend/connector/validate_test.go backend/connectorregistry/catalog.go backend/connectorregistry/catalog_test.go backend/runtime/llm.go backend/runtime/llm_test.go backend/cmd/agentd/admin.go backend/wire/assemble.go backend/wire/integration_test.go
git commit -m "feat: resolve published connectors per agent turn"
```

### Task 4: Local Connector Schema, Device Identity, And DPAPI Package Store

**Files:**
- Create: `desktop/src/main/connectors/schema.ts`
- Create: `desktop/src/main/connectors/canonical.ts`
- Create: `desktop/src/main/connectors/implementation-credential.ts`
- Create: `desktop/src/main/connectors/implementation-credential.test.ts`
- Create: `desktop/src/main/connectors/device-identity.ts`
- Create: `desktop/src/main/connectors/package-store.ts`
- Create: `desktop/src/main/connectors/package-store.test.ts`
- Create: `desktop/resources/implementation/platform-public.pem`
- Modify: `desktop/electron.vite.config.ts`
- Modify: `desktop/package.json`
- Modify: `desktop/package-lock.json`

**Interfaces:**
- Consumes: Electron `safeStorage`, Node Ed25519 crypto, and platform credential format from Task 2.
- Produces: `ConnectorDraft`, `InstalledConnectorEnvelope`, `verifyImplementationCredential`, `DeviceIdentityStore`, and `ConnectorPackageStore`.

- [ ] **Step 1: Pin desktop dependencies**

Run: `npm install --save-exact mssql@12.7.0 node-sql-parser@5.4.0 keytar@7.9.0 && npm install --save-dev --save-exact @types/mssql@12.3.0`

Expected: `package.json` and `package-lock.json` contain exact versions without `^` or `~`. Add `keytar` to `rebuild:electron` and `asarUnpack` beside `better-sqlite3`.

- [ ] **Step 2: Write failing schema, credential, encryption, and tamper tests**

```ts
it("binds an implementation credential to tenant, device, scope, key, and expiry", () => {
  const now = new Date("2026-07-12T10:00:00Z");
  const verified = verifyImplementationCredential(fixtureCredential(), platformPublicKey, now);
  expect(verified.tenantId).toBe("mock-corp-001");
  expect(verified.deviceId).toBe("device-01");
  expect(verified.scopes).toEqual(["connector:draft", "connector:test", "connector:submit"]);
  expect(() => verifyImplementationCredential(expiredFixtureCredential(), platformPublicKey, now)).toThrowError("implementation_credential_expired");
});

it("stores only public manifest plus DPAPI ciphertext and detects payload tampering", () => {
  const safe = fakeSafeStorage();
  const store = new ConnectorPackageStore(tempDir(), safe, fixtureIdentity());
  const installed = store.install(locallyValidatedDraft());
  const disk = readFileSync(installed.path, "utf8");
  expect(disk).not.toContain("SELECT");
  expect(disk).not.toContain("dbo.production_orders");
  expect(disk).toContain('"encryptedPayload"');
  mutateCiphertext(installed.path);
  expect(() => store.loadApproved(installed.ref, installed.manifest.digest)).toThrowError("package_integrity");
});
```

- [ ] **Step 3: Run focused tests and observe RED**

Run: `npm test -- src/main/connectors/implementation-credential.test.ts src/main/connectors/package-store.test.ts`

Expected: FAIL because Connector schema and package services do not exist.

- [ ] **Step 4: Define the exact local schema**

```ts
export type ConnectorEnvironment = "test" | "preproduction";
export type ConnectorState = "draft" | "locally_validated" | "pending_admin_approval" | "published" | "suspended" | "revoked";
export type ConnectorErrorCode = "connector_not_installed" | "package_integrity" | "package_version" | "approval_revoked" | "missing_credentials" | "invalid_credentials" | "connection_failed" | "tls_failed" | "invalid_argument" | "unsafe_template" | "permission_denied" | "record_not_found" | "source_conflict" | "source_rejected" | "failed" | "unknown";

export interface ParameterProperty {
  type: "string" | "integer" | "boolean";
  minLength?: number; maxLength?: number; minimum?: number; maximum?: number; enum?: Array<string | number | boolean>;
}
export interface ParameterSchema {
  type: "object"; properties: Record<string, ParameterProperty>; required: string[]; additionalProperties: false;
}
export interface PublicToolContract {
  name: string; description: string; parameters: ParameterSchema; resultFields: string[];
  resourceType: "business_record"; resourceKind: string; resourceArg: string;
  resourceRelation: "viewer" | "operator"; dataDomain: string;
  risk: "read" | "low_write"; requiresConfirmation: boolean;
  timeoutMS: number; maxResults: number;
}
export interface SQLServerProfile {
  profileId: string; server: string; instance?: string; port?: number; database: string;
  encrypt: true; trustServerCertificate: false; caPath?: string;
  connectTimeoutMS: number; queryTimeoutMS: number; credentialRef: string;
  environment: ConnectorEnvironment;
}
export interface SQLBinding { parameter: string; argument: string; type: "NVarChar" | "Int"; maxLength?: number }
export interface SQLProjection { sourceAlias: string; resultField: string; type: "string" | "integer" }
export interface ProposedField { resultField: string; argument?: string; preserveIfMissing?: boolean }
export interface SQLReadOperation {
  kind: "read"; tool: string; sql: string; bindings: SQLBinding[]; projection: SQLProjection[];
  declaredObjects: string[]; maxResults: number; timeoutMS: number;
}
export interface SQLUpdateOperation {
  kind: "update"; tool: string; beforeSql: string; updateSql: string; readBackSql: string;
  bindings: SQLBinding[]; projection: SQLProjection[]; proposed: ProposedField[];
  declaredObject: string; resourceParameter: string; concurrencyParameter: string;
  updateColumns: string[]; versionField: string; timeoutMS: number;
}
export type SQLOperation = SQLReadOperation | SQLUpdateOperation;
export interface ConnectorDraft {
  draftId: string; tenantId: string; deviceId: string; state: "draft" | "locally_validated";
  payload: ConnectorPrivatePayload;
}
export interface VerifiedImplementationCredential {
  credentialId: string; tenantId: string; deviceId: string; devicePublicKeyPem: string;
  scopes: Array<"connector:draft" | "connector:test" | "connector:submit">;
  issuedAt: string; expiresAt: string;
}
export interface ConnectorPrivatePayload {
  schemaVersion: 1; connectorId: string; version: string; adapter: "sqlserver";
  profile: SQLServerProfile; operations: SQLOperation[];
  publicContract: { tools: PublicToolContract[] };
  checker: { version: string; rulesetVersion: "m7.1-sql-v1"; testsDigest: string };
}
export interface InstalledConnectorEnvelope {
  manifest: { connectorId: string; version: string; adapter: "sqlserver"; environment: ConnectorEnvironment; digest: string; publicContract: { tools: PublicToolContract[] }; checks: { checkerVersion: string; rulesetVersion: "m7.1-sql-v1"; testsDigest: string }; credentialId: string; deviceId: string; signedAt: string };
  encryptedPayload: string; implementationCredential: string; implementationSignature: string;
}
```

- [ ] **Step 5: Implement identity and package invariants**

`DeviceIdentityStore.loadOrCreate()` generates Ed25519 keys, stores only the public key and `safeStorage.encryptString(privateKeyPem)` on disk, and exposes a non-secret enrollment view containing device ID, public key, and SHA-256 fingerprint before credential import. It rejects a credential whose embedded public key differs. `ConnectorPackageStore.install()` canonicalizes the private payload, computes `sha256:<hex>`, signs the Task 2 submission string with `signedAt`, encrypts the canonical payload, writes atomically under `userData/connectors/<connector>/<version>.ma-connector`, and calls an injected `ACLProtector.protect(path)`. The Windows implementation obtains the current SID with `whoami.exe /user /fo csv /nh` and invokes `icacls.exe` with a fixed argument array to remove inherited access and grant only that SID full control; it never invokes a shell. `loadApproved(ref, approvedDigest)` verifies the platform signature, proves `signedAt` fell inside the implementation credential validity interval, verifies device signature, digest, version, environment, and schema, then returns plaintext only to Electron main. Current-time credential expiry locks Workbench editing/testing but does not invalidate a package that was signed, submitted, and approved while the credential was valid. Bundle only the platform public key as an Electron resource; the platform private key remains an operator input to Task 2's issuer CLI.

- [ ] **Step 6: Run tests and typecheck**

Run: `npm test -- src/main/connectors/implementation-credential.test.ts src/main/connectors/package-store.test.ts && npm run typecheck:node`

Expected: PASS; disk leak, signature tamper, wrong device, expiry, digest mismatch, unsafe environment, and malformed schema cases all fail closed.

- [ ] **Step 7: Commit**

```bash
git add desktop/package.json desktop/package-lock.json desktop/electron.vite.config.ts desktop/resources/implementation/platform-public.pem desktop/src/main/connectors/schema.ts desktop/src/main/connectors/canonical.ts desktop/src/main/connectors/implementation-credential.ts desktop/src/main/connectors/implementation-credential.test.ts desktop/src/main/connectors/device-identity.ts desktop/src/main/connectors/package-store.ts desktop/src/main/connectors/package-store.test.ts
git commit -m "feat: add encrypted connector package store"
```

### Task 5: Windows Credential Vault And SQL Server Profiles

**Files:**
- Create: `desktop/src/main/connectors/credential-vault.ts`
- Create: `desktop/src/main/connectors/credential-vault.test.ts`
- Create: `desktop/src/main/connectors/source-profile.ts`
- Create: `desktop/src/main/connectors/source-profile.test.ts`
- Modify: `desktop/src/main/connectors/schema.ts`

**Interfaces:**
- Consumes: `keytar` and `SQLServerProfile` from Task 4.
- Produces: `CredentialVault`, `KeytarCredentialVault`, `validateSQLServerProfile`, and `toMSSQLConfig`.

- [ ] **Step 1: Write failing vault and profile tests**

```ts
it("stores a service credential by opaque ref and never returns it from list", async () => {
  const keytar = fakeKeytar();
  const vault = new KeytarCredentialVault(keytar, "mock-corp-001", "device-01");
  await vault.put("erp-test", { username: "agent_test", password: "S3cret!" });
  expect(await vault.get("erp-test")).toEqual({ username: "agent_test", password: "S3cret!" });
  expect(await vault.listRefs()).toEqual(["erp-test"]);
  expect(JSON.stringify(await vault.listRefs())).not.toContain("S3cret!");
});

it("rejects production-like and weakened TLS profiles", () => {
  expect(() => validateSQLServerProfile({ ...fixtureProfile(), environment: "production" as never })).toThrowError("invalid_argument");
  expect(() => validateSQLServerProfile({ ...fixtureProfile(), encrypt: false as never })).toThrowError("tls_failed");
  expect(() => validateSQLServerProfile({ ...fixtureProfile(), trustServerCertificate: true as never })).toThrowError("tls_failed");
});
```

- [ ] **Step 2: Run focused tests and observe RED**

Run: `npm test -- src/main/connectors/credential-vault.test.ts src/main/connectors/source-profile.test.ts`

Expected: FAIL with missing `KeytarCredentialVault` and profile validation exports.

- [ ] **Step 3: Implement the narrow credential boundary**

```ts
export interface ServiceCredential { username: string; password: string }
export interface CredentialVault {
  put(ref: string, value: ServiceCredential): Promise<void>;
  get(ref: string): Promise<ServiceCredential | null>;
  remove(ref: string): Promise<boolean>;
  listRefs(): Promise<string[]>;
}

export class KeytarCredentialVault implements CredentialVault {
  constructor(private readonly api: Pick<typeof keytar, "setPassword" | "getPassword" | "deletePassword" | "findCredentials">, tenantId: string, deviceId: string)
}
```

Use service name `com.merchantagent.connector/<tenantId>/<deviceId>` and account `credential/<ref>`. Validate refs against `^[a-z0-9][a-z0-9._-]{0,63}$`. Serialize only `{username,password}` into Credential Vault, zero the local Buffer used for decoding after use, never expose `findCredentials()` outside the class, and normalize missing/invalid entries to `missing_credentials`/`invalid_credentials` without driver details.

- [ ] **Step 4: Implement fixed non-production profile mapping**

```ts
export function validateSQLServerProfile(profile: SQLServerProfile): void;
export function toMSSQLConfig(profile: SQLServerProfile, credential: ServiceCredential): mssql.config;
```

Require `encrypt === true`, `trustServerCertificate === false`, database/server fixed non-empty strings, ports 1 through 65535, connect timeout 1000 through 30000 ms, query timeout 1000 through 10000 ms, and `environment` exactly `test` or `preproduction`. Do not build or log a connection string; return structured `mssql.config` with credentials inserted only at pool creation.

- [ ] **Step 5: Run tests and typecheck**

Run: `npm test -- src/main/connectors/credential-vault.test.ts src/main/connectors/source-profile.test.ts && npm run typecheck:node`

Expected: PASS, including malformed Credential Vault JSON and prohibited TLS/environment cases.

- [ ] **Step 6: Commit**

```bash
git add desktop/src/main/connectors/schema.ts desktop/src/main/connectors/credential-vault.ts desktop/src/main/connectors/credential-vault.test.ts desktop/src/main/connectors/source-profile.ts desktop/src/main/connectors/source-profile.test.ts
git commit -m "feat: add local sql credential vault"
```

### Task 6: Restricted T-SQL AST Policy

**Files:**
- Create: `desktop/src/main/connectors/sql-policy.ts`
- Create: `desktop/src/main/connectors/sql-policy.test.ts`
- Create: `desktop/src/main/connectors/sql-policy-corpus.test.ts`
- Modify: `desktop/src/main/connectors/schema.ts`

**Interfaces:**
- Consumes: `node-sql-parser` with `{ database: "TransactSQL" }` and operation schema from Task 4.
- Produces: `validateReadOperation(operation)`, `validateUpdateOperation(operation)`, and `validateOperationBeforeExecution(operation)`.

- [ ] **Step 1: Define exact operation shapes and failing allowlist tests**

```ts
export interface SQLBinding { parameter: string; argument: string; type: "NVarChar" | "Int"; maxLength?: number }
export interface SQLProjection { sourceAlias: string; resultField: string; type: "string" | "integer" }
export interface SQLReadOperation {
  kind: "read"; tool: string; sql: string; bindings: SQLBinding[]; projection: SQLProjection[];
  declaredObjects: string[]; maxResults: number; timeoutMS: number;
}
export interface SQLUpdateOperation {
  kind: "update"; tool: string; beforeSql: string; updateSql: string; readBackSql: string;
  bindings: SQLBinding[]; projection: SQLProjection[]; proposed: ProposedField[]; declaredObject: string;
  resourceParameter: string; concurrencyParameter: string; updateColumns: string[];
  versionField: string; timeoutMS: number;
}

it.each([
  "SELECT * FROM dbo.orders WHERE order_id=@orderId",
  "SELECT order_id FROM otherdb.dbo.orders WHERE order_id=@orderId",
  "SELECT order_id FROM dbo.orders WHERE order_id=@orderId; DELETE FROM dbo.orders",
  "SELECT order_id FROM dbo.orders WHERE order_id IN (SELECT order_id FROM dbo.secret)",
  "EXEC dbo.read_order @orderId",
  "SELECT order_id FROM OPENROWSET('SQLNCLI','x','SELECT 1')",
])("rejects unsafe read SQL: %s", (sql) => {
  expect(() => validateReadOperation({ ...fixtureReadOperation(), sql })).toThrowError("unsafe_template");
});
```

- [ ] **Step 2: Run parser tests and observe RED**

Run: `npm test -- src/main/connectors/sql-policy.test.ts src/main/connectors/sql-policy-corpus.test.ts`

Expected: FAIL because policy validators do not exist.

- [ ] **Step 3: Implement AST validation with deny-by-default traversal**

```ts
export interface ValidatedSQL { normalizedSQL: string; parameterNames: ReadonlySet<string>; resultAliases: ReadonlySet<string> }
export function validateReadOperation(operation: SQLReadOperation): ValidatedSQL;
export function validateUpdateOperation(operation: SQLUpdateOperation): { before: ValidatedSQL; update: ValidatedSQL; readBack: ValidatedSQL };
export function validateOperationBeforeExecution(operation: SQLOperation): void;
```

Parse exactly one AST statement using `parser.astify(sql, { database: "TransactSQL" })`. For reads, accept only `select`, explicit expression aliases, declared tables/views, declared joins, parameterized predicates, and fixed order clauses; reject AST nodes or properties outside the ruleset, including `star`, `union`, `with`, `into`, `limit` controlled by input, subqueries, variables used as identifiers, three-part names, functions that perform external/file access, and comments containing parser directives. For updates, accept only one `update` node for `declaredObject`, assignments whose columns equal `updateColumns`, and a conjunction containing equality predicates for both `resourceParameter` and `concurrencyParameter`; reject output clauses and affected-table ambiguity. Compare parser-discovered parameters and result aliases exactly with bindings/projection.

- [ ] **Step 4: Add a fixed attack corpus**

The corpus must include at least 60 explicit cases across stacked statements, comments, quoted identifiers, Unicode whitespace, nested queries, CTEs, `OPENROWSET`, `OPENDATASOURCE`, `OPENQUERY`, `BULK`, `xp_cmdshell`, `sp_executesql`, `WAITFOR`, `USE`, `DECLARE`, `SET`, temp tables, table variables, cross-database names, `SELECT *`, `UPDATE` without resource/version, multiple tables, and parser failures. Each case names its expected `unsafe_template` reason, and every accepted fixture is re-parsed by `validateOperationBeforeExecution`.

- [ ] **Step 5: Run parser suite and typecheck**

Run: `npm test -- src/main/connectors/sql-policy.test.ts src/main/connectors/sql-policy-corpus.test.ts && npm run typecheck:node`

Expected: PASS with all accepted templates parsed as T-SQL and all attack cases denied.

- [ ] **Step 6: Commit**

```bash
git add desktop/src/main/connectors/schema.ts desktop/src/main/connectors/sql-policy.ts desktop/src/main/connectors/sql-policy.test.ts desktop/src/main/connectors/sql-policy-corpus.test.ts
git commit -m "feat: enforce restricted tsql policy"
```

### Task 7: SQL Server Read Adapter

**Files:**
- Create: `desktop/src/main/connectors/sql-adapter.ts`
- Create: `desktop/src/main/connectors/sql-adapter.test.ts`
- Create: `test/sqlserver/init.sql`
- Create: `test/sqlserver/docker-compose.yml`
- Create: `test/sqlserver/generate-tls.sh`
- Create: `test/sqlserver/mssql.conf`

**Interfaces:**
- Consumes: `CredentialVault`, `toMSSQLConfig`, `validateReadOperation`, `mssql.ConnectionPool`, and `SQLReadOperation`.
- Produces: `SQLServerAdapter.testConnection()`, `SQLServerAdapter.executeRead()`, and the reusable test SQL Server fixture.

- [ ] **Step 1: Add deterministic SQL Server fixture and failing adapter tests**

`test/sqlserver/docker-compose.yml` uses `mcr.microsoft.com/mssql/server:2022-CU20-ubuntu-22.04` for both the database and one-shot initializer, binds only `127.0.0.1:11433`, sets `MSSQL_PID=Developer`, waits on `/opt/mssql-tools18/bin/sqlcmd`, then runs `test/sqlserver/init.sql`. `generate-tls.sh` creates a local test CA and a server certificate with SANs `localhost` and `127.0.0.1`; `mssql.conf` mounts that certificate/key into SQL Server, and the test profile trusts only the generated CA with `trustServerCertificate=false`. The schema contains `dbo.production_orders(order_id, work_order_id, status, promise_date, completion_rate, note, version)` and rows `ORD-1001` and `ORD-1002`; it grants the test service account `SELECT` plus `UPDATE(completion_rate,note,version)` only.

```ts
it("binds values, caps rows, and returns only declared aliases", async () => {
  const adapter = adapterWithFakePool([{ orderId: "ORD-1001", status: "in_production", secret_cost: 900 }]);
  const result = await adapter.executeRead(fixtureReadOperation(), { orderId: "ORD-1001" });
  expect(result).toEqual([{ orderId: "ORD-1001", status: "in_production" }]);
  expect(fakeRequest.input).toHaveBeenCalledWith("orderId", expect.anything(), "ORD-1001");
  expect(fakeRequest.query).toHaveBeenCalledWith(expect.stringContaining("SELECT"));
  expect(JSON.stringify(result)).not.toContain("secret_cost");
});

it("normalizes driver failures without leaking source details", async () => {
  const adapter = adapterRejecting(new Error("Login failed for sql.internal; password=S3cret"));
  await expect(adapter.executeRead(fixtureReadOperation(), { orderId: "ORD-1001" })).rejects.toMatchObject({ code: "invalid_credentials", message: "invalid_credentials" });
});
```

- [ ] **Step 2: Run focused tests and observe RED**

Run: `npm test -- src/main/connectors/sql-adapter.test.ts`

Expected: FAIL because `SQLServerAdapter` does not exist.

- [ ] **Step 3: Implement structured parameter binding and allowlisted projection**

```ts
export interface SQLPoolFactory { open(config: mssql.config): Promise<mssql.ConnectionPool> }
export class SQLServerAdapter {
  constructor(private readonly profile: SQLServerProfile, private readonly vault: CredentialVault, private readonly pools: SQLPoolFactory) {}
  testConnection(signal?: AbortSignal): Promise<{ environment: ConnectorEnvironment; latencyMS: number }>;
  executeRead(operation: SQLReadOperation, args: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>[]>;
}
```

Resolve the credential only immediately before pool creation, bind every argument through `Request.input`, set `requestTimeout` to the smaller of operation/profile timeout, set `TOP (@__maxResults)` through an internal integer parameter or reject templates that cannot be deterministically capped, accept no more than 100 rows, project only declared aliases, and close pools in `finally`. Retry a read once only for normalized transient connection errors. Error objects expose only the unified Connector error code.

- [ ] **Step 4: Run unit tests and real fixture smoke test**

Run: `wsl.exe -e bash -lc 'cd /mnt/d/merchantAgent/.worktrees/desktop-local-tools/test/sqlserver && ./generate-tls.sh && docker compose up -d --wait'`

Expected: SQL Server fixture reports healthy on `127.0.0.1:11433`.

Run: `$env:M7_SQLSERVER_TEST='1'; npm test -- src/main/connectors/sql-adapter.test.ts`

Expected: PASS for fake-pool security tests and real `ORD-1001` query; returned JSON has no undeclared fields.

- [ ] **Step 5: Commit**

```bash
git add desktop/src/main/connectors/sql-adapter.ts desktop/src/main/connectors/sql-adapter.test.ts test/sqlserver/init.sql test/sqlserver/docker-compose.yml test/sqlserver/generate-tls.sh test/sqlserver/mssql.conf
git commit -m "feat: add sql server read adapter"
```

### Task 8: Transactional Low-Risk Update, Ledger, And Unknown Recovery

**Files:**
- Create: `desktop/src/main/connectors/ledger.ts`
- Create: `desktop/src/main/connectors/ledger.test.ts`
- Modify: `desktop/src/main/connectors/sql-adapter.ts`
- Create: `desktop/src/main/connectors/sql-write.test.ts`
- Modify: `desktop/src/main/local-tools/executor.ts`
- Modify: `desktop/src/main/local-tools/executor.test.ts`

**Interfaces:**
- Consumes: existing `Confirm`, `ExecutionMeta`, `better-sqlite3`, SQL update policy, and SQL Server adapter from Task 7.
- Produces: `ExecutionLedger.begin`, `markSucceeded`, `markUnknown`, `get`, `SQLServerAdapter.previewUpdate`, `executeConfirmedUpdate`, and `recoverUnknown`.

- [ ] **Step 1: Write failing replay, conflict, transaction, and crash-window tests**

```ts
it("replays same key and rejects a changed fingerprint", () => {
  const ledger = openLedger();
  const first = ledger.begin({ idempotencyKey: "k1", fingerprint: "f1", connectorId: "sql-orders", version: "1.0.0", tool: "report_production_progress", before: { version: 4 }, proposed: { completionRate: 60 } });
  expect(first.kind).toBe("created");
  ledger.markSucceeded("k1", { orderId: "ORD-1001", completionRate: 60, version: 5 });
  expect(ledger.begin({ ...firstInput(), idempotencyKey: "k1", fingerprint: "f1" }).kind).toBe("replay");
  expect(() => ledger.begin({ ...firstInput(), idempotencyKey: "k1", fingerprint: "changed" })).toThrowError("source_conflict");
});

it("marks unknown after source commit and never repeats UPDATE", async () => {
  const fixture = sqlWriteFixture({ failAfterSourceCommit: true });
  await expect(fixture.adapter.executeConfirmedUpdate(fixture.operation, fixture.args, "k-crash", fixture.preview)).rejects.toMatchObject({ code: "unknown" });
  expect(fixture.updateCalls()).toBe(1);
  const recovered = await fixture.adapter.recoverUnknown(fixture.operation, fixture.args, "k-crash");
  expect(recovered).toMatchObject({ completionRate: 60, version: 5 });
  expect(fixture.updateCalls()).toBe(1);
});
```

- [ ] **Step 2: Run write tests and observe RED**

Run: `npm test -- src/main/connectors/ledger.test.ts src/main/connectors/sql-write.test.ts src/main/local-tools/executor.test.ts`

Expected: FAIL because persistent ledger and SQL write methods do not exist.

- [ ] **Step 3: Implement the persistent local ledger**

```ts
export type LedgerStatus = "pending" | "succeeded" | "unknown";
export interface LedgerInput { idempotencyKey: string; fingerprint: string; connectorId: string; version: string; tool: string; before: Record<string, unknown>; proposed: Record<string, unknown> }
export interface LedgerEntry extends LedgerInput { status: LedgerStatus; allowlistedReadBack?: Record<string, unknown>; createdAt: string; updatedAt: string }
export type BeginResult = { kind: "created"; entry: LedgerEntry } | { kind: "replay"; entry: LedgerEntry } | { kind: "recover"; entry: LedgerEntry };
export class ExecutionLedger {
  begin(input: LedgerInput): BeginResult;
  markSucceeded(key: string, allowlistedReadBack: Record<string, unknown>): void;
  markUnknown(key: string): void;
  get(key: string): LedgerEntry | null;
  close(): void;
}
```

Store canonical request fingerprint, connector/version/tool, allowlisted before/proposed/read-back, status, and timestamps in `userData/connectors/executions.db`. Use a unique idempotency key, immediate local transaction, and strict JSON decoding. Never store SQL, source profile values, credential refs, raw rows, or driver errors.

- [ ] **Step 4: Implement source transaction and recovery semantics**

```ts
export interface UpdatePreview { before: Record<string, unknown>; proposed: Record<string, unknown> }
previewUpdate(operation: SQLUpdateOperation, args: Record<string, unknown>): Promise<UpdatePreview>;
executeConfirmedUpdate(operation: SQLUpdateOperation, args: Record<string, unknown>, idempotencyKey: string, preview: UpdatePreview): Promise<Record<string, unknown>>;
recoverUnknown(operation: SQLUpdateOperation, args: Record<string, unknown>, idempotencyKey: string): Promise<Record<string, unknown>>;
```

`executeConfirmedUpdate` persists local `pending`, opens one SQL Server transaction, runs fixed `beforeSql`, checks it still equals the confirmed before/version, executes absolute-value `updateSql`, requires `rowsAffected == [1]`, runs fixed `readBackSql`, verifies proposed fields and version increment, commits the source transaction, then marks local success. Any failure before source commit rolls back and returns `source_conflict`, `source_rejected`, or `failed`; a failure after a possibly successful commit calls `markUnknown` and returns `unknown`. `recoverUnknown` executes only `readBackSql`; matching proposed/version marks success, a proven unchanged before returns `source_conflict`, and inconclusive evidence stays `unknown`. It never calls UPDATE.

- [ ] **Step 5: Route the existing local executor through the SQL runtime**

Keep the native confirmation before `executeConfirmedUpdate`. Freeze request identity, arguments, before, and proposed exactly as the current reference executor does. Map `pending/succeeded/unknown`, confirmation time, before/after, and idempotency key into the existing `LocalToolResponse`; do not remove the reference SQLite path until the SQL vertical passes acceptance.

- [ ] **Step 6: Run unit and real SQL write suites**

Run: `$env:M7_SQLSERVER_TEST='1'; npm test -- src/main/connectors/ledger.test.ts src/main/connectors/sql-write.test.ts src/main/local-tools/executor.test.ts`

Expected: PASS for preview/cancel/confirm, one-row update, version conflict, multi-row denial, same-key replay, changed-fingerprint conflict, source rejection, post-commit unknown, and read-back-first recovery.

- [ ] **Step 7: Commit**

```bash
git add desktop/src/main/connectors/ledger.ts desktop/src/main/connectors/ledger.test.ts desktop/src/main/connectors/sql-adapter.ts desktop/src/main/connectors/sql-write.test.ts desktop/src/main/local-tools/executor.ts desktop/src/main/local-tools/executor.test.ts
git commit -m "feat: add idempotent sql server updates"
```

### Task 9: Connector Runtime And Isolated Workbench IPC

**Files:**
- Create: `desktop/src/main/connectors/runtime.ts`
- Create: `desktop/src/main/connectors/runtime.test.ts`
- Create: `desktop/src/main/connectors/workbench-service.ts`
- Create: `desktop/src/main/connectors/workbench-service.test.ts`
- Create: `desktop/src/main/connectors/workbench-window.ts`
- Create: `desktop/src/shared/connector-contract.ts`
- Modify: `desktop/src/shared/contract.ts`
- Modify: `desktop/src/main/ipc.ts`
- Modify: `desktop/src/main/agentd.ts`
- Modify: `desktop/src/main/startup.ts`
- Modify: `desktop/src/main/index.ts`
- Create: `desktop/src/preload/workbench.ts`
- Modify: `desktop/electron.vite.config.ts`

**Interfaces:**
- Consumes: tasks 4 through 8, existing local tool request handler, existing `agentd` admin proxy, and Electron BrowserWindow.
- Produces: `ConnectorRuntime.execute`, `WorkbenchService`, dedicated Workbench IPC channels, and a locked-down Workbench window.

- [ ] **Step 1: Write failing Gate C and raw-result boundary tests**

```ts
it("denies before opening SQL when approval or installed digest differs", async () => {
  const runtime = runtimeFixture({ approvedDigest: "sha256:" + "a".repeat(64), installedDigest: "sha256:" + "b".repeat(64) });
  const result = await runtime.execute(localRequest(), confirmYes);
  expect(result.error).toBe("package_version");
  expect(runtime.sqlOpenCalls()).toBe(0);
});

it("keeps raw test rows only in the active workbench session", async () => {
  const service = workbenchFixture();
  const session = await service.unlock(fixtureCredential());
  const result = await service.testOperation(session.id, draftId, sampleArgs);
  expect(result.raw).toEqual([{ order_id: "ORD-1001", internal_cost: 900 }]);
  service.closeResult(session.id, result.resultId);
  expect(() => service.readResult(session.id, result.resultId)).toThrowError("workbench_result_expired");
  expect(service.persistedText()).not.toContain("internal_cost");
});
```

- [ ] **Step 2: Run focused tests and observe RED**

Run: `npm test -- src/main/connectors/runtime.test.ts src/main/connectors/workbench-service.test.ts src/main/ipc.localtools.test.ts`

Expected: FAIL because runtime, Workbench service, and isolated channels do not exist.

- [ ] **Step 3: Implement Gate C runtime**

```ts
export interface ApprovalResolver { getApproval(tenantId: string, userId: string, connectorId: string, version: string): Promise<{ digest: string; status: "published" | "suspended" | "revoked" } | null> }
export class ConnectorRuntime {
  execute(request: LocalToolRequest, confirm: Confirm): Promise<LocalToolResponse>;
  close(): Promise<void>;
}
```

Execution order is approval status/digest, installed package signature/digest, device and implementation chain, tool contract match, argument schema, fresh T-SQL AST check, credential existence, then data source. Every denial before the final step records zero pool opens. Suspended/revoked return `approval_revoked`; missing package returns `connector_not_installed`; all errors remain normalized and secret-free.

- [ ] **Step 4: Implement Workbench sessions and strict IPC contracts**

```ts
export interface WorkbenchSessionView { sessionId: string; tenantId: string; deviceId: string; expiresAt: string; scopes: string[] }
export interface ConnectionTestView { environment: ConnectorEnvironment; latencyMS: number }
export interface WorkbenchTestResult { resultId: string; raw: unknown; projected: Record<string, unknown> | Record<string, unknown>[]; expiresAt: string }
export interface ValidationSummary { digest: string; checkerVersion: string; rulesetVersion: "m7.1-sql-v1"; testsDigest: string; publicContract: { tools: PublicToolContract[] } }
export class WorkbenchService {
  getEnrollment(): Promise<{ deviceId: string; devicePublicKeyPem: string; fingerprint: string }>;
  unlock(encodedCredential: string): Promise<WorkbenchSessionView>;
  saveDraft(sessionId: string, draft: ConnectorDraft): Promise<{ draftId: string }>;
  testConnection(sessionId: string, draftId: string): Promise<ConnectionTestView>;
  testOperation(sessionId: string, draftId: string, args: Record<string, unknown>): Promise<WorkbenchTestResult>;
  closeResult(sessionId: string, resultId: string): void;
  validateAndFreeze(sessionId: string, draftId: string): Promise<ValidationSummary>;
  submit(sessionId: string, draftId: string): Promise<{ digest: string; status: "pending_admin_approval" }>;
  lock(sessionId: string): void;
}
```

The ordinary `AgentAPI` exposes only `openWorkbench(): Promise<void>`. Before unlock, the dedicated Workbench preload can read only the non-secret enrollment view needed by the platform operator to issue a credential. After unlock it exposes typed commands for draft/profile/credential writes, tests, result close, freeze, and submit. It never exposes filesystem, Node, generic IPC, package decryption, credential reads, private keys, or signing methods. All handlers validate session ID, tenant, device, expiry, scope, draft ownership, and closed schemas.

- [ ] **Step 5: Create an isolated window and cleanup triggers**

Use a distinct Vite entry and BrowserWindow with `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, dedicated preload, no shared session partition, no DevTools in packaged builds, navigation denied, and popup creation denied. On close, renderer crash, credential expiry, draft switch, and app shutdown call `WorkbenchService.lock`, clear raw result Maps, dispose pools, and release plaintext payload references.

- [ ] **Step 6: Integrate startup without weakening the existing reference path**

`initializeDesktop` creates package store, vault, ledger, Connector runtime, and Workbench service after `app.whenReady()`, registers the published Connector executor alongside the reference executor, and closes every owned resource in reverse order. Startup tests must prove partial construction still cleans up all earlier resources.

- [ ] **Step 7: Run IPC, runtime, startup, and type suites**

Run: `npm test -- src/main/connectors/runtime.test.ts src/main/connectors/workbench-service.test.ts src/main/ipc.localtools.test.ts src/main/startup.test.ts && npm run typecheck`

Expected: PASS; ordinary renderer API has no raw response, credential retrieval, SQL, decrypt, or signing method.

- [ ] **Step 8: Commit**

```bash
git add desktop/src/main/connectors/runtime.ts desktop/src/main/connectors/runtime.test.ts desktop/src/main/connectors/workbench-service.ts desktop/src/main/connectors/workbench-service.test.ts desktop/src/main/connectors/workbench-window.ts desktop/src/shared/connector-contract.ts desktop/src/shared/contract.ts desktop/src/main/ipc.ts desktop/src/main/agentd.ts desktop/src/main/startup.ts desktop/src/main/index.ts desktop/src/preload/workbench.ts desktop/electron.vite.config.ts
git commit -m "feat: add isolated connector workbench runtime"
```

### Task 10: Workbench And Admin Lifecycle UI

**Files:**
- Create: `desktop/src/renderer/workbench.html`
- Create: `desktop/src/renderer/src/workbench/main.tsx`
- Create: `desktop/src/renderer/src/workbench/WorkbenchApp.tsx`
- Create: `desktop/src/renderer/src/workbench/workbench.css`
- Create: `desktop/src/renderer/src/workbench/WorkbenchApp.test.tsx`
- Create: `desktop/src/renderer/src/components/admin/ConnectorsPane.tsx`
- Create: `desktop/src/renderer/src/components/admin/ConnectorsPane.test.tsx`
- Modify: `desktop/src/renderer/src/components/admin/AdminView.tsx`
- Modify: `desktop/src/renderer/src/components/admin/SkillsPane.tsx`
- Modify: `desktop/src/renderer/src/components/admin/SkillsPane.test.tsx`
- Modify: `desktop/src/renderer/src/admin.ts`
- Modify: `desktop/src/renderer/src/App.tsx`
- Modify: `desktop/src/renderer/src/components/TopBar.tsx`
- Modify: `desktop/src/renderer/src/app.css`

**Interfaces:**
- Consumes: Workbench IPC from Task 9 and backend lifecycle endpoints from Task 2.
- Produces: implementation workflow UI, public-only admin review, immediate lifecycle controls, and published-tool-only Skill assignment.

- [ ] **Step 1: Write failing role-boundary and workflow UI tests**

```tsx
it("shows SQL only in Workbench and clears raw results when closed", async () => {
  render(<WorkbenchApp api={workbenchAPI()} />);
  await user.click(screen.getByRole("button", { name: "运行测试" }));
  expect(await screen.findByText("SELECT order_id FROM dbo.production_orders")).toBeVisible();
  expect(screen.getByText("internal_cost")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "关闭测试结果" }));
  expect(screen.queryByText("internal_cost")).toBeNull();
  expect(workbenchAPI().closeResult).toHaveBeenCalled();
});

it("admin reviews public fields but never local implementation", async () => {
  render(<ConnectorsPane client={adminClientWithPendingContract()} />);
  expect(await screen.findByText("query_order_status")).toBeVisible();
  expect(screen.getByText("sha256:approved-digest")).toBeVisible();
  for (const secret of ["SELECT", "dbo.", "sql.internal", "credentialRef"]) {
    expect(screen.queryByText(new RegExp(secret, "i"))).toBeNull();
  }
});
```

- [ ] **Step 2: Run UI tests and observe RED**

Run: `npm test -- src/renderer/src/workbench/WorkbenchApp.test.tsx src/renderer/src/components/admin/ConnectorsPane.test.tsx src/renderer/src/components/admin/SkillsPane.test.tsx`

Expected: FAIL because Workbench and Connector lifecycle components do not exist.

- [ ] **Step 3: Implement the Workbench flow**

Build compact steps for credential unlock, SQL Server profile, credential entry, operation editor, local tests, validation summary, and submission. Use tabs for profile/operations/tests, password inputs for credential write-only entry, segmented test/preproduction control, fixed numeric inputs for timeouts/result limits, code editor textarea only in the isolated window, and a persistent non-production banner. Write previews show resource, environment, before, and proposed values before invoking the existing native confirmation. Raw test rows render only inside the test panel and call `closeResult` on panel close, draft selection change, window unload, and session expiry.

- [ ] **Step 4: Implement admin review and lifecycle controls**

Extend `makeAdminClient` with:

```ts
export interface ConnectorVersionView {
  tenantId: string; connectorId: string; version: string; digest: string; adapter: "sqlserver";
  environment: "test" | "preproduction"; status: "pending_admin_approval" | "published" | "suspended" | "revoked";
  checks: { checkerVersion: string; rulesetVersion: string; testsDigest: string };
  contract: { tools: PublicToolContract[] }; submittedBy: string; approvedBy?: string;
}
listConnectors: () => call<ConnectorVersionView[]>("GET", "/admin/connectors"),
publishConnector: (id: string, version: string) => call<void>("POST", `/admin/connectors/${id}/versions/${version}/publish`),
suspendConnector: (id: string, version: string) => call<void>("POST", `/admin/connectors/${id}/versions/${version}/suspend`),
revokeConnector: (id: string, version: string) => call<void>("POST", `/admin/connectors/${id}/versions/${version}/revoke`),
```

The admin pane displays connector/version/digest, adapter, non-production environment, check versions/digest, Tool parameters, result fields, resource relation, data domain, risk, and confirmation requirement. Publish is available for pending approval, resume is available for suspended by calling the publish transition, suspend is available only for published, and revoke is available for published/suspended with destructive confirmation. It has no SQL, database, profile, credential, raw result, or edit controls.

- [ ] **Step 5: Keep Skill assignment synchronized with current publication**

After any lifecycle action, invalidate `listTools` and `listConnectors`; `SkillsPane` can select only tools returned by the live `/admin/tools`. If an existing Skill references a now suspended/revoked tool, display it as unavailable and prevent saving a newly added unavailable reference without silently deleting the historical Skill configuration.

- [ ] **Step 6: Run UI, responsive, and type tests**

Run: `npm test -- src/renderer/src/workbench/WorkbenchApp.test.tsx src/renderer/src/components/admin/ConnectorsPane.test.tsx src/renderer/src/components/admin/SkillsPane.test.tsx src/renderer/src/responsive.test.ts && npm run typecheck`

Expected: PASS at desktop and narrow-window fixtures with no overlap or horizontal overflow, and no local implementation fields in admin/chat snapshots.

- [ ] **Step 7: Commit**

```bash
git add desktop/src/renderer/workbench.html desktop/src/renderer/src/workbench desktop/src/renderer/src/components/admin/ConnectorsPane.tsx desktop/src/renderer/src/components/admin/ConnectorsPane.test.tsx desktop/src/renderer/src/components/admin/AdminView.tsx desktop/src/renderer/src/components/admin/SkillsPane.tsx desktop/src/renderer/src/components/admin/SkillsPane.test.tsx desktop/src/renderer/src/admin.ts desktop/src/renderer/src/App.tsx desktop/src/renderer/src/components/TopBar.tsx desktop/src/renderer/src/app.css
git commit -m "feat: add connector workbench and approval ui"
```

### Task 11: M7.1 Vertical Acceptance, Audit, Leak Scan, And Runbook

**Files:**
- Create: `backend/e2e/m7_sqlserver_test.go`
- Modify: `backend/runtime/audit.go`
- Modify: `backend/runtime/audit_immutability_test.go`
- Modify: `backend/connector/localtool.go`
- Modify: `desktop/src/shared/contract.ts`
- Create: `desktop/src/main/connectors/security-boundary.test.ts`
- Create: `docs/acceptance/m7-1-sql-server.md`
- Modify: `backend/README.md`
- Modify: `desktop/README.md`

**Interfaces:**
- Consumes: all prior tasks plus the existing OpenFGA role/record rules, local reverse bridge, Skill registry, and native confirmation.
- Produces: non-sensitive Connector audit metadata, executable acceptance commands, and evidence that M7.1 meets the approved vertical scope.

- [ ] **Step 1: Write the failing end-to-end and leak-boundary tests**

```go
func TestM71SQLServerVertical(t *testing.T) {
	h := newM71Harness(t)
	h.SubmitAndPublishSQLConnector("sql-orders", "1.0.0")
	h.As("u_sales1").Query("ORD-1001").ExpectFields("orderId", "workOrderId", "status", "promiseDate", "completionRate", "note", "version").RejectField("cost")
	h.As("u_sales1").ReportProgress("ORD-1001", 60, 4).ExpectDeniedBeforeDesktop()
	h.As("u_prod1").ReportProgress("ORD-1001", 60, 4).Confirm().ExpectSucceededVersion(5)
	h.As("u_sales1").Query("ORD-1001").ExpectCompletionRate(60)
	h.Suspend("sql-orders", "1.0.0")
	h.As("u_sales1").Query("ORD-1001").ExpectApprovalRevokedWithoutRestart()
	h.ExpectAuditChainValidAndSecretFree()
}
```

```ts
it("finds no secret material in cloud payloads, logs, audit, chat IPC, or diagnostic views", async () => {
  const evidence = await runM71BoundaryScenario();
  for (const surface of [evidence.submissionBody, evidence.agentdLogs, evidence.auditJSON, evidence.chatEvents, evidence.diagnosticJSON]) {
    expect(surface).not.toMatch(/SELECT|UPDATE|dbo\.|sql\.internal|S3cret|credentialRef|internal_cost/i);
  }
  expect(evidence.workbenchRawDuringTest).toContain("internal_cost");
  expect(evidence.workbenchRawAfterClose).toBe("");
});
```

- [ ] **Step 2: Run acceptance tests and observe RED**

Run: `wsl.exe -e bash -lc 'cd /mnt/d/merchantAgent/.worktrees/desktop-local-tools/backend && M7_SQLSERVER_TEST=1 go test ./e2e -run TestM71SQLServerVertical -v'`

Run: `npm test -- src/main/connectors/security-boundary.test.ts`

Expected: FAIL until Connector audit fields, harness glue, and leak scanner are connected.

- [ ] **Step 3: Extend audit with public Connector execution metadata**

```go
type ConnectorAudit struct {
	ConnectorID, Version, Digest, Adapter, SourceProfileID, Environment, DeviceID string
	ResourceKind, ResourceID, ResourceRelation, ApprovalVersion string
	IdempotencyKeyID, RequestFingerprintID, ExecutionStatus, ReadBackStatus string
	DurationMS int64
	Before, After map[string]any
}
```

Extend `connector.ExecutionMeta` and the shared desktop counterpart with only `SourceProfileID`, `Environment`, `ReadBackStatus`, and `DurationMS`. The backend derives connector ID, package version/digest, adapter, Tool, resource, relation, role, and device from its own ToolSpec/invocation rather than trusting duplicate desktop values. Attach only allowlisted before/after and one-way identifiers for idempotency key and request fingerprint. Preserve the existing hash chain. Add an audit serialization test that rejects database address, SQL, credential values/refs, raw request/response, and undeclared result fields.

- [ ] **Step 4: Complete the backend vertical harness and Windows integration path**

The Go harness starts OpenFGA and the existing mock org/backend in WSL and uses a deterministic desktop bridge emulator to prove submission, approval, Gate A/B, stable Tool contracts, audit, and next-turn suspension without pretending that WSL can exercise DPAPI or Credential Manager. The TypeScript integration tests use the real SQL Server fixture on `127.0.0.1:11433` for parameter binding, TLS, read, transactional write, replay, conflict, and unknown recovery. The Windows runbook in Step 5 joins both halves through the packaged Electron app and is the required evidence for DPAPI, Credential Manager, native confirmation, and raw-result isolation.

- [ ] **Step 5: Write the Windows/WSL runbook**

Document exact prerequisites, test-only service account grants, platform/device key generation, implementation credential issuance, Workbench configuration for both fixed Tool Contracts, local validation checks, admin approval, employee read/write flow, suspend/revoke test, credential removal, SQL fixture teardown, and evidence table. Include explicit warnings that M7.1 is non-production and that local administrators can access target-user secrets.

- [ ] **Step 6: Run the complete automated gate**

Run: `wsl.exe -e bash -lc 'cd /mnt/d/merchantAgent/.worktrees/desktop-local-tools/backend && go test ./...'`

Expected: PASS for all backend packages.

Run: `npm test && npm run typecheck && npm run build`

Expected: PASS for all desktop tests, both TypeScript projects, and Electron production build.

Run: `$env:M7_SQLSERVER_TEST='1'; npm test -- src/main/connectors/sql-adapter.test.ts src/main/connectors/sql-write.test.ts src/main/connectors/security-boundary.test.ts`

Expected: PASS against the pinned SQL Server fixture.

- [ ] **Step 7: Perform Windows visual and security acceptance**

Start the WSL backend and SQL Server fixture, launch the new Windows executable, and execute `docs/acceptance/m7-1-sql-server.md`. Capture desktop and 900x700 Workbench/admin screenshots, verify no overlap or horizontal overflow, inspect Windows Credential Manager entries, restart the app to prove package/credential/ledger persistence, and verify raw results are unrecoverable after close. Record date, commit, tester, SQL fixture image, and PASS/FAIL for every row in the runbook.

- [ ] **Step 8: Commit**

```bash
git add backend/e2e/m7_sqlserver_test.go backend/runtime/audit.go backend/runtime/audit_immutability_test.go backend/connector/localtool.go desktop/src/shared/contract.ts desktop/src/main/connectors/security-boundary.test.ts docs/acceptance/m7-1-sql-server.md backend/README.md desktop/README.md
git commit -m "test: verify m7 sql server vertical"
```

## Final Verification Gate

- [ ] Confirm `git diff --check` reports no whitespace errors.
- [ ] Confirm `wsl.exe -e bash -lc 'cd /mnt/d/merchantAgent/.worktrees/desktop-local-tools/backend && go test ./...'` passes.
- [ ] Confirm `npm test && npm run typecheck && npm run build` passes in `desktop`.
- [ ] Confirm real SQL Server read, confirmed write, replay, conflict, unknown recovery, and suspend-without-restart tests pass.
- [ ] Confirm cloud submission bodies and registry database contain no SQL, source address, credential ref/value, test input, or raw response.
- [ ] Confirm normal chat preload/renderer cannot request Workbench raw results, package decryption, credential values, or signing.
- [ ] Confirm the implementation engineer cannot publish or assign Skills, and the enterprise admin cannot read or edit local SQL/credentials.
- [ ] Confirm M7.2 HTTP/OAuth and M7.3 multi-device distribution code is absent from this change.
- [ ] Confirm the Windows acceptance record is complete and identifies the tested commit.
