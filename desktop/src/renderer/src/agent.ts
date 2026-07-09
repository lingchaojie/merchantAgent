// getAgent returns the real preload-exposed window.agent inside Electron, or a
// MOCK implementation in a plain browser (for UI dev + screenshots only). The
// mock mirrors the Phase 0 backend permission logic so the "same question,
// different permissions" behavior is visible without running Go/OpenFGA.
//
// DEV-ONLY: the mock never ships — in the packaged app window.agent is always
// present.
import type { AgentAPI, Answer, Principal } from "../../shared/contract";
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

function mockAsk(userId: string, question: string): Answer {
  const r = route(question);
  if (!r) return { text: "没听懂，请说明订单号与要查的内容（进度/齐套/利润）。" };
  const o = ORDERS[r.orderId];
  if (!o) return { text: `订单 ${r.orderId} 不存在。`, tool: r.tool };
  const denied = (): Answer => ({ text: "抱歉，你没有权限查看该信息。", tool: r.tool, denied: true });

  if (r.tool === "query_order_financials") {
    if (!ORDER_VIEWERS.has(userId) || !COST_VIEWERS.has(userId)) return denied();
    return {
      text: `订单 ${r.orderId}：成本 ${o.cost}，售价 ${o.price}，利润 ${o.price - o.cost}。`,
      tool: r.tool,
      data: { orderId: r.orderId, cost: o.cost, price: o.price, profit: o.price - o.cost },
    };
  }
  if (!ORDER_VIEWERS.has(userId)) return denied();
  if (r.tool === "check_material_kitting") {
    return {
      text: `订单 ${r.orderId}：未齐套，欠料 M-螺栓 200。`,
      tool: r.tool,
      data: { orderId: r.orderId, complete: false, shortages: [{ material: "M-螺栓", short: 200 }] },
    };
  }
  return {
    text: `订单 ${r.orderId}（${o.customer}）：状态 ${o.status}，交期 ${o.promise}。`,
    tool: r.tool,
    data: { orderId: r.orderId, customer: o.customer, status: o.status, promiseDate: o.promise },
  };
}

const mockAgent: AgentAPI = {
  async login(userId) {
    const u = MOCK_USERS.find((x) => x.id === userId);
    return { TenantID: "mock-corp-001", UserID: userId, DisplayName: u?.name ?? userId } as Principal;
  },
  async ask(_tenantId, userId, question) {
    await new Promise((r) => setTimeout(r, 280)); // simulate latency for the pending state
    return mockAsk(userId, question);
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
