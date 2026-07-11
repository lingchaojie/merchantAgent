import type { Skill } from "./admin";

export function moveItem<T>(items: T[], index: number, delta: -1 | 1): T[] {
  const target = index + delta;
  if (index < 0 || index >= items.length || target < 0 || target >= items.length) {
    return [...items];
  }
  const next = [...items];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

export function newSkillDraft(tenantId: string): Skill {
  return {
    tenantId,
    skillId: "",
    name: "",
    description: "",
    playbookMd: "",
    allowedTools: [],
    dataDomains: [],
    roles: [],
  };
}
