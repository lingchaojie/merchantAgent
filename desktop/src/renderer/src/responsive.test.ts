import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./app.css", import.meta.url), "utf8");
const workbenchCss = readFileSync(new URL("./workbench/workbench.css", import.meta.url), "utf8");
const mobile = css.slice(css.lastIndexOf("@media (max-width: 760px)"));

describe("mobile shell CSS", () => {
  it("stacks the fixed sidebar above the main content", () => {
    expect(mobile).toMatch(/\.layout\s*\{[^}]*grid-template-columns:\s*1fr;/s);
    expect(mobile).toMatch(/\.layout\s*\{[^}]*grid-template-rows:\s*52px minmax\(0,\s*1fr\);/s);
    expect(mobile).toMatch(/\.sidebar\s*\{[^}]*border-bottom:/s);
  });

  it("keeps identity controls but removes the desktop thread list", () => {
    expect(mobile).toMatch(/\.thread-list\s*\{[^}]*display:\s*none;/s);
    expect(mobile).toMatch(/\.side-foot\s*\{[^}]*border-top:\s*0;/s);
  });

  it("allows long admin subjects to wrap", () => {
    expect(mobile).toMatch(/\.pane-row code\s*\{[^}]*overflow-wrap:\s*anywhere;/s);
  });

  it("keeps connector contracts and top-bar actions inside narrow windows", () => {
    expect(mobile).toMatch(/\.connectors-pane\s*\{[^}]*max-width:\s*100%;/s);
    expect(mobile).toMatch(/\.connector-meta\s*\{[^}]*grid-template-columns:\s*1fr;/s);
    expect(mobile).toMatch(/\.topbar-right\s*\{[^}]*min-width:\s*0;/s);
  });

  it("contains long Workbench session and header text", () => {
    expect(workbenchCss).toMatch(/\.wb-topbar\s*>\s*div\s*\{[^}]*min-width:\s*0;/s);
    expect(workbenchCss).toMatch(/\.wb-session\s+span\s*\{[^}]*overflow-wrap:\s*anywhere;/s);
  });
});
