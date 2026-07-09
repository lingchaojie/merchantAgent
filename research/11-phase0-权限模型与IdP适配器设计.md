# Phase 0 详细设计 —— 权限模型 + IdP 适配器 + 组织→元组同步

> 版本 v1.0 ｜ 2026-07-08 ｜ 承接 `10` 的 Phase 0
> 目标：把"复用企微既有角色/职位、免全量导入、manager≠staff、agent 权限≤用户"落成**可实现的 OpenFGA 模型 + 适配器接口 + 同步算法**。
> 本阶段全本地/mock，无外部依赖（无备案域名、mock IdP、mock ERP）。

---

## 0. 设计目标与不变量

1. **权限从组织架构涌现**：manager-agent vs staff-agent 不靠克隆两个 agent，而靠"角色绑定 + 身份"——同一 agent、同一问题，因调用者身份不同而结果不同。
2. **agent 权限 ≤ 当前用户权限**：工具调用与数据检索都做实时 Check，取"用户 ∧ agent 都授权"的交集。
3. **免全量导入**：企业授权后，自动从企微（Phase 0 是 mock）拉组织架构播种权限，不需企业手工录入员工。
4. **两条接缝可插拔**：`IdP 适配器`（换企微/钉钉/飞书/AD）与 `连接器抽象`（换 ERP/DB/UI）——Phase 0 用 mock 实现，日后无痛替换。
5. **租户隔离**：一切按 `tenant`（企微 corpid）命名空间隔离，跨租户 Check 结构上不可能。

---

## 1. 权限的两个维度

我们要同时管两类授权，别混为一谈：

| 维度 | 问题 | 例子 | 主要机制 |
|---|---|---|---|
| **A. 能力授权**（工具/skill/agent 可见可用）| 这个角色能用哪个 agent、能调哪些工具/skill？| 审批类工具只给经理；报价 skill 只给销售 | RBAC + 角色→工具元组 |
| **B. 数据授权**（能看哪些具体数据）| 这个用户能看哪些订单/文档/数据域？| 销售只看自己客户；成本仅经理可见 | ReBAC（部门/主管继承）+ 数据域敏感度 |

两者都落在**同一张 OpenFGA 授权图**里（不建平行手工表，防漂移）。

---

## 2. OpenFGA 授权模型（DSL）

下面是 Phase 0 的模型（OpenFGA DSL / schema 1.1）。注释解释每个关系。

```
model
  schema 1.1

# ---------- 主体 ----------
type user            # subject = user:<open_userid>（企微全局稳定 ID；mock 阶段用 mock id）

# ---------- 租户（= 企微 corpid） ----------
type tenant
  relations
    define admin: [user]          # 企业管理员（来自企微授权信息/管理员回调）
    define member: [user]         # 该租户的在职成员（status=1）

# ---------- 部门（层级，来自企微通讯录） ----------
type department
  relations
    define tenant: [tenant]                       # 属于哪个租户
    define parent: [department]                   # 上级部门（企微 parentid）
    define direct_member: [user]                  # 直属该部门的成员
    define leader: [user]                          # 该部门主管（is_leader_in_dept）
    # 部门成员 = 直属成员（不向下继承成员；成员不因父部门而扩大）
    define member: direct_member
    # 管辖（manager）向下继承：父部门主管也管辖子部门
    define manager: leader or manager from parent

# ---------- 角色（部门+主管+标签 推导，或管理员映射） ----------
type role
  relations
    define tenant: [tenant]
    # 角色被赋予：可以直接给用户，也可以"整个部门成员"或"某标签成员"批量赋予
    define assignee: [user, department#member, department#manager]

# ---------- 数据域（敏感度分级的抽象资源，能力A与数据B的桥） ----------
type data_domain
  relations
    define tenant: [tenant]
    # 谁能读这个数据域（如 cost/margin/pricing 只给经理与财务角色）
    define viewer: [user, role#assignee, department#manager]

# ---------- Agent（一个通用 agent 可被多角色使用，行为随身份变） ----------
type agent
  relations
    define tenant: [tenant]
    define can_configure: admin from tenant
    define can_use: [user, role#assignee, department#member] or member from tenant
    define can_view_audit: admin from tenant

# ---------- 工具 / Skill（能力授权的核心） ----------
type tool
  relations
    define tenant: [tenant]
    define domain: [data_domain]                  # 该工具触碰的数据域（可空）
    # 谁能调用该工具（按角色/部门授予）
    define invoker: [user, role#assignee, department#manager]

# ---------- 业务记录（数据授权的最细粒度，Phase 0 以"订单"为例） ----------
type order
  relations
    define tenant: [tenant]
    define owner_dept: [department]               # 订单归属部门
    define owner: [user]                          # 订单负责人（如业务员）
    # 可见 = 负责人 本人 OR 归属部门成员 OR 归属部门（含上级）主管
    define viewer: owner
      or member from owner_dept
      or manager from owner_dept
```

**几个关键设计点：**
- **`manager from parent` 向下继承**：父部门主管自动管辖子部门 → "厂长看全厂、车间主管只看本车间"天然成立。
- **`member` 不向上/向下扩散**：成员就是直属成员，避免"父部门的人能看子部门全部"的越权。
- **能力A 与 数据B 的桥 = `data_domain`**：一个工具声明它碰哪个数据域（如"查成本"工具 domain=cost），Check 时既查 `tool#invoker` 又查 `data_domain#viewer`，双满足才放行。
- **`agent.can_use` 用 `or member from tenant`**：通用 agent 默认全员可用，具体能力由它能调的 tool 决定——符合"一个通用 agent、按角色收窄工具"。

---

## 3. IdP 适配器接口（身份源可插拔的接缝）

一个接口，把"从企微/钉钉/飞书/AD/mock 拿身份与组织"统一。Phase 0 只实现 `MockIdpAdapter`（+ 留 `WeComIdpAdapter` 骨架）。

```typescript
// 规范化的组织快照（各 IdP 都归一到这个结构）
interface OrgSnapshot {
  tenantId: string;                 // 企微 corpid（mock 时自造）
  admins: string[];                 // user ids（管理员）
  users: OrgUser[];
  departments: OrgDept[];
  tags: OrgTag[];                   // 标签（角色组的原料之一）
}
interface OrgUser {
  userId: string;                   // 规范主键 = 企微 open_userid（mock 时自造稳定 id）
  name?: string;                    // 可空（PII 需授权，不依赖）
  status: 'active' | 'disabled' | 'quit';   // 企微 status 归一
  deptIds: string[];                // 所属部门（可多个）
  mainDeptId?: string;
  positionText?: string;            // 【自由文本】职位，如 "业务一部经理"——不可当枚举
  leaderInDeptIds: string[];        // 在这些部门里是主管（is_leader_in_dept）
  tagIds: string[];
}
interface OrgDept { deptId: string; name: string; parentId?: string; order?: number; }
interface OrgTag  { tagId: string; name: string; memberUserIds: string[]; }

// 适配器接口
interface IdpAdapter {
  readonly kind: 'wecom' | 'dingtalk' | 'feishu' | 'ad' | 'mock';

  // 1) 登录：把 IdP 的登录结果换成我们的会话主体
  authenticate(ctx: LoginContext): Promise<Principal>;   // → { tenantId, userId(open_userid), displayName? }

  // 2) 全量拉组织（授权成功/首配时）
  fetchOrgSnapshot(tenantId: string): Promise<OrgSnapshot>;

  // 3) 增量拉变更（回调/轮询驱动）
  fetchOrgChanges(tenantId: string, since: Cursor): Promise<{ changes: OrgChange[]; next: Cursor }>;
}
type OrgChange =
  | { op: 'upsertUser'; user: OrgUser }
  | { op: 'removeUser'; userId: string }
  | { op: 'upsertDept'; dept: OrgDept }
  | { op: 'removeDept'; deptId: string }
  | { op: 'upsertTag';  tag: OrgTag };
```

**Phase 0 落法**：`MockIdpAdapter` 从一份 YAML/JSON（mock 通讯录，见 §6）读出 `OrgSnapshot`；`authenticate` 直接按选中的 mock 用户返回 `Principal`（本地开发登录，无需备案域名）。日后 `WeComIdpAdapter` 把 §08 的 `getuserinfo3rd`/`user/get`/`department/list` 映射到同样的结构——**上层同步逻辑与权限模型完全不用改**。

---

## 4. 组织快照 → OpenFGA 元组同步算法

核心：把 `OrgSnapshot` 翻译成 OpenFGA 元组；增量变更做幂等 upsert/delete；定期全量对账兜底。

### 4.1 全量播种（首次授权 / 全量对账）
对 `OrgSnapshot` 生成期望元组集合 `desired`：

```
# 租户
tenant:<T>#admin@user:<u>            for u in admins
tenant:<T>#member@user:<u>           for u in users where status==active

# 部门层级
department:<T>/<d>#tenant@tenant:<T>
department:<T>/<d>#parent@department:<T>/<parent>      if dept has parent
department:<T>/<d>#direct_member@user:<u>              for u in dept.directMembers (active)
department:<T>/<d>#leader@user:<u>                     for u where d in u.leaderInDeptIds

# 角色（见 §5 的职位→角色映射产出 roleId + assignees）
role:<T>/<r>#tenant@tenant:<T>
role:<T>/<r>#assignee@user:<u>                         # 直接赋予
role:<T>/<r>#assignee@department:<T>/<d>#member         # 整部门赋予
```

对账 = 拉取 OpenFGA 现有元组 `current`（按本次同步的类型范围），计算：
- `toAdd = desired − current` → `fga.write(writes=toAdd)`
- `toDelete = current − desired` → `fga.write(deletes=toDelete)`
- 幂等：重复跑得同一结果；分批写（OpenFGA 单次 write 有条数上限，分页提交）。

### 4.2 增量同步（回调/轮询驱动）
每个 `OrgChange` 映射到最小元组增删：
- `upsertUser`：改 `tenant#member`（active 与否）、`department#direct_member`、`department#leader`、`role#assignee`（若职位/标签变了重算其角色）。
- `removeUser`（离职 status=quit）：删该用户所有 subject 元组（member/direct_member/leader/role assignee/owner…）。**离职清理是安全关键，必须做。**
- `upsertDept`/`removeDept`：改 `parent`/`tenant`；删部门要处理其成员与子部门（级联或标记）。
- `upsertTag`：重算该标签对应角色的 assignees。

### 4.3 一致性保障
- **幂等**：所有写按"期望态"计算，天然可重放（回调可能重复/乱序）。
- **定期全量对账**：每日跑一次 §4.1 全量 diff，兜住漏掉/乱序的增量。
- **顺序**：先写 department（parent 链）再写依赖它的 role/member，避免悬空引用。

---

## 5. 职位自由文本 → 平台角色映射

**问题**：企微 `positionText` 是自由文本（"销售""业务一部经理""外贸-张三"），不能直接当角色。可靠的结构化信号是 **部门 + 主管标记 + 标签**。

**策略（三层，优先级从高到低）：**
1. **结构化优先**：`is_leader_in_dept` → 直接给 `manager` 语义（对应 `department#leader`，天然进模型）；部门/标签 → 绑定平台角色（管理员在开通时把"某部门/某标签 = 某平台角色"配好，一次性）。
2. **职位文本规则匹配（辅助）**：可选的规则表把文本归一到角色，仅作**建议**，需管理员确认：
   ```yaml
   positionRules:                 # 按顺序匹配，命中即止
     - match: ["经理","主管","总监","厂长","负责人"]   # 含即视为管理层
       role: manager_tier
     - match: ["销售","业务","外贸","BD"]
       role: sales
     - match: ["采购"]      role: purchasing
     - match: ["计划","PMC","排产"]   role: planner
     - match: ["质检","QC","IQC","IPQC","OQC","品控"]   role: qc
     - match: ["财务","会计","出纳"]   role: finance
     - default: staff
   ```
3. **管理员兜底**：后台给管理员一个"职位文本 → 平台角色"的映射确认页；未确认的走 `default: staff`（最小权限）。**遵循 fail-closed：拿不准就给最小权限，不误放大。**

**产出**：每个用户得到一组 `roleId`，进 §4 的 `role#assignee` 元组。角色定义与映射规则落在**我们平台侧**，以企微结构播种，可微调——既复用企微、又不被自由文本绑死。

---

## 6. 运行时权限检查流程

### 6.1 工具调用（能力A + 数据B 双查，取交集）
```
Agent 决定调用 tool:<T>/<toolId>（如"查订单成本"，其 domain=cost）
  1) 解析调用者 Principal:(tenantId, userId)  ← 来自 IdP 适配器登录
  2) 能力检查:  fga.check(user:<uid>, invoker, tool:<T>/<toolId>)      # 角色能不能调这个工具
  3) 数据域检查(若 tool 有 domain): fga.check(user:<uid>, viewer, data_domain:<T>/cost)
  4) 仅当 2)&3) 都为 true 才执行；否则拒绝并给出"无权限"提示（不泄露数据存在性）
  5) Token Exchange: 换出 act=user / actor=agent 的短时降权令牌，MCP Server 以"用户身份"查后端系统
  6) 全过程写哈希链审计（谁、调什么工具、参数、授权决策、租户）
```
**这一步保证 agent 权限 ≤ 用户权限**：即使 LLM"想"调它没权的工具，第 2/3 步直接拦。

### 6.2 数据检索 / RAG（filter-before-grounding）
```
用户提问 → 需检索企业知识/记录
  1) 粗过滤(预): fga.list_objects(user:<uid>, viewer, "order")  → 授权的 order id 集
     （对 KB chunk 同理：list 授权的 doc/scope）
  2) 把授权 id 集 + tenantId + scope 灌进 Qdrant 元数据过滤，执行混合检索(BM25+向量)+rerank
  3) 命中结果再细过滤(后): 对返回项 fga.batch_check 复核（over-fetch 2-3x 再筛）
  4) 只有通过的内容进入 LLM 上下文 —— 模型永远看不到越权数据
```
**关键**：检查在**数据到达 LLM 之前**。高敏数据域（cost/margin/pricing/客户名单/薪资）默认仅经理/财务角色的 `data_domain#viewer` 通过，其余角色**检索阶段就被过滤掉**，模型无从泄露。

### 6.3 "同一问题、不同身份、不同结果"如何发生（串起来）
- 销售 A 问"这批订单利润多少"：`data_domain:cost#viewer` check 失败 → 成本字段被过滤/拒答，只回非敏感的进度信息。
- 经理 B 问同一句：B 因 `department#manager`（或 finance 角色）通过 cost viewer → 正常返回利润。
- **同一个 agent、同一个工具、同一句话，结果因身份而异**——这就是"权限从组织架构涌现"，无需两个 agent。

---

## 7. Mock 数据示例（Phase 0 可直接用）

### 7.1 mock 组织（一份通讯录，喂 MockIdpAdapter）
```yaml
tenantId: mock-corp-001
admins: [u_boss]
departments:
  - { deptId: d_root,  name: "示例贸易公司", parentId: null }
  - { deptId: d_sales, name: "销售部",       parentId: d_root }
  - { deptId: d_prod,  name: "生产部",       parentId: d_root }
  - { deptId: d_fin,   name: "财务部",       parentId: d_root }
users:
  - { userId: u_boss,   positionText: "总经理",     status: active, deptIds: [d_root], leaderInDeptIds: [d_root], tagIds: [] }
  - { userId: u_sales1, positionText: "销售",       status: active, deptIds: [d_sales], leaderInDeptIds: [],       tagIds: [t_sales] }
  - { userId: u_smgr,   positionText: "销售部经理", status: active, deptIds: [d_sales], leaderInDeptIds: [d_sales], tagIds: [t_sales] }
  - { userId: u_plan,   positionText: "生产计划员", status: active, deptIds: [d_prod],  leaderInDeptIds: [],        tagIds: [] }
  - { userId: u_fin,    positionText: "会计",       status: active, deptIds: [d_fin],   leaderInDeptIds: [],        tagIds: [] }
tags:
  - { tagId: t_sales, name: "销售团队", memberUserIds: [u_sales1, u_smgr] }
```

### 7.2 由上表推导出的关键元组（片段）
```
tenant:mock-corp-001#admin@user:u_boss
department:mock-corp-001/d_sales#parent@department:mock-corp-001/d_root
department:mock-corp-001/d_sales#leader@user:u_smgr        # 销售经理 → manager(d_sales)
department:mock-corp-001/d_sales#direct_member@user:u_sales1
role:mock-corp-001/sales#assignee@department:mock-corp-001/d_sales#member
data_domain:mock-corp-001/cost#viewer@user:u_boss
data_domain:mock-corp-001/cost#viewer@user:u_fin
data_domain:mock-corp-001/cost#viewer@department:mock-corp-001/d_root#manager   # 总经理管辖全公司→可见成本
```

### 7.3 mock ERP 数据（喂 mock MCP Server，跑 T3/M2 场景）
```
orders: [
  { orderId: SO-1001, ownerUserId: u_sales1, ownerDeptId: d_sales, customer: "A公司",
    status: "生产中", promiseDate: "2026-07-20", cost: 82000, price: 100000 },
  { orderId: SO-1002, ownerUserId: u_sales1, ownerDeptId: d_sales, customer: "B公司",
    status: "待排产", promiseDate: "2026-07-25", cost: 45000, price: 60000 }
]
# 齐套/欠料(M2): 每个 order 关联 BOM 与库存，算 shortage 清单
```
→ 对应元组：`order:mock-corp-001/SO-1001#owner@user:u_sales1`、`#owner_dept@department:mock-corp-001/d_sales`。

### 7.4 验收用例（可写成自动化测试）
| 用户 | 提问 | 期望 |
|---|---|---|
| u_sales1（销售）| SO-1001 进度？| ✅ 返回进度（自己的订单，viewer 通过）|
| u_sales1 | SO-1001 利润多少？| ⛔ 成本/利润被过滤（cost#viewer 不通过），只答进度 |
| u_smgr（销售经理）| 本部门订单利润？| ✅ 返回（manager(d_sales) + 若配 finance 语义）|
| u_boss（总经理）| 任意订单利润？| ✅ 返回（manager(d_root) 向下管辖全公司）|
| u_plan（计划员）| SO-1001 进度？| 按配置：非销售部→默认看不到该订单（owner_dept 不含其部门）|
| u_fin（会计）| 成本？| ✅ cost#viewer 通过 |

---

## 8. Phase 0 落地清单（工程可直接拆任务）

**里程碑 A — 权限地基（最先做，不依赖任何外部）**
- [ ] 起 OpenFGA（单机 + Postgres），写入 §2 的 model。
- [ ] `MockIdpAdapter`：读 §7.1 YAML → `OrgSnapshot`；`authenticate` 返回选定 mock 用户的 `Principal`。
- [ ] 同步器：`OrgSnapshot → 元组`（§4.1 全量 + diff 对账），职位映射（§5）。
- [ ] 单元测试：§7.4 的 6 个用例全绿（这是"权限正确"的可回归证明）。

**里程碑 B — 单场景闭环（mock ERP + 桌面壳）**
- [ ] mock ERP MCP Server：暴露 `query_order_status`、`check_material_kitting`（读 §7.3 数据）。
- [ ] 工具/数据域元组：`tool#invoker`、`tool#domain`、`data_domain#viewer`。
- [ ] 运行时检查中间件（§6.1 双查 + Token Exchange 骨架）。
- [ ] Tauri 桌面壳：本地登录（选 mock 用户）→ 聊天 → 调 agent → 流式回答；本地文件 MCP 骨架（路径沙箱）。
- [ ] 编排：LangGraph 一个确定性场景（T3 或 M2）。
- [ ] 哈希链审计日志（最小版）。

**里程碑 C — 验证**
- [ ] 端到端：桌面里切换 mock 用户，复现 §7.4 的"同问不同权"。
- [ ] 留好两条接缝：`IdpAdapter`（待接真实企微）、连接器抽象（待接真实系统）。

**Phase 0 不做（明确边界）**：真实企微 OAuth（无域名）、真实 ERP、写操作、多 IdP 实现、知识库 RAG（放 P1）、计费。

---

*本设计（11）是 Phase 0 的实现蓝图，与 `10`（落地方案）、`00`（主报告）+ `01–09`（调研）配套。确认此设计后即可开工里程碑 A；如需，我可再产出里程碑 A 的目录结构与关键代码骨架（OpenFGA model 文件、适配器接口、同步器、测试用例）。*