# M7.1 SQL Server Windows/WSL Acceptance

This runbook joins the WSL backend/OpenFGA harness to the packaged Windows
Electron client and pinned SQL Server fixture.

> M7.1 is strictly non-production. Use only `test` or `preproduction` data and
> credentials. Never point this build at production. A local Windows
> administrator can access another target user's files, DPAPI-protected data,
> and Credential Manager secrets; this design does not defend against a local
> administrator.

WSL automation does not prove DPAPI, Windows Credential Manager, packaged
Electron behavior, native confirmation, window isolation, or visual layout.
Record those rows only from the visible Windows procedure.

## Evidence Header

| Field | Value |
| --- | --- |
| Date/time and timezone | PENDING |
| Tester | PENDING |
| Commit (`git rev-parse HEAD`) | PENDING |
| Windows version / WSL distribution | PENDING |
| SQL image | `mcr.microsoft.com/mssql/server:2022-CU20-ubuntu-22.04` |
| Desktop package path | PENDING |

Store sanitized screenshots and transcripts outside the repository. Never put
credentials, private keys, SQL result rows, or Workbench SQL screenshots in a
shared issue, chat, backend log, or audit record.

## Prerequisites

- Windows 11, WSL2, Docker Desktop with WSL integration, PowerShell 7, OpenSSL,
  Go, and Node.js/npm.
- A standard Windows test user and a separate local administrator. Run normal
  acceptance as the standard user.
- A repository checkout at the commit recorded above. Keep acceptance secrets
  outside the repository.
- A test-only LLM key if the visible chat flow uses the live provider.

```powershell
$Repo = 'D:\merchantAgent\.worktrees\desktop-local-tools'
$Acceptance = Join-Path $env:LOCALAPPDATA 'merchantAgent-m7-acceptance'
New-Item -ItemType Directory -Force $Acceptance | Out-Null
git -C $Repo rev-parse HEAD
```

## 1. Automated Baseline

```powershell
wsl.exe -e bash -lc 'cd /mnt/d/merchantAgent/.worktrees/desktop-local-tools/backend && docker compose up -d && go test ./...'
wsl.exe -e bash -lc 'cd /mnt/d/merchantAgent/.worktrees/desktop-local-tools/backend && M7_SQLSERVER_TEST=1 go test ./e2e -run TestM71SQLServerVertical -count=1 -v'
Set-Location "$Repo\desktop"
npm test
npm run typecheck
npm run build
```

All commands must pass. If compose reports a stale health label, verify the
actual API before continuing: `curl http://localhost:18080/healthz` must return
`SERVING`.

## 2. Strict-TLS SQL Fixture

The fixture recreates `merchant_test`, creates only `merchant_agent_test`, and
grants only `SELECT` on `dbo.production_orders` plus `UPDATE` on
`completion_rate`, `note`, and `version`.

```powershell
wsl.exe -e bash -lc 'cd /mnt/d/merchantAgent/.worktrees/desktop-local-tools/test/sqlserver && ./generate-tls.sh && docker compose up -d'
wsl.exe -e bash -lc 'until docker inspect --format="{{.State.Health.Status}}" sqlserver-sqlserver-1 2>/dev/null | grep -q healthy; do sleep 2; done'
Set-Location "$Repo\desktop"
$env:M7_SQLSERVER_TEST = '1'
npm test -- src/main/connectors/sql-adapter.test.ts src/main/connectors/sql-write.test.ts src/main/connectors/security-boundary.test.ts
Remove-Item Env:M7_SQLSERVER_TEST
```

Expected: parameter binding, strict TLS read, confirmed transactional write,
same-key replay, optimistic conflict, and unknown-outcome recovery pass. Reset
before the visible procedure so `ORD-1001` is completion 45/version 1:

```powershell
wsl.exe -e bash -lc 'cd /mnt/d/merchantAgent/.worktrees/desktop-local-tools/test/sqlserver && docker compose down -v --remove-orphans && ./generate-tls.sh && docker compose up -d'
```

## 3. Isolated Application State, Platform Key, Device Key, and Credential

This procedure uses exact scoped backup/removal/restoration so the standard
test user's existing connector state cannot be mistaken for acceptance state or
destroyed by cleanup. Before the first packaged-app launch, stop the app and
agentd, back up the device identity, the exact `sql-orders@1.0.0` installed
envelope, and every SQLite execution-ledger file, then remove only those paths:

```powershell
$UserData = Join-Path $env:APPDATA 'merchant-agent-desktop'
$ConnectorState = Join-Path $UserData 'connectors'
$IdentityPath = Join-Path $ConnectorState 'device-identity.json'
$InstalledPackagePath = Join-Path $ConnectorState 'sql-orders\1.0.0.ma-connector'
$LedgerPath = Join-Path $ConnectorState 'executions.db'
$StateBackup = Join-Path $Acceptance 'preflight-state-backup'
$StateManifestPath = Join-Path $StateBackup 'manifest.json'
$StatePaths = [ordered]@{
  deviceIdentity = $IdentityPath
  installedPackage = $InstalledPackagePath
  executionLedger = $LedgerPath
  executionLedgerWal = "${LedgerPath}-wal"
  executionLedgerShm = "${LedgerPath}-shm"
}

Get-Process merchantAgent -ErrorAction SilentlyContinue | Stop-Process -Force
wsl.exe -e bash -lc 'pkill -TERM -f "[c]md/agentd" 2>/dev/null || true'
if (Test-Path -LiteralPath $StateBackup) {
  throw "Stale state backup exists; restore or securely remove it before acceptance: $StateBackup"
}
New-Item -ItemType Directory -Path $StateBackup | Out-Null
$StateManifest = foreach ($entry in $StatePaths.GetEnumerator()) {
  $exists = Test-Path -LiteralPath $entry.Value -PathType Leaf
  $backupPath = Join-Path $StateBackup "$($entry.Key).bin"
  if ($exists) {
    Copy-Item -LiteralPath $entry.Value -Destination $backupPath
  }
  [pscustomobject]@{
    name = $entry.Key
    path = $entry.Value
    existed = $exists
    backupPath = $backupPath
    sha256 = if ($exists) { (Get-FileHash -Algorithm SHA256 -LiteralPath $entry.Value).Hash } else { $null }
    sddl = if ($exists) { (Get-Acl -LiteralPath $entry.Value).Sddl } else { $null }
  }
}
$StateManifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $StateManifestPath -Encoding utf8NoBOM
foreach ($state in $StateManifest) {
  Remove-Item -LiteralPath $state.path -Force -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $state.path) { throw "Could not isolate $($state.name): $($state.path)" }
}
```

Do not proceed unless the manifest exists, every file that previously existed
has a backup and hash, and all five live paths are absent. The backup can contain
a DPAPI private key, implementation credential, and ledger data. Keep it local,
never inspect or upload it, and restore/delete it in Step 9 even if acceptance
fails.

Generate an acceptance-only Ed25519 platform key outside the repository. Copy
its public half only long enough to build the acceptance package; never commit
the generated pair.

```powershell
wsl.exe -e bash -lc 'set -eu; d=/mnt/c/Users/'"$env:USERNAME"'/AppData/Local/merchantAgent-m7-acceptance; openssl genpkey -algorithm ED25519 -out "$d/platform-private.pem"; openssl pkey -in "$d/platform-private.pem" -pubout -out "$d/platform-public.pem"; chmod 600 "$d/platform-private.pem"'
$PlatformKeyRelative = 'desktop/resources/implementation/platform-public.pem'
$PlatformKey = Join-Path $Repo $PlatformKeyRelative
if ((git -C $Repo status --short -- $PlatformKeyRelative) -or
    (git -C $Repo diff --cached --name-only -- $PlatformKeyRelative)) {
  throw "Tracked platform key is not clean; preserve that work before acceptance."
}
$CanonicalPlatformKey = [IO.File]::ReadAllBytes($PlatformKey)
try {
  Copy-Item "$Acceptance\platform-public.pem" $PlatformKey -Force
  Set-Location "$Repo\desktop"
  npm run dist:dir
  if ($LASTEXITCODE -ne 0) { throw "acceptance package build failed" }
} finally {
  [IO.File]::WriteAllBytes($PlatformKey, $CanonicalPlatformKey)
}
if (git -C $Repo status --short -- $PlatformKeyRelative) {
  throw "Tracked platform key was not restored after packaging."
}
& "$Repo\desktop\dist\win-unpacked\merchantAgent.exe"
```

The packaged `win-unpacked` now contains the acceptance public key, while the
tracked source key has already been restored. Do not reuse that package after
this acceptance run.

Open Connector Workbench, record the device ID/fingerprint, then close the app.
Export only the public device key:

```powershell
$Identity = Get-Content -Raw $IdentityPath | ConvertFrom-Json
[IO.File]::WriteAllText((Join-Path $Acceptance 'device-public.pem'), $Identity.devicePublicKeyPem)
$Identity.deviceId | Set-Content -LiteralPath (Join-Path $Acceptance 'acceptance-device-id.txt') -Encoding ascii
$Identity.deviceId
icacls.exe $IdentityPath
Select-String -Path $IdentityPath -Pattern 'encryptedPrivateKey','BEGIN PRIVATE KEY'
```

Require `encryptedPrivateKey`, no plaintext private key, and a target-user-only
ACL. Replace `DEVICE_ID`, then issue a short-lived credential:

```powershell
wsl.exe -e bash -lc 'cd /mnt/d/merchantAgent/.worktrees/desktop-local-tools/backend && go run ./cmd/implementation-credential -tenant mock-corp-001 -device DEVICE_ID -device-public-key /mnt/c/Users/'"$env:USERNAME"'/AppData/Local/merchantAgent-m7-acceptance/device-public.pem -expires 2h -platform-private-key /mnt/c/Users/'"$env:USERNAME"'/AppData/Local/merchantAgent-m7-acceptance/platform-private.pem > /mnt/c/Users/'"$env:USERNAME"'/AppData/Local/merchantAgent-m7-acceptance/implementation-credential.txt'
```

Paste it only into Workbench unlock. Do not put it in chat, logs, screenshots,
or the evidence table.

## 4. Persistent Backend and Packaged App

In WSL terminal 1 (replace `USERNAME` and the test-only key):

```bash
cd /mnt/d/merchantAgent/.worktrees/desktop-local-tools/backend
mkdir -p "$HOME/.local/share/merchantagent-m7"
export OPENFGA_API_URL=http://localhost:18080
export DATA_DIR="$HOME/.local/share/merchantagent-m7"
export IMPLEMENTATION_PUBLIC_KEY_FILE=/mnt/c/Users/USERNAME/AppData/Local/merchantAgent-m7-acceptance/platform-public.pem
export LLM_API_KEY='TEST-ONLY-KEY'
go run ./cmd/agentd
```

```powershell
& "$Repo\desktop\dist\win-unpacked\merchantAgent.exe"
```

## 5. Configure, Validate, and Submit

Unlock Workbench with the implementation credential. Use only:

| Field | Value |
| --- | --- |
| Environment | `test` |
| Connector/version | `sql-orders` / `1.0.0` |
| Profile/credential ref | `erp-test` / `erp-test-credential` |
| Server/port/database | `localhost` / `11433` / `merchant_test` |
| CA | `D:\merchantAgent\.worktrees\desktop-local-tools\test\sqlserver\tls\ca.crt` |
| Username | `merchant_agent_test` |
| Password | fixture value in `test/sqlserver/init.sql` (do not record) |

Keep encryption enabled and `trustServerCertificate` disabled. Configure only:

- `query_order_status(orderId)`.
- `report_production_progress(orderId, workOrderId, completionRate,
  expectedVersion, note?)`, relation `operator`, `low_write`, native
  confirmation, optimistic versioning, and read-back.

Use the fixed repository templates with `ORD-1001` and `WO-2001`. Do not add
arbitrary SQL, objects, tools, or fields. Run connection, read, and update
preview checks. Close each raw result and prove it cannot reopen. Freeze, submit,
and record only the public digest/status.

## 6. Approval and Authority Separation

As enterprise admin `u_boss`, open Admin > Connectors. Verify only public
metadata is visible, then publish `sql-orders@1.0.0`. The admin must not see or
edit SQL, address, CA path, credential ref/value, test inputs, or raw results.

Verify the implementation user cannot publish/suspend/revoke connectors or
publish/assign Skills. Verify the enterprise admin has no implementation
credential and cannot retrieve the local implementation or credentials.

## 7. Employee Flow, Restart, and Suspension

1. As `u_sales1`, query `ORD-1001`; only declared fields may appear.
2. As `u_sales1`, request a progress write. Gate A/B must deny before the
   desktop bridge; no native confirmation may appear.
3. As `u_plan`, read, then request completion 60 with `expectedVersion=1` and
   `workOrderId=WO-2001`.
4. Cancel the native preview once and prove no row change. Retry, confirm once,
   and verify version 2 plus read-back completion 60.
5. Restart both app windows. Verify package, Credential Manager entry, ledger,
   and approval persist; query successfully again.
6. As `u_boss`, suspend the connector. Start a new employee turn without an
   app/backend restart; the tool must be unavailable and no SQL call may run.

Inspect Windows Credential Manager target
`com.merchantagent.connector/mock-corp-001/DEVICE_ID`, account
`credential/erp-test-credential`. The app must never display its password.

## 8. Visual and Raw-Result Acceptance

Capture sanitized screenshots of the main desktop at 1000x720 and Workbench
Profile/Operations/Tests/raw-result plus Admin Connectors at 900x700. Capture
native confirmation before cancel and confirm. Verify no overlap, clipped
controls, or horizontal page overflow. Screenshots must not expose SQL, rows,
credentials, keys, or implementation credentials.

Close the result, close Workbench, and restart the app. Prove raw rows are
unrecoverable from Workbench, ordinary chat IPC, diagnostics, logs, package
files, connector registry, and audit JSON.

## 9. Cleanup

First close all packaged app windows and stop WSL terminal 1. Run the following
even when any earlier acceptance step fails. It deletes the exact acceptance
Credential Manager target, acceptance package, DPAPI device identity, installed
connector envelope, and execution ledger; restores every preflight file with
its original bytes and ACL; and tears down backend/SQL material:

```powershell
$AcceptanceDeviceIdPath = Join-Path $Acceptance 'acceptance-device-id.txt'
$AcceptanceDeviceId = if (Test-Path -LiteralPath $AcceptanceDeviceIdPath -PathType Leaf) {
  (Get-Content -Raw -LiteralPath $AcceptanceDeviceIdPath).Trim()
} else { $null }
$CredentialTarget = if ($AcceptanceDeviceId) {
  "com.merchantagent.connector/mock-corp-001/$AcceptanceDeviceId"
} else { $null }
$UserData = Join-Path $env:APPDATA 'merchant-agent-desktop'
$ConnectorState = Join-Path $UserData 'connectors'
$StateBackup = Join-Path $Acceptance 'preflight-state-backup'
$StateManifestPath = Join-Path $StateBackup 'manifest.json'
if (!(Test-Path -LiteralPath $StateManifestPath -PathType Leaf)) {
  throw "Preflight state manifest is missing: $StateManifestPath"
}
$StateManifest = @(Get-Content -Raw -LiteralPath $StateManifestPath | ConvertFrom-Json)

Get-Process merchantAgent -ErrorAction SilentlyContinue | Stop-Process -Force
wsl.exe -e bash -lc 'pkill -TERM -f "[c]md/agentd" 2>/dev/null || true'
if ($CredentialTarget) {
  cmdkey.exe /delete:$CredentialTarget
  $CredentialListing = cmdkey.exe /list:$CredentialTarget 2>&1 | Out-String
  if ($CredentialListing -match [regex]::Escape($CredentialTarget)) {
    throw "Credential Manager target still exists: $CredentialTarget"
  }
}
Remove-Item "$Repo\desktop\dist\win-unpacked" -Recurse -Force -ErrorAction SilentlyContinue
wsl.exe -e bash -lc 'rm -rf "$HOME/.local/share/merchantagent-m7"; cd /mnt/d/merchantAgent/.worktrees/desktop-local-tools/test/sqlserver && docker compose down -v --remove-orphans && rm -rf tls'

foreach ($state in $StateManifest) {
  Remove-Item -LiteralPath $state.path -Force -ErrorAction SilentlyContinue
  if ($state.existed) {
    if (!(Test-Path -LiteralPath $state.backupPath -PathType Leaf)) {
      throw "Backup is missing for $($state.name): $($state.backupPath)"
    }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $state.path) | Out-Null
    Copy-Item -LiteralPath $state.backupPath -Destination $state.path
    $acl = Get-Acl -LiteralPath $state.path
    $acl.SetSecurityDescriptorSddlForm($state.sddl)
    Set-Acl -LiteralPath $state.path -AclObject $acl
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $state.path).Hash -ne $state.sha256) {
      throw "Restored bytes differ for $($state.name): $($state.path)"
    }
    if ((Get-Acl -LiteralPath $state.path).Sddl -ne $state.sddl) {
      throw "Restored ACL differs for $($state.name): $($state.path)"
    }
  } elseif (Test-Path -LiteralPath $state.path) {
    throw "Acceptance state remains for $($state.name): $($state.path)"
  }
}
$InstalledPackageDirectory = Join-Path $ConnectorState 'sql-orders'
if ((Test-Path -LiteralPath $InstalledPackageDirectory) -and
    (Get-ChildItem -Force -LiteralPath $InstalledPackageDirectory | Measure-Object).Count -eq 0) {
  Remove-Item -LiteralPath $InstalledPackageDirectory -Force
}
Remove-Item "$Acceptance\implementation-credential.txt","$Acceptance\platform-private.pem","$Acceptance\platform-public.pem","$Acceptance\device-public.pem","$Acceptance\acceptance-device-id.txt" -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $StateBackup -Recurse -Force
```

Do not rebuild with the acceptance key. Confirm cleanup with scoped checks so
unrelated worktree changes do not obscure the result:

```powershell
git -C $Repo status --short -- desktop/resources/implementation/platform-public.pem test/sqlserver
Test-Path "$Repo\desktop\dist\win-unpacked"
if ($CredentialTarget) { cmdkey.exe /list:$CredentialTarget }
$StateManifest | Select-Object name,existed,path
Test-Path -LiteralPath $StateBackup
```

Expected: scoped Git status is empty, `Test-Path` is `False`, and the exact
credential target is absent. The state manifest transcript must show each
scoped path and whether an original file was restored; its recorded hash and ACL
checks must have completed without error. The state-backup path must be absent.

## Evidence Table

Every row needs tester initials, timestamp, and sanitized artifact path. Never
mark Windows-only rows from WSL automation.

| Check | Status | Artifact/notes |
| --- | --- | --- |
| Backend full gate | PENDING | |
| Desktop tests/typechecks/build | PENDING | |
| Real TLS/read/write/replay/conflict/recovery | PENDING | |
| Submission/audit/chat/log/diagnostic leak scan | PENDING | |
| DPAPI key and target-user ACL | PENDING WINDOWS | |
| Credential Manager persistence/removal | PENDING WINDOWS | |
| Workbench raw isolation after close/restart | PENDING WINDOWS | |
| Gate A/B denial before desktop | PENDING WINDOWS | |
| Gate C and native cancel/confirm | PENDING WINDOWS | |
| Package/credential/ledger/approval restart persistence | PENDING WINDOWS | |
| Suspend invalidates next turn without restart | PENDING WINDOWS | |
| Implementer/admin authority separation | PENDING WINDOWS | |
| 1000x720 desktop layout | PENDING WINDOWS | |
| 900x700 Workbench/admin layout | PENDING WINDOWS | |
| Device/package/ledger/credential/fixture/TLS/key cleanup or exact restoration | PENDING WINDOWS | |

Final result is PASS only when every row is PASS against the recorded commit.
