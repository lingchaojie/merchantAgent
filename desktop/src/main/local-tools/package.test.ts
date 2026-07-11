import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyCapabilityPackage } from "./package";

const desktopRoot = path.resolve(import.meta.dirname, "../../..");
const repositoryRoot = path.resolve(desktopRoot, "..");
const packagePath = path.join(
  desktopRoot,
  "resources/capabilities/reference-manufacturing.cap.json",
);
const publicKeyPath = path.join(desktopRoot, "resources/capabilities/reference-public.pem");
const temporaryDirectories: string[] = [];

function loadReferencePackage() {
  return verifyCapabilityPackage(packagePath, publicKeyPath);
}

function copyPackage(mutator: (capability: Record<string, string>) => void): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "capability-test-"));
  temporaryDirectories.push(directory);
  const copyPath = path.join(directory, "capability.json");
  const capability = JSON.parse(fs.readFileSync(packagePath, "utf8")) as Record<string, string>;
  mutator(capability);
  fs.writeFileSync(copyPath, JSON.stringify(capability), "utf8");
  return copyPath;
}

function replaceSignedPayload(mutator: (manifest: Record<string, unknown>) => void): string {
  return copyPackage((capability) => {
    const manifest = JSON.parse(Buffer.from(capability.payload, "base64").toString("utf8")) as Record<
      string,
      unknown
    >;
    mutator(manifest);
    capability.payload = Buffer.from(JSON.stringify(manifest), "utf8").toString("base64");
  });
}

function writeSignedManifest(manifest: unknown): { packagePath: string; publicKeyPath: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "signed-capability-test-"));
  temporaryDirectories.push(directory);
  const signedPackagePath = path.join(directory, "capability.json");
  const signedPublicKeyPath = path.join(directory, "public.pem");
  const payload = Buffer.from(JSON.stringify(manifest), "utf8");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  fs.writeFileSync(
    signedPackagePath,
    JSON.stringify({
      payload: payload.toString("base64"),
      signature: sign(null, payload, privateKey).toString("base64"),
      manifestDigest: `sha256:${createHash("sha256").update(payload).digest("hex")}`,
    }),
    "utf8",
  );
  fs.writeFileSync(
    signedPublicKeyPath,
    publicKey.export({ type: "spki", format: "pem" }),
    "utf8",
  );
  return { packagePath: signedPackagePath, publicKeyPath: signedPublicKeyPath };
}

function backendManifestDigest(): string {
  const directory = fs.mkdtempSync(path.join(repositoryRoot, "backend", ".digest-test-"));
  temporaryDirectories.push(directory);
  const sourcePath = path.join(directory, "main.go");
  fs.writeFileSync(
    sourcePath,
    `package main
import (
  "fmt"
  "github.com/merchantagent/backend/connector/clientexec"
)
func main() {
  tools := clientexec.NewReference().Tools()
  fmt.Print(tools[0].Spec().ManifestDigest)
}
`,
    "utf8",
  );
  if (process.platform === "win32") {
    const toWslPath = (windowsPath: string) => {
      const normalized = windowsPath.replaceAll("\\", "/");
      return `/mnt/${normalized[0].toLowerCase()}${normalized.slice(2)}`;
    };
    return execFileSync(
      "wsl.exe",
      [
        "-e",
        "bash",
        "-lc",
        `cd '${toWslPath(path.join(repositoryRoot, "backend"))}' && go run '${toWslPath(sourcePath)}'`,
      ],
      { encoding: "utf8" },
    ).trim();
  }
  return execFileSync("go", ["run", sourcePath], {
    cwd: path.join(repositoryRoot, "backend"),
    encoding: "utf8",
  }).trim();
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("verifyCapabilityPackage", () => {
  it("accepts the signed reference package", () => {
    expect(loadReferencePackage().manifest).toMatchObject({
      packageId: "reference-manufacturing",
      version: "1.0.0",
      tools: [{ name: "query_order_status" }, { name: "report_production_progress" }],
    });
  });

  it("matches the digest published by the backend reference tool catalog", () => {
    expect(loadReferencePackage().manifestDigest).toBe(backendManifestDigest());
  });

  it.each(["payload", "signature", "manifestDigest"])("rejects tampered %s", (field) => {
    const tampered = copyPackage((capability) => {
      capability[field] = `${capability[field]}tampered`;
    });

    expect(() => verifyCapabilityPackage(tampered, publicKeyPath)).toThrow(/package_integrity/);
  });

  it("rejects a version changed inside the signed payload", () => {
    const tampered = replaceSignedPayload((manifest) => {
      manifest.version = "2.0.0";
    });

    expect(() => verifyCapabilityPackage(tampered, publicKeyPath)).toThrow(/package_integrity/);
  });

  it("reports a signed but unsupported package version", () => {
    const verified = loadReferencePackage();
    expect(() =>
      verified.requireTool(
        verified.manifest.packageId,
        "2.0.0",
        verified.manifestDigest,
        "query_order_status",
      ),
    ).toThrow(/package_version/);
  });

  it("reports tools outside the signed allowlist as not installed", () => {
    const verified = loadReferencePackage();
    expect(() =>
      verified.requireTool(
        verified.manifest.packageId,
        verified.manifest.version,
        verified.manifestDigest,
        "execute_sql",
      ),
    ).toThrow(/tool_not_installed/);
  });

  it.each([
    [
      "duplicate tool names",
      (manifest: ReturnType<typeof loadReferencePackage>["manifest"]) => {
        manifest.tools.push(structuredClone(manifest.tools[0]));
      },
    ],
    [
      "high-write tools",
      (manifest: ReturnType<typeof loadReferencePackage>["manifest"]) => {
        (manifest.tools[0] as unknown as { risk: string }).risk = "high_write";
      },
    ],
    [
      "malformed parameter schemas",
      (manifest: ReturnType<typeof loadReferencePackage>["manifest"]) => {
        manifest.tools[0].parameters.required = ["undeclared"];
      },
    ],
    [
      "prototype-sensitive parameter names",
      (manifest: ReturnType<typeof loadReferencePackage>["manifest"]) => {
        manifest.tools[0].parameters.properties = JSON.parse(
          '{"__proto__":{"type":"string"}}',
        ) as typeof manifest.tools[0]["parameters"]["properties"];
        manifest.tools[0].parameters.required = ["__proto__"];
      },
    ],
  ] as const)("rejects validly signed %s", (_name, mutate) => {
    const manifest = structuredClone(loadReferencePackage().manifest);
    mutate(manifest);
    const signed = writeSignedManifest(manifest);

    expect(() => verifyCapabilityPackage(signed.packagePath, signed.publicKeyPath)).toThrow(
      /package_integrity/,
    );
  });
});
