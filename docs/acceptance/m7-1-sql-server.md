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
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
$Repo = 'D:\merchantAgent\.worktrees\desktop-local-tools'
$Acceptance = Join-Path $env:LOCALAPPDATA 'merchantAgent-m7-acceptance'
New-Item -ItemType Directory -Force $Acceptance | Out-Null
function Invoke-CheckedNativeCommand {
  param(
    [Parameter(Mandatory)] [string] $FilePath,
    [Parameter(Mandatory)] [string[]] $ArgumentList,
    [Parameter(Mandatory)] [string] $FailureMessage
  )
  & $FilePath @ArgumentList
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) { throw "$FailureMessage (exit $exitCode)" }
}
function Invoke-NativeCapture {
  param(
    [Parameter(Mandatory)] [string] $FilePath,
    [Parameter(Mandatory)] [string[]] $ArgumentList,
    [Parameter(Mandatory)] [string] $FailureMessage
  )
  $previousNativePreference = $PSNativeCommandUseErrorActionPreference
  try {
    $PSNativeCommandUseErrorActionPreference = $false
    $output = @(& $FilePath @ArgumentList 2>&1)
    $exitCode = $LASTEXITCODE
  } finally {
    $PSNativeCommandUseErrorActionPreference = $previousNativePreference
  }
  if ($exitCode -ne 0) { throw "$FailureMessage (exit $exitCode)" }
  return ($output | Out-String)
}
function Get-ConnectorStateManifest {
  param([Parameter(Mandatory)] [string] $Root)
  if (!(Test-Path -LiteralPath $Root -PathType Container)) { return @() }
  $manifest = [Collections.Generic.List[object]]::new()
  $manifest.Add([pscustomobject]@{
    relativePath = '.'
    kind = 'directory'
    length = $null
    sha256 = $null
    sddl = (Get-Acl -LiteralPath $Root).Sddl
  })
  foreach ($item in @(Get-ChildItem -Force -Recurse -LiteralPath $Root)) {
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Connector state contains an unsupported reparse point: $($item.FullName)"
    }
    $isDirectory = $item.PSIsContainer
    $manifest.Add([pscustomobject]@{
      relativePath = [IO.Path]::GetRelativePath($Root, $item.FullName).Replace('\', '/')
      kind = if ($isDirectory) { 'directory' } else { 'file' }
      length = if ($isDirectory) { $null } else { $item.Length }
      sha256 = if ($isDirectory) { $null } else { (Get-FileHash -Algorithm SHA256 -LiteralPath $item.FullName).Hash }
      sddl = (Get-Acl -LiteralPath $item.FullName).Sddl
    })
  }
  return @($manifest | Sort-Object -Property relativePath)
}
function Assert-ConnectorStateMatches {
  param(
    [Parameter(Mandatory)] [AllowEmptyCollection()] [object[]] $Expected,
    [Parameter(Mandatory)] [AllowEmptyCollection()] [object[]] $Actual
  )
  $expectedRows = @($Expected | ForEach-Object { $_ | ConvertTo-Json -Compress })
  $actualRows = @($Actual | ForEach-Object { $_ | ConvertTo-Json -Compress })
  $difference = @(Compare-Object -ReferenceObject $expectedRows -DifferenceObject $actualRows)
  if ($difference.Count -ne 0) {
    throw "Unexpected connector state remains after restore: $($difference | Out-String)"
  }
}
Invoke-CheckedNativeCommand -FilePath 'git.exe' -ArgumentList @('-C', $Repo, 'rev-parse', 'HEAD') -FailureMessage 'Could not read the acceptance commit.'

$AgentdStopScript = @'
set -euo pipefail
capture_optional_pgrep() {
  local variable="$1" pattern="$2" output status
  if output="$(pgrep -f "$pattern")"; then
    :
  else
    status=$?
    if [ "$status" -ne 1 ]; then
      echo "pgrep failed for process check (exit $status)" >&2
      return "$status"
    fi
    output=''
  fi
  printf -v "$variable" '%s' "$output"
}
capture_required() {
  local variable="$1"
  shift
  local output status
  if output="$("$@")"; then
    printf -v "$variable" '%s' "$output"
  else
    status=$?
    echo "required process/port check failed: $* (exit $status)" >&2
    return "$status"
  fi
}
agentd_pids() {
  local go_run compiled listeners
  capture_optional_pgrep go_run '[g]o run ./cmd/agentd'
  capture_optional_pgrep compiled '[/]tmp/go-build.*/exe/agentd'
  capture_required listeners ss -H -ltnp 'sport = :8765'
  {
    printf '%s\n' "$go_run"
    printf '%s\n' "$compiled"
    printf '%s\n' "$listeners" | awk 'match($0,/pid=[0-9]+/){print substr($0,RSTART+4,RLENGTH-4)}'
  } | sort -u
}
pids="$(agentd_pids)"
if [ -n "$pids" ]; then
  while read -r pid; do kill -TERM "$pid" 2>/dev/null || :; done <<<"$pids"
fi
for _ in $(seq 1 50); do
  pids="$(agentd_pids)"
  [ -z "$pids" ] && break
  sleep 0.2
done
pids="$(agentd_pids)"
if [ -n "$pids" ]; then
  while read -r pid; do kill -KILL "$pid" 2>/dev/null || :; done <<<"$pids"
  sleep 0.2
fi
pids="$(agentd_pids)"
if [ -n "$pids" ]; then
  echo 'agentd still owns backend port 8765 or an agentd process remains' >&2
  exit 1
fi
'@
function Invoke-WSLBashScript {
  param(
    [Parameter(Mandatory)] [string] $Script,
    [Parameter(Mandatory)] [string] $FailureMessage
  )
  $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Script))
  Invoke-CheckedNativeCommand -FilePath 'wsl.exe' -ArgumentList @('-e', 'bash', '-lc', "printf '%s' '$encoded' | base64 -d | bash") -FailureMessage $FailureMessage
}
function Stop-PackagedApplicationProcesses {
  $appPids = @(Get-Process -Name merchantAgent -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
  if ($appPids.Count -gt 0) {
    Stop-Process -Id $appPids -Force -ErrorAction Stop
  }
  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  while ((Get-Process -Name merchantAgent -ErrorAction SilentlyContinue) -and
         [DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 200
  }
  if (Get-Process -Name merchantAgent -ErrorAction SilentlyContinue) {
    throw 'Packaged merchantAgent processes are still running.'
  }
}
function Stop-AgentdProcessesAndPort {
  Invoke-WSLBashScript -Script $AgentdStopScript -FailureMessage 'Could not stop and verify agentd.'
}
```

## 1. Automated Baseline

```powershell
Invoke-CheckedNativeCommand -FilePath 'wsl.exe' -ArgumentList @('-e', 'bash', '-lc', 'cd /mnt/d/merchantAgent/.worktrees/desktop-local-tools/backend && docker compose up -d && go test ./...') -FailureMessage 'Backend full gate failed.'
Invoke-CheckedNativeCommand -FilePath 'wsl.exe' -ArgumentList @('-e', 'bash', '-lc', 'cd /mnt/d/merchantAgent/.worktrees/desktop-local-tools/backend && M7_SQLSERVER_TEST=1 go test ./e2e -run TestM71SQLServerVertical -count=1 -v') -FailureMessage 'Backend M7.1 vertical gate failed.'
Set-Location "$Repo\desktop"
Invoke-CheckedNativeCommand -FilePath 'npm.cmd' -ArgumentList @('test') -FailureMessage 'Desktop test gate failed.'
Invoke-CheckedNativeCommand -FilePath 'npm.cmd' -ArgumentList @('run', 'typecheck') -FailureMessage 'Desktop typecheck failed.'
Invoke-CheckedNativeCommand -FilePath 'npm.cmd' -ArgumentList @('run', 'build') -FailureMessage 'Desktop build failed.'
```

All commands must pass. If compose reports a stale health label, verify the
actual API before continuing: `curl http://localhost:18080/healthz` must return
`SERVING`.

## 2. Strict-TLS SQL Fixture

The fixture recreates `merchant_test`, creates only `merchant_agent_test`, and
grants only `SELECT` on `dbo.production_orders` plus `UPDATE` on
`completion_rate`, `note`, and `version`.

```powershell
$SQLFixtureStartScript = @'
set -euo pipefail
cd /mnt/d/merchantAgent/.worktrees/desktop-local-tools/test/sqlserver
./generate-tls.sh
docker compose up -d
'@
$SQLReadyScript = @'
set -euo pipefail
cd /mnt/d/merchantAgent/.worktrees/desktop-local-tools/test/sqlserver
readiness_deadline=$((SECONDS + 120))
while [ "$SECONDS" -lt "$readiness_deadline" ]; do
  sql_id="$(docker compose ps -q sqlserver)"
  initializer_id="$(docker compose ps -a -q initializer)"
  if [ -n "$sql_id" ]; then
    sql_health="$(docker inspect --format='{{.State.Health.Status}}' "$sql_id")"
  else
    sql_health='missing'
  fi
  if [ -n "$initializer_id" ]; then
    initializer_status="$(docker inspect --format='{{.State.Status}}' "$initializer_id")"
    initializer_exit="$(docker inspect --format='{{.State.ExitCode}}' "$initializer_id")"
  else
    initializer_status='missing'
    initializer_exit='missing'
  fi
  if [ "$sql_health" = healthy ] && [ "$initializer_status" = exited ] && [ "$initializer_exit" = 0 ]; then
    exit 0
  fi
  if [ "$initializer_status" = exited ] && [ "$initializer_exit" != 0 ]; then
    echo "SQL initializer failed with exit $initializer_exit" >&2
    docker compose ps >&2 || echo 'docker compose ps diagnostics failed' >&2
    docker compose logs --no-color --tail 200 sqlserver initializer >&2 || echo 'docker compose logs diagnostics failed' >&2
    exit 1
  fi
  sleep 2
done
echo 'SQL Server did not become healthy before the readiness deadline' >&2
docker compose ps >&2 || echo 'docker compose ps diagnostics failed' >&2
docker compose logs --no-color --tail 200 sqlserver >&2 || echo 'docker compose logs diagnostics failed' >&2
exit 1
'@
try {
  Invoke-WSLBashScript -Script $SQLFixtureStartScript -FailureMessage 'SQL fixture startup failed.'
  Invoke-WSLBashScript -Script $SQLReadyScript -FailureMessage 'SQL fixture readiness failed.'
  Set-Location "$Repo\desktop"
  $env:M7_SQLSERVER_TEST = '1'
  Invoke-CheckedNativeCommand -FilePath 'npm.cmd' -ArgumentList @('test', '--', 'src/main/connectors/sql-adapter.test.ts', 'src/main/connectors/sql-write.test.ts', 'src/main/connectors/security-boundary.test.ts') -FailureMessage 'Strict-TLS SQL gate failed.'
} catch {
  Write-Warning 'Run Step 9 cleanup even after this failure.'
  throw
} finally {
  if (Test-Path Env:M7_SQLSERVER_TEST) { Remove-Item Env:M7_SQLSERVER_TEST -ErrorAction Stop }
}
```

Expected: parameter binding, strict TLS read, confirmed transactional write,
same-key replay, optimistic conflict, and unknown-outcome recovery pass. Reset
before the visible procedure so `ORD-1001` is completion 45/version 1:

```powershell
Invoke-CheckedNativeCommand -FilePath 'wsl.exe' -ArgumentList @('-e', 'bash', '-lc', 'cd /mnt/d/merchantAgent/.worktrees/desktop-local-tools/test/sqlserver && docker compose down -v --remove-orphans && ./generate-tls.sh && docker compose up -d') -FailureMessage 'SQL fixture reset failed.'
Invoke-WSLBashScript -Script $SQLReadyScript -FailureMessage 'Reset SQL fixture readiness failed.'
```

## 3. Isolated Application State, Platform Key, Device Key, and Credential

This procedure uses exact scoped backup/removal/restoration so the standard
test user's existing connector state cannot be mistaken for acceptance state or
destroyed by cleanup. Before the first packaged-app launch, stop the app and
agentd, snapshot the complete connector directory by relative path, SHA-256, and
ACL SDDL, then back up and isolate only the identity, exact
`sql-orders@1.0.0` envelope, and SQLite execution-ledger files:

```powershell
$UserData = Join-Path $env:APPDATA 'merchant-agent-desktop'
$ConnectorState = Join-Path $UserData 'connectors'
$IdentityPath = Join-Path $ConnectorState 'device-identity.json'
$InstalledPackagePath = Join-Path $ConnectorState 'sql-orders\1.0.0.ma-connector'
$LedgerPath = Join-Path $ConnectorState 'executions.db'
$StateBackup = Join-Path $env:LOCALAPPDATA 'merchantAgent-m7-preflight-state-backup'
$StatePurge = Join-Path $env:LOCALAPPDATA 'merchantAgent-m7-preflight-state-backup.purge'
$StateManifestPath = Join-Path $StateBackup 'manifest.json'
$StateFilesBackup = Join-Path $StateBackup 'files'
$IsolationRelativePaths = @(
  'device-identity.json',
  'sql-orders/1.0.0.ma-connector',
  'executions.db',
  'executions.db-wal',
  'executions.db-shm',
  'executions.db-journal'
)

Stop-PackagedApplicationProcesses
Stop-AgentdProcessesAndPort
if (Test-Path -LiteralPath $StateBackup) {
  throw "Stale state backup exists; restore or securely remove it before acceptance: $StateBackup"
}
if (Test-Path -LiteralPath $StatePurge) {
  throw "Stale post-restore purge remnants exist; inspect and securely remove them before acceptance: $StatePurge"
}
New-Item -ItemType Directory -Path $StateFilesBackup -Force | Out-Null
$PreflightManifest = @(Get-ConnectorStateManifest -Root $ConnectorState)
ConvertTo-Json -InputObject @($PreflightManifest) -Depth 4 |
  Set-Content -LiteralPath $StateManifestPath -Encoding utf8NoBOM -ErrorAction Stop
foreach ($relativePath in $IsolationRelativePaths) {
  $state = @($PreflightManifest | Where-Object { $_.relativePath -eq $relativePath })
  if ($state.Count -gt 1) { throw "Duplicate preflight manifest path: $relativePath" }
  $livePath = Join-Path $ConnectorState $relativePath
  if ($state.Count -eq 1) {
    if ($state[0].kind -ne 'file') { throw "Isolation target is not a file: $relativePath" }
    $backupPath = Join-Path $StateFilesBackup $relativePath
    New-Item -ItemType Directory -Path (Split-Path -Parent $backupPath) -Force | Out-Null
    Copy-Item -LiteralPath $livePath -Destination $backupPath -ErrorAction Stop
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $backupPath).Hash -ne $state[0].sha256) {
      throw "Backup hash differs before isolation: $relativePath"
    }
    Remove-Item -LiteralPath $livePath -Force -ErrorAction Stop
  } elseif (Test-Path -LiteralPath $livePath) {
    throw "Unrecorded isolation target appeared after snapshot: $relativePath"
  }
  if (Test-Path -LiteralPath $livePath) { throw "Could not isolate connector state: $relativePath" }
}
```

Do not proceed unless the complete manifest exists, every isolated preflight
file has a hash-identical backup, and all six live paths are absent. Unrelated
connector files remain in place and must not be modified during acceptance. The
backup can contain a DPAPI private key, implementation credential, and ledger
data. It is deliberately outside the acceptance-artifact directory so every
pre-purge cleanup failure leaves it untouched. Keep it local, never inspect or
upload it, and restore/purge it in Step 9 even if acceptance fails.

Generate an acceptance-only Ed25519 platform key outside the repository. Copy
its public half only long enough to build the acceptance package; never commit
the generated pair.

```powershell
$KeyGenerationCommand = 'set -eu; d=/mnt/c/Users/' + $env:USERNAME + '/AppData/Local/merchantAgent-m7-acceptance; openssl genpkey -algorithm ED25519 -out "$d/platform-private.pem"; openssl pkey -in "$d/platform-private.pem" -pubout -out "$d/platform-public.pem"; chmod 600 "$d/platform-private.pem"'
Invoke-CheckedNativeCommand -FilePath 'wsl.exe' -ArgumentList @('-e', 'bash', '-lc', $KeyGenerationCommand) -FailureMessage 'Acceptance platform-key generation failed.'
$PlatformKeyRelative = 'desktop/resources/implementation/platform-public.pem'
$PlatformKey = Join-Path $Repo $PlatformKeyRelative
$PlatformKeyWorktree = Invoke-NativeCapture -FilePath 'git.exe' -ArgumentList @('-C', $Repo, 'status', '--short', '--', $PlatformKeyRelative) -FailureMessage 'Platform-key worktree check failed.'
$PlatformKeyIndex = Invoke-NativeCapture -FilePath 'git.exe' -ArgumentList @('-C', $Repo, 'diff', '--cached', '--name-only', '--', $PlatformKeyRelative) -FailureMessage 'Platform-key index check failed.'
if ($PlatformKeyWorktree -or $PlatformKeyIndex) {
  throw "Tracked platform key is not clean; preserve that work before acceptance."
}
$CanonicalPlatformKey = [IO.File]::ReadAllBytes($PlatformKey)
try {
  Copy-Item "$Acceptance\platform-public.pem" $PlatformKey -Force
  Set-Location "$Repo\desktop"
  Invoke-CheckedNativeCommand -FilePath 'npm.cmd' -ArgumentList @('run', 'dist:dir') -FailureMessage 'Acceptance package build failed.'
} finally {
  [IO.File]::WriteAllBytes($PlatformKey, $CanonicalPlatformKey)
}
$PlatformKeyRestoredStatus = Invoke-NativeCapture -FilePath 'git.exe' -ArgumentList @('-C', $Repo, 'status', '--short', '--', $PlatformKeyRelative) -FailureMessage 'Platform-key restore check failed.'
if ($PlatformKeyRestoredStatus) {
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
$IdentityRaw = Get-Content -Raw -LiteralPath $IdentityPath -ErrorAction Stop
$Identity = $IdentityRaw | ConvertFrom-Json -ErrorAction Stop
if ([string]::IsNullOrWhiteSpace($Identity.encryptedPrivateKey)) {
  throw 'DPAPI identity has no encryptedPrivateKey.'
}
try {
  [Convert]::FromBase64String($Identity.encryptedPrivateKey) | Out-Null
} catch {
  throw 'DPAPI encryptedPrivateKey is not valid base64.'
}
if ($IdentityRaw -match '-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----') {
  throw 'DPAPI identity contains a plaintext private-key marker.'
}
[IO.File]::WriteAllText((Join-Path $Acceptance 'device-public.pem'), $Identity.devicePublicKeyPem)
$Identity.deviceId | Set-Content -LiteralPath (Join-Path $Acceptance 'acceptance-device-id.txt') -Encoding ascii
$Identity.deviceId
Invoke-CheckedNativeCommand -FilePath 'icacls.exe' -ArgumentList @($IdentityPath) -FailureMessage 'Device identity ACL inspection failed.'
```

Require `encryptedPrivateKey`, no plaintext private key, and a target-user-only
ACL. Replace `DEVICE_ID`, then issue a short-lived credential:

```powershell
$CredentialIssueCommand = 'cd /mnt/d/merchantAgent/.worktrees/desktop-local-tools/backend && go run ./cmd/implementation-credential -tenant mock-corp-001 -device DEVICE_ID -device-public-key /mnt/c/Users/' + $env:USERNAME + '/AppData/Local/merchantAgent-m7-acceptance/device-public.pem -expires 2h -platform-private-key /mnt/c/Users/' + $env:USERNAME + '/AppData/Local/merchantAgent-m7-acceptance/platform-private.pem > /mnt/c/Users/' + $env:USERNAME + '/AppData/Local/merchantAgent-m7-acceptance/implementation-credential.txt'
Invoke-CheckedNativeCommand -FilePath 'wsl.exe' -ArgumentList @('-e', 'bash', '-lc', $CredentialIssueCommand) -FailureMessage 'Implementation credential issuance failed.'
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

Run the following even when any earlier acceptance step fails. It independently
attempts to stop every packaged-app process and both the `go run` parent and
listening agentd child before the state stages. It deletes the exact acceptance
Credential Manager target, acceptance package, DPAPI device identity, installed
connector envelope, and execution ledger; restores every preflight file with
its original bytes and ACL; and tears down backend/OpenFGA and SQL material:

```powershell
$AcceptanceDeviceIdPath = Join-Path $Acceptance 'acceptance-device-id.txt'
$UserData = Join-Path $env:APPDATA 'merchant-agent-desktop'
$ConnectorState = Join-Path $UserData 'connectors'
$StateBackup = Join-Path $env:LOCALAPPDATA 'merchantAgent-m7-preflight-state-backup'
$StatePurge = Join-Path $env:LOCALAPPDATA 'merchantAgent-m7-preflight-state-backup.purge'
$StateManifestPath = Join-Path $StateBackup 'manifest.json'
$StateFilesBackup = Join-Path $StateBackup 'files'
$CleanupErrors = [Collections.Generic.List[string]]::new()
$CleanupContext = [ordered]@{
  HasPreflightManifest = $false
  PreflightManifest = @()
  PreflightPaths = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  CredentialTarget = $null
  CredentialPreListCompleted = $false
  CredentialPresentBeforeDelete = $false
  RestorationVerified = $false
  FinalChecksCompleted = $false
  BackupQuarantined = $false
  BackupPurgeVerified = $false
}
# BEGIN EXTRACTABLE CLEANUP ORCHESTRATION
function Invoke-CleanupOrchestration {
  param(
    [Parameter(Mandatory)] [Collections.IDictionary] $Context,
    [Parameter(Mandatory)] [AllowEmptyCollection()] [Collections.Generic.List[string]] $Errors,
    [Parameter(Mandatory)] [object[]] $SafeStages,
    [Parameter(Mandatory)] [object[]] $FinalStages,
    [Parameter(Mandatory)] [object] $QuarantineStage,
    [Parameter(Mandatory)] [object] $PurgeStage,
    [Parameter(Mandatory)] [object] $BackupAbsenceStage
  )

  $attempted = [Collections.Generic.List[string]]::new()
  function Invoke-NamedCleanupStage {
    param([Parameter(Mandatory)] [object] $Stage)
    $name = [string] $Stage.Name
    $action = [scriptblock] $Stage.Action
    $attempted.Add($name)
    try {
      $null = & $action
    } catch {
      $Errors.Add("[$name] $($_.Exception.Message)")
    }
  }

  foreach ($stage in $SafeStages) {
    Invoke-NamedCleanupStage -Stage $stage
  }
  foreach ($stage in $FinalStages) {
    Invoke-NamedCleanupStage -Stage $stage
  }
  $Context.FinalChecksCompleted = $true

  if (!$Context.RestorationVerified -and $Errors.Count -eq 0) {
    $Errors.Add('[cleanup orchestration] Exact restoration verification did not complete.')
  }
  if ($Errors.Count -eq 0 -and $Context.RestorationVerified -and $Context.FinalChecksCompleted) {
    Invoke-NamedCleanupStage -Stage $QuarantineStage
    if ($Context.BackupQuarantined) {
      Invoke-NamedCleanupStage -Stage $PurgeStage
    }
    Invoke-NamedCleanupStage -Stage $BackupAbsenceStage
  }
  if ($Errors.Count -eq 0 -and !$Context.BackupPurgeVerified) {
    $Errors.Add('[cleanup orchestration] Backup and quarantine absence verification did not complete.')
  }

  return [pscustomobject]@{
    Passed = $Errors.Count -eq 0 -and
      $Context.RestorationVerified -and
      $Context.FinalChecksCompleted -and
      $Context.BackupPurgeVerified
    Attempted = @($attempted)
    Errors = @($Errors)
  }
}
# END EXTRACTABLE CLEANUP ORCHESTRATION
$IsolationRelativePaths = @(
  'device-identity.json',
  'sql-orders/1.0.0.ma-connector',
  'executions.db',
  'executions.db-wal',
  'executions.db-shm',
  'executions.db-journal'
)
$AcceptanceTempPatterns = @(
  '^device-identity\.json\.\d+\.[0-9a-fA-F-]+\.tmp$',
  '^sql-orders/1\.0\.0\.ma-connector\.\d+\.[0-9a-fA-F-]+\.tmp$',
  '^sql-orders/1\.0\.0\.ma-connector\.lock$'
)
$AcceptancePackage = Join-Path $Repo 'desktop\dist\win-unpacked'
$AcceptanceArtifacts = @(
  (Join-Path $Acceptance 'implementation-credential.txt'),
  (Join-Path $Acceptance 'platform-private.pem'),
  (Join-Path $Acceptance 'platform-public.pem'),
  (Join-Path $Acceptance 'device-public.pem'),
  $AcceptanceDeviceIdPath
)
$BackendComposeCleanup = @'
set -euo pipefail
cd /mnt/d/merchantAgent/.worktrees/desktop-local-tools/backend
docker compose down -v --remove-orphans
'@
$SQLComposeCleanup = @'
set -euo pipefail
cd /mnt/d/merchantAgent/.worktrees/desktop-local-tools/test/sqlserver
docker compose down -v --remove-orphans
'@
$BackendDataCleanup = @'
rm -rf -- "$HOME/.local/share/merchantagent-m7"
'@
$SQLTLSCleanup = @'
rm -rf -- /mnt/d/merchantAgent/.worktrees/desktop-local-tools/test/sqlserver/tls
'@
$BackendContainersVerification = @'
set -euo pipefail
containers="$(docker ps -aq --filter label=com.docker.compose.project=backend)"
if [ -n "$containers" ]; then echo 'Acceptance Compose containers remain: backend' >&2; exit 1; fi
'@
$BackendNetworksVerification = @'
set -euo pipefail
networks="$(docker network ls -q --filter label=com.docker.compose.project=backend)"
if [ -n "$networks" ]; then echo 'Acceptance Compose networks remain: backend' >&2; exit 1; fi
'@
$SQLContainersVerification = @'
set -euo pipefail
containers="$(docker ps -aq --filter label=com.docker.compose.project=sqlserver)"
if [ -n "$containers" ]; then echo 'Acceptance Compose containers remain: sqlserver' >&2; exit 1; fi
'@
$SQLNetworksVerification = @'
set -euo pipefail
networks="$(docker network ls -q --filter label=com.docker.compose.project=sqlserver)"
if [ -n "$networks" ]; then echo 'Acceptance Compose networks remain: sqlserver' >&2; exit 1; fi
'@
$BackendDataVerification = @'
set -eu
if [ -e "$HOME/.local/share/merchantagent-m7" ]; then echo 'Generated backend data remains' >&2; exit 1; fi
'@
$SQLTLSVerification = @'
set -eu
if [ -e /mnt/d/merchantAgent/.worktrees/desktop-local-tools/test/sqlserver/tls ]; then echo 'Generated SQL TLS remains' >&2; exit 1; fi
'@
function New-CleanupStage {
  param(
    [Parameter(Mandatory)] [string] $Name,
    [Parameter(Mandatory)] [scriptblock] $Action
  )
  return [pscustomobject]@{ Name = $Name; Action = $Action }
}

$SafeCleanupStages = @(
  New-CleanupStage -Name 'Load preflight state manifest' -Action {
    if (!(Test-Path -LiteralPath $StateManifestPath -PathType Leaf)) {
      throw "Preflight state manifest is missing: $StateManifestPath"
    }
    $CleanupContext.PreflightManifest = @(
      Get-Content -Raw -LiteralPath $StateManifestPath -ErrorAction Stop |
        ConvertFrom-Json -ErrorAction Stop
    )
    foreach ($state in $CleanupContext.PreflightManifest) {
      if (!$CleanupContext.PreflightPaths.Add([string]$state.relativePath)) {
        throw "Duplicate preflight manifest path: $($state.relativePath)"
      }
    }
    $CleanupContext.HasPreflightManifest = $true
  }
  New-CleanupStage -Name 'Read acceptance device identifier' -Action {
    if (!(Test-Path -LiteralPath $AcceptanceDeviceIdPath -PathType Leaf)) {
      throw "Acceptance device identifier is missing: $AcceptanceDeviceIdPath"
    }
    $acceptanceDeviceId = (Get-Content -Raw -LiteralPath $AcceptanceDeviceIdPath -ErrorAction Stop).Trim()
    if ([string]::IsNullOrWhiteSpace($acceptanceDeviceId)) {
      throw 'Acceptance device identifier is empty.'
    }
    $CleanupContext.CredentialTarget = "com.merchantagent.connector/mock-corp-001/$acceptanceDeviceId"
  }
  New-CleanupStage -Name 'Stop packaged application processes' -Action {
    Stop-PackagedApplicationProcesses
  }
  New-CleanupStage -Name 'Stop agentd processes and backend port' -Action {
    Stop-AgentdProcessesAndPort
  }
  New-CleanupStage -Name 'List Credential Manager target before deletion' -Action {
    if (!$CleanupContext.CredentialTarget) {
      throw 'Cannot list the exact Credential Manager target without the acceptance device ID.'
    }
    $credentialListing = Invoke-NativeCapture -FilePath 'cmdkey.exe' -ArgumentList @("/list:$($CleanupContext.CredentialTarget)") -FailureMessage 'Credential Manager pre-deletion listing failed.'
    $CleanupContext.CredentialPresentBeforeDelete = $credentialListing -match [regex]::Escape($CleanupContext.CredentialTarget)
    $CleanupContext.CredentialPreListCompleted = $true
  }
  New-CleanupStage -Name 'Delete exact Credential Manager target' -Action {
    if (!$CleanupContext.CredentialTarget) {
      throw 'Cannot delete the exact Credential Manager target without the acceptance device ID.'
    }
    if (!$CleanupContext.CredentialPreListCompleted -or $CleanupContext.CredentialPresentBeforeDelete) {
      Invoke-CheckedNativeCommand -FilePath 'cmdkey.exe' -ArgumentList @("/delete:$($CleanupContext.CredentialTarget)") -FailureMessage "Credential Manager deletion failed: $($CleanupContext.CredentialTarget)"
    }
  }
  New-CleanupStage -Name 'Remove acceptance package' -Action {
    if (Test-Path -LiteralPath $AcceptancePackage) {
      Remove-Item -LiteralPath $AcceptancePackage -Recurse -Force -ErrorAction Stop
    }
  }
  New-CleanupStage -Name 'Tear down backend Compose' -Action {
    Invoke-WSLBashScript -Script $BackendComposeCleanup -FailureMessage 'Backend/OpenFGA cleanup failed.'
  }
  New-CleanupStage -Name 'Tear down SQL Compose' -Action {
    Invoke-WSLBashScript -Script $SQLComposeCleanup -FailureMessage 'SQL resource cleanup failed.'
  }
  New-CleanupStage -Name 'Remove generated backend data' -Action {
    Invoke-WSLBashScript -Script $BackendDataCleanup -FailureMessage 'Generated backend data cleanup failed.'
  }
  New-CleanupStage -Name 'Remove generated SQL TLS' -Action {
    Invoke-WSLBashScript -Script $SQLTLSCleanup -FailureMessage 'Generated SQL TLS cleanup failed.'
  }
  New-CleanupStage -Name 'Inspect unexpected connector state' -Action {
    if (!$CleanupContext.HasPreflightManifest) {
      throw 'Cannot inspect connector state without the preflight manifest.'
    }
    $currentManifest = @(Get-ConnectorStateManifest -Root $ConnectorState)
    $extraState = @($currentManifest | Where-Object {
      !$CleanupContext.PreflightPaths.Contains([string]$_.relativePath)
    })
    $unexpectedState = @()
    foreach ($state in $extraState) {
      $isIsolationFile = $state.kind -eq 'file' -and $IsolationRelativePaths -contains $state.relativePath
      $isAcceptanceTemp = $state.kind -eq 'file' -and @(
        $AcceptanceTempPatterns | Where-Object { $state.relativePath -match $_ }
      ).Count -gt 0
      $isAcceptanceDirectory = $state.kind -eq 'directory' -and $state.relativePath -in @('.', 'sql-orders')
      if (!$isIsolationFile -and !$isAcceptanceTemp -and !$isAcceptanceDirectory) {
        $unexpectedState += $state.relativePath
      }
    }
    if ($unexpectedState.Count -gt 0) {
      throw "Unexpected connector state remains after acceptance and will be preserved: $($unexpectedState -join ', ')"
    }
  }
  New-CleanupStage -Name 'Remove acceptance connector temporary files' -Action {
    if (!$CleanupContext.HasPreflightManifest) {
      throw 'Cannot distinguish acceptance temporary files without the preflight manifest.'
    }
    if (!(Test-Path -LiteralPath $ConnectorState -PathType Container)) { return }
    $temporaryFailures = [Collections.Generic.List[string]]::new()
    foreach ($state in @(Get-ConnectorStateManifest -Root $ConnectorState)) {
      $isAcceptanceTemp = $state.kind -eq 'file' -and @(
        $AcceptanceTempPatterns | Where-Object { $state.relativePath -match $_ }
      ).Count -gt 0 -and !$CleanupContext.PreflightPaths.Contains([string]$state.relativePath)
      if ($isAcceptanceTemp) {
        try {
          $temporaryPath = Join-Path $ConnectorState $state.relativePath
          Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction Stop
          if (Test-Path -LiteralPath $temporaryPath) {
            throw "Acceptance atomic-write temporary file remains: $($state.relativePath)"
          }
        } catch {
          $temporaryFailures.Add("$($state.relativePath): $($_.Exception.Message)")
        }
      }
    }
    if ($temporaryFailures.Count -gt 0) {
      throw "Acceptance temporary-file cleanup failed: $($temporaryFailures -join '; ')"
    }
  }
  New-CleanupStage -Name 'Restore preflight connector files and ACLs' -Action {
    if (!$CleanupContext.HasPreflightManifest) {
      throw 'Cannot restore connector state without the preflight manifest; leave live state and the sensitive backup untouched.'
    }
    $restoreFailures = [Collections.Generic.List[string]]::new()
    foreach ($relativePath in $IsolationRelativePaths) {
      try {
        $preflightState = @($CleanupContext.PreflightManifest | Where-Object {
          $_.relativePath -eq $relativePath
        })
        if ($preflightState.Count -gt 1) { throw "Duplicate preflight manifest path: $relativePath" }
        $livePath = Join-Path $ConnectorState $relativePath
        if ($preflightState.Count -eq 1) {
          if ($preflightState[0].kind -ne 'file') { throw "Restore target is not a file: $relativePath" }
          $backupPath = Join-Path $StateFilesBackup $relativePath
          if (!(Test-Path -LiteralPath $backupPath -PathType Leaf)) {
            throw "Backup is missing for connector state: $relativePath"
          }
          if ((Get-FileHash -Algorithm SHA256 -LiteralPath $backupPath).Hash -ne $preflightState[0].sha256) {
            throw "Backup hash differs before deleting live state: $relativePath"
          }
        }
        if (Test-Path -LiteralPath $livePath -PathType Leaf) {
          Remove-Item -LiteralPath $livePath -Force -ErrorAction Stop
        } elseif (Test-Path -LiteralPath $livePath) {
          throw "Acceptance state path is not a file and will be preserved: $relativePath"
        }
        if ($preflightState.Count -eq 1) {
          New-Item -ItemType Directory -Force -Path (Split-Path -Parent $livePath) | Out-Null
          Copy-Item -LiteralPath $backupPath -Destination $livePath -ErrorAction Stop
          $acl = Get-Acl -LiteralPath $livePath -ErrorAction Stop
          $acl.SetSecurityDescriptorSddlForm($preflightState[0].sddl)
          Set-Acl -LiteralPath $livePath -AclObject $acl -ErrorAction Stop
          if ((Get-FileHash -Algorithm SHA256 -LiteralPath $livePath).Hash -ne $preflightState[0].sha256) {
            throw "Restored bytes differ for connector state: $relativePath"
          }
          if ((Get-Acl -LiteralPath $livePath -ErrorAction Stop).Sddl -ne $preflightState[0].sddl) {
            throw "Restored ACL differs for connector state: $relativePath"
          }
        } elseif (Test-Path -LiteralPath $livePath) {
          throw "Acceptance userData state remains: $livePath"
        }
      } catch {
        $restoreFailures.Add("$($relativePath): $($_.Exception.Message)")
      }
    }
    if ($restoreFailures.Count -gt 0) {
      throw "One or more connector paths could not be restored: $($restoreFailures -join '; ')"
    }
  }
  New-CleanupStage -Name 'Remove empty acceptance package directory' -Action {
    if (!$CleanupContext.HasPreflightManifest) {
      throw 'Cannot decide whether the connector package directory predated acceptance.'
    }
    $installedPackageDirectory = Join-Path $ConnectorState 'sql-orders'
    if (!$CleanupContext.PreflightPaths.Contains('sql-orders') -and
        (Test-Path -LiteralPath $installedPackageDirectory) -and
        (Get-ChildItem -Force -LiteralPath $installedPackageDirectory | Measure-Object).Count -eq 0) {
      Remove-Item -LiteralPath $installedPackageDirectory -Force -ErrorAction Stop
    }
  }
  New-CleanupStage -Name 'Remove empty acceptance connector root' -Action {
    if (!$CleanupContext.HasPreflightManifest) {
      throw 'Cannot decide whether the connector root predated acceptance.'
    }
    if (!$CleanupContext.PreflightPaths.Contains('.') -and
        (Test-Path -LiteralPath $ConnectorState) -and
        (Get-ChildItem -Force -LiteralPath $ConnectorState | Measure-Object).Count -eq 0) {
      Remove-Item -LiteralPath $ConnectorState -Force -ErrorAction Stop
    }
  }
  New-CleanupStage -Name 'Remove acceptance artifacts' -Action {
    $artifactFailures = [Collections.Generic.List[string]]::new()
    foreach ($artifact in $AcceptanceArtifacts) {
      try {
        if (Test-Path -LiteralPath $artifact) {
          Remove-Item -LiteralPath $artifact -Force -ErrorAction Stop
        }
      } catch {
        $artifactFailures.Add("$($artifact): $($_.Exception.Message)")
      }
    }
    if ($artifactFailures.Count -gt 0) {
      throw "Acceptance artifact cleanup failed: $($artifactFailures -join '; ')"
    }
  }
  New-CleanupStage -Name 'Remove empty acceptance temp directory' -Action {
    if ((Test-Path -LiteralPath $Acceptance) -and
        (Get-ChildItem -Force -LiteralPath $Acceptance | Measure-Object).Count -gt 0) {
      throw "Unexpected acceptance temp artifact will be preserved under: $Acceptance"
    }
    if (Test-Path -LiteralPath $Acceptance) {
      Remove-Item -LiteralPath $Acceptance -Force -ErrorAction Stop
    }
  }
)

$FinalCleanupStages = @(
  New-CleanupStage -Name 'Verify restored connector manifest, file hashes, and ACLs' -Action {
    if (!$CleanupContext.HasPreflightManifest) {
      throw 'Cannot verify restored connector state without the preflight manifest.'
    }
    $finalManifest = @(Get-ConnectorStateManifest -Root $ConnectorState)
    Assert-ConnectorStateMatches -Expected $CleanupContext.PreflightManifest -Actual $finalManifest
    $CleanupContext.RestorationVerified = $true
    Write-Host 'Complete preflight connector-state snapshot restored'
  }
  New-CleanupStage -Name 'Verify acceptance artifact files' -Action {
    $remainingArtifacts = @($AcceptanceArtifacts | Where-Object { Test-Path -LiteralPath $_ })
    if ($remainingArtifacts.Count -gt 0) {
      throw "Acceptance artifact remains: $($remainingArtifacts -join ', ')"
    }
  }
  New-CleanupStage -Name 'Verify acceptance temp directory' -Action {
    if (Test-Path -LiteralPath $Acceptance) {
      throw "Acceptance temp directory remains: $Acceptance"
    }
  }
  New-CleanupStage -Name 'Verify packaged application processes' -Action {
    Stop-PackagedApplicationProcesses
  }
  New-CleanupStage -Name 'Verify agentd processes and backend port' -Action {
    Stop-AgentdProcessesAndPort
  }
  New-CleanupStage -Name 'Verify backend Compose containers' -Action {
    Invoke-WSLBashScript -Script $BackendContainersVerification -FailureMessage 'Backend Compose container verification failed.'
  }
  New-CleanupStage -Name 'Verify backend Compose networks' -Action {
    Invoke-WSLBashScript -Script $BackendNetworksVerification -FailureMessage 'Backend Compose network verification failed.'
  }
  New-CleanupStage -Name 'Verify SQL Compose containers' -Action {
    Invoke-WSLBashScript -Script $SQLContainersVerification -FailureMessage 'SQL Compose container verification failed.'
  }
  New-CleanupStage -Name 'Verify SQL Compose networks' -Action {
    Invoke-WSLBashScript -Script $SQLNetworksVerification -FailureMessage 'SQL Compose network verification failed.'
  }
  New-CleanupStage -Name 'Verify generated backend data' -Action {
    Invoke-WSLBashScript -Script $BackendDataVerification -FailureMessage 'Generated backend data verification failed.'
  }
  New-CleanupStage -Name 'Verify generated SQL TLS' -Action {
    Invoke-WSLBashScript -Script $SQLTLSVerification -FailureMessage 'Generated SQL TLS verification failed.'
  }
  New-CleanupStage -Name 'List and verify Credential Manager target after deletion' -Action {
    if (!$CleanupContext.CredentialTarget) {
      throw 'Cannot verify the exact Credential Manager target without the acceptance device ID.'
    }
    $credentialListing = Invoke-NativeCapture -FilePath 'cmdkey.exe' -ArgumentList @("/list:$($CleanupContext.CredentialTarget)") -FailureMessage 'Credential Manager post-deletion listing failed.'
    if ($credentialListing -match [regex]::Escape($CleanupContext.CredentialTarget)) {
      throw "Credential Manager target still exists: $($CleanupContext.CredentialTarget)"
    }
  }
  New-CleanupStage -Name 'Verify acceptance package' -Action {
    if (Test-Path -LiteralPath $AcceptancePackage) {
      throw "Acceptance package remains: $AcceptancePackage"
    }
  }
  New-CleanupStage -Name 'Verify scoped Git state' -Action {
    $scopedGitStatus = Invoke-NativeCapture -FilePath 'git.exe' -ArgumentList @('-C', $Repo, 'status', '--short', '--', 'desktop/resources/implementation/platform-public.pem', 'test/sqlserver') -FailureMessage 'Scoped acceptance Git verification failed.'
    if ($scopedGitStatus) {
      throw "Acceptance changed tracked platform-key or SQL-fixture files: $scopedGitStatus"
    }
  }
)

$QuarantineBackupStage = New-CleanupStage -Name 'Quarantine verified sensitive backup' -Action {
  if (!(Test-Path -LiteralPath $StateBackup -PathType Container)) {
    throw "Complete restoration backup is missing before quarantine: $StateBackup"
  }
  if (Test-Path -LiteralPath $StatePurge) {
    throw "Post-restore purge path already exists: $StatePurge"
  }
  Move-Item -LiteralPath $StateBackup -Destination $StatePurge -ErrorAction Stop
  if ((Test-Path -LiteralPath $StateBackup) -or !(Test-Path -LiteralPath $StatePurge -PathType Container)) {
    throw "Atomic backup quarantine did not complete from $StateBackup to $StatePurge"
  }
  $CleanupContext.BackupQuarantined = $true
}
$PurgeBackupStage = New-CleanupStage -Name 'Delete quarantined sensitive backup' -Action {
  Remove-Item -LiteralPath $StatePurge -Recurse -Force -ErrorAction Stop
}
$BackupAbsenceStage = New-CleanupStage -Name 'Verify restoration backup and purge path absent' -Action {
  $remainingBackupPaths = @(@($StateBackup, $StatePurge) | Where-Object { Test-Path -LiteralPath $_ })
  if ($remainingBackupPaths.Count -gt 0) {
    throw "Sensitive restoration backup or post-restore purge remnants remain: $($remainingBackupPaths -join ', ')"
  }
  $CleanupContext.BackupPurgeVerified = $true
}
$CleanupResult = Invoke-CleanupOrchestration `
  -Context $CleanupContext `
  -Errors $CleanupErrors `
  -SafeStages $SafeCleanupStages `
  -FinalStages $FinalCleanupStages `
  -QuarantineStage $QuarantineBackupStage `
  -PurgeStage $PurgeBackupStage `
  -BackupAbsenceStage $BackupAbsenceStage

if (!$CleanupResult.Passed) {
  if (Test-Path -LiteralPath $StateBackup) {
    $ManualRecovery = @"
Manual recovery required. The original restoration backup remains untouched at:
  $StateBackup
Keep the packaged app and agentd stopped. Read manifest.json, restore only the
six isolation paths from the files directory, apply each recorded SDDL with
Set-Acl, and verify every SHA-256 and ACL before removing the backup. Preserve
unexpected unrelated connector state.
"@
  } elseif (Test-Path -LiteralPath $StatePurge) {
    $ManualRecovery = @"
Manual purge required. Exact userData restoration already verified, but
post-restore purge remnants remain at:
  $StatePurge
Do not claim that the original restoration backup was retained. Keep the app
stopped, inspect this exact quarantine path, and securely remove its remnants.
"@
  } else {
    $ManualRecovery = @"
Manual investigation required. Neither the restoration backup nor its tracked
post-restore purge path remains. Use the aggregated stage errors below; do not
claim recovery material is retained.
"@
  }
  $ManualRecovery += @"
Re-run every final process/port, Compose, Credential Manager, artifact,
manifest, hash, ACL, original-backup, and purge-path check before claiming PASS.
"@
  Write-Warning $ManualRecovery
  throw "Cleanup failed in $($CleanupErrors.Count) stage(s):`n - $($CleanupErrors -join "`n - ")`n$ManualRecovery"
}
Write-Host 'Final cleanup verification passed'
```

Do not rebuild with the acceptance key. The cleanup block is successful only if
it prints the sole success marker shown above. Before that line it rechecks the
exact Credential Manager target, packaged processes and backend port, both
Compose projects' containers and networks, the acceptance package and key files,
fixture TLS, backend data, temporary directory, and each userData file. An
original userData file is present only after its recorded SHA-256 and ACL SDDL
match; a path that did not exist before acceptance remains absent. Every cleanup
and verification stage records its own failure and allows later stages to run.
Any pre-purge error leaves the complete original backup untouched. A purge
failure reports the exact tracked quarantine path and never claims that the
original backup was retained; unexpected unrelated state is reported and
preserved.

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
