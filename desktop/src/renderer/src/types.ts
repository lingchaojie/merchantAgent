// Renderer view-model types (distinct from the wire types in shared/contract).
import type { ChatEvent } from "../../shared/contract";

export type Role = "user" | "assistant";

export interface Message {
  id: string;
  role: Role;
  text: string;
  tool?: string; // last backend tool used this turn (badge)
  data?: Record<string, unknown>; // last structured result → rendered as a card
  denied?: boolean; // a guard refusal occurred during the turn
  pending?: boolean; // in-flight (typing indicator)
  status?: string; // live status line while streaming (e.g. "调用 订单进度…")
  ts: number;
}

export interface Thread {
  id: string;
  title: string;
  sessionId: string; // server-side per-session history key
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

// Human labels for the live status line as tools stream in.
const TOOL_LABEL: Record<string, string> = {
  load_skill: "加载技能",
  query_order_status: "订单进度",
  query_order_financials: "订单财务",
  check_material_kitting: "齐套检查",
  query_customer_orders: "客户订单",
  query_customer_contacts: "客户联系人",
  query_customer_followups: "客户跟进",
  query_customer_opportunities: "客户商机",
  report_production_progress: "生产进度",
};

function executionStatusText(tool: string | undefined, status: unknown): string {
  const label = TOOL_LABEL[tool ?? ""] ?? tool ?? "本地工具";
  switch (status) {
    case "executing":
      return `正在执行 ${label}…`;
    case "succeeded":
      return `${label}执行成功（已验证）`;
    case "failed":
      return `${label}执行失败`;
    case "cancelled":
      return `${label}执行已取消`;
    case "source_conflict":
      return `${label}数据已变化，请重试`;
    default:
      return `${label}结果待确认`;
  }
}

// foldEvent folds one streamed ChatEvent into the in-flight assistant message.
// tool_result data + tool name drive the ResultCard; final sets the text; a
// denied event flags the turn (unless a later result supersedes the card).
export function foldEvent(m: Message, e: ChatEvent): Message {
  switch (e.kind) {
    case "tool_call":
      return { ...m, status: `调用 ${TOOL_LABEL[e.tool ?? ""] ?? e.tool ?? ""}…` };
    case "skill_loaded":
      return { ...m, status: `已加载技能 ${e.tool ?? ""}` };
    case "tool_result":
      return { ...m, tool: e.tool, data: e.data, denied: false, status: undefined };
    case "tool_state":
      return { ...m, status: executionStatusText(e.tool, e.data?.status) };
    case "denied":
      return { ...m, denied: m.data ? m.denied : true, status: undefined };
    case "assistant":
      return e.text ? { ...m, text: e.text } : m;
    case "final":
    case "done":
      return { ...m, text: e.text ?? m.text, pending: false, status: undefined };
    default:
      return m;
  }
}
