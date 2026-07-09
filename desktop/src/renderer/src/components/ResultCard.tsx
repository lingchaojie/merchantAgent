// Renders a tool's structured result as a compact card, keyed by tool name.
// This is where the agent's answer becomes scannable data, not just prose.
import { IconBox, IconChart } from "./icons";

type Data = Record<string, unknown>;

function Row({ k, v, accent }: { k: string; v: unknown; accent?: "green" | "red" }) {
  return (
    <div className="card-row">
      <span className="card-k">{k}</span>
      <span className={"card-v" + (accent ? " " + accent : "")}>{String(v)}</span>
    </div>
  );
}

export function ResultCard({ tool, data }: { tool?: string; data?: Data }): JSX.Element | null {
  if (!tool || !data) return null;

  if (tool === "query_order_status") {
    return (
      <div className="card">
        <div className="card-head"><IconBox width={14} height={14} /> 订单进度 · {String(data.orderId)}</div>
        <Row k="客户" v={data.customer} />
        <Row k="状态" v={data.status} />
        <Row k="交期" v={data.promiseDate} />
      </div>
    );
  }

  if (tool === "query_order_financials") {
    const profit = Number(data.profit);
    return (
      <div className="card">
        <div className="card-head"><IconChart width={14} height={14} /> 订单财务 · {String(data.orderId)}</div>
        <Row k="成本" v={data.cost} />
        <Row k="售价" v={data.price} />
        <Row k="利润" v={data.profit} accent={profit >= 0 ? "green" : "red"} />
      </div>
    );
  }

  if (tool === "check_material_kitting") {
    const complete = data.complete === true;
    const shortages = Array.isArray(data.shortages) ? (data.shortages as Data[]) : [];
    return (
      <div className="card">
        <div className="card-head"><IconBox width={14} height={14} /> 齐套检查 · {String(data.orderId)}</div>
        {complete ? (
          <div className="card-row"><span className="badge green">已齐套</span></div>
        ) : (
          <>
            <div className="card-row"><span className="badge amber">未齐套</span></div>
            {shortages.map((s, i) => (
              <Row key={i} k={String(s.material)} v={`欠 ${String(s.short)}`} accent="red" />
            ))}
          </>
        )}
      </div>
    );
  }

  return null;
}
