# merchantAgent backend — Phase 0 里程碑 A/B

企业智能体平台的权限地基与单场景闭环骨架。**全本地/mock，无外部依赖**（无需备案域名、真实企微、真实 ERP）。

设计依据：`../research/11-phase0-权限模型与IdP适配器设计.md`。

## 它证明了什么

**"同一个 agent、同一个问题，因调用者身份不同而结果不同"**——权限从组织架构涌现，agent 权限 ≤ 用户权限。

- 销售问自己订单的**进度** → ✅；问**利润/成本** → ⛔（被 cost 数据域过滤）
- 销售经理问本部门订单利润 → ✅（`d_sales` 的 manager）
- 老板问任意订单利润 → ✅（`d_root` manager 向下继承）
- 计划员问销售部订单 → ⛔（不在该部门，`ListObjects` 预过滤为空）
- 会计可看 cost 数据域 → ✅

## 结构

```
backend/
├─ org/                  # 身份/组织的可插拔接缝（IdP 适配器）
│  ├─ types.go           #   规范化 OrgSnapshot / User / Dept / Tag / Principal
│  ├─ adapter.go         #   Adapter 接口 (Authenticate/FetchSnapshot/FetchChanges)
│  └─ mock.go            #   MockAdapter（读 testdata/mock-org.yaml；WeCom 实现日后同接口）
├─ sync/                 # 纯逻辑（无 OpenFGA、可 hermetic 测试）
│  ├─ rolemap.go         #   职位自由文本 → 平台角色（结构化优先，fail-closed 到 staff）
│  ├─ tuples.go          #   OrgSnapshot → OpenFGA 元组
│  └─ reconcile.go       #   desired vs current 的幂等 diff
├─ authz/                # OpenFGA 封装 + 同步编排
│  ├─ model.fga          #   授权模型 DSL（tenant/dept/role/data_domain/agent/tool/order）
│  ├─ store.go           #   建 store、写模型、Check / ListObjects / ApplyDiff
│  ├─ syncer.go          #   FetchSnapshot → tuples → reconcile → apply（Seed）
│  └─ *_test.go          #   6 个验收用例 + ListObjects 预过滤
└─ testdata/             # mock-org.yaml（通讯录）、mock-erp.yaml（订单/BOM）
```

### 里程碑 B 新增（连接器 + 运行时 + 服务）
```
├─ connector/            # 企业系统抽象（MCP 只是它的一种传输绑定）
│  ├─ connector.go       #   Tool/Connector 接口 + ToolSpec(带授权声明: ResourceType/Arg/DataDomain)
│  └─ mockerp/           #   mock ERP: query_order_status / query_order_financials(cost域) / check_material_kitting
├─ runtime/              # 确定性 Agent 循环
│  ├─ agent.go           #   IntentRouter(KeywordRouter) + Ask: 路由→授权→调工具→组织回答
│  ├─ guard.go           #   §6.1 授权中间件: 记录级 viewer ∧ 数据域 viewer 取交集(agent≤用户)
│  └─ audit.go           #   哈希链审计日志(可验证/防篡改)
├─ e2e/                  # 组合根测试: 真 OpenFGA + mock ERP + runtime 复现"同问不同权"
└─ cmd/
   ├─ mock-erp-mcp/      # mock ERP 暴露成真 MCP server(官方 go-sdk, stdio) + 冒烟测试
   └─ agentd/            # HTTP API(/login /chat(SSE) /audit) + 桌面本地工具反向桥
```

**跑 MCP server / HTTP API：**
```bash
go test ./cmd/mock-erp-mcp/...          # 冒烟: spawn MCP server, 列工具, 调用
docker compose up -d                     # 需 OpenFGA
go run ./cmd/agentd                      # HTTP API on localhost:8765 (loopback, demo)
# curl -N -X POST localhost:8765/chat -H 'content-type: application/json' \
#   -d '{"sessionId":"s1","userId":"u_sales1","question":"SO-1001 进度怎么样"}'
```

> ⚠️ **agentd 是本地 demo**：`/chat` 目前信任请求体的 userId（Phase 0 捷径）。生产必须从企微 OAuth 换发的会话/JWT 推导身份，绝不信客户端传的 userId。已在 `cmd/agentd/main.go` 顶部显著标注。桌面壳在 `../desktop/`（Electron，需真机构建）。

## 运行

```bash
# 1) 纯逻辑单测（不需要 OpenFGA，秒级）
make test-unit

# 2) 完整验收（起 OpenFGA，跑"同问不同权"6 用例）
make accept          # = docker compose up -d + 等待 + go test ./authz -run Acceptance -v

# 或手动：
docker compose up -d           # OpenFGA 在 host :18080（避开常见 8080 冲突）
go test ./...                  # 验收用例连不上 OpenFGA 会自动 skip，不会误失败
```

覆盖默认端点：`OPENFGA_API_URL=http://host:port go test ./authz/...`。

## Desktop-local enterprise tool 竖切

agentd 注册 `connector/clientexec` 的桌面代理工具。通过 `/chat` 触发时，服务端先执行 Skill/OpenFGA/记录级门禁，再用 SSE 发 `local_tool_request`；Windows 主进程验证签名 capability 并执行参考 SQLite，随后 POST `/chat/local-tool-result`。服务端只把字段 allowlist 反馈给模型，并把角色快照、设备、决策、终态、幂等键、确认时间和 before/after 写入租户哈希链。

参考工具只有：

- `query_order_status`：desktop/read，不含成本、SQL、路径或凭据。
- `report_production_progress`：desktop/low_write，必须确认，使用乐观版本、幂等键和写后校验。

确定性竖切：

```bash
OPENFGA_API_URL=http://localhost:18080 go test ./cmd/agentd ./e2e \
  -run 'LocalToolVertical|SameQuestionDifferentRights' -count=1 -v
```

`provider.Fake` 只替代外部 LLM，HTTP/SSE、真实 OpenFGA、runtime guard、client-exec 请求契约和审计链均走生产代码。sales 强制尝试写时，必须无 `local_tool_request` 且留下 `decision=deny,status=denied`；已知但未由授权 Skill 解锁的工具也会被审计，而任意未知工具名不会被执行。

Gate A（Skill 暴露）与 Gate B（记录关系）独立生效。2026-07-12 真机探针临时把 `production-progress` 暴露给 sales，绕过 Gate A 后，`u_sales1` 对 `SO-1001` 的写仍被 Gate B `business_record#operator` 拒绝；桌面未收到本地请求、未出现原生确认，参考库未变，审计记录 `decision=deny,status=denied,reason="no operator access to business_record order/SO-1001"`。探针结束后立即把 Skill 恢复为仅 `manager_tier`。

这证明授权后的桌面本地执行拓扑，不是客户数据库集成。参考库位于 Windows `%APPDATA%\merchant-agent-desktop\reference-enterprise.db`，不在 backend；没有任意 SQL/CRUD、真实企微、真实客户凭据或高风险写。

## 两条"可插拔接缝"（Phase 0 用 mock，日后无痛替换）

1. **IdP 适配器**（`org.Adapter`）：换真实企微只需实现同接口，把 `getuserinfo3rd`/`user/get`/`department/list` 映射成 `OrgSnapshot`——上层同步与权限模型**零改动**。
2. **连接器抽象**：真实 ERP/DB/UI 经 MCP 工具接入，替换 `testdata/mock-erp.yaml`。

## Phase 0 边界（明确不做）

真实企微 OAuth（无备案域名）、真实 ERP/客户系统写入、任意 SQL/CRUD、高风险写、多 IdP 实现、知识库 RAG（P1）、计费。参考 SQLite 的低风险生产进度写已实现，不代表客户连接器。

## 已知取舍

- **`authz/model.fga` 用 DSL + `openfga/language` 转换器加载**，该转换器拉入 gonum/otel 等较重依赖（仅**加载模型时**用，非运行时热路径）。如需瘦身，可改为直接内嵌等价 JSON 模型、去掉该依赖。
- **`Syncer.Seed` 面向全新 store**（`Reconcile(nil, desired)`）——这是 Phase 0 的"授权即播种"路径。针对已播种 store 的**增量对账**需 Read 现有元组算 deletes，列为 P0 后续。
- `go.mod` 因转换器被抬到 `go 1.25`（工具链自动满足）。
