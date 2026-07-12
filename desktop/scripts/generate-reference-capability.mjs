import { generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.resolve(
  desktopRoot,
  "../backend/connector/clientexec/reference_manifest.json",
);
const outputDirectory = path.join(desktopRoot, "resources/capabilities");
const packagePath = path.join(outputDirectory, "reference-manufacturing.cap.json");
const publicKeyPath = path.join(outputDirectory, "reference-public.pem");

const payload = readFileSync(manifestPath);
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const signature = sign(null, payload, privateKey);
const manifestDigest = `sha256:${createHash("sha256").update(payload).digest("hex")}`;

mkdirSync(outputDirectory, { recursive: true });
writeFileSync(
  packagePath,
  `${JSON.stringify({
    payload: payload.toString("base64"),
    signature: signature.toString("base64"),
    manifestDigest,
  })}\n`,
  "utf8",
);
writeFileSync(
  publicKeyPath,
  publicKey.export({ type: "spki", format: "pem" }),
  { encoding: "utf8", mode: 0o644 },
);
