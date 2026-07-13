import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const runbook = readFileSync(
  new URL("../../../../docs/acceptance/m7-1-sql-server.md", import.meta.url),
  "utf8",
);

const powershellBlocks = [...runbook.matchAll(/```powershell\r?\n([\s\S]*?)\r?\n```/g)]
  .map((match) => match[1]);

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
    expect(runbook).toMatch(/backend[^\r\n]+docker compose down -v --remove-orphans/);
    expect(runbook).toMatch(/test\/sqlserver[^\r\n]+docker compose down -v --remove-orphans/);
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
    expect(runbook).toMatch(/Invoke-NativeCapture[\s\S]*?-FilePath 'cmdkey\.exe'[\s\S]*?\/list:\$CredentialTarget/);
    expect(runbook).toMatch(/Invoke-CheckedNativeCommand[\s\S]*?-FilePath 'cmdkey\.exe'[\s\S]*?\/delete:\$CredentialTarget/);
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
    expect(runbook).toContain("$CleanupVerificationFailures");
    expect(runbook).toContain("if ($HasPreflightManifest)");
    const resourceCleanup = runbook.indexOf("Invoke-WSLBashScript -Script $ResourceCleanup");
    expect(resourceCleanup).toBeGreaterThan(-1);
    expect(resourceCleanup).toBeLessThan(runbook.indexOf("if ($HasPreflightManifest)", resourceCleanup));
    expect(runbook).not.toContain('throw "Preflight state manifest is missing: $StateManifestPath"');
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

  it.skipIf(process.platform !== "win32")("parses every PowerShell block without syntax errors", () => {
    const parser = [
      "$source = [Console]::In.ReadToEnd()",
      "$tokens = $null",
      "$errors = $null",
      "[System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors) | Out-Null",
      "if ($errors.Count -gt 0) { $errors | ForEach-Object { [Console]::Error.WriteLine($_.Message) }; exit 1 }",
    ].join("; ");
    let parsed = spawnSync("pwsh.exe", ["-NoProfile", "-NonInteractive", "-Command", parser], {
      input: powershellBlocks.join("\n\n"),
      encoding: "utf8",
    });
    if ((parsed.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      parsed = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", parser], {
        input: powershellBlocks.join("\n\n"),
        encoding: "utf8",
      });
    }

    expect(parsed.error).toBeUndefined();
    expect(parsed.stderr).toBe("");
    expect(parsed.status).toBe(0);
  });
});
