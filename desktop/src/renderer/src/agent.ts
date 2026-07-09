// getAgent returns the real preload-exposed window.agent inside Electron, or a
// MOCK implementation in a plain browser (for UI dev + screenshots only). The
// mock mirrors the Phase 0 backend permission logic so the "same question,
// different permissions" behavior is visible without running Go/OpenFGA.
//
// DEV-ONLY: the mock never ships — in the packaged app window.agent is always
// present.
import type { AgentAPI, ChatEvent, Principal } from "../../shared/contract";
import { MOCK_USERS } from "./types";

const ORDERS: Record<string, { customer: string; status: string; promise: string; cost: number; price: number }> = {
  "SO-1001": { customer: "A公司", status: "生产中", promise: "2026-07-20", cost: 82000, price: 100000 },
  "SO-1002": { customer: "B公司", status: "待排产", promise: "2026-07-25", cost: 45000, price: 60000 },
};
// Who may view the cost data-domain (finance + managers). Mirrors backend fixtures.
const COST_VIEWERS = new Set(["u_fin", "u_smgr", "u_boss"]);
// Who may view the sales orders (owner + sales dept members/managers + boss).
const ORDER_VIEWERS = new Set(["u_sales1", "u_smgr", "u_boss"]);

function route(q: string): { tool: string; orderId: string } | null {
  const id = (q.match(/[A-Za-z]{1,4}-?\d{3,}/) || [""])[0].toUpperCase();
  if (!id) return null;
  if (/利润|成本|毛利|profit|cost/i.test(q)) return { tool: "query_order_financials", orderId: id };
  if (/齐套|欠料|缺料|备料|kitting/i.test(q)) return { tool: "check_material_kitting", orderId: id };
  if (/进度|交期|状态|什么时候|progress|status/i.test(q)) return { tool: "query_order_status", orderId: id };
  return null;
}

// mockChat mirrors the backend loop's event stream (tool_call → tool_result |
// denied → final) so the browser preview shows live streaming without Go/OpenFGA.
async function mockChat(userId: string, question: string, onEvent: (e: ChatEvent) => void): Promise<string> {
  const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  const r = route(question);
  if (!r) {
    const text = "没听懂，请说明订单号与要查的内容（进度/齐套/利润）。";
    onEvent({ kind: "final", text });
    return text;
  }
  await wait(200);
  onEvent({ kind: "tool_call", tool: r.tool, data: { orderId: r.orderId } });
  await wait(200);
  const o = ORDERS[r.orderId];
  const finish = (text: string): string => {
    onEvent({ kind: "final", text });
    return text;
  };
  if (!o) return finish(`订单 ${r.orderId} 不存在。`);

  const canOrder = ORDER_VIEWERS.has(userId);
  const canCost = COST_VIEWERS.has(userId);
  if (r.tool === "query_order_financials") {
    if (!canOrder || !canCost) {
      onEvent({ kind: "denied", tool: r.tool });
      return finish("抱歉，利润属于敏感数据，需要更高权限。");
    }
    onEvent({ kind: "tool_result", tool: r.tool, data: { orderId: r.orderId, cost: o.cost, price: o.price, profit: o.price - o.cost } });
    return finish(`订单 ${r.orderId}：成本 ${o.cost}，售价 ${o.price}，利润 ${o.price - o.cost}。`);
  }
  if (!canOrder) {
    onEvent({ kind: "denied", tool: r.tool });
    return finish("抱歉，你没有权限查看该订单。");
  }
  if (r.tool === "check_material_kitting") {
    onEvent({ kind: "tool_result", tool: r.tool, data: { orderId: r.orderId, complete: false, shortages: [{ material: "M-螺栓", short: 200 }] } });
    return finish(`订单 ${r.orderId}：未齐套，欠料 M-螺栓 200。`);
  }
  onEvent({ kind: "tool_result", tool: r.tool, data: { orderId: r.orderId, customer: o.customer, status: o.status, promiseDate: o.promise } });
  return finish(`订单 ${r.orderId}（${o.customer}）：状态 ${o.status}，交期 ${o.promise}。`);
}

const mockAgent: AgentAPI = {
  async login(userId) {
    const u = MOCK_USERS.find((x) => x.id === userId);
    return { TenantID: "mock-corp-001", UserID: userId, DisplayName: u?.name ?? userId } as Principal;
  },
  chat(req, onEvent) {
    return mockChat(req.userId, req.question, onEvent);
  },
  async readFile() {
    throw new Error("readFile unavailable in browser mock");
  },
  async writeFile() {
    throw new Error("writeFile unavailable in browser mock");
  },
};

export const IS_MOCK = typeof window !== "undefined" && !window.agent;

export function getAgent(): AgentAPI {
  return (typeof window !== "undefined" && window.agent) || mockAgent;
}
