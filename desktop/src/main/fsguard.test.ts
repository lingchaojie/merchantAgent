// Hermetic tests for the path sandbox — the security-critical logic. Runs under
// vitest, no Electron needed.
import { test, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Sandbox } from "./fsguard";

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fsguard-"));
}

test("read/write inside root works", () => {
  const sb = new Sandbox(tmpRoot());
  sb.write("notes/a.txt", "hello");
  expect(sb.read("notes/a.txt")).toBe("hello");
});

test("../ traversal is rejected", () => {
  const sb = new Sandbox(tmpRoot());
  expect(() => sb.read("../etc/passwd")).toThrow(/escapes the sandbox/);
  expect(() => sb.write("../../evil.txt", "x")).toThrow(/escapes the sandbox/);
});

test("absolute path is rejected", () => {
  const sb = new Sandbox(tmpRoot());
  expect(() => sb.write("/etc/evil.txt", "x")).toThrow(/escapes the sandbox/);
});

test("overwrite requires confirmation", () => {
  const sb = new Sandbox(tmpRoot());
  sb.write("f.txt", "v1");
  expect(() => sb.write("f.txt", "v2")).toThrow(/overwrite requires confirmation/);
  sb.write("f.txt", "v2", true);
  expect(sb.read("f.txt")).toBe("v2");
});

test("sibling-of-root prefix is not treated as inside root", () => {
  const base = tmpRoot();
  const root = path.join(base, "root");
  fs.mkdirSync(root);
  fs.mkdirSync(path.join(base, "rootX"));
  const sb = new Sandbox(root);
  expect(() => sb.write("../rootX/f.txt", "x")).toThrow(/escapes the sandbox/);
});
