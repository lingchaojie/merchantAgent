import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  WorkbenchAPI,
  WorkbenchConnectorDraft,
  WorkbenchEnvironment,
  WorkbenchPublicToolContract,
  WorkbenchSessionView,
  WorkbenchSQLOperation,
  WorkbenchTestResultView,
  WorkbenchValidationSummary,
} from "../../../shared/connector-contract";

type Tab = "profile" | "operations" | "tests";
type ToolName = "query_order_status" | "report_production_progress";

interface ProfileForm {
  connectorId: string; version: string; profileId: string; server: string; instance: string;
  port: string; database: string; caPath: string; connectTimeoutMS: number; queryTimeoutMS: number;
  credentialRef: string; environment: WorkbenchEnvironment;
}

interface OperationForm {
  querySql: string; beforeSql: string; updateSql: string; readBackSql: string;
  orderId: string; workOrderId: string; completionRate: number; expectedVersion: number; note: string;
}

const DEFAULT_PROFILE: ProfileForm = {
  connectorId: "sql-orders", version: "1.0.0", profileId: "erp-test", server: "",
  instance: "", port: "1433", database: "", caPath: "", connectTimeoutMS: 5_000,
  queryTimeoutMS: 5_000, credentialRef: "erp-test", environment: "test",
};

const DEFAULT_OPERATIONS: OperationForm = {
  querySql: "SELECT o.order_id AS order_id, o.status AS status FROM dbo.production_orders o WHERE o.order_id = @orderId",
  beforeSql: "SELECT o.order_id AS order_id, o.work_order_id AS work_order_id, o.completion_rate AS completion_rate, o.note AS note, o.version AS version FROM dbo.production_orders o WHERE o.order_id = @orderId AND o.work_order_id = @workOrderId",
  updateSql: "UPDATE dbo.production_orders SET completion_rate = @completionRate, note = @note, version = @nextVersion WHERE order_id = @orderId AND work_order_id = @workOrderId AND version = @expectedVersion",
  readBackSql: "SELECT o.order_id AS order_id, o.work_order_id AS work_order_id, o.completion_rate AS completion_rate, o.note AS note, o.version AS version FROM dbo.production_orders o WHERE o.order_id = @orderId AND o.work_order_id = @workOrderId",
  orderId: "ORD-1001", workOrderId: "WO-1001", completionRate: 80, expectedVersion: 1, note: "",
};

function publicTools(profile: ProfileForm): WorkbenchPublicToolContract[] {
  return [{
    name: "query_order_status", description: "查询订单状态",
    parameters: { type: "object", properties: { orderId: { type: "string" } }, required: ["orderId"], additionalProperties: false },
    resultFields: ["orderId", "status"], resourceType: "business_record", resourceKind: "order",
    resourceArg: "orderId", resourceRelation: "viewer", dataDomain: "orders", risk: "read",
    requiresConfirmation: false, timeoutMS: profile.queryTimeoutMS, maxResults: 10,
  }, {
    name: "report_production_progress", description: "上报生产进度",
    parameters: {
      type: "object",
      properties: {
        orderId: { type: "string" }, workOrderId: { type: "string" }, completionRate: { type: "integer" },
        expectedVersion: { type: "integer" }, note: { type: "string" },
      },
      required: ["orderId", "workOrderId", "completionRate", "expectedVersion"], additionalProperties: false,
    },
    resultFields: ["orderId", "workOrderId", "completionRate", "note", "version"],
    resourceType: "business_record", resourceKind: "order", resourceArg: "orderId",
    resourceRelation: "operator", dataDomain: "orders", risk: "low_write", requiresConfirmation: true,
    timeoutMS: profile.queryTimeoutMS, maxResults: 1,
  }];
}

function operations(profile: ProfileForm, form: OperationForm): WorkbenchSQLOperation[] {
  return [{
    kind: "read", tool: "query_order_status", sql: form.querySql,
    bindings: [{ parameter: "orderId", argument: "orderId", type: "NVarChar", maxLength: 64 }],
    projection: [
      { sourceAlias: "order_id", resultField: "orderId", type: "string" },
      { sourceAlias: "status", resultField: "status", type: "string" },
    ],
    declaredObjects: ["dbo.production_orders"], maxResults: 10, timeoutMS: profile.queryTimeoutMS,
  }, {
    kind: "update", tool: "report_production_progress", beforeSql: form.beforeSql,
    updateSql: form.updateSql, readBackSql: form.readBackSql,
    bindings: [
      { parameter: "orderId", argument: "orderId", type: "NVarChar", maxLength: 64 },
      { parameter: "workOrderId", argument: "workOrderId", type: "NVarChar", maxLength: 64 },
      { parameter: "completionRate", argument: "completionRate", type: "Int" },
      { parameter: "expectedVersion", argument: "expectedVersion", type: "Int" },
      { parameter: "note", argument: "note", type: "NVarChar", maxLength: 200 },
      { parameter: "nextVersion", argument: "nextVersion", type: "Int" },
    ],
    projection: [
      { sourceAlias: "order_id", resultField: "orderId", type: "string" },
      { sourceAlias: "work_order_id", resultField: "workOrderId", type: "string" },
      { sourceAlias: "completion_rate", resultField: "completionRate", type: "integer" },
      { sourceAlias: "note", resultField: "note", type: "string" },
      { sourceAlias: "version", resultField: "version", type: "integer" },
    ],
    proposed: [
      { resultField: "completionRate", argument: "completionRate" },
      { resultField: "note", argument: "note", preserveIfMissing: true },
      { resultField: "version", argument: "nextVersion" },
    ],
    declaredObject: "dbo.production_orders", resourceParameter: "orderId",
    concurrencyParameter: "expectedVersion", updateColumns: ["completion_rate", "note", "version"],
    versionField: "version", timeoutMS: profile.queryTimeoutMS,
  }];
}

function makeDraft(
  enrollment: { deviceId: string }, session: WorkbenchSessionView, profile: ProfileForm,
  form: OperationForm, draftId: string,
): WorkbenchConnectorDraft {
  return {
    draftId, tenantId: session.tenantId, deviceId: enrollment.deviceId, state: "draft",
    payload: {
      schemaVersion: 1, connectorId: profile.connectorId, version: profile.version, adapter: "sqlserver",
      profile: {
        profileId: profile.profileId, server: profile.server,
        ...(profile.instance ? { instance: profile.instance } : {}),
        ...(profile.port ? { port: Number(profile.port) } : {}), database: profile.database,
        encrypt: true, trustServerCertificate: false, ...(profile.caPath ? { caPath: profile.caPath } : {}),
        connectTimeoutMS: profile.connectTimeoutMS, queryTimeoutMS: profile.queryTimeoutMS,
        credentialRef: profile.credentialRef, environment: profile.environment,
      },
      operations: operations(profile, form), publicContract: { tools: publicTools(profile) },
      checker: { version: "m7.1-checker-1", rulesetVersion: "m7.1-sql-v1", testsDigest: `sha256:${"0".repeat(64)}` },
    },
  };
}

export async function closeWorkbenchResult(
  api: WorkbenchAPI, sessionId: string, result: WorkbenchTestResultView | null,
): Promise<null> {
  if (result) await api.closeResult(sessionId, result.resultId);
  return null;
}

export function resultExpiryDelay(result: WorkbenchTestResultView, now = Date.now()): number {
  return Math.max(0, new Date(result.expiresAt).getTime() - now);
}

export async function freezeCurrentWorkbenchDraft(
  api: WorkbenchAPI,
  sessionId: string,
  persist: () => Promise<string>,
): Promise<WorkbenchValidationSummary> {
  const currentDraftId = await persist();
  return api.validateAndFreeze(sessionId, currentDraftId);
}

function displayError(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  if (detail.includes("expired")) return "实现凭据会话已过期，请重新解锁。";
  if (detail.includes("locked")) return "实现凭据会话已锁定，请重新解锁。";
  if (detail.includes("busy")) return "工作台正在处理另一项操作，请稍候。";
  return `操作失败：${detail}`;
}

function JsonValue({ value }: { value: unknown }): JSX.Element {
  return <pre className="wb-json">{JSON.stringify(value, null, 2)}</pre>;
}

export function WorkbenchOperationResult({
  sql, result, onClose,
}: { sql: string; result: WorkbenchTestResultView; onClose: () => void }): JSX.Element {
  return (
    <section className="wb-result" aria-label="本地测试结果">
      <div className="wb-section-head">
        <div><h3>临时原始结果</h3><p>仅保存在当前隔离窗口，关闭后立即清除。</p></div>
        <button className="wb-btn" onClick={onClose}>关闭测试结果</button>
      </div>
      <code className="wb-sql-preview">{sql}</code>
      <div className="wb-result-grid">
        <div><h4>原始行</h4><JsonValue value={result.raw} /></div>
        <div><h4>公开投影</h4><JsonValue value={result.projected} /></div>
      </div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return <label className="wb-field"><span>{label}</span>{children}</label>;
}

export function WorkbenchApp({ api }: { api: WorkbenchAPI }): JSX.Element {
  const [enrollment, setEnrollment] = useState<{ deviceId: string; devicePublicKeyPem: string; fingerprint: string } | null>(null);
  const [encodedCredential, setEncodedCredential] = useState("");
  const [session, setSession] = useState<WorkbenchSessionView | null>(null);
  const [profile, setProfile] = useState(DEFAULT_PROFILE);
  const [credential, setCredential] = useState({ username: "", password: "" });
  const [form, setForm] = useState(DEFAULT_OPERATIONS);
  const [tab, setTab] = useState<Tab>("profile");
  const [tool, setTool] = useState<ToolName>("query_order_status");
  const [draftId, setDraftId] = useState(() => `draft-${Date.now()}`);
  const [savedDraftId, setSavedDraftId] = useState<string | null>(null);
  const [result, setResult] = useState<WorkbenchTestResultView | null>(null);
  const resultRef = useRef<WorkbenchTestResultView | null>(null);
  const [connection, setConnection] = useState<{ environment: WorkbenchEnvironment; latencyMS: number } | null>(null);
  const [summary, setSummary] = useState<WorkbenchValidationSummary | null>(null);
  const [submitStatus, setSubmitStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => { api.getEnrollment().then(setEnrollment).catch((e) => setError(displayError(e))); }, [api]);
  useEffect(() => { resultRef.current = result; }, [result]);

  const closeResult = useCallback(async () => {
    if (!session) { setResult(null); return; }
    const current = resultRef.current;
    resultRef.current = null;
    setResult(null);
    try { await closeWorkbenchResult(api, session.sessionId, current); } catch { /* session teardown is best effort */ }
  }, [api, session]);

  useEffect(() => {
    if (!result) return;
    const timer = window.setTimeout(() => { void closeResult(); }, Math.min(resultExpiryDelay(result), 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [closeResult, result]);

  const lock = useCallback(async () => {
    if (!session) return;
    await closeResult();
    try { await api.lock(session.sessionId); } finally {
      setSession(null); setSummary(null); setSavedDraftId(null); setSubmitStatus("");
      setCredential({ username: "", password: "" });
    }
  }, [api, closeResult, session]);

  useEffect(() => {
    if (!session) return;
    const remaining = new Date(session.expiresAt).getTime() - Date.now();
    const timer = window.setTimeout(() => { setError("实现凭据会话已过期，请重新解锁。"); void lock(); }, Math.max(0, remaining));
    return () => window.clearTimeout(timer);
  }, [lock, session]);

  useEffect(() => {
    const onUnload = () => {
      const current = resultRef.current;
      if (session && current) void api.closeResult(session.sessionId, current.resultId);
      if (session) void api.lock(session.sessionId);
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [api, session]);

  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError("");
    try { await action(); } catch (e) {
      const message = displayError(e); setError(message);
      if (message.includes("过期") || message.includes("锁定")) await lock();
    } finally { setBusy(false); }
  };

  const unlock = () => void run(async () => {
    const next = await api.unlock(encodedCredential.trim());
    setSession(next); setEncodedCredential(""); setSubmitStatus("");
  });

  const persistDraft = async (): Promise<string> => {
    if (!session || !enrollment) throw new Error("请先解锁实现凭据");
    await closeResult();
    const saved = await api.saveDraft(session.sessionId, makeDraft(enrollment, session, profile, form, draftId));
    if (saved.draftId !== savedDraftId) setResult(null);
    setSavedDraftId(saved.draftId); setSummary(null); setSubmitStatus("");
    return saved.draftId;
  };

  const selectTool = (next: ToolName) => {
    if (next !== tool) void closeResult();
    setTool(next);
  };

  const selectedOperation = useMemo(() => operations(profile, form).find((item) => item.tool === tool)!, [form, profile, tool]);
  const operationSql = selectedOperation.kind === "read"
    ? selectedOperation.sql
    : `${selectedOperation.beforeSql}\n${selectedOperation.updateSql}\n${selectedOperation.readBackSql}`;

  if (!session) {
    return (
      <main className="workbench-shell locked">
        <div className="wb-banner">非生产环境 · 本窗口包含本地实现配置，请勿共享</div>
        <section className="wb-unlock">
          <header><span className="wb-eyebrow">Connector Workbench</span><h1>连接器实现工作台</h1></header>
          {error && <div className="wb-error" role="alert">{error}</div>}
          <div className="wb-enrollment">
            <span>设备注册</span>
            <strong>{enrollment?.deviceId ?? "正在读取…"}</strong>
            <code>{enrollment?.fingerprint ?? ""}</code>
          </div>
          <Field label="实现凭据">
            <textarea rows={5} value={encodedCredential} disabled={busy} autoComplete="off"
              onChange={(e) => setEncodedCredential(e.target.value)} placeholder="粘贴已签发的实现凭据" />
          </Field>
          <button className="wb-btn primary" disabled={busy || !enrollment || !encodedCredential.trim()} onClick={unlock}>解锁工作台</button>
        </section>
      </main>
    );
  }

  return (
    <main className="workbench-shell">
      <div className="wb-banner">非生产环境 · 仅支持测试与预生产 · 原始结果仅在当前窗口短暂显示</div>
      <header className="wb-topbar">
        <div><span className="wb-eyebrow">Connector Workbench</span><h1>SQL Server 连接器</h1></div>
        <div className="wb-session"><span>{session.tenantId}</span><span>有效期至 {new Date(session.expiresAt).toLocaleTimeString()}</span>
          <button className="wb-btn" disabled={busy} onClick={() => void run(lock)}>锁定</button></div>
      </header>
      <nav className="wb-tabs" aria-label="工作台步骤">
        {(["profile", "operations", "tests"] as Tab[]).map((id) => (
          <button key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>
            {id === "profile" ? "1 连接配置" : id === "operations" ? "2 操作定义" : "3 测试与提交"}
          </button>
        ))}
      </nav>
      {error && <div className="wb-error" role="alert">{error}</div>}

      <div className="wb-content">
        {tab === "profile" && <section className="wb-panel">
          <div className="wb-section-head"><div><h2>SQL Server 配置</h2><p>凭据为只写；保存后无法从工作台读取。</p></div></div>
          <div className="wb-segment" aria-label="目标环境">
            {(["test", "preproduction"] as WorkbenchEnvironment[]).map((env) => <button key={env}
              className={profile.environment === env ? "active" : ""}
              onClick={() => setProfile({ ...profile, environment: env })}>{env === "test" ? "测试" : "预生产"}</button>)}
          </div>
          <div className="wb-form-grid">
            <Field label="连接器 ID"><input value={profile.connectorId} onChange={(e) => setProfile({ ...profile, connectorId: e.target.value })} /></Field>
            <Field label="版本"><input value={profile.version} onChange={(e) => setProfile({ ...profile, version: e.target.value })} /></Field>
            <Field label="配置 ID"><input value={profile.profileId} onChange={(e) => setProfile({ ...profile, profileId: e.target.value })} /></Field>
            <Field label="凭据引用"><input value={profile.credentialRef} onChange={(e) => setProfile({ ...profile, credentialRef: e.target.value })} /></Field>
            <Field label="服务器"><input value={profile.server} onChange={(e) => setProfile({ ...profile, server: e.target.value })} /></Field>
            <Field label="实例（可选）"><input value={profile.instance} onChange={(e) => setProfile({ ...profile, instance: e.target.value })} /></Field>
            <Field label="端口"><input type="number" min="1" max="65535" value={profile.port} onChange={(e) => setProfile({ ...profile, port: e.target.value })} /></Field>
            <Field label="数据库"><input value={profile.database} onChange={(e) => setProfile({ ...profile, database: e.target.value })} /></Field>
            <Field label="连接超时（毫秒）"><input type="number" min="100" max="60000" value={profile.connectTimeoutMS} onChange={(e) => setProfile({ ...profile, connectTimeoutMS: Number(e.target.value) })} /></Field>
            <Field label="查询超时（毫秒）"><input type="number" min="100" max="60000" value={profile.queryTimeoutMS} onChange={(e) => setProfile({ ...profile, queryTimeoutMS: Number(e.target.value) })} /></Field>
            <Field label="CA 文件（可选）"><input value={profile.caPath} onChange={(e) => setProfile({ ...profile, caPath: e.target.value })} /></Field>
          </div>
          <div className="wb-credential-tool">
            <Field label="用户名"><input autoComplete="off" value={credential.username} onChange={(e) => setCredential({ ...credential, username: e.target.value })} /></Field>
            <Field label="密码"><input type="password" autoComplete="new-password" value={credential.password} onChange={(e) => setCredential({ ...credential, password: e.target.value })} /></Field>
            <button className="wb-btn primary" disabled={busy || !credential.username || !credential.password}
              onClick={() => void run(async () => { await api.saveCredential(session.sessionId, profile.credentialRef, credential); setCredential({ username: "", password: "" }); })}>写入凭据</button>
          </div>
        </section>}

        {tab === "operations" && <section className="wb-panel">
          <div className="wb-section-head"><div><h2>固定操作定义</h2><p>仅支持 query_order_status 与 report_production_progress。</p></div></div>
          <div className="wb-operation-switch">
            <button className={tool === "query_order_status" ? "active" : ""} onClick={() => selectTool("query_order_status")}>query_order_status</button>
            <button className={tool === "report_production_progress" ? "active" : ""} onClick={() => selectTool("report_production_progress")}>report_production_progress</button>
          </div>
          {tool === "query_order_status" ? <>
            <Field label="查询 SQL"><textarea className="wb-code" rows={12} value={form.querySql} onChange={(e) => setForm({ ...form, querySql: e.target.value })} /></Field>
            <div className="wb-form-grid"><Field label="最大结果数"><input type="number" value="10" readOnly /></Field><Field label="资源关系"><input value="viewer" readOnly /></Field></div>
          </> : <>
            <Field label="变更前读取 SQL"><textarea className="wb-code" rows={7} value={form.beforeSql} onChange={(e) => setForm({ ...form, beforeSql: e.target.value })} /></Field>
            <Field label="更新 SQL"><textarea className="wb-code" rows={7} value={form.updateSql} onChange={(e) => setForm({ ...form, updateSql: e.target.value })} /></Field>
            <Field label="更新后读取 SQL"><textarea className="wb-code" rows={7} value={form.readBackSql} onChange={(e) => setForm({ ...form, readBackSql: e.target.value })} /></Field>
          </>}
          <button className="wb-btn primary" disabled={busy || !profile.server || !profile.database} onClick={() => void run(async () => { await persistDraft(); setTab("tests"); })}>保存草稿</button>
        </section>}

        {tab === "tests" && <section className="wb-panel">
          <div className="wb-section-head"><div><h2>本地测试与提交</h2><p>冻结后仅提交公开契约与校验摘要。</p></div><code>{draftId}</code></div>
          <div className="wb-test-actions">
            <button className="wb-btn" disabled={busy} onClick={() => void run(async () => {
              const id = await persistDraft(); setConnection(await api.testConnection(session.sessionId, id));
            })}>测试连接</button>
            <button className="wb-btn primary" disabled={busy} onClick={() => void run(async () => {
              const id = await persistDraft();
              const args = tool === "query_order_status"
                ? { orderId: form.orderId }
                : { orderId: form.orderId, workOrderId: form.workOrderId, completionRate: form.completionRate, expectedVersion: form.expectedVersion, ...(form.note ? { note: form.note } : {}) };
              setResult(await api.testOperation(session.sessionId, id, tool, args));
            })}>运行测试</button>
          </div>
          {connection && <div className="wb-ok">连接成功 · {connection.environment} · {connection.latencyMS} ms</div>}
          <div className="wb-form-grid test-args">
            <Field label="orderId"><input value={form.orderId} onChange={(e) => setForm({ ...form, orderId: e.target.value })} /></Field>
            {tool === "report_production_progress" && <>
              <Field label="workOrderId"><input value={form.workOrderId} onChange={(e) => setForm({ ...form, workOrderId: e.target.value })} /></Field>
              <Field label="completionRate"><input type="number" min="0" max="100" value={form.completionRate} onChange={(e) => setForm({ ...form, completionRate: Number(e.target.value) })} /></Field>
              <Field label="expectedVersion"><input type="number" min="0" value={form.expectedVersion} onChange={(e) => setForm({ ...form, expectedVersion: Number(e.target.value) })} /></Field>
              <Field label="note（可选）"><input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></Field>
            </>}
          </div>
          {tool === "report_production_progress" && <section className="wb-write-preview">
            <h3>写入预览</h3>
            <dl><div><dt>资源</dt><dd>{form.orderId} / {form.workOrderId}</dd></div><div><dt>环境</dt><dd>{profile.environment}</dd></div>
              <div><dt>变更前</dt><dd>version = {form.expectedVersion}</dd></div><div><dt>拟写入</dt><dd>completionRate = {form.completionRate}, version = {form.expectedVersion + 1}{form.note ? `, note = ${form.note}` : ""}</dd></div></dl>
          </section>}
          {result && <WorkbenchOperationResult sql={operationSql} result={result} onClose={() => void closeResult()} />}
          <div className="wb-freeze-actions">
            <button className="wb-btn" disabled={busy || !profile.server || !profile.database} onClick={() => void run(async () => {
              setSummary(await freezeCurrentWorkbenchDraft(api, session.sessionId, persistDraft));
            })}>校验并冻结</button>
            <button className="wb-btn primary" disabled={busy || !summary || !savedDraftId} onClick={() => void run(async () => {
              await closeResult(); const submitted = await api.submit(session.sessionId, savedDraftId!);
              setSubmitStatus(`${submitted.status} · ${submitted.digest}`);
            })}>提交管理员审批</button>
          </div>
          {summary && <section className="wb-summary"><h3>冻结摘要</h3><dl>
            <div><dt>digest</dt><dd>{summary.digest}</dd></div><div><dt>checker</dt><dd>{summary.checkerVersion}</dd></div>
            <div><dt>ruleset</dt><dd>{summary.rulesetVersion}</dd></div><div><dt>tests</dt><dd>{summary.testsDigest}</dd></div>
          </dl></section>}
          {submitStatus && <div className="wb-ok">已提交：{submitStatus}</div>}
        </section>}
      </div>
    </main>
  );
}
