# M6 管理界面 —— 设计 (spec)

> 版本 v1.0 ｜ 2026-07-10 ｜ 承接 `docs/phase1-设计.md` §6/§11、M1–M5 已完成骨架
> 里程碑 **M6 = 管理界面**：CRUD API + 桌面配置页（角色 / 职位映射 / skill / 分配 / 数据域）。
> 本 spec 是 M6 的实现蓝图，决策来源见下"决策清单"（与用户逐条确认）。

---

## 0. 目标与范围

把 Phase 1 §6 的"租户管理员自助配置"落地：管理员在桌面配置页里**建角色、改职位映射、编 skill、分配（两个闸）、授数据域**，改动**落盘持久化**并**实时**投影进 OpenFGA。

**一句话架构**：新增一个 `config` 配置库（DB 当真源）+ 一个 `wire.Projector` 投影引擎，把"配置 DB → OpenFGA 元组"收口成一条主轴——启动全新投影、运行时改一次差量 reconcile 一次（含删除）。顺手还清 `authz.Syncer.Seed` 里标注的 "P0 遗留增量 reconcile" 技术债。

**不做（M6 边界）**：真企微 OAuth（admin 身份仍由 demo 注入）、tag 派生角色的 UI 管理（仍自动投影，见 §2 注）、跨重启**会话**持久化（§10 沿用，只持久化**配置**）、模板升级 diff 提示、角色/域的国际化。

---

## 1. 决策清单（brainstorming 结论）

| # | 决策 | 结论 |
|---|---|---|
| 持久化 | 配置跨重启存活？ | **配置落盘持久化**：文件型 SQLite 当真源；启动时全新投影进内存 OpenFGA。会话历史仍不持久化。 |
| API 鉴权 | /admin/* 校验？ | **强制 admin 鉴权**：每端点先 `Check(user, admin, tenant)`，非 admin → 403。复用既有 `tenant.admin`。 |
| 投影时机 | 何时落 OpenFGA？ | **实时差量 reconcile（含删除）**：每次保存重算期望集 → 读当前 → Reconcile → ApplyDiff。撤权即时生效。 |
| 投影引擎 | 怎么建？ | **方案 A：全量重投影 + 差量 reconcile**（否决"每实体增量 diff"的脆弱、"清空再写"的鉴权真空）。 |
| 角色 | 隐式还是实体？ | 加 `roles` 表让角色成一等公民（先建后分配）。 |
| tag 派生角色 | 纳入 UI？ | **不纳入**（已知取舍），仍自动投影。 |

---

## 2. 配置数据模型（新增 `backend/config` 包）

文件型 SQLite（`config.Open(dsn)`，`dsn=""` → `:memory:` 供测试；`OpenFile(path)` → 落盘）。四张新表，均带 `tenant_id`。**seed 值 = 现有硬编码的等价物**，保证零行为回归。

```sql
-- 角色注册表：让角色成为可先建、可列出、可分配的一等对象
CREATE TABLE roles (
  tenant_id   TEXT NOT NULL,
  role_id     TEXT NOT NULL,
  label       TEXT NOT NULL,        -- 展示名（如 "销售"）
  description TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (tenant_id, role_id)
);
-- seed: manager_tier/sales/purchasing/planner/qc/finance/staff
--       （= DefaultRoleRules 引用的 6 个功能角色 + staff 兜底）

-- 职位映射规则（取代写死的 sync.DefaultRoleRules），有序
CREATE TABLE role_rules (
  tenant_id  TEXT NOT NULL,
  ord        INTEGER NOT NULL,       -- 求值顺序（第一个命中者胜）
  match_terms TEXT NOT NULL,         -- JSON array，如 ["经理","主管","总监"]
  role_id    TEXT NOT NULL,
  PRIMARY KEY (tenant_id, ord)
);
-- seed: DefaultRoleRules 逐条

-- 数据域目录（skill 编辑器 data_domains 选择源 + 闸 B 的域清单）
CREATE TABLE data_domains (
  tenant_id TEXT NOT NULL,
  domain_id TEXT NOT NULL,
  label     TEXT NOT NULL,
  PRIMARY KEY (tenant_id, domain_id)
);
-- seed: cost(成本)、pricing(定价)

-- 数据域授予（闸 B）。subject = 完整 OpenFGA 主体串，兼容 user/role/dept-manager 三形态
CREATE TABLE domain_grants (
  tenant_id TEXT NOT NULL,
  domain_id TEXT NOT NULL,
  subject   TEXT NOT NULL,           -- 如 "role:<t>/finance#assignee" 或 "user:u_fin"
  PRIMARY KEY (tenant_id, domain_id, subject)
);
-- seed（原样搬 wire.seedScenario 的 cost viewer 三条，e2e 零回归）:
--   user:u_fin | cost
--   department:<t>/d_sales#manager | cost
--   department:<t>/d_root#manager  | cost
```

`skills` / `templates` 两表已存在（`backend/skill/schema.sql`），**不改结构**，只加 CRUD 方法并支持文件落盘。

**投影约定**（见 §3 纯函数）：
- `roles` → `tenant:<t> | tenant | role:<t>/<id>`（角色对象存在，可被 UI 列、被分配）。
- `data_domains` → `tenant:<t> | tenant | data_domain:<t>/<id>`（新增，additive，不破坏现有 fixtures）。
- `domain_grants` → `<subject> | viewer | data_domain:<t>/<domain>`。
- `role_rules` → 不直接投影；加载成 `[]sync.RoleRule` 喂 `sync.SnapshotToTuples`，改规则即重算 user→role。

**注（已知取舍）**：`sync.RolesForUser` 里的 tag 派生角色 `tag-<tag>` M6 不纳入 UI 管理，仍随 org 快照自动投影。避免把 tag 体系拖进本里程碑。

---

## 3. 投影引擎（`wire.Projector`）+ `authz.ReadTuples`

三个纯投影函数各管一块（无 OpenFGA/网络，可 hermetic 测试），`Projector` 只做编排。

```go
// backend/config/tuples.go — 纯函数
func RoleTuples(roles []Role, tenant string) []sync.Tuple
func DomainTuples(domains []Domain, grants []Grant, tenant string) []sync.Tuple
func LoadRules(rules []RoleRule) []sync.RoleRule   // DB 行 → sync.RoleRule

// backend/authz/store.go — 新增：差量 reconcile 的前提
// 用 OpenFGA Read API（空 TupleKey = 全量），循环 continuation_token 分页，回 []sync.Tuple
func (s *Store) ReadTuples(ctx context.Context) ([]sync.Tuple, error)

// backend/wire/projector.go — 唯一"不纯"的编排者
type Projector struct {
    store  *authz.Store
    idp    org.Adapter
    cfg    *config.Store
    sk     *skill.Store
    tenant string
    mu     sync.Mutex   // 串行化 Reproject（配置写频率极低）
}

// desired 一次算全整租户期望元组
func (p *Projector) desired(ctx context.Context) ([]sync.Tuple, error) {
    snap  := p.idp.FetchSnapshot(ctx, p.tenant)              // org 快照
    rules := config.LoadRules(cfg.Rules(ctx, p.tenant))      // 规则来自 DB
    org   := sync.SnapshotToTuples(snap, rules)              // 复用
    sks   := skill.Tuples(sk.List(ctx, p.tenant), p.tenant)  // 复用
    dom   := config.DomainTuples(domains, grants, p.tenant)
    rol   := config.RoleTuples(roles, p.tenant)
    fix   := demoFixtures(p.tenant)                          // 非配置派生的订单归属
    return dedup(concat(org, sks, dom, rol, fix)), nil
}

// Reproject —— 启动 & 每次 admin 写共用这一条
func (p *Projector) Reproject(ctx context.Context) error {
    p.mu.Lock(); defer p.mu.Unlock()
    desired, err := p.desired(ctx); ...
    current, err := p.store.ReadTuples(ctx); ...            // 读当前
    return p.store.ApplyDiff(ctx, sync.Reconcile(current, desired))  // 含删除
}
```

- **启动**：`wire.Assemble` 里把现有 `seedScenario` 换成建 `Projector` + 调 `Reproject`（首次 `current` 空 → 纯写，等价今天）。
- **每次 admin 写**：handler 改完 DB → `Projector.Reproject` → 差量落地（含撤权删除）。
- **`demoFixtures`**：把 `seedScenario` 里"非配置派生"的部分（订单 `owner`/`owner_dept` 共 5 条）收进 `desired`，否则全量 reconcile 会误删。cost viewer 三条改由 `domain_grants` 表接管（§2）。
- **复用**：`sync.SnapshotToTuples`、`skill.Tuples`、`sync.Reconcile`、`authz.ApplyDiff` 全部原样复用；新代码只有"读 DB + 合并去重 + Read API"。

---

## 4. Admin API（`cmd/agentd`）

全部走 `requireAdmin` 中间件：`Check("user:"+userId, "admin", "tenant:"+tenant)`，非 admin → 403。userId 来源：demo 阶段由 IPC 从当前身份注入请求头 `X-User-Id`（生产换成 WeCom 会话）。Go 1.22 method+pattern 路由。写端点成功即已完成 `Reproject`。

```
GET    /admin/tools                    平台工具目录（连接器 Tools() 的 Spec，供 skill 编辑器挑）
GET    /admin/roles                    列角色
POST   /admin/roles                    建角色 {id,label,description} → Reproject
PUT    /admin/roles/{id}               改 label/description        → Reproject
DELETE /admin/roles/{id}               删角色（级联清 skills.roles、domain_grants 引用）→ Reproject

GET    /admin/rules                    读职位映射规则（有序）
PUT    /admin/rules                    整体替换规则               → Reproject

GET    /admin/skills                   列 skill
GET    /admin/templates                列平台模板
POST   /admin/skills                   建（blank）或克隆模板 {templateId?} → Reproject
PUT    /admin/skills/{id}              改 name/description/playbookMd/allowedTools/dataDomains/roles → Reproject
DELETE /admin/skills/{id}              删                          → Reproject

GET    /admin/domains                  列数据域
POST   /admin/domains/{d}/grants       授予 域 viewer {subject}    → Reproject
DELETE /admin/domains/{d}/grants       撤销 {subject}              → Reproject
```

**两个闸分开（设计 §3.3 命脉）**：
- **闸 A（能力）** = `PUT /admin/skills/{id}` 的 `roles` 字段（skill → 角色）。
- **闸 B（数据）** = `/admin/domains/{d}/grants`（数据域 → 角色）。
- 二者**不同端点、UI 不同页签**，绝不合并。
- skill 的 `dataDomains` **只是声明**（喂 prompt 边界 + UI 提示"此 skill 可能暴露成本"），存进去但**不产生授权元组**（`skill.Tuples` 已不投影它，现有测试守着）。

---

## 5. 桌面 UI（`desktop/src/renderer`）

顶层加**视图切换**（chat ⇄ admin），复用现有 Linear 风格 tokens（`theme.css`/`app.css`），不引新依赖。

```
App
 ├─ 顶栏齿轮入口（仅当当前身份 Check(admin) 为真才亮；非 admin 灰置+提示）
 ├─ ChatView（现状不动）
 └─ AdminView  ← 新增
     ├─ 左侧子导航：角色 · 职位映射 · 技能 · 分配 · 数据域
     ├─ RolesPane    列表 + 建/改/删（label/description）
     ├─ RulesPane    有序规则行（match 词条 → 角色下拉），增删/排序，整体保存
     ├─ SkillsPane   列表 → 编辑器：名/描述/playbook(textarea)/工具多选(来自 /admin/tools)/
     │               dataDomains 多选(带"⚠ 可能暴露成本"提示)/从模板克隆
     ├─ AssignPane   两张分开的表：① skill × 角色（闸 A，写 skills.roles）
     │                            ② 数据域 × 角色（闸 B，写 grants）—— 视觉强调"能力 ≠ 数据"
     └─ DomainsPane  数据域清单 + 各自 viewer 授予列表
```

**IPC**：加一条**通用**通道 `admin`，preload 暴露 `admin(req: AdminReq): Promise<AdminResp>`；main 代理到 agentd 并注入 `X-User-Id: <当前身份>`（renderer 无网络访问，一贯到底）。renderer 侧封一薄层 typed helper（`listRoles()`、`saveSkill()`…），避免 ~15 个 IPC 通道又保持类型。契约 `shared/contract.ts` 加：

```ts
export interface AdminReq { method: "GET"|"POST"|"PUT"|"DELETE"; path: string; body?: unknown }
export type AdminResp = { ok: true; data: unknown } | { ok: false; status: number; error: string }
// AgentAPI 增: admin(req: AdminReq): Promise<AdminResp>
// Channels 增: admin: "agent:admin"
```

**保存后**：调用返回即代表 `Reproject` 完成 → UI 提示"已生效"。验收演示：切回 chat 用会计/销售身份复问，直观看到撤权/授权即时生效。

**mock 模式**：浏览器预览（`IS_MOCK`）下 admin 走内存 mock（纯为截图/UI dev）；打包 app 永远连真 agentd。

---

## 6. 测试策略

延续现有分层（纯函数 hermetic + 集成 gated on OpenFGA）。全绿判据：`go test ./...`（OpenFGA 起着含 gated）+ desktop `tsc` + `vitest` + `npm run build`。

- **config 单测**（无网络）：`RoleTuples`/`DomainTuples`/`LoadRules` 投影正确；CRUD 往返；删角色级联清引用；首次 seed vs 已有库**跳过 seed**（不覆盖编辑）。
- **skill 单测**：新增 CRUD + CloneTemplate（克隆落 `tenant_id`/`source_template_id`、与模板脱钩）；`Tuples` 仍不投影 `data_domains`（已有测试守住）。
- **projector 单测**（fake store/idp）：`desired()` 合并去重正确；改一条 rule → 某 user 的 role 元组从 desired 消失；删 skill→role → `Reconcile` 产出对应 **Delete**（撤权命脉回归守卫）。
- **`ReadTuples` 集成测**（gated）：写 N 条 → 读回 N 条（含分页）。
- **agentd handler 测**：`requireAdmin` 非 admin → 403；admin CRUD → DB 变 + `Reproject` 被调（可用 fake Projector 断言调用）。
- **e2e 守护**：现有 `e2e/scenarios_test.go`、`wire/live_test.go`（客户360、同问不同权）**必须仍绿**。注意它们各自建 store（`NewStore`+`Seed`+内联 fixture），**不走 `Assemble`**，所以守的是 **runtime/guard 回路**不被破坏。投影路径（`Assemble`→`Projector.Reproject` 产出的元组集）由**新增的 `wire` 集成测**守护：断言经 Projector 种子后，`u_sales1` 能看 SO-1001、`u_fin` 能看 cost 域等关键 Check 与今天一致。两张网合起来才完整。
- **验收剧本**（手动/脚本）：admin 建新角色 → 分配 order360 → 切该身份复问，从"无权"变"可答"；再撤下 → 变回"无权"。证明实时 reconcile 闭环。

---

## 7. 里程碑内拆分（建议实现顺序）

1. **M6a 配置库地基**：`config` 包（4 表 + schema/seed + CRUD + 纯投影函数）+ `skill` CRUD/OpenFile + `authz.ReadTuples`。单测覆盖。
2. **M6b 投影引擎**：`wire.Projector` + 改 `Assemble` 走 Reproject + `demoFixtures`。projector 单测 + e2e 仍绿。
3. **M6c Admin API**：`/admin/*` 路由 + `requireAdmin` + handler 接 config/skill/projector。handler 测。
4. **M6d 桌面 UI**：`admin` IPC 通道 + `AdminView` + 五个 Pane + typed helper。`tsc`/`vitest`/`build`。
5. **M6e 验收**：跑验收剧本，确认实时授权/撤权闭环；更新 memory（部署拓扑里 config.db/skills.db 落盘位置）。

---

## 8. 涉及文件（预估）

**新增**：`backend/config/{config.go,schema.sql,seed.sql,tuples.go,config_test.go,tuples_test.go}`、`backend/wire/projector.go`+`projector_test.go`（含 Assemble→Reproject 集成测，gated on OpenFGA）、`desktop/src/renderer/src/components/admin/{AdminView,RolesPane,RulesPane,SkillsPane,AssignPane,DomainsPane}.tsx`、`desktop/src/renderer/src/admin.ts`(typed helper+mock)。

**改动**：`backend/skill/skill.go`（CRUD+OpenFile）、`backend/authz/store.go`（ReadTuples）、`backend/wire/assemble.go`（Projector 接线、Close 加 cfg）、`backend/cmd/agentd/{main.go,handlers.go}`（路由+requireAdmin+admin handlers）、`backend/dev.env`（CONFIG_DB/SKILL_DB 路径）、`desktop/src/shared/contract.ts`（AdminReq/Resp+通道）、`desktop/src/preload/index.ts`、`desktop/src/main/ipc.ts`+`agentd.ts`（admin 代理+注入 X-User-Id）、`desktop/src/renderer/src/App.tsx`（视图切换+齿轮入口）。

---

*本 spec 与 brainstorming 的 6 项决策逐条对应。确认后进入 writing-plans。*

