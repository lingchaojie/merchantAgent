import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const runbook = readFileSync(
  new URL("../../../../docs/acceptance/m7-1-sql-server.md", import.meta.url),
  "utf8",
);

const powershellBlocks = [...runbook.matchAll(/```powershell\r?\n([\s\S]*?)\r?\n```/g)]
  .map((match) => match[1]);
const embeddedBashBlocks = [
  ...[...runbook.matchAll(/```bash\r?\n([\s\S]*?)\r?\n```/g)].map((match) => match[1]),
  ...[...runbook.matchAll(/\$\w+\s*=\s*@'\r?\n([\s\S]*?)\r?\n'@/g)].map((match) => match[1]),
];
const cleanupBlock = powershellBlocks.find((block) => block.includes("Final cleanup verification passed"))
  ?? "";

const cleanupOrchestration = cleanupBlock.match(
  /# BEGIN EXTRACTABLE CLEANUP ORCHESTRATION\r?\n([\s\S]*?)# END EXTRACTABLE CLEANUP ORCHESTRATION/,
)?.[1] ?? "";

function stageNamesBetween(start: string, end: string): string[] {
  const startIndex = cleanupBlock.indexOf(start);
  const endIndex = cleanupBlock.indexOf(end, startIndex + start.length);
  if (startIndex < 0 || endIndex < 0) return [];
  return [...cleanupBlock.slice(startIndex, endIndex).matchAll(/(?:Name\s*=|-Name)\s*'([^']+)'/g)]
    .map((match) => match[1]);
}

const safeCleanupStageNames = stageNamesBetween("$SafeCleanupStages = @(", "$FinalCleanupStages = @(");
const finalCleanupStageNames = stageNamesBetween("$FinalCleanupStages = @(", "$QuarantineBackupStage =");

function powerShellStringArray(values: readonly string[]): string {
  return values.map((value) => `'${value.replaceAll("'", "''")}'`).join(", ");
}

function runPowerShell(script: string) {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  let result = spawnSync("pwsh.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
    encoding: "utf8",
  });
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
    result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
      encoding: "utf8",
    });
  }
  expect(result.error).toBeUndefined();
  const progressOnly = result.stderr.startsWith("#< CLIXML")
    && result.stderr.includes('S="progress"')
    && !result.stderr.includes('<S S="Error">');
  expect(progressOnly ? "" : result.stderr).toBe("");
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout.trim()) as unknown;
}

type SyntheticCleanupResult = {
  failure: string;
  attempted: string[];
  errors: string[];
  passed: boolean;
  restorationVerified: boolean;
  finalChecksCompleted: boolean;
  originalBackupPresent: boolean;
  purgePathPresent: boolean;
  backupPurgeVerified: boolean;
};

let cachedSyntheticCleanupScenarios: SyntheticCleanupResult[] | undefined;

function runSyntheticCleanupScenarios(): SyntheticCleanupResult[] {
  if (cachedSyntheticCleanupScenarios) return cachedSyntheticCleanupScenarios;
  const script = String.raw`
$ErrorActionPreference = 'Stop'
${cleanupOrchestration}
$SafeNames = @(${powerShellStringArray(safeCleanupStageNames)})
$FinalNames = @(${powerShellStringArray(finalCleanupStageNames)})
function New-SyntheticStage {
  param(
    [Parameter(Mandatory)] [string] $Name,
    [Parameter(Mandatory)] [Collections.IDictionary] $Context,
    [Parameter(Mandatory)] [AllowEmptyCollection()] [Collections.Generic.List[string]] $Attempted,
    [Parameter(Mandatory)] [AllowEmptyCollection()] [Collections.Generic.HashSet[string]] $Failing
  )
  $action = {
    $Attempted.Add($Name)
    if ($Failing.Contains($Name)) { throw "injected failure: $Name" }
    if ($Name -eq 'Verify restored connector manifest, file hashes, and ACLs') {
      $Context.RestorationVerified = $true
    }
  }.GetNewClosure()
  return [pscustomobject]@{ Name = $Name; Action = $action }
}
function Invoke-SyntheticScenario {
  param([Parameter(Mandatory)] [AllowEmptyCollection()] [string[]] $Failures)
  $attempted = [Collections.Generic.List[string]]::new()
  $failing = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
  foreach ($failure in $Failures) { [void] $failing.Add($failure) }
  $context = [ordered]@{
    RestorationVerified = $false
    FinalChecksCompleted = $false
    BackupQuarantined = $false
    BackupPurgeVerified = $false
    OriginalBackupPresent = $true
    PurgePathPresent = $false
  }
  $errors = [Collections.Generic.List[string]]::new()
  $safeStages = @($SafeNames | ForEach-Object { New-SyntheticStage -Name $_ -Context $context -Attempted $attempted -Failing $failing })
  $finalStages = @($FinalNames | ForEach-Object { New-SyntheticStage -Name $_ -Context $context -Attempted $attempted -Failing $failing })
  $quarantineAction = {
    $attempted.Add('quarantine-backup')
    if ($failing.Contains('quarantine-backup')) { throw 'injected failure: quarantine-backup' }
    $context.OriginalBackupPresent = $false
    $context.PurgePathPresent = $true
    $context.BackupQuarantined = $true
  }.GetNewClosure()
  $purgeAction = {
    $attempted.Add('purge-quarantine')
    if ($failing.Contains('purge-quarantine')) { throw 'injected failure: purge-quarantine' }
    $context.PurgePathPresent = $false
  }.GetNewClosure()
  $absenceAction = {
    $attempted.Add('verify-backup-paths-absent')
    if ($context.OriginalBackupPresent -or $context.PurgePathPresent) {
      throw 'backup or quarantine path remains'
    }
    $context.BackupPurgeVerified = $true
  }.GetNewClosure()
  $parameters = @{
    Context = $context
    Errors = $errors
    SafeStages = $safeStages
    FinalStages = $finalStages
    QuarantineStage = [pscustomobject]@{ Name = 'quarantine-backup'; Action = $quarantineAction }
    PurgeStage = [pscustomobject]@{ Name = 'purge-quarantine'; Action = $purgeAction }
    BackupAbsenceStage = [pscustomobject]@{ Name = 'verify-backup-paths-absent'; Action = $absenceAction }
  }
  $result = Invoke-CleanupOrchestration @parameters
  return [pscustomobject]@{
    failure = ($Failures -join ',')
    attempted = @($attempted)
    errors = @($result.Errors)
    passed = $result.Passed
    restorationVerified = $context.RestorationVerified
    finalChecksCompleted = $context.FinalChecksCompleted
    originalBackupPresent = $context.OriginalBackupPresent
    purgePathPresent = $context.PurgePathPresent
    backupPurgeVerified = $context.BackupPurgeVerified
  }
}
$results = @()
foreach ($failure in @($SafeNames + $FinalNames)) {
  $results += Invoke-SyntheticScenario -Failures @($failure)
}
$results += Invoke-SyntheticScenario -Failures @($SafeNames[0], $FinalNames[-1])
$results += Invoke-SyntheticScenario -Failures @('quarantine-backup')
$results += Invoke-SyntheticScenario -Failures @('purge-quarantine')
$results += Invoke-SyntheticScenario -Failures @()
ConvertTo-Json -Compress -Depth 8 -InputObject @($results)
`;
  cachedSyntheticCleanupScenarios = runPowerShell(script) as SyntheticCleanupResult[];
  return cachedSyntheticCleanupScenarios;
}

describe("M7.1 Windows acceptance runbook", () => {
  it("inspects the DPAPI identity without rendering the encrypted private key", () => {
    expect(runbook).toContain("$Identity = $IdentityRaw | ConvertFrom-Json");
    expect(runbook).toContain("[string]::IsNullOrWhiteSpace($Identity.encryptedPrivateKey)");
    expect(runbook).toContain("$IdentityRaw -match '-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'");
    expect(runbook).not.toMatch(/Select-String[^\r\n]*encryptedPrivateKey/);
  });

  it("fails closed while stopping processes and removing all acceptance resources", () => {
    expect(runbook).toContain("$ErrorActionPreference = 'Stop'");
    expect(runbook).toContain("$PSNativeCommandUseErrorActionPreference = $true");
    expect(runbook).toContain("function Invoke-CheckedNativeCommand");
    expect(runbook).toContain("function Invoke-NativeCapture");
    expect(runbook).toContain("if ($exitCode -ne 0) { throw");
    expect(runbook).not.toMatch(/Remove-Item[^\r\n]*-ErrorAction SilentlyContinue/);
    expect(runbook).toContain("capture_optional_pgrep go_run '[g]o run ./cmd/agentd'");
    expect(runbook).toContain("capture_required listeners ss -H -ltnp 'sport = :8765'");
    expect(runbook).toContain("agentd still owns backend port 8765");
    expect(runbook).toContain("function Invoke-WSLBashScript");
    expect(runbook).toContain("[Convert]::ToBase64String");
    expect(runbook).toMatch(/desktop-local-tools\/backend\r?\ndocker compose down -v --remove-orphans/);
    expect(runbook).toMatch(/desktop-local-tools\/test\/sqlserver\r?\ndocker compose down -v --remove-orphans/);
    expect(runbook).toContain("com.docker.compose.project=backend");
    expect(runbook).toContain("com.docker.compose.project=sqlserver");
    expect(runbook).toContain("$AcceptanceArtifacts");
    expect(runbook).toContain("Acceptance artifact remains");
    expect(runbook).toContain("Acceptance userData state remains");
    expect(runbook).toContain("Acceptance Compose containers remain");
    expect(runbook).toContain("Acceptance Compose networks remain");
    expect(runbook).toContain("Cannot verify the exact Credential Manager target");
    expect(runbook).toContain("Final cleanup verification passed");
  });

  it("routes every critical PowerShell native command through fail-closed helpers", () => {
    for (const executable of ["wsl.exe", "npm.cmd", "git.exe", "icacls.exe", "cmdkey.exe"]) {
      expect(runbook).toContain(`-FilePath '${executable}'`);
    }
    expect(runbook).not.toMatch(/^\s*(?:wsl\.exe|npm(?:\.cmd)?|git(?:\.exe)?|icacls\.exe|cmdkey\.exe)\b/gm);
    expect(runbook).toMatch(/Invoke-NativeCapture[\s\S]*?-FilePath 'cmdkey\.exe'[\s\S]*?\/list:\$\(\$CleanupContext\.CredentialTarget\)/);
    expect(runbook).toMatch(/Invoke-CheckedNativeCommand[\s\S]*?-FilePath 'cmdkey\.exe'[\s\S]*?\/delete:\$\(\$CleanupContext\.CredentialTarget\)/);
    expect(runbook).toContain("Credential Manager pre-deletion listing failed");
    expect(runbook).toContain("Credential Manager post-deletion listing failed");
    expect(runbook).toContain("capture_optional_pgrep");
    expect(runbook).toContain("capture_required");
  });

  it("uses bounded Compose-derived SQL readiness with diagnostics and an outer cleanup route", () => {
    expect(runbook).toContain("docker compose ps -q sqlserver");
    expect(runbook).not.toContain("sqlserver-sqlserver-1");
    expect(runbook).toContain("readiness_deadline=$((SECONDS + 120))");
    expect(runbook).toContain("docker compose ps");
    expect(runbook).toContain("docker compose logs --no-color --tail 200 sqlserver");
    expect(runbook).toContain("SQL Server did not become healthy before the readiness deadline");
    expect(runbook).toContain("Run Step 9 cleanup even after this failure");
    expect(runbook).toMatch(/try \{[\s\S]*?\$SQLReadyScript[\s\S]*?\} catch \{[\s\S]*?Step 9 cleanup[\s\S]*?\} finally \{/);
    expect(runbook).toContain("$CleanupErrors");
    expect(runbook).toContain("if (!$CleanupContext.HasPreflightManifest)");
    const resourceCleanup = runbook.indexOf("New-CleanupStage -Name 'Tear down backend Compose'");
    expect(resourceCleanup).toBeGreaterThan(-1);
    expect(resourceCleanup).toBeLessThan(runbook.indexOf("New-CleanupStage -Name 'Restore preflight connector files and ACLs'", resourceCleanup));
  });

  it("snapshots and restores the complete connector directory without deleting unrelated state", () => {
    expect(runbook).toContain("function Get-ConnectorStateManifest");
    expect(runbook).toContain("[IO.Path]::GetRelativePath");
    expect(runbook).toContain("Get-FileHash -Algorithm SHA256");
    expect(runbook).toContain("Get-Acl -LiteralPath");
    expect(runbook).toContain("Backup hash differs before isolation");
    expect(runbook).toContain("device-identity\\.json\\.\\d+\\.[0-9a-fA-F-]+\\.tmp");
    expect(runbook).toContain("1\\.0\\.0\\.ma-connector\\.\\d+\\.[0-9a-fA-F-]+\\.tmp");
    expect(runbook).toContain("Unexpected connector state remains after restore");
    expect(runbook).toContain("Compare-Object");
    expect(runbook).toContain("Complete preflight connector-state snapshot restored");
    expect(runbook).not.toContain("Remove every file under $ConnectorState");
  });

  it("defines independently aggregated safe and final cleanup stages", () => {
    expect(cleanupOrchestration).toContain("function Invoke-CleanupOrchestration");
    expect(cleanupOrchestration).toMatch(/foreach \(\$stage in \$SafeStages\)[\s\S]*?foreach \(\$stage in \$FinalStages\)/);
    expect(cleanupOrchestration).toMatch(/try \{[\s\S]*?& \$action[\s\S]*?\} catch \{[\s\S]*?\$Errors\.Add/);

    for (const stage of [
      "Stop packaged application processes",
      "Stop agentd processes and backend port",
      "List Credential Manager target before deletion",
      "Delete exact Credential Manager target",
      "Tear down backend Compose",
      "Tear down SQL Compose",
      "Remove generated backend data",
      "Remove generated SQL TLS",
      "Restore preflight connector files and ACLs",
    ]) expect(safeCleanupStageNames).toContain(stage);
    for (const stage of [
      "Verify restored connector manifest, file hashes, and ACLs",
      "Verify acceptance artifact files",
      "Verify acceptance temp directory",
      "Verify packaged application processes",
      "Verify agentd processes and backend port",
      "Verify backend Compose containers",
      "Verify backend Compose networks",
      "Verify SQL Compose containers",
      "Verify SQL Compose networks",
      "Verify generated backend data",
      "Verify generated SQL TLS",
      "List and verify Credential Manager target after deletion",
      "Verify acceptance package",
      "Verify scoped Git state",
    ]) expect(finalCleanupStageNames).toContain(stage);
    expect(cleanupBlock).not.toContain("$GeneratedResourceCleanup");
    expect(cleanupBlock).not.toContain("$GeneratedResourceVerification");
  });

  it.skipIf(process.platform !== "win32")("executes the exact orchestration and continues after every safe or final failure", () => {
    const results = runSyntheticCleanupScenarios();
    const declaredStages = [...safeCleanupStageNames, ...finalCleanupStageNames];
    const injected = results.filter((result) => declaredStages.includes(result.failure));
    expect(injected).toHaveLength(declaredStages.length);
    for (const result of injected) {
      expect(result.attempted, result.failure).toEqual(declaredStages);
      expect(result.errors, result.failure).toHaveLength(1);
      expect(result.errors[0], result.failure).toContain(`[${result.failure}]`);
      expect(result.finalChecksCompleted, result.failure).toBe(true);
      expect(result.attempted, result.failure).not.toContain("quarantine-backup");
      expect(result.originalBackupPresent, result.failure).toBe(true);
      expect(result.passed, result.failure).toBe(false);
    }
  });

  it.skipIf(process.platform !== "win32")("aggregates multiple errors and gates backup purge on exact restoration plus clean final checks", () => {
    const results = runSyntheticCleanupScenarios();
    const multipleFailure = `${safeCleanupStageNames[0]},${finalCleanupStageNames.at(-1)}`;
    const multiple = results.find((result) => result.failure === multipleFailure);
    expect(multiple?.errors).toHaveLength(2);
    expect(multiple?.attempted).toEqual([...safeCleanupStageNames, ...finalCleanupStageNames]);
    expect(multiple?.restorationVerified).toBe(true);
    expect(multiple?.originalBackupPresent).toBe(true);
    expect(multiple?.purgePathPresent).toBe(false);
    expect(multiple?.passed).toBe(false);

    const restorationFailure = results.find((result) => (
      result.failure === "Verify restored connector manifest, file hashes, and ACLs"
    ));
    expect(restorationFailure?.restorationVerified).toBe(false);
    expect(restorationFailure?.attempted).not.toContain("quarantine-backup");
  });

  it.skipIf(process.platform !== "win32")("tracks post-restore purge remnants and requires both backup paths absent for PASS", () => {
    const results = runSyntheticCleanupScenarios();
    const quarantineFailure = results.find((result) => result.failure === "quarantine-backup");
    expect(quarantineFailure?.attempted).toContain("verify-backup-paths-absent");
    expect(quarantineFailure?.attempted).not.toContain("purge-quarantine");
    expect(quarantineFailure?.originalBackupPresent).toBe(true);
    expect(quarantineFailure?.passed).toBe(false);

    const purgeFailure = results.find((result) => result.failure === "purge-quarantine");
    expect(purgeFailure?.attempted).toEqual(expect.arrayContaining([
      "quarantine-backup",
      "purge-quarantine",
      "verify-backup-paths-absent",
    ]));
    expect(purgeFailure?.originalBackupPresent).toBe(false);
    expect(purgeFailure?.purgePathPresent).toBe(true);
    expect(purgeFailure?.errors).toHaveLength(2);
    expect(purgeFailure?.passed).toBe(false);

    const success = results.find((result) => result.failure === "");
    expect(success?.attempted.slice(-3)).toEqual([
      "quarantine-backup",
      "purge-quarantine",
      "verify-backup-paths-absent",
    ]);
    expect(success?.errors).toEqual([]);
    expect(success?.originalBackupPresent).toBe(false);
    expect(success?.purgePathPresent).toBe(false);
    expect(success?.backupPurgeVerified).toBe(true);
    expect(success?.passed).toBe(true);
  });

  it("reports restoration backups separately from post-restore purge remnants and gates the sole PASS marker", () => {
    expect(runbook.match(/Final cleanup verification passed/g)).toHaveLength(1);
    expect(cleanupBlock).toContain("Move-Item -LiteralPath $StateBackup -Destination $StatePurge -ErrorAction Stop");
    expect(cleanupBlock).toContain("post-restore purge remnants remain at:");
    expect(cleanupBlock).toContain("The original restoration backup remains untouched at:");
    expect(cleanupBlock).not.toContain("The sensitive preflight backup was retained at:");
    expect(cleanupBlock).toMatch(/if \(!\$CleanupResult\.Passed\)[\s\S]*?throw[\s\S]*?\}\r?\nWrite-Host 'Final cleanup verification passed'/);
  });

  it.skipIf(process.platform !== "win32")("parses every PowerShell block without syntax errors", () => {
    const parser = [
      "$source = [Console]::In.ReadToEnd()",
      "$tokens = $null",
      "$errors = $null",
      "[System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors) | Out-Null",
      "if ($errors.Count -gt 0) { $errors | ForEach-Object { [Console]::Error.WriteLine($_.Message) }; exit 1 }",
    ].join("; ");
    for (const [index, block] of powershellBlocks.entries()) {
      let parsed = spawnSync("pwsh.exe", ["-NoProfile", "-NonInteractive", "-Command", parser], {
        input: block,
        encoding: "utf8",
      });
      if ((parsed.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
        parsed = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", parser], {
          input: block,
          encoding: "utf8",
        });
      }

      expect(parsed.error, `PowerShell block ${index + 1}`).toBeUndefined();
      expect(parsed.stderr, `PowerShell block ${index + 1}`).toBe("");
      expect(parsed.status, `PowerShell block ${index + 1}`).toBe(0);
    }
  });

  it.skipIf(process.platform !== "win32")("parses every embedded Bash block without executing it", () => {
    expect(embeddedBashBlocks.length).toBeGreaterThanOrEqual(5);
    for (const [index, block] of embeddedBashBlocks.entries()) {
      const parsed = spawnSync("wsl.exe", ["-e", "bash", "-n"], {
        input: block,
        encoding: "utf8",
      });
      expect(parsed.error, `Bash block ${index + 1}`).toBeUndefined();
      expect(parsed.stderr, `Bash block ${index + 1}`).toBe("");
      expect(parsed.status, `Bash block ${index + 1}`).toBe(0);
    }
  });
});
