import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  WorkbenchAPI,
  WorkbenchEnvironment,
  WorkbenchSessionView,
  WorkbenchTestResultView,
  WorkbenchValidationSummary,
} from "../../../shared/connector-contract";
import {
  DEFAULT_OPERATIONS,
  DEFAULT_PROFILE,
  currentDraftKey,
  evidenceComplete,
  evidenceDigest,
  makeDraft,
  operationArgs,
  operationSQL,
  type OperationForm,
  type ProfileForm,
  type ToolName,
  type WorkbenchEvidence,
} from "./workflow";

export { evidenceDigest } from "./workflow";

type Tab = "profile" | "operations" | "tests";

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

interface DisplayedResult {
  result: WorkbenchTestResultView;
  tool: ToolName;
  sql: string;
  args: Record<string, unknown>;
  draftId: string;
  environment: WorkbenchEnvironment;
  resource: string;
}

function JsonValue({ value }: { value: unknown }): JSX.Element {
  return <pre className="wb-json">{JSON.stringify(value, null, 2)}</pre>;
}

export function WorkbenchOperationResult({
  sql, result, tool = "query_order_status", draftId, environment, resource, onClose,
}: {
  sql: string;
  result: WorkbenchTestResultView;
  tool?: ToolName;
  draftId?: string;
  environment?: WorkbenchEnvironment;
  resource?: string;
  onClose: () => void;
}): JSX.Element {
  const write = tool === "report_production_progress";
  return (
    <section className="wb-result" aria-label="本地测试结果">
      <div className="wb-section-head">
        <div>
          <h3>临时原始结果</h3>
          <p>{draftId ? `结果快照 · ${tool} · ${draftId}` : "仅保存在当前隔离窗口，关闭后立即清除。"}</p>
        </div>
        <button className="wb-btn" onClick={onClose}>关闭测试结果</button>
      </div>
      {(environment || resource) && <div className="wb-result-context">
        {environment && <span>环境 · {environment}</span>}
        {resource && <span>资源 · {resource}</span>}
      </div>}
      <code className="wb-sql-preview">{sql}</code>
      <div className="wb-result-grid">
        <div><h4>{write ? "实际变更前" : "原始行"}</h4><JsonValue value={result.raw} /></div>
        <div><h4>{write ? "实际拟写入" : "公开投影"}</h4><JsonValue value={result.projected} /></div>
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
  const [draftId] = useState(() => `draft-${Date.now()}`);
  const [savedDraftId, setSavedDraftId] = useState<string | null>(null);
  const [result, setResult] = useState<DisplayedResult | null>(null);
  const resultRef = useRef<DisplayedResult | null>(null);
  const [connection, setConnection] = useState<{ environment: WorkbenchEnvironment; latencyMS: number } | null>(null);
  const draftKey = useMemo(() => currentDraftKey(profile, form), [form, profile]);
  const [evidence, setEvidence] = useState<WorkbenchEvidence>(() => ({
    draftKey: currentDraftKey(DEFAULT_PROFILE, DEFAULT_OPERATIONS), operations: {},
  }));
  const [summary, setSummary] = useState<WorkbenchValidationSummary | null>(null);
  const [frozen, setFrozen] = useState<{ draftId: string; draftKey: string; digest: string; testsDigest: string } | null>(null);
  const [submitStatus, setSubmitStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => { api.getEnrollment().then(setEnrollment).catch((e) => setError(displayError(e))); }, [api]);
  useEffect(() => { resultRef.current = result; }, [result]);

  const clearSessionState = useCallback(() => {
    resultRef.current = null; setResult(null); setSession(null); setSummary(null); setFrozen(null);
    setSavedDraftId(null); setSubmitStatus(""); setConnection(null);
    setEvidence({ draftKey: "", operations: {} }); setCredential({ username: "", password: "" });
  }, []);

  const closeResult = useCallback(async (reason = ""): Promise<boolean> => {
    if (!session) { resultRef.current = null; setResult(null); return true; }
    const current = resultRef.current;
    resultRef.current = null;
    setResult(null);
    if (!current) return true;
    try {
      await closeWorkbenchResult(api, session.sessionId, current.result);
      return true;
    } catch {
      try { await api.lock(session.sessionId); } catch { /* blocking UI state remains locked */ }
      clearSessionState();
      setError(`${reason ? `${reason}；` : ""}原始结果清理失败，工作台已锁定。`);
      return false;
    }
  }, [api, clearSessionState, session]);

  useEffect(() => {
    if (!result) return;
    const timer = window.setTimeout(() => { void closeResult("测试结果已过期"); }, Math.min(resultExpiryDelay(result.result), 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [closeResult, result]);

  const lock = useCallback(async () => {
    if (!session) return;
    if (!await closeResult()) return;
    await api.lock(session.sessionId);
    clearSessionState();
  }, [api, clearSessionState, closeResult, session]);

  useEffect(() => {
    if (!session) return;
    const remaining = new Date(session.expiresAt).getTime() - Date.now();
    const timer = window.setTimeout(() => {
      void (async () => {
        if (!await closeResult("实现凭据会话已过期")) return;
        try { await api.lock(session.sessionId); } catch { /* native expiry already disposes the session */ }
        clearSessionState(); setError("实现凭据会话已过期，请重新解锁。");
      })();
    }, Math.max(0, remaining));
    return () => window.clearTimeout(timer);
  }, [api, clearSessionState, closeResult, session]);

  useEffect(() => {
    const onUnload = () => {
      const current = resultRef.current;
      if (session && current) void api.closeResult(session.sessionId, current.result.resultId)
        .catch(() => api.lock(session.sessionId).catch(() => undefined));
      if (session) void api.lock(session.sessionId).catch(() => undefined);
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

  const unlock = () => run(async () => {
    const next = await api.unlock(encodedCredential.trim());
    setSession(next); setEncodedCredential(""); setSubmitStatus("");
  });

  const invalidateDraftState = useCallback(() => {
    setConnection(null); setEvidence({ draftKey: "", operations: {} }); setSummary(null); setFrozen(null);
    setSubmitStatus(""); setSavedDraftId(null);
  }, []);

  const updateProfile = <K extends keyof ProfileForm>(key: K, value: ProfileForm[K]) => {
    invalidateDraftState(); setProfile((current) => ({ ...current, [key]: value }));
  };
  const updateForm = <K extends keyof OperationForm>(key: K, value: OperationForm[K]) => {
    invalidateDraftState(); setForm((current) => ({ ...current, [key]: value }));
  };

  const persistDraft = async (): Promise<{ draftId: string; testsDigest: string } | null> => {
    if (!session || !enrollment) throw new Error("请先解锁实现凭据");
    if (!await closeResult()) return null;
    const currentEvidence: WorkbenchEvidence = evidence.draftKey === draftKey
      ? evidence : { draftKey, operations: {} };
    const testsDigest = await evidenceDigest(currentEvidence);
    const saved = await api.saveDraft(
      session.sessionId, makeDraft(enrollment, session, profile, form, draftId, testsDigest),
    );
    setSavedDraftId(saved.draftId);
    return { draftId: saved.draftId, testsDigest };
  };

  const selectTool = (next: ToolName) => {
    if (next !== tool) void closeResult("操作已切换");
    setTool(next);
  };

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
          <button className="wb-btn" disabled={busy} onClick={() => run(lock)}>锁定</button></div>
      </header>
      <nav className="wb-tabs" role="tablist" aria-label="工作台步骤">
        {(["profile", "operations", "tests"] as Tab[]).map((id) => (
          <button key={id} id={`wb-tab-${id}`} role="tab" aria-selected={tab === id} aria-controls={`wb-panel-${id}`}
            tabIndex={tab === id ? 0 : -1} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>
            {id === "profile" ? "1 连接配置" : id === "operations" ? "2 操作定义" : "3 测试与提交"}
          </button>
        ))}
      </nav>
      {error && <div className="wb-error" role="alert">{error}</div>}

      <div className="wb-content">
        {tab === "profile" && <section className="wb-panel" id="wb-panel-profile" role="tabpanel" aria-labelledby="wb-tab-profile">
          <div className="wb-section-head"><div><h2>SQL Server 配置</h2><p>凭据为只写；保存后无法从工作台读取。</p></div></div>
          <div className="wb-segment" aria-label="目标环境">
            {(["test", "preproduction"] as WorkbenchEnvironment[]).map((env) => <button key={env}
              className={profile.environment === env ? "active" : ""}
              aria-pressed={profile.environment === env}
              onClick={() => updateProfile("environment", env)}>{env === "test" ? "测试" : "预生产"}</button>)}
          </div>
          <div className="wb-form-grid">
            <Field label="连接器 ID"><input value={profile.connectorId} onChange={(e) => updateProfile("connectorId", e.target.value)} /></Field>
            <Field label="版本"><input value={profile.version} onChange={(e) => updateProfile("version", e.target.value)} /></Field>
            <Field label="配置 ID"><input value={profile.profileId} onChange={(e) => updateProfile("profileId", e.target.value)} /></Field>
            <Field label="凭据引用"><input value={profile.credentialRef} onChange={(e) => updateProfile("credentialRef", e.target.value)} /></Field>
            <Field label="服务器"><input value={profile.server} onChange={(e) => updateProfile("server", e.target.value)} /></Field>
            <Field label="实例（可选）"><input value={profile.instance} onChange={(e) => updateProfile("instance", e.target.value)} /></Field>
            <Field label="端口"><input type="number" min="1" max="65535" value={profile.port} onChange={(e) => updateProfile("port", e.target.value)} /></Field>
            <Field label="数据库"><input value={profile.database} onChange={(e) => updateProfile("database", e.target.value)} /></Field>
            <Field label="连接超时（毫秒）"><input type="number" min="100" max="60000" value={profile.connectTimeoutMS} onChange={(e) => updateProfile("connectTimeoutMS", Number(e.target.value))} /></Field>
            <Field label="查询超时（毫秒）"><input type="number" min="100" max="60000" value={profile.queryTimeoutMS} onChange={(e) => updateProfile("queryTimeoutMS", Number(e.target.value))} /></Field>
            <Field label="CA 文件（可选）"><input value={profile.caPath} onChange={(e) => updateProfile("caPath", e.target.value)} /></Field>
          </div>
          <div className="wb-credential-tool">
            <Field label="用户名"><input autoComplete="off" value={credential.username} onChange={(e) => setCredential({ ...credential, username: e.target.value })} /></Field>
            <Field label="密码"><input type="password" autoComplete="new-password" value={credential.password} onChange={(e) => setCredential({ ...credential, password: e.target.value })} /></Field>
            <button className="wb-btn primary" disabled={busy || !credential.username || !credential.password}
              onClick={() => run(async () => { await api.saveCredential(session.sessionId, profile.credentialRef, credential); setCredential({ username: "", password: "" }); })}>写入凭据</button>
          </div>
        </section>}

        {tab === "operations" && <section className="wb-panel" id="wb-panel-operations" role="tabpanel" aria-labelledby="wb-tab-operations">
          <div className="wb-section-head"><div><h2>固定操作定义</h2><p>仅支持 query_order_status 与 report_production_progress。</p></div></div>
          <div className="wb-operation-switch">
            <button className={tool === "query_order_status" ? "active" : ""} aria-pressed={tool === "query_order_status"} onClick={() => selectTool("query_order_status")}>query_order_status</button>
            <button className={tool === "report_production_progress" ? "active" : ""} aria-pressed={tool === "report_production_progress"} onClick={() => selectTool("report_production_progress")}>report_production_progress</button>
          </div>
          {tool === "query_order_status" ? <>
            <Field label="查询 SQL"><textarea className="wb-code" rows={12} value={form.querySql} onChange={(e) => updateForm("querySql", e.target.value)} /></Field>
            <div className="wb-form-grid"><Field label="最大结果数"><input type="number" value="10" readOnly /></Field><Field label="资源关系"><input value="viewer" readOnly /></Field></div>
          </> : <>
            <Field label="变更前读取 SQL"><textarea className="wb-code" rows={7} value={form.beforeSql} onChange={(e) => updateForm("beforeSql", e.target.value)} /></Field>
            <Field label="更新 SQL"><textarea className="wb-code" rows={7} value={form.updateSql} onChange={(e) => updateForm("updateSql", e.target.value)} /></Field>
            <Field label="更新后读取 SQL"><textarea className="wb-code" rows={7} value={form.readBackSql} onChange={(e) => updateForm("readBackSql", e.target.value)} /></Field>
          </>}
          <button className="wb-btn primary" disabled={busy || !profile.server || !profile.database} onClick={() => run(async () => {
            if (await persistDraft()) setTab("tests");
          })}>保存草稿</button>
        </section>}

        {tab === "tests" && <section className="wb-panel" id="wb-panel-tests" role="tabpanel" aria-labelledby="wb-tab-tests">
          <div className="wb-section-head"><div><h2>本地测试与提交</h2><p>冻结后仅提交公开契约与校验摘要。</p></div><code>{draftId}</code></div>
          <div className="wb-test-actions">
            <button className="wb-btn" disabled={busy} onClick={() => run(async () => {
              const saved = await persistDraft(); if (!saved) return;
              const tested = await api.testConnection(session.sessionId, saved.draftId);
              setConnection(tested);
              setEvidence((current) => ({
                ...(current.draftKey === draftKey ? current : { draftKey, operations: {} }),
                connection: { environment: tested.environment },
              }));
            })}>测试连接</button>
            <button className="wb-btn primary" disabled={busy} onClick={() => run(async () => {
              const saved = await persistDraft(); if (!saved) return;
              const args = operationArgs(tool, form);
              const sql = operationSQL(tool, profile, form);
              const resource = tool === "report_production_progress"
                ? `${String(args.orderId)} / ${String(args.workOrderId)}`
                : String(args.orderId);
              const tested = await api.testOperation(session.sessionId, saved.draftId, tool, args);
              const snapshot: DisplayedResult = {
                result: tested, tool, sql, args: { ...args }, draftId: saved.draftId,
                environment: profile.environment, resource,
              };
              resultRef.current = snapshot; setResult(snapshot);
              setEvidence((current) => {
                const base = current.draftKey === draftKey ? current : { draftKey, operations: {} };
                return { ...base, operations: { ...base.operations, [tool]: { args: { ...args }, projected: tested.projected, sql } } };
              });
            })}>运行测试</button>
          </div>
          <div className="wb-evidence-status" role="status">
            <span>{evidence.draftKey === draftKey && evidence.connection ? "连接 · 已通过" : "连接 · 待测试"}</span>
            <span>{evidence.draftKey === draftKey && evidence.operations.query_order_status ? "query_order_status · 已通过" : "query_order_status · 待测试"}</span>
            <span>{evidence.draftKey === draftKey && evidence.operations.report_production_progress ? "report_production_progress · 已通过" : "report_production_progress · 待测试"}</span>
          </div>
          {connection && <div className="wb-ok">连接成功 · {connection.environment} · {connection.latencyMS} ms</div>}
          <div className="wb-form-grid test-args">
            <Field label="orderId"><input value={form.orderId} onChange={(e) => updateForm("orderId", e.target.value)} /></Field>
            {tool === "report_production_progress" && <>
              <Field label="workOrderId"><input value={form.workOrderId} onChange={(e) => updateForm("workOrderId", e.target.value)} /></Field>
              <Field label="completionRate"><input type="number" min="0" max="100" value={form.completionRate} onChange={(e) => updateForm("completionRate", Number(e.target.value))} /></Field>
              <Field label="expectedVersion"><input type="number" min="0" value={form.expectedVersion} onChange={(e) => updateForm("expectedVersion", Number(e.target.value))} /></Field>
              <Field label="note（可选）"><input value={form.note} onChange={(e) => updateForm("note", e.target.value)} /></Field>
            </>}
          </div>
          {result && <WorkbenchOperationResult sql={result.sql} result={result.result} tool={result.tool} draftId={result.draftId}
            environment={result.environment} resource={result.resource}
            onClose={() => closeResult("用户关闭测试结果")} />}
          <div className="wb-freeze-actions">
            <button className="wb-btn" disabled={busy || !profile.server || !profile.database || !evidenceComplete(evidence, draftKey)} onClick={() => run(async () => {
              if (!evidenceComplete(evidence, draftKey)) throw new Error("请先完成当前草稿的连接及两项操作测试");
              const saved = await persistDraft(); if (!saved) return;
              const validated = await api.validateAndFreeze(session.sessionId, saved.draftId);
              if (validated.testsDigest !== saved.testsDigest) throw new Error("测试证据摘要不匹配");
              setSummary(validated);
              setFrozen({ draftId: saved.draftId, draftKey, digest: validated.digest, testsDigest: saved.testsDigest });
            })}>校验并冻结</button>
            <button className="wb-btn primary" disabled={busy || !summary || !frozen || frozen.draftKey !== draftKey || frozen.draftId !== savedDraftId} onClick={() => run(async () => {
              if (!summary || !frozen || frozen.draftKey !== draftKey || frozen.draftId !== savedDraftId) return;
              if (!await closeResult("提交前清理")) return;
              const submitted = await api.submit(session.sessionId, frozen.draftId);
              if (submitted.digest !== frozen.digest) throw new Error("提交摘要不匹配");
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
