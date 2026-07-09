// Renderer view-model types (distinct from the wire types in shared/contract).
import type { Answer } from "../../shared/contract";

export type Role = "user" | "assistant";

export interface Message {
  id: string;
  role: Role;
  text: string;
  tool?: string; // which backend tool answered (badge)
  data?: Record<string, unknown>; // structured result → rendered as a card
  denied?: boolean; // permission refusal → lock treatment
  pending?: boolean; // in-flight (typing indicator)
  ts: number;
}

export interface Thread {
  id: string;
  title: string;
  messages: Message[];
  createdAt: number;
}

/** Mock users mirror testdata/mock-org.yaml (Phase 0 identity switcher). */
export interface MockUser {
  id: string;
  name: string;
  roleLabel: string;
}

export const MOCK_USERS: MockUser[] = [
  { id: "u_sales1", name: "小销售", roleLabel: "销售" },
  { id: "u_smgr", name: "销售经理", roleLabel: "销售 · 主管" },
  { id: "u_boss", name: "总经理", roleLabel: "管理层" },
  { id: "u_plan", name: "计划员", roleLabel: "生产计划" },
  { id: "u_fin", name: "会计", roleLabel: "财务" },
];

export function answerToMessage(a: Answer): Message {
  return {
    id: crypto.randomUUID(),
    role: "assistant",
    text: a.text,
    tool: a.tool,
    data: a.data,
    denied: a.denied,
    ts: Date.now(),
  };
}
