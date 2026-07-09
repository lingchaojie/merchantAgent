// Path-sandboxed local file access — the security-critical piece of the shell
// (research/07 §8.5). The agent can only read/write inside one allowed root;
// ../ traversal and absolute paths are rejected; overwriting an existing file
// requires explicit prior user consent (confirmed=true), captured by the UI.
import fs from "node:fs";
import path from "node:path";

export class Sandbox {
  readonly root: string;

  constructor(root: string) {
    // Resolve to an absolute, symlink-free root so later checks can't be fooled.
    this.root = fs.realpathSync(root);
  }

  // resolve joins a caller-supplied relative path and verifies it stays inside
  // root (lexical .. handling via path.resolve + a boundary check).
  resolve(rel: string): string {
    if (typeof rel !== "string" || rel.length === 0) {
      throw new Error("path required");
    }
    const abs = path.resolve(this.root, rel);
    if (abs !== this.root && !abs.startsWith(this.root + path.sep)) {
      throw new Error(`path ${JSON.stringify(rel)} escapes the sandbox root`);
    }
    return abs;
  }

  read(rel: string): string {
    return fs.readFileSync(this.resolve(rel), "utf8");
  }

  // write refuses to overwrite unless confirmed — destructive-action gate.
  write(rel: string, contents: string, confirmed = false): string {
    const abs = this.resolve(rel);
    if (fs.existsSync(abs) && !confirmed) {
      throw new Error("overwrite requires confirmation");
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents);
    return abs;
  }
}
