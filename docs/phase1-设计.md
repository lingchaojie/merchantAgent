# Phase 1 设计 —— LLM 大脑 + skill 体系 + 跨系统数据（本地/mock）

> 版本 v1.0 ｜ 2026-07-09 ｜ 承接 `research/00·10·11` 与 `docs/实现进度.md`
> 本文件是 Phase 1 的实现蓝图：把 Phase 0 的确定性骨架，升级成**真正的产品形态**
> （真 LLM 编排 + skill 体系 + ERP/CRM 跨系统 + 管理界面），但**仍全本地/mock，零外部阻塞**。
> 决策来源：与用户的一轮 grilling（逐节确认，见下"决策清单"）。

---

## 0. 定位与范围

**目标**：Phase 0 已验证"同问不同权"（真 OpenFGA），但跑在确定性正则路由 + 2 订单 YAML 上。
Phase 1 引入真 LLM 大脑、skill 抽象、SQLite 真库（ERP+CRM）、管理界面，验证真实产品形态。

**⚠️ 一个定位变化（相对 research/00）**：skill 作者从"FSE 上门建"改为"**租户管理员自助建+改**"。
产品从"重服务"往"自助配置"挪一格；FSE/服务商的价值落在**出起步模板**上，而非逐户手写。

**7 项产品约束（不变）**：SaaS 多租户 · 贸易+制造 · 企微仅鉴权+组织源 · 核心自研+开源 ·
服务商+按席位 · 无硬合规 · 桌面为主。

---

## 1. 决策清单（本轮 grilling 结论）

| # | 决策 | 结论 |
|---|---|---|
| 范围 | 是否上 LLM | **Phase 1 = LLM + 本地 mock**，骨架变真产品形态 |
| skill 定义 | skill 是什么 | **场景剧本**：指令(给LLM) + allowed_tools + data_domains |
| skill 作者 | 谁写、存哪 | **租户管理员**定义/可改；从平台模板克隆；运行时可编辑，存 DB |
| skill 分配 | 分配授予什么 | **两层**：可见性(哪些角色能用) + 同一 skill 按角色实时鉴权展不同数据 |
| 无权处理 | 看不到怎么办 | **工具级组合、静默跳过**（复用 guard，不做字段级脱敏） |
| 编排 | 循环跑哪 | **Go 原生 LLM 循环**，guard 进程内直调；LangGraph 后置到写操作阶段 |
| 模型 | 用哪个 LLM | **OpenAI 兼容 provider 接缝**（base_url/api_key/model，用户提供） |
| prompt 透明度 | 告不告知边界 | **告知边界（仅体验）**；filter-before-grounding 仍是安全底线 |
| mock 存储 | YAML 还是库 | **SQLite 真库**，工具跑参数化只读 SQL |
| mock 广度 | 几个系统 | **ERP + CRM 两库两连接器**，验证跨系统聚合（客户360） |
| 管理 UI | 何时建 | **Phase 1 同时建**（选工具/写剧本/分配角色/设数据域）+ CRUD API |
| RAG | 本轮做否 | **本轮不做**，专注结构化数据 agent 做深 |
| 角色 | 固定还是可建 | **管理员可自建角色** + 编辑"职位文本→角色"映射 |
| 披露 | 全注入否 | **渐进式披露**：prompt 常驻 skill 索引 + load_skill 按需展开 |
| SQL 沙盒 | LLM 写 SQL 否 | **不写裸 SQL**，只调参数化只读工具，DB 只读账号 |
| 并发 | 多会话 | sessionId + 每会话历史；审计链**按租户**；流式 + 取消 |
| 本地文件 | 脑子跑哪 | **云脑 + 桥**（Cursor 式）：云 agentd + 桌面瘦客户端 + 文件走反向桥 |
| 数据流 | 喂 LLM 什么 | 默认云端预处理文件、**只把必要字段喂 LLM**；连接器两形态藏在接口后 |

---

## 2. 目标架构

```
桌面瘦客户端 (Electron)
  ·聊天 + 流式渲染   ·管理配置页   ·本地文件工具(fsguard + 确认窗)
        ▲  │
   反向桥 │  │ WebSocket/HTTP（当远端对待；开发期 localhost）
   (文件) │  ▼
┌────────────────── 云 agentd (Go 单进程) ──────────────────┐
│  LLM 编排循环（工具调用, 流式）                              │
│   ·渐进式披露: prompt 常驻【skill 索引】+ load_skill 元工具  │
│   ·5 层 system prompt                                       │
│  Guard（进程内直调）—— 记录级 ∧ 数据域 交集                 │
│  skill 注册表(DB) │ 每会话历史 │ 按租户哈希链审计            │
│  连接器抽象 ──┬─ mock-ERP (SQLite, 参数化只读 SQL)          │
│               └─ mock-CRM (SQLite, 参数化只读 SQL)          │
└──────────────────────────────────────────────────────────┘
     LLM provider 接缝（OpenAI 兼容: base_url/api_key/model）
```

**进程/信任边界**：
- **云 agentd（服务端，可信）**：LLM 循环、guard/OpenFGA、连接器、审计。安全命脉全在此。
- **桌面（客户端，不可信）**：UI、本地文件工具（fsguard 路径牢笼 + 覆盖写确认）。
- **桥**：云需要读/写本机文件时，流式下发"文件工具调用"→ 桌面执行 → 结果回传。
- 开发期 agentd 仍可跑 localhost，但**按"隔着网络"的接缝建**，上云零返工。

**为什么脑子必须在云**：客户端是员工机器，不可信。若 guard/连接器/DB 密钥落在员工机器上，
可被改二进制/直接取数绕过 → "销售不能看成本"失效。故 guard 必须在服务端、绑核验身份、
在取数那刻判权。本地文件是"用户自己的东西"，无跨用户权限问题，故理直气壮留客户端。

---

## 3. skill 模型（核心新抽象）

### 3.1 数据形状
skill = 一条 DB 记录（场景剧本）：
```
skill {
  id, tenant_id, name, description,
  playbook_md,        # Markdown 剧本正文（给 LLM：怎么干这件事）
  allowed_tools[],    # 能调哪些平台工具
  data_domains[],     # 声明它"可能碰"的敏感域（cost/pricing…）—— 仅声明，非授权
  source_template_id, # 来自哪个平台模板（可空）
  created / updated
}
```

### 3.2 两层语义（可见性 ≠ 数据）
- **可见性（能力维度）**：skill 分配给哪些角色 → 决定角色**能不能用**这个 skill。
- **数据自适应（数据维度）**：同一 skill 服务多角色，运行时按调用者身份实时 Check 数据域。
  销售用"订单360"看到状态/交期；经理用**同一个** skill 多看到成本/利润。**不为每角色克隆 skill。**

### 3.3 两个独立的闸（务必分开，别粘）
- **闸 A：把 skill 分配给角色** → 该角色能用此 skill、能调它的工具。（能力）
- **闸 B：把数据域 viewer 授给角色** → 该角色能看 cost/pricing 等敏感数据。（数据）
- skill 里的 `data_domains` 字段**不是授权**，只用于：(1) 喂 prompt 边界告知；(2) 管理员分配时
  UI 提示"此 skill 可能暴露成本/底价"，让他再单独决定闸 B。
- 反例（禁止）：把"分配 skill"直接等同"授数据域" → 能力×数据塌成一维，预过滤护城河变糊。

### 3.4 授权模型改动（OpenFGA）
- 新增 `type skill`，含 `usable_by: [user, role#assignee, department#member, department#manager]`。
- **工具可达性改为经由 skill**：不再给角色直接绑 `tool#invoker`；"能调工具" =
  用户有一个 usable 的 skill 且该工具 ∈ skill.allowed_tools。
- **`data_domain#viewer` 保持独立第二轴**（"同问不同权"命脉，不动）。
- 净效果：能力由 skill 决定；数据由数据域独立决定；guard 每次调用取交集。

### 3.5 模板 → 租户 skill → 分配（三层）
1. **平台模板**（全局、只读、我们/FSE 维护、带版本）：起步 skill，含 playbook + allowed_tools
   + suggested_data_domains + suggested_roles。
2. **管理员克隆模板** → 生成本租户 skill 行（落 tenant_id、source_template_id）。可改：
   playbook 措辞（加公司术语）、加/减工具（**只能从平台工具目录挑，不能造新工具**）、
   调 data_domains 声明、改名。克隆后与模板脱钩（模板升级不自动覆盖；未来可做 diff 提示）。
3. **分配**（写 OpenFGA `usable_by` 元组）：skill → 角色。

---

## 4. 编排器 + system prompt（Go 原生）

### 4.1 "算一次、扇出三处"
对登录用户只算**一次** usable skill 集合（DB + OpenFGA `usable_by`），扇出到三处：
- **②(a) 工具墙**：常驻只给 `load_skill` 元工具 + 环境工具（本地文件读）；某 skill 被 load 后，
  才把它的 allowed_tools 加进可用集。
- **②(b) prompt 剧本层**：常驻只放 **skill 索引**（每 skill 一行"名字 + 一句话描述"）；
  正文 `playbook_md` **不进** prompt，按需由 load_skill 展开。
- **②(c) 边界告知**：prompt 里写调用者角色与不可见域（仅体验）。

### 4.2 单次问答流程
1. （假）登录 → Principal → roles。
2. 载入 usable skills → 算工具墙 + skill 索引。
3. 拼 **5 层 system prompt**：
   - 平台基座（铁律：只用给到的工具、不猜权限、拒答不泄露存在性）
   - 租户（公司名/行业/术语口径）
   - 角色（调用者是"销售"/"经理"…）
   - skill 索引（+ 已 load 的 skill 正文）
   - 上下文（已过滤工具清单、时间、边界告知、订单号等）
4. **LLM 工具调用循环**：LLM 判断该用哪本 → `load_skill(name)` 拿正文 + 解锁其工具 →
   选工具 → `guard.Authorize`（记录级 ∧ 数据域）→ 无权则**静默跳过**该子工具、告知 LLM
   "此项不可用" → 连接器跑参数化只读 SQL → 结果回喂 → 收敛 → **流式**推客户端。
5. 哈希链审计记每次工具调用 + 决策 + 所用 skill。

### 4.3 渐进式披露（不再全注入）
- 常驻体积与 skill 数量脱钩（只随索引线性、每行极短），省 token、降 LLM 选错工具概率。
- 安全不变：load 一本剧本不授予任何权限；工具仍逐次过 guard；索引只列 usable 的 skill。
- Phase 1 skill 少也用渐进式（用户明确要求，不做全注入捷径）。

### 4.4 无权处理（工具级跳过）
工具粗粒度、各绑一个数据域；skill 组合多个工具；调用者无权的子工具被静默跳过，
skill 返回成功的那部分。复用已验证 guard，**不做字段级脱敏**（避免新安全面）。

### 4.5 模型接缝
OpenAI 兼容 provider（chat completions + tool calling）。配置留 `base_url / api_key / model`
三项，开发期指向用户服务端网关，生产改配置即可。不锁供应商。

---

## 5. mock 环境（SQLite 真库 · ERP + CRM）

### 5.1 两个库、两个连接器
- **mock-erp.db**：orders、customers、inventory、boms、materials、receivables(应收)、suppliers。
- **mock-crm.db**：contacts(联系人)、follow_ups(跟进)、opportunities(商机)。
- **erpConnector / crmConnector**：各自把 SQL 封成**参数化只读**查询工具，均实现现有
  `connector.Connector` 接口；也可各自暴露成 MCP server。演练 research/09 的"老 ERP 无 API 靠读库"。

### 5.2 SQL 沙盒（安全底线）
- LLM **绝不写裸 SQL**，只调参数化只读工具（如 `erp.query_order(orderId)`）。
- DB 连接开**只读账号**。每个工具带 `ResourceType/ResourceArg/DataDomain` 声明、走 guard。
- 理由：让 LLM 拼 SQL = 敞开注入面 + 绕过数据域。参数化工具 = 注入面收敛 + 逐次判权。

### 5.3 种子数据（要"够聚合"）
~20-30 订单、~8-10 客户、多部门多人、含逾期应收、含欠料库存——才验证得出聚合/筛选/JOIN。

### 5.4 先验证的场景
1. **客户360**（跨 ERP+CRM，旗舰）：一句"A公司现在啥情况"→ 拼订单+应收+联系人+跟进。
2. 逾期应收预警（聚合 + 数据域）。
3. 交期风险（齐套 + 排期，多工具）。
4. 订单利润（数据域、角色差异——延续"同问不同权"证明）。
5. 喂本机文件 → 查库 → 出文件（验证桥 + 本地文件工具）。

---

## 6. 管理界面（Phase 1 同时建）

桌面新增**配置页** + agentd 的 CRUD API：
- **角色管理**：新建/编辑自定义角色（管理员可自建，不限于固定 7 个）。
- **职位映射**：编辑"企微职位文本 → 角色"规则（取代写死的 `sync.DefaultRoleRules`）。
- **skill 编辑器**：命名、从工具目录挑工具、写 playbook Markdown、设 data_domains、克隆平台模板。
- **分配**：skill → 角色（闸 A）；数据域 viewer → 角色（闸 B）——**两个动作分开呈现**。

---

## 7. 并发 / 会话 / 审计

- **会话状态**：引入 `sessionId` + 每会话消息历史（Phase 1 内存 map；跨重启持久化后置）。
- **审计链**：从"一条全局链"改为**按租户一条链**（租户才是隔离与"老板查审计"边界）。
- **流式 + 取消**：LLM 走 SSE/WebSocket 流式；用户"停止" → context 取消 → 中止循环 + 在飞 LLM 调用。
- 并发：Go 每请求一 goroutine；LLM 为 IO 密集，高并发无碍；审计若落库开 WAL 或串行化。

---

## 8. 数据流与外传边界（心里有数）

以"销售小王喂本机 Excel → 查订单 → 整理成表"为例：
```
① 桌面 fsguard 读文件 → ② 客户端 ─[桥]→ 云 agentd（内容上云）
→ ③ 云端拼请求（prompt + skill + 文件相关字段 + 工具）
→ ④ 云 ─[OpenAI兼容API]→ LLM 厂商  ★ 内容到达模型厂商
→ ⑤ LLM 要调 query_order → ⑥ guard 判权 → 连接器查库
→ ⑦ 结果回喂 LLM ★ → ⑧ 流式回客户端 →（可选）fsguard 写回本机
```
**两道外传门**：② 到你的云（自控）；④ 到 LLM 厂商（第三方）。后者是资料外传真正边界。
- 控制手段 1：LLM endpoint 选**自建/国产/私有化网关**，避免数据出境。
- 控制手段 2（设计原则，本轮认可）：**云端先用代码/工具预处理文件、只把必要字段喂 LLM**；
  客户名/价格/毛利等敏感列尽量不进 LLM 请求。

---

## 9. 生产连接器拓扑（Phase 1 不实现，记清避免遗忘）

云 agentd 在云端，客户老 ERP 常在其内网防火墙后 → 云**拨不进去**。生产两类连接器：
- **本地网关连接器**（接内网库）：客户内网装一个小 Agent，挨着 DB，**主动出站**连你的云；
  云下发"已批准的参数化只读查询"，本地 Agent 执行并回传行。**DB 密码只留客户现场、永不上云**；
  本地 Agent 是"哑肌肉"、不做鉴权（鉴权仍在云 guard）。
- **云 API 连接器**（接 SaaS ERP：金蝶云星空/用友 Open API/好业财）：云直接调其公网 API，免装。
- 二者都藏在现有 `connector.Connector` 接口后。**Phase 1 用本地 SQLite 顶替，循环/guard/skill 层零改动。**
- 落地成本提醒：本地网关需客户装小程序（行业标配，但对无 IT 的 SME 是 onboarding 摩擦）。

---

## 10. 明确不做（Phase 1 边界）

真企微 OAuth（无备案域名）、真实 ERP/连接器、RAG/知识库、写操作 + 人在环审批、
计费、真实身份（仍假下拉登录）、LangGraph、跨重启会话持久化。

---

## 11. 里程碑（按"先出一条竖切"排）

- **M1 数据地基**：ERP/CRM 两 SQLite + 种子数据 + 两连接器（参数化只读工具，实现 `Connector` 接口）。
- **M2 skill 内核**：skill DB 模型 + OpenFGA `type skill` + guard 改经 skill + 渐进式披露
  （索引 / load_skill）+ 种子 skill + 平台模板。
- **M3 云 agentd 编排**：provider 接缝 + Go 工具循环 + 5 层 prompt + 流式 + 每会话状态 + 按租户审计。
- **M4 客户端/服务端接缝 + 桥**：桌面改瘦客户端（WS/HTTP）+ 本地文件反向桥（fsguard + 确认窗）。
- **M5 一条竖切验证**：跑通"客户360"端到端 + 复现同问不同权 —— 先证架构，再铺 UI。
- **M6 管理界面**：CRUD API + 桌面配置页（角色 / 映射 / skill / 分配 / 数据域）。
- **M7 全场景验证**：4 场景 + "喂本机文件→查库→出文件"。

---

*本设计与用户 grilling 的 18 条决策逐条对应。确认后从 M1 开工。*

