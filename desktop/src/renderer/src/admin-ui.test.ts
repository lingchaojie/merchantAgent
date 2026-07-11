import { describe, expect, it } from "vitest";
import { moveItem, newSkillDraft } from "./admin-ui";

describe("admin UI state", () => {
  it("moves an item without mutating the input", () => {
    const source = ["a", "b", "c"];

    expect(moveItem(source, 1, -1)).toEqual(["b", "a", "c"]);
    expect(source).toEqual(["a", "b", "c"]);
  });

  it("does not move an item outside the list", () => {
    expect(moveItem(["a", "b"], 0, -1)).toEqual(["a", "b"]);
    expect(moveItem(["a", "b"], 1, 1)).toEqual(["a", "b"]);
  });

  it("creates an empty tenant-scoped skill draft", () => {
    expect(newSkillDraft("mock-corp-001")).toEqual({
      tenantId: "mock-corp-001",
      skillId: "",
      name: "",
      description: "",
      playbookMd: "",
      allowedTools: [],
      dataDomains: [],
      roles: [],
    });
  });
});
