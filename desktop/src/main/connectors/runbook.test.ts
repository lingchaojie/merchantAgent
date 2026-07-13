import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const runbook = readFileSync(
  new URL("../../../../docs/acceptance/m7-1-sql-server.md", import.meta.url),
  "utf8",
);

describe("M7.1 Windows acceptance runbook", () => {
  it("inspects the DPAPI identity without rendering the encrypted private key", () => {
    expect(runbook).toContain("$Identity = $IdentityRaw | ConvertFrom-Json");
    expect(runbook).toContain("[string]::IsNullOrWhiteSpace($Identity.encryptedPrivateKey)");
    expect(runbook).toContain("$IdentityRaw -match '-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'");
    expect(runbook).not.toMatch(/Select-String[^\r\n]*encryptedPrivateKey/);
  });

  it("fails closed while stopping processes and removing all acceptance resources", () => {
    expect(runbook).toContain("$ErrorActionPreference = 'Stop'");
    expect(runbook).not.toMatch(/Remove-Item[^\r\n]*-ErrorAction SilentlyContinue/);
    expect(runbook).toContain("pgrep -f '[g]o run ./cmd/agentd'");
    expect(runbook).toContain("ss -H -ltnp 'sport = :8765'");
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
});
