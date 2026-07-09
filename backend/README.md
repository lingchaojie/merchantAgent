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
   └─ agentd/            # HTTP API(/login /ask /audit) 供桌面壳调用
```

**跑 MCP server / HTTP API：**
```bash
go test ./cmd/mock-erp-mcp/...          # 冒烟: spawn MCP server, 列工具, 调用
docker compose up -d                     # 需 OpenFGA
go run ./cmd/agentd                      # HTTP API on 127.0.0.1:8765 (loopback, demo)
# curl -X POST localhost:8765/ask -d '{"userId":"u_sales1","question":"SO-1001 利润多少"}'
```

> ⚠️ **agentd 是本地 demo**：`/ask` 目前信任请求体的 userId（Phase 0 捷径）。生产必须从企微 OAuth 换发的会话/JWT 推导身份，绝不信客户端传的 userId。已在 `cmd/agentd/main.go` 顶部显著标注。桌面壳在 `../desktop/`（Tauri v2 脚手架，需真机构建）。

## 运行

```bash
# 1) 纯逻辑单测（不需要 OpenFGA，秒级）
make test-unit

# 2) 完整验收（起 OpenFGA，跑"同问不同权"6 用例）
make accept          # = docker compose up -d + 等待 + go test ./authz -run Acceptance -v

# 或手动：
docker compose up -d           # OpenFGA 在 host :8090（避开常见 8080 冲突）
go test ./...                  # 验收用例连不上 OpenFGA 会自动 skip，不会误失败
```

覆盖默认端点：`OPENFGA_API_URL=http://host:port go test ./authz/...`。

## 两条"可插拔接缝"（Phase 0 用 mock，日后无痛替换）

1. **IdP 适配器**（`org.Adapter`）：换真实企微只需实现同接口，把 `getuserinfo3rd`/`user/get`/`department/list` 映射成 `OrgSnapshot`——上层同步与权限模型**零改动**。
2. **连接器抽象**：真实 ERP/DB/UI 经 MCP 工具接入，替换 `testdata/mock-erp.yaml`。

## Phase 0 边界（明确不做）

真实企微 OAuth（无备案域名）、真实 ERP、写操作、多 IdP 实现、知识库 RAG（P1）、计费。

## 已知取舍

- **`authz/model.fga` 用 DSL + `openfga/language` 转换器加载**，该转换器拉入 gonum/otel 等较重依赖（仅**加载模型时**用，非运行时热路径）。如需瘦身，可改为直接内嵌等价 JSON 模型、去掉该依赖。
- **`Syncer.Seed` 面向全新 store**（`Reconcile(nil, desired)`）——这是 Phase 0 的"授权即播种"路径。针对已播种 store 的**增量对账**需 Read 现有元组算 deletes，列为 P0 后续。
- `go.mod` 因转换器被抬到 `go 1.25`（工具链自动满足）。
