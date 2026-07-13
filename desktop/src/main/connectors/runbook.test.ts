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

function cleanupStageNames(): string[] {
  return [...cleanupBlock.matchAll(/Invoke-CleanupStage -Name '([^']+)'/g)]
    .map((match) => match[1]);
}

function simulateCleanup(failingStages: ReadonlySet<string>) {
  const attempted: string[] = [];
  const errors: string[] = [];
  for (const name of cleanupStageNames()) {
    if (name === "Delete verified sensitive backup" && errors.length > 0) continue;
    attempted.push(name);
    if (failingStages.has(name)) errors.push(name);
  }
  return { attempted, errors, passed: errors.length === 0 };
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
    expect(runbook).toContain("Acceptance Compose resource remains");
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
    expect(runbook).toContain("Credential Manager listing failed");
    expect(runbook).toContain("Credential Manager verification failed");
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
    const resourceCleanup = runbook.indexOf("Invoke-CleanupStage -Name 'Tear down backend Compose'");
    expect(resourceCleanup).toBeGreaterThan(-1);
    expect(resourceCleanup).toBeLessThan(runbook.indexOf("Invoke-CleanupStage -Name 'Restore preflight connector files and ACLs'", resourceCleanup));
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

  it("aggregates early cleanup failures without skipping exact preflight restoration", () => {
    expect(cleanupBlock).toContain("function Invoke-CleanupStage");
    expect(cleanupBlock).toMatch(/function Invoke-CleanupStage[\s\S]*?try \{[\s\S]*?& \$Action[\s\S]*?\} catch \{[\s\S]*?\$CleanupErrors\.Add/);
    expect(cleanupBlock).not.toContain("$CleanupStages");

    const restoration = "Restore preflight connector files and ACLs";
    const finalVerification = "Verify restored connector manifest, file hashes, and ACLs";
    const failuresBeforeRestoration = [
      "Stop acceptance processes",
      "Remove Credential Manager target",
      "Remove acceptance package",
      "Tear down backend Compose",
      "Tear down SQL Compose",
    ];
    for (const failure of failuresBeforeRestoration) {
      const result = simulateCleanup(new Set([failure]));
      expect(result.attempted, failure).toContain(restoration);
      expect(result.attempted, failure).toContain(finalVerification);
      expect(result.errors, failure).toEqual([failure]);
      expect(result.attempted, failure).not.toContain("Delete verified sensitive backup");
      expect(result.passed, failure).toBe(false);
    }
  });

  it("records unexpected unrelated state but still restores known preflight files", () => {
    const stages = cleanupStageNames();
    const unexpectedState = "Inspect unexpected connector state";
    const restoration = "Restore preflight connector files and ACLs";
    expect(stages.indexOf(unexpectedState)).toBeGreaterThan(-1);
    expect(stages.indexOf(unexpectedState)).toBeLessThan(stages.indexOf(restoration));
    expect(cleanupBlock).toMatch(/Invoke-CleanupStage -Name 'Inspect unexpected connector state'[\s\S]*?Unexpected connector state remains after acceptance/);
    expect(cleanupBlock).not.toMatch(/Unexpected connector state remains after acceptance[\s\S]*?Remove-Item -LiteralPath \$unexpected/);
    expect(cleanupBlock).toMatch(/Invoke-CleanupStage -Name 'Remove acceptance connector temporary files'[\s\S]*?!\$CleanupContext\.PreflightPaths\.Contains/);

    const result = simulateCleanup(new Set([unexpectedState]));
    expect(result.attempted).toContain(restoration);
    expect(result.attempted).toContain("Verify restored connector manifest, file hashes, and ACLs");
    expect(result.passed).toBe(false);
  });

  it("deletes the sensitive backup only after restoration and every final check succeeds", () => {
    const stages = cleanupStageNames();
    const finalChecks = [
      "Verify restored connector manifest, file hashes, and ACLs",
      "Verify acceptance artifacts",
      "Verify acceptance processes and port",
      "Verify backend Compose resources",
      "Verify SQL Compose resources",
      "Verify Credential Manager target",
      "Verify acceptance package",
      "Verify scoped Git state",
    ];
    for (const finalCheck of finalChecks) expect(stages).toContain(finalCheck);

    const runnerEnd = cleanupBlock.indexOf("Invoke-CleanupStage -Name 'Verify scoped Git state'");
    const backupGate = cleanupBlock.indexOf("if ($CleanupErrors.Count -eq 0 -and $CleanupContext.RestorationVerified)", runnerEnd);
    const backupDeletion = cleanupBlock.indexOf("Invoke-CleanupStage -Name 'Delete verified sensitive backup'", backupGate);
    expect(runnerEnd).toBeGreaterThan(-1);
    expect(backupGate).toBeGreaterThan(runnerEnd);
    expect(backupDeletion).toBeGreaterThan(backupGate);
    expect(cleanupBlock.slice(backupGate, backupDeletion)).toContain("$CleanupContext.FinalChecksCompleted");
    expect(cleanupBlock).toMatch(/Delete verified sensitive backup[\s\S]*?Remove-Item -LiteralPath \$StateBackup/);
  });

  it("cannot print the sole PASS marker when cleanup errors accumulated", () => {
    expect(runbook.match(/Final cleanup verification passed/g)).toHaveLength(1);
    expect(cleanupBlock).toMatch(/if \(\$CleanupErrors\.Count -gt 0\) \{[\s\S]*?Manual recovery required[\s\S]*?throw[\s\S]*?\}\r?\nWrite-Host 'Final cleanup verification passed'/);

    const failed = simulateCleanup(new Set(["Remove acceptance package"]));
    expect(failed.errors).toHaveLength(1);
    expect(failed.passed).toBe(false);
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
