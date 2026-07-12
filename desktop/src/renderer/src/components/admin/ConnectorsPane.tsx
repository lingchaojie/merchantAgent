import { useCallback, useEffect, useState } from "react";

import type { AdminClient, ConnectorVersionView, PublicToolContract } from "../../admin";

export type ConnectorLifecycleAction = "publish" | "suspend" | "revoke";

export async function runConnectorLifecycleAction(
  client: AdminClient,
  connector: ConnectorVersionView,
  action: ConnectorLifecycleAction,
): Promise<ConnectorVersionView[]> {
  if (action === "publish") await client.publishConnector(connector.connectorId, connector.version);
  else if (action === "suspend") await client.suspendConnector(connector.connectorId, connector.version);
  else await client.revokeConnector(connector.connectorId, connector.version);
  const [connectors] = await Promise.all([client.listConnectors(), client.listTools()]);
  return connectors;
}

function riskLabel(tool: PublicToolContract): string {
  return tool.risk === "read" ? "只读" : tool.risk === "low_write" ? "低风险写入" : "高风险写入";
}

function statusLabel(status: ConnectorVersionView["status"]): string {
  return {
    pending_admin_approval: "待管理员审批",
    published: "已发布",
    suspended: "已暂停",
    revoked: "已撤销",
  }[status];
}

function ToolContractView({ tool }: { tool: PublicToolContract }): JSX.Element {
  return (
    <section className="connector-tool">
      <div className="connector-tool-head">
        <div><strong>{tool.name}</strong><p>{tool.description}</p></div>
        <span className={`connector-risk ${tool.risk}`}>{riskLabel(tool)}</span>
      </div>
      <dl className="connector-meta">
        <div><dt>执行位置</dt><dd>{tool.execution === "desktop" ? "本地桌面" : "服务端"}</dd></div>
        <div><dt>数据域</dt><dd>{tool.dataDomain}</dd></div>
        <div><dt>资源</dt><dd>{tool.resourceType} / {tool.resourceKind} / {tool.resourceArg}</dd></div>
        <div><dt>资源关系</dt><dd>{tool.resourceRelation}</dd></div>
        <div><dt>确认要求</dt><dd>{tool.requiresConfirmation ? "需要确认" : "无需确认"}</dd></div>
        <div><dt>限制</dt><dd>{tool.timeoutMS} ms / {tool.maxResults} 条</dd></div>
      </dl>
      <div className="connector-contract-grid">
        <div><h5>参数</h5><ul>{tool.params.map((param) => <li key={param.name}>
          <code>{param.name}</code><span>{param.type}{param.required ? " · 必填" : " · 可选"}</span>
          {param.description && <small>{param.description}</small>}
        </li>)}</ul></div>
        <div><h5>结果字段</h5><div className="connector-fields">{tool.resultFields.map((field) => <code key={field}>{field}</code>)}</div></div>
      </div>
    </section>
  );
}

export function ConnectorVersionCard({
  connector, busy, onAction,
}: {
  connector: ConnectorVersionView;
  busy: boolean;
  onAction: (action: ConnectorLifecycleAction) => void;
}): JSX.Element {
  const pending = connector.status === "pending_admin_approval";
  const published = connector.status === "published";
  const suspended = connector.status === "suspended";
  return (
    <article className="connector-card">
      <header className="connector-head">
        <div><h3>{connector.connectorId} <code>{connector.version}</code></h3><code className="connector-digest">{connector.digest}</code></div>
        <div className="connector-state"><span>{connector.adapter}</span><span className="nonprod">{connector.environment === "test" ? "测试" : "预生产"}</span><b>{statusLabel(connector.status)}</b></div>
      </header>
      <dl className="connector-checks">
        <div><dt>检查器</dt><dd>{connector.checks.checkerVersion}</dd></div>
        <div><dt>规则集</dt><dd>{connector.checks.rulesetVersion}</dd></div>
        <div><dt>测试摘要</dt><dd>{connector.checks.testsDigest}</dd></div>
        <div><dt>提交者</dt><dd>{connector.submittedBy}</dd></div>
        {connector.approvedBy && <div><dt>审批者</dt><dd>{connector.approvedBy}</dd></div>}
      </dl>
      <div className="connector-tools">{connector.contract.tools.map((tool) => <ToolContractView key={tool.name} tool={tool} />)}</div>
      <footer className="connector-actions">
        {pending && <button className="btn-primary" disabled={busy} onClick={() => onAction("publish")}>发布</button>}
        {suspended && <button className="btn-primary" disabled={busy} onClick={() => onAction("publish")}>恢复发布</button>}
        {published && <button className="btn" disabled={busy} onClick={() => onAction("suspend")}>暂停</button>}
        {(published || suspended) && <button className="btn-danger" disabled={busy} onClick={() => onAction("revoke")}>撤销</button>}
      </footer>
    </article>
  );
}

export function ConnectorsPane({ client, onLifecycle }: { client: AdminClient; onLifecycle?: () => void }): JSX.Element {
  const [connectors, setConnectors] = useState<ConnectorVersionView[]>([]);
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try { setConnectors(await client.listConnectors()); setError(""); }
    catch (e) { setError(String(e)); }
  }, [client]);
  useEffect(() => { void load(); }, [load]);

  const action = async (connector: ConnectorVersionView, transition: ConnectorLifecycleAction) => {
    if (transition === "revoke" && !window.confirm(`确认永久撤销 ${connector.connectorId}@${connector.version}？`)) return;
    const id = `${connector.connectorId}@${connector.version}`;
    setBusyId(id); setError("");
    try {
      setConnectors(await runConnectorLifecycleAction(client, connector, transition));
      onLifecycle?.();
    } catch (e) { setError(String(e)); }
    finally { setBusyId(""); }
  };

  return (
    <div className="pane connectors-pane">
      <h2 className="pane-title">连接器审批</h2>
      <p className="pane-caption">仅审核公开工具契约与校验摘要。本地实现配置不会显示在此处。</p>
      {error && <div className="pane-err">{error}</div>}
      {connectors.length === 0 && !error && <div className="connector-empty">暂无待审核或已发布的连接器。</div>}
      <div className="connector-list">{connectors.map((connector) => {
        const id = `${connector.connectorId}@${connector.version}`;
        return <ConnectorVersionCard key={id} connector={connector} busy={busyId === id}
          onAction={(transition) => void action(connector, transition)} />;
      })}</div>
    </div>
  );
}
