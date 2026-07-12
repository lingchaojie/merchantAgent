# M7 企业本地 Connector 与实施工作台设计

> 版本：v1.0
> 日期：2026-07-12
> 状态：已完成产品讨论，待书面规格复核
> 上游设计：`2026-07-12-enterprise-agent-platform-design.md`

## 0. 文档目的

M6 已证明：云端 Agent 可以在 Skill、角色和记录级权限通过后，把签名工具请求下发到员工 Windows App，在本地读取和低风险写入参考 SQLite，并完成确认、回读、幂等、撤权和审计。

M7 的目标不是继续扩展 reference SQLite，而是把这条执行拓扑连接到企业测试或预生产环境中的真实 Microsoft SQL Server 和 HTTP API。企业的 SQL、API 内部地址、凭据和原始响应继续留在企业本地；Agent 仍只看到固定业务工具和字段白名单结果。

M7 不以“无代码数据库平台”为目标。首期 Connector 由我们的实施工程师配置，企业管理员负责审核、发布、停用以及 Skill/角色分配。

## 1. 已确认的产品决策

1. Connector 由我们的实施工程师创建和测试，企业管理员不能编写 SQL 或 API 映射。
2. 首批支持 Microsoft SQL Server 和 HTTP API。
3. M7 使用企业配置的最小权限服务账号，不做员工个人 ERP、API 或数据库账号绑定。
4. Connector 在 Windows App 内的“实施工作台”中配置，不在云端编辑 SQL、URL 或凭据。
5. 实施工程师创建并测试草稿；企业管理员审核工具合同后发布。实施工程师不能自行发布或分配员工权限。
6. SQL Server 使用受限参数化 SQL 模板，不允许任意 SQL。
7. HTTP API 首批支持 API Key、静态 Bearer Token 和 OAuth2 Client Credentials，不支持员工个人 OAuth。
8. 草稿测试期间允许临时查看原始响应；退出测试结果后立即丢弃。发布运行时不持久化原始响应。
9. 首个真实业务验收继续使用制造/贸易场景，保持 `query_order_status` 和 `report_production_progress` 工具合同不变。
10. 试点设备的服务账号凭据由实施工程师逐台在 Windows 本地录入，不经过云端分发。
11. 实施工作台由平台签发的实施凭证解锁。凭证绑定企业、设备和有效期，只允许创建和测试草稿。
12. 采用声明式 Connector Runtime。任意代码插件和通用 MCP Server 不作为 M7 主路径。
13. M7 只连接企业测试库或预生产 API。真实身份接入前不得连接或标记为可连接生产环境。
14. M7 拆分为 M7.1 SQL Server 垂直链路、M7.2 HTTP API、M7.3 试点交付与加固。

## 2. 范围与里程碑

### 2.1 M7.1：SQL Server Connector 垂直链路

交付：

- 平台实施凭证及实施工作台入口；
- 数据源、Operation、参数、返回字段和风险配置；
- Windows Credential Manager/DPAPI 凭据存储；
- Connector schema、版本、摘要和本地签名；
- 受限 T-SQL 解析与安全校验；
- SQL Server 连接、查询、低风险更新、幂等和回读；
- 不含本地实现细节的公开 Tool Contract；
- 企业管理员审核、发布、停用和撤销；
- 企业 SQL Server 测试环境端到端验收。

### 2.2 M7.2：HTTP API Connector

交付：

- 固定 host、endpoint、method 和请求/响应映射；
- API Key、Bearer Token、OAuth2 Client Credentials；
- 企业 CA、TLS、超时、响应大小和重试策略；
- HTTP 读取、低风险写入、幂等和回读；
- 复用 M7.1 的工作台、发布、权限、审计和本地包机制。

### 2.3 M7.3：试点交付与加固

交付：

- 多设备离线包安装；
- 每台设备本地凭据录入；
- Connector 健康检查和脱敏诊断导出；
- 发布、升级、回滚、撤销和版本不匹配处理；
- SQL Server 与 HTTP Adapter 实现同一 Tool Contract 的互换测试；
- 企业测试/预生产环境 Windows 验收；
- 安全、泄露、并发、超时和故障恢复测试。

### 2.4 明确不做

- 生产数据库或生产 API 接入；
- 企业微信 OAuth、真实 IdP 和员工会话；
- 员工个人 ERP/API/数据库账号绑定；
- 云端凭据或 Connector 本地实现分发；
- 企业集中网关和后台无人值守任务；
- 企业管理员自助编写 Connector；
- 任意代码插件或通用 MCP Server；
- 任意 SQL、`INSERT`、`DELETE`、`MERGE`、DDL 和高风险写入；
- 高风险写入审批和补偿流程。

## 3. 总体架构

M7 将一个企业能力拆成“云端公开合同”和“企业本地执行包”。二者通过不可变摘要绑定。

### 3.1 云端公开 Tool Contract

云端可保存：

- tenant ID、Connector ID、版本和包摘要；
- Tool ID、描述和参数类型；
- 返回字段名与字段类型；
- resource kind、resource ID 参数和声明关系；
- data domain；
- risk、requiresConfirmation、超时和结果上限；
- 发布、停用和撤销状态；
- Skill 和角色授权关系。

云端不得保存：

- SQL 模板、schema/table/view 名；
- API base URL、endpoint 和内部 header；
- Credential Manager 引用的实际凭据；
- 测试参数、原始请求、原始响应；
- OAuth access token、refresh token 或 client secret。

### 3.2 企业本地执行包

本地 `.ma-connector` 包包含：

- Connector ID、版本和 environment=`non_production`；
- Adapter 类型和声明式配置；
- SQL AST 校验后的模板或 HTTP 映射；
- 参数绑定、字段投影和结果上限；
- before/proposed 预览映射；
- 幂等、并发条件和回读规则；
- credential reference 名称，不含凭据值；
- 公开 Tool Contract 的副本和摘要；
- 实施签名及签名链。

包内的 SQL 和 API 路径属于企业本地敏感实现，不上传平台云端。单设备 M7.1 由实施工程师直接在目标设备创建。M7.3 的多设备包通过企业认可的离线渠道分发，凭据仍逐台录入。

安装后的执行 payload 必须使用 DPAPI 加密并由文件 ACL 限制到目标 Windows 用户；磁盘上只允许公开 manifest、签名链和密文。解密只发生在 Electron main process，明文 SQL/API 映射不得进入普通 renderer、preload 日志或诊断导出。

M7.3 离线分发时，目标设备先生成本地导入公钥，工作台把同一已签名 payload 分别加密给目标设备。私钥不离开目标设备，不使用云端中转密钥或共享导入密码。

### 3.3 签名与批准

1. 平台向实施工程师设备签发短期实施凭证，绑定 tenant、device、权限范围和有效期。
2. 工作台使用设备本地受保护的实施签名密钥签署执行包；平台实施凭证证明该设备密钥有权为指定 tenant 创建草稿。
3. 工作台从本地包导出不含敏感实现的公开 Tool Contract、安全检查摘要和包 digest。
4. 企业管理员审核并批准指定 digest。批准不继承到后续版本。
5. Runtime 执行前同时验证实施签名链、包 digest、管理员批准 digest、安装状态和用户授权。
6. 任一 SQL、API 映射、字段、风险或回读规则变化都生成新版本和新 digest。

实施签名表示“该包由获授权的实施设备创建”；管理员批准表示“企业允许公开这些工具合同”。两者不能互相替代。

## 4. 身份与职责

### 4.1 实施工程师

可以：

- 使用绑定 tenant/device/expiry 的平台实施凭证进入工作台；
- 创建、编辑和删除未发布草稿；
- 在本地录入凭据并测试连接；
- 查看草稿测试的临时原始响应；
- 运行安全检查并提交待审核版本。

不可以：

- 发布 Connector；
- 给角色分配 Skill；
- 修改业务记录级权限或 data domain 授权；
- 访问其他 tenant 的草稿、包或凭据；
- 在凭证过期后继续编辑或测试。

### 4.2 企业管理员

可以：

- 查看公开 Tool Contract、安全检查摘要和业务字段；
- 批准指定版本/digest；
- 发布、停用和撤销；
- 将已发布 Tool 组合到 Skill 并分配角色；
- 查看企业审计和安装健康状态。

不可以：

- 查看或编辑 SQL、API 内部路径和凭据；
- 绕过实施签名、安全检查或本地安装验证；
- 让批准自动适用于新版本。

### 4.3 普通员工

只能通过已授权 Skill 使用已发布工具。员工不能进入工作台、查看 Connector 实现或修改本地凭据。

## 5. 实施工作台

### 5.1 数据源

SQL Server Profile：

- server、instance、database；
- TLS 模式和企业 CA；
- connect/query timeout；
- credentialRef；
- environment 固定为 test 或 preproduction；
- 本地连接健康状态。

HTTP Profile：

- base URL、TLS 和企业 CA；
- API Key、Bearer 或 OAuth2 Client Credentials；
- token endpoint、scope 和 credentialRef；
- connect/request timeout；
- environment 固定为 test 或 preproduction。

配置文件只保存 `credentialRef`。实际秘密写入 Windows Credential Manager，并使用 DPAPI 绑定目标员工的 Windows 用户上下文。实施工程师必须在目标员工会话内通过受控工作台完成录入，不能把凭据写入实施工程师自己的 Windows profile。

M7 只面向测试/预生产环境。拥有目标设备本地管理员权限的人仍可能提取该 Windows 用户可用的服务凭据；这一终端信任风险不能被 Credential Manager 消除，必须通过测试环境、最小权限账号和源系统网络限制降低影响。

### 5.2 Operation 编辑器

一个 Operation 对应一个 Tool。必须声明：

- Tool ID、版本、业务描述；
- 参数名、类型、必填、长度/范围/枚举；
- resource kind、resource ID 参数和所需关系；
- data domain；
- risk 和 requiresConfirmation；
- SQL/API 映射；
- 返回字段白名单；
- 最大结果数量和超时；
- 写入预览字段、并发条件、幂等和回读规则。

Operation 编辑器不向模型暴露 SQL、URL、header 或凭据参数。

### 5.3 本地测试

工作台必须支持：

- 凭据和网络连接测试；
- 参数样例和边界值测试；
- 原始响应临时预览；
- 字段白名单后的实际 Tool Result 预览；
- 写入 preview、cancel、confirm 和 read-back；
- 幂等重放、并发冲突和源系统拒绝；
- 日志、审计和公开合同的敏感信息扫描。

原始响应只存在于当前测试会话内，不写日志、审计、SQLite 或云端。它只允许进入隔离、已通过实施凭证解锁的工作台测试视图；普通员工聊天 renderer 永远不接收原始响应。关闭结果、切换草稿、凭证失效或退出工作台时，main process 和工作台状态同时清除。

### 5.4 状态机

```text
draft
  -> locally_validated
  -> pending_admin_approval
  -> published
  -> suspended | revoked
```

- `draft`：只允许实施工程师本地编辑；
- `locally_validated`：所有必需检查通过，内容被冻结并生成 digest；
- `pending_admin_approval`：云端只有公开合同、检查摘要和 digest；
- `published`：管理员批准，授权设备可执行匹配 digest；
- `suspended`：临时停止下发，不删除批准和审计；
- `revoked`：永久撤销该版本，已安装包不得执行。

对冻结内容的任何修改都创建新草稿版本。

## 6. SQL Server Adapter

### 6.1 解析原则

必须使用支持 T-SQL 的成熟 AST Parser。禁止使用正则表达式或字符串关键字列表作为主要安全边界。

所有 identifier 在配置时固定，运行时只能绑定值参数。模型不能控制 schema、table、view、column、operator、order by 或 SQL fragment。

### 6.2 只读操作

允许：

- 单条 `SELECT`；
- 显式列名和别名；
- 固定 schema/table/view；
- 已声明对象之间的 `JOIN`；
- 参数化 `WHERE`；
- 固定排序；
- 默认 20、最大 100 行；
- 默认 10 秒查询超时。

禁止：

- `SELECT *`；
- 多语句；
- 动态 identifier；
- 子查询产生未受限结果集；
- 跨未声明数据库；
- SQL Server 外部访问和文件操作。

### 6.3 低风险写入

仅允许单条、单表 `UPDATE`，并同时满足：

- 更新列在显式白名单内；
- `WHERE` 包含业务资源 ID；
- `WHERE` 包含 version 或 updated_at 并发条件；
- 影响行数必须等于 1；
- 写入带持久化幂等键和请求指纹；
- 写入后执行固定 allowlisted 回读；
- before、UPDATE 和 read-back 在源 SQL Server 的受控事务内完成；
- 用户在 Windows 原生确认框明确确认 before/proposed。

禁止 `INSERT`、`DELETE`、`MERGE`、`EXEC`、DDL、临时表、事务控制和任意存储过程调用。

### 6.4 幂等与断电窗口

本地 Runtime 维护持久化执行 ledger，保存 idempotency key、请求指纹、before/proposed、状态和 allowlisted 回读结果。它与企业 SQL Server 不构成分布式事务。

执行顺序：

1. 在本地 ledger 写入 `pending`；
2. 在源 SQL Server 事务中执行带 expectedVersion 的绝对值 `UPDATE`；
3. 在同一源事务中回读并提交；
4. 本地 ledger 更新为 `succeeded`。

同 key、同指纹且 ledger 已成功时直接返回原结果；同 key、不同指纹返回 `source_conflict`。进程在第 2 至第 4 步之间中断时，ledger 保持 `pending/unknown`。恢复后只能先用固定 read-back 判断目标值和版本，不能自动再次执行 UPDATE；无法证明结果时继续保持 `unknown`。

如果企业源提供原生幂等键表或等价机制，可以声明 `source_native_idempotency` 获得更强保证，但 M7 不要求企业修改 schema。默认安全保证来自绝对值更新、expectedVersion、持久化本地 ledger、回读和 unknown 不重试。

## 7. HTTP API Adapter

### 7.1 请求映射

- host 和 base path 固定；
- endpoint path 模板固定，只允许声明参数填入指定 segment；
- 只读使用 `GET`；
- 低风险写入使用 `POST` 或 `PATCH`；
- query/body 字段必须逐项声明类型和来源；
- method、host、header 名和未声明 body 字段不能由模型控制；
- 认证 header 由 Runtime 从 credentialRef 注入。

### 7.2 网络与认证

- 默认且正式验收必须使用 HTTPS；
- 支持导入企业自签 CA；
- 携带凭据的明文 HTTP 一律拒绝；
- 禁止跨 host 重定向；
- API Key、Bearer、OAuth client secret 和 token 不进入日志、工具参数或审计；
- OAuth access token 仅在内存中使用，刷新凭据保存在本地安全存储；
- OAuth 刷新失败后不得继续使用旧 token。

### 7.3 响应与写入

- 限制响应字节数、解析深度和数组长度；
- 只投影声明字段；
- 写入 endpoint 必须支持原生幂等键，或支持 `If-Match`/version 等条件写入；二者都不支持时不得发布为写 Tool；
- Runtime 必须传递幂等键或条件版本，并在本地保存请求指纹和 pending 状态；
- 写入后调用固定 read-back endpoint；
- read-back 与 proposed 不一致时返回失败或 unknown，不得伪报成功。

## 8. 授权与执行数据流

每次调用必须依次通过三道门。

### 8.1 Gate A：能力权限

- 用户角色拥有对应 Skill；
- Skill 允许该 Tool；
- Connector 已发布且未停用/撤销；
- 请求版本和管理员批准 digest 匹配。

### 8.2 Gate B：业务数据权限

- 当前用户对目标 `business_record` 拥有 Tool 声明的关系；
- 读取默认需要 `viewer`；
- 低风险写入默认需要 `operator`；
- data domain 独立检查；
- Gate A 通过不自动授予 Gate B。

### 8.3 Gate C：企业本地执行权限

- 本地实施签名链有效；
- 本地包 digest 与管理员批准一致；
- 当前设备已安装该 Connector 版本；
- credentialRef 存在且凭据有效；
- Operation 与签名 schema 一致；
- SQL/API 运行时安全检查通过；
- 源系统服务账号实际允许本次操作。

任意一道门拒绝都不得接触数据源。

### 8.4 低风险写入

```text
读取当前值
-> 生成 before/proposed
-> Windows 原生确认
-> 带幂等键和并发条件执行
-> 回读验证
-> 返回字段白名单结果
-> 写入审计终态
```

`unknown` 表示无法确认写入是否发生。Runtime 不得自动再次写入，必须先执行 read-back/status operation。

## 9. 错误模型与重试

统一错误类别：

- `connector_not_installed`；
- `package_version` / `approval_revoked`；
- `missing_credentials` / `invalid_credentials`；
- `connection_failed` / `tls_failed`；
- `invalid_argument` / `unsafe_template`；
- `permission_denied` / `record_not_found`；
- `source_conflict`；
- `source_rejected`；
- `failed`；
- `unknown`。

重试规则：

- 只读临时网络错误最多自动重试一次；
- OAuth token 失效允许刷新一次并重试原请求；
- 写入不做普通自动重试；
- 写入只能使用原幂等键进行状态查询或安全重放；
- `source_conflict` 必须重新读取和重新确认；
- `unknown` 必须先回读，不得直接再次写入。

错误信息不得包含 SQL、完整 URL、请求/响应体、token 或数据库驱动内部连接串。

## 10. 审计与诊断

审计新增：

- Connector ID、版本、包摘要和 Adapter 类型；
- source profile ID 和 environment；
- Tool、Skill、角色和设备；
- resource kind、resource ID 和声明关系；
- 管理员批准版本；
- 确认时间、幂等键和请求指纹标识；
- allowlisted before/after；
- 执行状态、耗时和回读状态。

审计不得保存：

- 数据库地址、SQL、API 完整 URL；
- credentialRef 对应的秘密；
- OAuth token；
- 原始请求体和响应体；
- 未进入字段白名单的业务字段。

诊断导出仅包含公开合同、版本、摘要、状态码、耗时、错误类别和本地组件版本。导出前再次执行秘密扫描。

## 11. 制造/贸易验收场景

M7 保持以下 Tool Contract 不变：

- `query_order_status(orderId)`；
- `report_production_progress(orderId, workOrderId, completionRate, expectedVersion, note?)`。

M7.1 使用 SQL Server 测试库实现两个 Tool；M7.2 使用 HTTP API 测试服务实现相同合同。切换 Connector binding 时不得修改：

- Skill ID 和 playbook；
- 角色分配；
- OpenFGA `business_record` 模型；
- Agent tool schema；
- Windows 确认和审计 UI。

验收流程：

1. 实施工程师在授权设备进入工作台；
2. 配置测试环境数据源和本地凭据；
3. 创建两个 Operation 并通过全部本地测试；
4. 企业管理员审核公开合同并批准 digest；
5. 销售读取订单进度，不看到成本或本地实现；
6. 销售写入被 Gate A 或 Gate B 拒绝；
7. 生产角色看到 before/proposed 并确认低风险写入；
8. Runtime 执行、回读并返回新版本；
9. 销售重新读取到新进度；
10. 管理员看到查询、拒绝、确认、执行、回读和终态审计；
11. 管理员停用 Connector 后，下一次调用立即失败关闭；
12. 将 binding 从 SQL Server 切换到 HTTP 实现，同一业务流程继续通过。

## 12. 测试与发布门禁

### 12.1 静态安全测试

- T-SQL AST 白名单和禁止语句矩阵；
- 参数绑定和 identifier 不可变；
- HTTP host/method/header/body 映射边界；
- package 签名、digest、版本和批准匹配；
- credential/token/SQL/URL 泄露扫描。

### 12.2 运行时测试

- 正常读取和最大结果限制；
- 非法参数、未知字段和越权字段；
- 凭据缺失、失效和 OAuth 刷新；
- TLS、超时、断连和源系统拒绝；
- 写入 preview、cancel、confirm 和 read-back；
- 同 key 同请求回放；
- 同 key 不同请求冲突；
- version conflict 和影响多行失败关闭；
- `unknown` 后先回读；
- 发布、停用、撤销和版本升级即时生效。

### 12.3 数据边界测试

- 云端 payload 不含 SQL、URL、credentialRef 秘密和原始响应；
- provider 和普通员工聊天 renderer 只收到 Tool Contract 和 allowlisted result；
- 隔离工作台 renderer 仅在有效实施会话内接收当前测试的临时原始预览；
- 日志、错误和审计不含秘密；
- 草稿原始预览在关闭后不可恢复；
- 多 tenant、错误 device 和过期实施凭证失败关闭。

### 12.4 Windows 验收

- Windows Credential Manager/DPAPI 实际读写；
- App 重启后 credentialRef、安装状态和幂等记录有效；
- 原生确认框显示数据源环境、业务资源和 before/proposed；
- Connector 停用和撤销无需重启立即生效；
- SQL Server 与 HTTP 绑定互换；
- 桌面和窄窗口无重叠/横向溢出；
- 测试/预生产环境标识始终可见。

## 13. 成功标准

M7 完成时必须同时满足：

1. SQL Server 和 HTTP Adapter 均能在真实企业测试/预生产源完成读取和低风险写入。
2. 两种 Adapter 实现相同 Tool Contract，无需修改 Skill、权限或 Agent 流程。
3. 企业管理员可以审核、发布、停用和撤销，但不能看到本地实现和凭据。
4. 实施工程师可以配置和测试，但不能发布或给员工授权。
5. 任意 SQL、凭据和完整 URL 均不进入云端、模型、普通员工 renderer、日志或审计；原始响应只允许短暂进入隔离工作台测试视图。
6. 所有写入都经过本地确认、持久化幂等、并发控制和回读。
7. 真实身份未接入前，系统只允许连接测试/预生产环境，并明确标记非生产可用。
8. 自动化、安全测试和 Windows 手工验收全部通过。

## 14. 实施顺序

本设计批准后只为 M7.1 编写实施计划。M7.1 通过发布门禁后，再分别为 M7.2 和 M7.3 编写计划。不得把 HTTP/OAuth、多设备和生产身份提前塞入 M7.1。

## 15. 风险与缓解

### 15.1 身份仍是 mock

M7 不解决企业员工真实身份。缓解方式是只允许测试/预生产数据源，并在工作台、员工窗口、确认框和审计中持续显示非生产环境。真实身份和设备会话完成前不得移除该限制。

### 15.2 服务凭据位于员工终端

Credential Manager/DPAPI 可以阻止普通文件读取，但不能抵御目标 Windows 用户或本地管理员主动提取。M7 必须使用最小权限测试账号、源系统网络 ACL、单记录写限制和短期 OAuth 凭据。生产环境需要个人账号绑定、受管设备秘密或企业网关中的至少一种。

### 15.3 SQL Parser 覆盖不足

T-SQL 方言复杂，错误 Parser 可能把危险语句误判为安全。M7.1 必须选择成熟 T-SQL AST Parser，在保存草稿和每次执行前都重新校验，并使用大规模禁止语句/嵌套语法回归语料。无法完整解析的模板一律拒绝。

### 15.4 本地执行包泄露

签名只能证明完整性，不能保护 SQL 和 API 路径的机密性。安装 payload 必须 DPAPI 加密，普通 renderer 不得获得解密接口；M7.3 离线导出必须使用目标设备公钥加密。

### 15.5 企业 schema 或 API 漂移

源系统升级可能导致字段、类型或响应结构变化。发布前保存结构指纹；运行时发现漂移时停止写操作，只允许健康诊断，并要求实施工程师创建新版本重新测试和审批。

### 15.6 管理员看不到本地实现

管理员不能直接检查 SQL，因此批准依赖公开合同和本地安全检查摘要。工作台必须签署检查器版本、规则集版本、测试结果摘要和 package digest；任何检查器或包内容变化都需要重新审批。
