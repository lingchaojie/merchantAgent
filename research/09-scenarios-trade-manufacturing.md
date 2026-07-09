# 贸易与制造 SME 的 AI Agent 场景原料库

> 目的：为面向中国 **贸易（外贸/批发分销）** 与 **制造（离散制造/生产）** 中小企业的 AI-Agent 平台，提供有据可依的场景设计原料——真实系统、真实角色、高频任务、真实痛点、权限敏感度。
> 时间：2026-07。研究者：企业域分析。

## 方法与可信度说明

本报告混合了两类信息，已明确标注：

- **[源]** — 有 WebSearch/WebFetch 来源支撑的事实（附链接）。中文搜索结果中权威一手资料较少，很多是厂商推广/SEO 内容；国外的运营/合规类分析质量更高。凡引用 SEO 类来源，均标注为"指示性"。
- **[域]** — 来自我对中国外贸与制造业信息化的领域知识的归纳。这些是行业常识层面的判断（岗位职责、单据流、系统边界、典型痛点），没有逐条引用来源，但可靠度较高，适合作为场景假设，落地前建议与真实客户访谈校验。

核心结论先行：

1. 中国贸易/制造 SME 的数据**天然分裂在 5-10 个系统 + 大量 Excel + 微信/邮件**里。这是所有 Agent 价值的根源——**跨系统聚合 + 主动问答**本身就是最大卖点。[源][域]
2. 头部 ERP（用友、金蝶）**云产品有 OpenAPI，老的本地部署版（U8/T3/KIS）主要靠读库或第三方中间件**，写操作风险高。这直接决定哪些场景能"读"、哪些能安全地"写"。[源]
3. **权限隔离是刚需，不是加分项**。报价/成本/毛利/客户名单/薪资一旦被错误角色问到，就是商业事故。权限模型必须按"角色 × 数据域"双维隔离。[域]

---

## 1. 企业常用系统盘点（含数据资产与 API 现状）

### 1.1 ERP —— 数据主干

中国 SME 的 ERP 市场高度集中在用友、金蝶两家，二者均为 IDC 中国 SaaS ERM/EA 榜首级玩家，金蝶更连续多期位列 SaaS ERP、财务云等多个细分第一，并成为首个入选 Gartner 离散制造 PLM Market Guide 的中国厂商。[源：[Kingdee/IDC FY2024H2](https://www.kingdee.com/mo/en/blog/2024/08/03/defending-dual-champion-idc-kingdees-saas-erm-and-finance-rank-first-in-the-chinese-market/)、[Kingdee FY2025 中期](https://www.kingdee.com/mo/en/blog/2025/08/11/kingdee-international-announces-fy2025-interim-results/)、[Kingdee/Gartner PLM](https://www.kingdee.com/mo/en/blog/2025/03/20/break-the-monopoly-for-the-first-time-kingdee-is-named-to-the-gartner-market-guide-for-plm-software/)] 市场整体 2025 年约 74.6 亿美元，预计 2035 达约 276 亿美元（CAGR≈13.3%）。[源：[Next Move Strategy](https://www.nextmsc.com/report/china-erp-software-market-ic3610)、[Technavio](https://www.technavio.com/report/china-erp-market-analysis)]

**产品线与规模阶梯**（版本定位来自厂商/代理商页面，为指示性；模块边界与命名以官网为准）[源：[用友YonSuite服务商](https://www.cnblogs.com/qhksz/p/19625667)、[畅捷通好生意 App Store](https://apps.apple.com/au/app/%E7%95%85%E6%8D%B7%E9%80%9A%E5%A5%BD%E7%94%9F%E6%84%8F-%E8%BF%9B%E9%94%80%E5%AD%98%E7%AE%A1%E7%90%86%E8%BD%AF%E4%BB%B6/id1366036892)、[金蝶生态](https://www.cnblogs.com/GrowthUME/p/20084898)、[金蝶云星辰生产云](https://www.szkap.cn/)][域]

| 规模档 | 用友/畅捷通 | 金蝶 | 部署 & API |
|---|---|---|---|
| 微小型（财务+进销存） | T3、好会计/好生意 | KIS、精斗云 | T3/KIS 本地部署为主，**无标准 OpenAPI**，靠读库/中间件；好生意/精斗云为 SaaS，有接口 |
| 小中型（较全供应链） | T+/T+Cloud、好业财 | 云星辰（含生产云） | T+ 有 OpenAPI（需先授权）；好业财/云星辰 SaaS 有接口 |
| 中大型全 ERP | U8/U8 Cloud | 云星空(K3Cloud) | U8 本地部署，官方有 API 但常见做法是读库；云星空有成熟 WebAPI |
| 成长型云原生 | YonSuite | 云星空(云) | SaaS，OpenAPI |
| 大型集团 | NC/YonBIP | 云星瀚/EAS | OpenAPI |

**API 现状（决定读/写可行性）：**

- **用友 Open API 开放平台**：官方接入入口，云产品（YonSuite/T+/好业财等）走标准 OpenAPI。[源：[用友开发者中心](https://developer.yonyou.com/openAPI)] 用友 T+ OpenAPI 企业自建应用需**先在开发管理中给当前用户授权**，否则消息接收地址设置不成功。[源：[用友T+ OpenAPI 指南](https://www.cnblogs.com/crazyghostvon/p/17685170.html)]
- **用友 U8（本地部署）**：官方有 API/UAP，但社区常见做法是**通过 ODBC/SQL Server 直接读底层库**（例如扫码入库场景用 PHP 读 U8 库）。直接读库绕过业务校验，**只适合只读**，写入风险高。[源：[U8 二次开发架构](https://blog.51cto.com/u_16099237/8257348)、[PHP 访问 U8 数据](https://www.cnblogs.com/houdj/p/8781068.html)]
- **金蝶云星空 K3Cloud WebAPI**：成熟，地址形如 `http://{ip:port}/k3cloud/…DynamicFormService.{操作}`，操作含 `ExecuteBillQuery`(查询)、`Save`(保存)、`View`(查看/审核) 等；开源 SDK 覆盖 C#/Java，可参考登录鉴权与单据查询/写入流程。[源：[外部系统调用星空接口](https://www.cnblogs.com/cyhj/p/15102491.html)、[C# WebAPI](https://github.com/Taki0327/Kindgee-k3cloud-WebAPI)、[Java client](https://github.com/laupaul/k3cloud-webapi-client)、[获取实时库存](https://www.cnblogs.com/woshinige/p/18392405)]
- **SAP**：外资/较大 SME 或供应链上游会用，标准 OData/BAPI/RFC 接口齐全但实施重。[域]
- **管家婆/速达**：贸易批发分销 SME 的轻量进销存+财务首选，管家婆定位最早一批面向中小商贸的财务软件。[源：[网上管家婆官网](https://erp.wsgjp.com/)、[速达](https://erpe.top.siteindices.com/)] 老版本多为本地部署，API 能力弱，常需读库或导出 Excel。[域]

> **Agent 设计要点**：把系统分成两类——**"有 API 可读可写"（云星空、YonSuite、T+、好业财、电商 ERP、钉钉/企微）** vs **"只能读库/UI 自动化/导出"（U8/T3/KIS/管家婆本地版、部分 MES）**。写操作优先走 API 且强制审批；对无 API 的老系统，读走只读库连接，写用 RPA/UI 自动化并二次确认。[域]

### 1.2 电商/店铺系统（贸易域尤其是内贸/跨境电商必备）

- **旺店通、聚水潭**：电商 ERP 双雄，管订单、库存、采购、售后、发货。**通过阿里"奇门(Qimen)"自定义接口**对接淘宝/天猫/拼多多/京东等平台，也能与金蝶云星空/云星辰做数据集成。[源：[聚水潭开放平台-淘系订单查询](https://open.jushuitan.com/document.aspx?doc_id=2352)、[奇门 DEMO](https://github.com/duanzonglong/qm)、[淘宝/奇门/WMS/拼多多对接](https://github.com/zhouSix/ERPAPI)、[旺店通→金蝶云星辰对接案例](https://www.cnblogs.com/standonline/articles/18497964)、[旺店通旗舰奇门→金蝶云星空](https://www.cnblogs.com/standonline/p/18503022)]
- 奇门接口关键细节：需 `appkey`/`secret` 签名，多店铺路由要带 `customer_id`（授权时获取），走淘宝 `router/qm` 网关。[源：[聚水潭工单查询接口](https://open.jushuitan.com/document.aspx?doc_id=2366)]
- 平台官方开放平台（拼多多、淘宝）覆盖商品、订单、营销 API，是电商数据的一手来源。[源：[拼多多开放平台实战](https://www.cnblogs.com/API-19970108110/p/19247864)]
- 数据资产：**订单、SKU 库存、买家信息、售后/退款、物流轨迹、店铺资金**。

### 1.3 外贸专用系统（外贸域）

- **小满 OKKI、孚盟、焦点、Zoho、纷享销客**等：外贸 CRM/获客，管客户、询盘、报价、往来邮件、商机漏斗。OKKI 还有浏览器插件在 LinkedIn/Facebook 上找并核验客户联系方式。[源：[2025主流CRM对比](https://www.cnblogs.com/worktile/articles/19422963)、[外贸客户管理6款对比](https://www.cnblogs.com/worktile/articles/18586844)、[OKKI io 插件](https://chromewebstore.google.com/detail/okki-io-%E5%A4%96%E8%B4%B8%E5%AE%A2%E6%88%B7%E5%BC%80%E5%8F%91%E9%82%AE%E7%AE%B1%E5%9C%B0%E5%9D%80%E6%9F%A5%E6%89%BE%E5%B7%A5%E5%85%B7/gddoffnommfblacbelhdogaooiediiol)]
- **外贸一体化 ERP**（如恩特、零壹问界等）：把报价、PI、订单、采购、供应商、出运单证、物流、财务、进销存串成闭环。[源：[外贸管理软件对比](https://www.cnblogs.com/myqiye/p/19702879)、[零壹问界 IC 外贸 ERP](https://www.iccn.cc/)、[外贸ERP软件对比](https://www.cnblogs.com/mygypw/p/19707174)]（均为厂商/SEO 页面，指示性）
- 数据资产：**客户/询盘、报价历史、PI/合同、单证（发票/箱单/提单/产地证/LC）、船期、收汇核销**。

### 1.4 制造专用系统（制造域）

| 系统 | 管什么 | 数据资产 | API 现状 |
|---|---|---|---|
| **MES（制造执行）** | 车间执行、工单、报工、过程追溯、在制品 | 工单进度、报工、良率、设备状态、批次追溯 | 头部/云 MES 有 API；老 MES 或产线级系统常需数据库/OPC 对接 [源][域] |
| **APS（高级排产）** | 有限产能排程、齐套校验、换型/交期约束 | 排产计划、瓶颈、可承诺交期(ATP) | 与 ERP/MES 集成度是选型关键 [源] |
| **WMS（仓储）** | 上架/拣货/盘点/批次库位 | 实时库存、库位、批次、出入库流水 | 云 WMS 有 API [域] |
| **SRM（供应商）** | 寻源、比价、供应商绩效、送货 | 供应商档案、报价、到货、质量记录 | 视厂商 [域] |
| **PLM（产品/工艺）** | BOM、图纸、工艺路线、变更(ECN) | BOM、工艺、图纸版本 | 金蝶已入选 Gartner 离散制造 PLM [源] |
| **QMS/质检** | IQC/IPQC/OQC、SPC、不良处理 | 检验记录、不良率、CAPA、供应商质量 | 多为模块内嵌 ERP/MES [源] |
| **TMS/设备/成本** | 运输、设备点检维保、成本核算 | 运单、设备台账、工时/料工费 | 视厂商 [域] |

MES 面向车间执行层，是连接计划层与现场的数字纽带，提供过程透明度；APS 负责"排什么、怎么排"，MES 负责"落地执行与数据回采"，二者互补。[源：[盘古 MES](https://www.cnblogs.com/pangus-ims/p/18976314)、[简道云](https://www.jiandaoyun.com/blog/article/542030/)、[Symestic 详细排产](https://www.symestic.com/en-us/what-is/detailed-scheduling)]

### 1.5 协同/OA/财务（两域共用）

- **钉钉、企业微信**：SME 事实上的协同+审批底座。两者均有成熟 OpenAPI，覆盖通讯录、消息推送、免登(silent login)、**审批(可自建工作流)**、考勤等；企微靠**回调(数据回调+指令回调)**接入，审批控件支持"外部选项"从外部系统拉数据。这是 Agent 最好的**触达与写回（发消息、发起审批）入口**。[源：[钉钉API-PingCode](https://docs.pingcode.com/baike/363112)、[钉钉端点版本](https://blog.51cto.com/u_16213664/7409932)、[钉钉审批自建工作流](https://edu.csdn.net/learn/26395/341899)、[企微API/SDK](https://cloud.tencent.com/developer/article/2158677)、[企微审批研发](https://cloud.tencent.com/developer/article/2562567)、[企微回调模式](https://cloud.tencent.com/developer/article/1859221)、[企微外部选项](https://www.cnblogs.com/wsk198726/p/18254503)]
- **泛微(e-cology)、致远(A8)**：中大型 SME 的重度 OA/流程平台，有接口但集成偏定制。搜索未找到其与钉钉/企微对接的一手文档，常见做法是回调+审批实例 API 同步。[源缺口，标注][域]
- **财务**：用友/金蝶财务模块或独立账套（好会计、精斗云），管应收应付、总账、开票、成本。[域]

---

## 2. 角色盘点 —— 谁在用，每天关心什么

> 以下岗位职责、关注点为行业常识归纳。[域]。SME 常一人多岗（尤其贸易公司，老板娘可能兼财务+采购），Agent 的角色模型要支持"一个自然人绑定多角色"。

### 2.1 贸易域角色

| 角色 | 每天关心什么 | 常用系统 |
|---|---|---|
| **外贸业务员/销售** | 询盘转化、报价能不能赢、这个价还有多少毛利、客户什么时候下单、老客户复购 | 外贸CRM(OKKI/孚盟)、邮箱、ERP、Excel |
| **内贸销售/分销** | 客户账期、历史成交价、库存够不够发、这单毛利、返利政策 | 管家婆/ERP、电商ERP、微信 |
| **采购** | 供应商报价、交期、到货没有、采购成本涨没涨、账期 | ERP采购模块、SRM、微信/邮件 |
| **跟单员(Merchandiser)** | 订单进度、生产/备货到哪步、能不能按期出货、船期订到没有 | ERP、供应商微信、Excel跟单表 |
| **单证员** | 发票/箱单/提单/产地证/LC 是否一致、有没有不符点、报关放行没 | 外贸ERP单证模块、电子口岸、Excel |
| **仓管** | 实物与账面对不对、批次/效期、发货备货、盘点差异 | WMS/ERP库存、扫码枪 |
| **财务/对账** | 应收有没有到账、应付该付谁、对账差异、收汇核销、开票 | 财务软件、ERP、银行 |
| **客服/售后** | 订单在哪、物流轨迹、退换货、投诉处理 | 电商ERP、客服系统、物流 |
| **老板/经理** | 今天卖了多少、毛利、谁欠钱、库存积压、哪个客户/业务员贡献大 | 全部（但多靠人汇报） |

外贸单证/跟单岗的核心是"缮制并审核出口单据、协调物流与合规、保证发运顺畅"，单据一致性与不符点处理是最易出错、最耗时的环节。[源：[Export Documentation Coordinator](https://chicago.craigslist.org/wcl/acc/d/lombard-export-documentation-coordinator/7945715306.html)、[提单要素](https://www.jdsupra.com/legalnews/bill-of-lading-primer-types-and-9964787/)、[LC 不符点处理](https://www.tradefinanceglobal.com/letters-of-credit/handling-document-discrepancies/)、[产地证用途](https://www.fedex.com/en-gb/how-to/clear-customs/certificate-of-origin.html)]

### 2.2 制造域角色

| 角色 | 每天关心什么 | 常用系统 |
|---|---|---|
| **销售** | 这个订单能不能接、报价、能不能按期交、客户催货 | ERP、CRM、微信 |
| **生产计划员/PMC** | 齐套了吗、产能够不够、这单排到几号、欠料清单、插单影响 | ERP、APS、MES、Excel |
| **车间主管** | 今日工单进度、报工、异常停机、人机料齐不齐、当班产量 | MES、纸质/看板 |
| **工艺** | BOM/工艺路线对不对、变更(ECN)有没有下发、标准工时 | PLM、ERP、图纸 |
| **质检(IQC/IPQC/OQC)** | 来料合格率、制程不良、出货批合不合格、供应商质量、CAPA | QMS/MES质检模块、SPC、Excel |
| **设备** | 点检保养到期、故障维修、稼动率、备件 | 设备管理/MES |
| **采购** | 欠料交期、供应商比价、到货、来料质量、账期 | ERP采购、SRM |
| **仓管** | 原料/半成品/成品库存、批次库位、领料发料、盘点 | WMS/ERP |
| **成本会计** | 料工费、订单成本、标准成本 vs 实际、差异分析 | ERP成本模块、财务 |
| **厂长/经理** | 准时交付率(OTD)、产能利用、在制、良率、成本、瓶颈 | 全部（多靠日报/会议） |

制造现场三大 QC 关口：**IQC（来料检验）** 卡供应商来料，**IPQC/PQC（制程检验）** 卡在制过程，**OQC（出货检验）** 卡成品出货，配合 SPC 做过程能力监控。[源：[IQC 定义](https://tetrainspection.com/iqc-inspection/)、[IPQC/制程](https://safetyculture.com/topics/quality-assurance-and-quality-control/in-process-quality-control)、[三阶段与人员结构](https://vietnamcleanroom.com/en/post/what-is-iqc-1370.htm)、[Jodoo QMS](https://www.jodoo.com/blog/ru-ru/quality-management-software-manufacturing/)]

---

## 3. 高频问题/任务 —— 场景种子（按角色，尽量具体）

> 这些是各角色真会对 Agent 问的原话级问题，直接作为场景需求来源。[域]（问题本身来自行业常识；跨系统聚合的价值由数据分裂现状支撑 [源]）

### 3.1 贸易域场景种子

**外贸业务员/销售**
- "这个客户历史成交价多少？上次给的什么价、什么条款？"（涉毛利/底价，敏感）
- "这个报价按 FOB 还有多少毛利？降到 X 还能不能做？"（成本/毛利，高敏感）
- "客户 ABC 最近半年下了几单、金额多少、有没有掉单风险？"
- "帮我根据这个询盘 + 产品成本，生成一版报价单/PI。"（写）
- "这个客户的信用/账期情况怎么样？还有多少应收没回？"
- "上次那批货客户投诉的质量问题，最后怎么处理的？"
- "同类产品我们给别的客户都报多少？"（横向价格，极敏感）

**跟单员**
- "PO#12345 现在到哪一步了？备货/生产完成没有？能按期出吗？"
- "这周要出的订单有哪些？哪些有延期风险？"（主动预警）
- "供应商说延期 3 天，会不会赶不上船期？影响哪些订单？"
- "帮我把这批订单的最新进度整理成表发给客户。"（写/触达）

**单证员**
- "PO#12345 的发票、箱单、提单金额/品名/数量对得上吗？有没有不符点？"（一致性校验）
- "这单 LC 要求的单据齐了吗？还差什么？交单期限是哪天？"
- "帮我生成这票货的形式发票/装箱单草稿。"（写）
- "这个目的国需要什么产地证（FORM A / CO / FTA）？"

**内贸销售/采购/仓管**
- "客户 X 现在还能不能赊账？账上还欠多少、超期没有？"
- "SKU-888 现在可用库存多少？够不够发这单 500 件？在途还有多少？"
- "这个供应商这次报价比上次贵了吗？贵多少？"
- "上个月卖得最好的 10 个 SKU 是哪些？哪些压货了？"

**财务/对账**
- "本月应收对账：谁到账了、谁超期、账实差异在哪？"（写/生成对账单）
- "这几笔收汇怎么核销到对应出口报关单？"（外汇核销）
- "这个月开了多少票、还有多少额度？"

**客服/老板**
- "客户下单的这批货，物流轨迹到哪了？预计几号到？"
- "今天/本月卖了多少、毛利多少、谁欠钱最多、哪些货压仓？"（老板驾驶舱，高敏感）

外贸链条横跨海关、外汇、税务、电子口岸多部门，单据一致性要求严（金额、品名、原产国需完全对应），错一处就被驳回/清关延误/罚款，且高度依赖 Excel 与人工对账——这正是 Agent 聚合+校验的价值点。[源：[清关单据一致性](https://www.fedex.com/en-au/small-business/getting-started/what-does-customs-cleared-mean.html)、[UK 报关新规品名/币种/原产国要求](https://woocommerce.com/posts/uk-shipping-updates/)、[进出口跨部门流程繁琐](https://www.cnblogs.com/GrowthUME/p/20955774)、[割裂 FX 工作流的隐性成本](https://insight.factset.com/the-hidden-cost-of-disconnected-fx-workflows)]

### 3.2 制造域场景种子

**销售/PMC（接单与承诺交期）**
- "这个订单能不能在 X 号交？现有排产和产能扛得住吗？"（可承诺交期 ATP）
- "客户要加急插单 500 个，会影响哪些在产订单？"（插单影响分析）
- "这张订单的物料齐套了吗？还差哪些料、什么时候到？"（齐套/欠料，超高频）

**生产计划员/PMC**
- "明天要开的工单，料都齐了吗？哪些卡在缺料？"
- "这个月的欠料清单：缺什么、缺多少、供应商交期哪天、影响哪些工单？"
- "瓶颈工序（如 CNC）排到几号了？还能塞下这单吗？"
- "帮我把这批工单按交期重排一版。"（写，需审批）

**车间主管**
- "今日各工单完成进度、报工数量、当班产量多少？"
- "哪台设备停机了、停了多久、影响哪个工单？"
- "这个工单为什么没按计划完成？卡在哪道工序？"

**质检（IQC/IPQC/OQC）**
- "这批来料（供应商 X 的物料 Y）合格率多少？要不要让步接收？"（IQC）
- "今天制程不良集中在哪个工序/哪个不良项？趋势有没有恶化？"（IPQC/SPC）
- "这批成品能不能放行出货？OQC 抽检结果如何？"（OQC）
- "供应商 X 近三个月来料合格率排名？该不该降级？"

**采购**
- "物料 M 的欠料，哪几个供应商能供、报价和交期各是多少？"（比价，成本敏感）
- "我上周下的采购单到货没有？没到的催一下。"（写/触达供应商）
- "这个物料最近价格涨了吗？涨了多少？影响哪些订单成本？"

**仓管/成本会计/厂长**
- "原料/半成品/成品当前库存和库龄？哪些呆滞？"
- "订单 #789 的实际成本（料工费）是多少？和报价/标准成本差多少？"（成本/毛利，高敏感）
- "本月准时交付率(OTD)、综合良率、产能利用率、在制金额？"（厂长驾驶舱）

制造 SME 的核心矛盾链是 **数据分散 → 齐套不清/欠料 → 交期延误**。调研显示 74% 制造商因系统割裂、数据管理差而遭遇生产延误；库存数据与生产脱节会让小误差滚雪球成缺料、工单延期、错过交期；即便有看板，割裂的数据也拖慢分析与响应。齐套(kitting)的本质就是"开工前把某工单所需物料凑齐"，凑不齐就停线。[源：[74% 数据割裂致延误](https://procurementmag.com/articles/l2l-survey-74-of-us-manufacturers-caught-in-data-chaos)、[库存与生产脱节→缺料/误期](https://manufacturing.einnews.com/article/921016848/9fXSY52yuNyF8qgR)、[割裂数据拖慢决策](https://www.ksmcpa.com/insights/the-hidden-costs-of-slow-decisions-in-manufacturing/)、[齐套/kitting 定义](https://www.jodoo.com/blog/zh-cn/kitting-manufacturing/)、[排产失败源于执行非计划](https://www.scmr.com/article/why-supply-chains-fail-at-launch-its-not-the-plan-its-the-execution)]

---

## 4. 痛点总览（为什么今天做不到）

1. **数据分裂在多系统 + Excel + 微信/邮件**：一个"订单能不能按期交"要串 ERP（订单/库存）、APS/MES（产能/进度）、采购/SRM（欠料交期）、供应商微信。今天靠人打电话、翻表、开会拼出答案。[源：[74% 数据割裂](https://procurementmag.com/articles/l2l-survey-74-of-us-manufacturers-caught-in-data-chaos)、[库存脱节](https://manufacturing.einnews.com/article/921016848/9fXSY52yuNyF8qgR)][域]
2. **实时性差**：库存/进度/物流是"昨天的数"或"问了才知道"，缺主动预警（延期、缺料、超期应收）。[域]
3. **跨部门协调靠人**：销售问 PMC、PMC 问采购、采购问供应商，链路长、响应慢，救火式决策。[源：[执行断层](https://www.scmr.com/article/why-supply-chains-fail-at-launch-its-not-the-plan-its-the-execution)][域]
4. **老系统无 API**：U8/T3/KIS/管家婆本地版、部分产线 MES 只能读库或 UI 自动化，写操作尤其危险。[源：[U8 读库实践](https://www.cnblogs.com/houdj/p/8781068.html)][域]
5. **单据/一致性易错**：外贸单证金额/品名/原产国要完全一致，制造 BOM/工艺变更要同步到现场，靠人核对极易出错。[源：[清关一致性](https://www.fedex.com/en-au/small-business/getting-started/what-does-customs-cleared-mean.html)、[LC 不符点](https://www.tradefinanceglobal.com/letters-of-credit/handling-document-discrepancies/)][域]
6. **知识锁在老员工脑里**：老客户脾气、某供应商靠不靠谱、这个工艺的坑，没沉淀。[域]

## 5. 权限敏感度框架（喂给权限设计）

**双维隔离：角色 × 数据域。** 同一问题，不同角色能看到的字段必须不同。

**高敏感数据域（错配 = 商业事故）：**
- **成本/毛利/底价**：报价成本、订单料工费、毛利率。业务员可见"能报的价"，但**成本与毛利只限经理/老板/成本会计**。[域]
- **横向报价/客户名单**：给 A 客户的价不能让 B 客户或其他业务员随便查；客户联系人是公司资产，防止业务员离职带走。[域]
- **供应商报价/比价**：采购的比价数据对销售、对其他供应商都敏感。[域]
- **薪资/绩效/财务全局**：应收应付全貌、资金、员工薪资，仅财务/老板。[域]
- **客户 PII**：买家联系方式、收货信息（尤其电商），受个人信息保护约束。[域]

**中敏感：** 库存数量、订单进度、生产进度、物流轨迹、交期——部门内共享，跨部门可读摘要。

**低敏感：** 公开产品资料、通用政策、物流时效常识、系统操作帮助。

**写操作分级（不只看数据敏感度，还看副作用）：**
- **低风险写**：生成草稿（报价单/PI/对账单草稿，存草稿箱不外发）。
- **中风险写**：发起审批、给内部同事发消息、更新非财务单据状态——**走钉钉/企微审批留痕**。
- **高风险写**：正式对外发报价/PI、改价、改订单、写回 ERP 财务单据、催付款——**强制人工二次确认 + 审批 + 全程审计日志**，无 API 的老系统禁止 Agent 直接 UI 写入财务类单据。[域]

> **落地建议**：每个场景在下表标注权限敏感度；高敏感场景默认"经理/老板/财务"角色才可触发，其余角色触发时返回脱敏摘要或拒答。所有写操作经审批中枢（钉钉/企微），因其审批 API 成熟、可留痕、SME 已在用。[源：[钉钉审批](https://edu.csdn.net/learn/26395/341899)、[企微审批](https://cloud.tencent.com/developer/article/2562567)]

---

## 6. 场景汇总表

图例：读/写 = 是否含写操作（写均需审批）；敏感度 = 权限隔离等级；价值/频率 = 综合业务价值与调用频率。

### 6.1 贸易域（外贸/批发分销）场景表

| # | 场景名 | 触发角色 | 涉及系统 | 读/写 | 权限敏感度 | 价值/频率 |
|---|---|---|---|---|---|---|
| T1 | 客户历史成交价/条款速查 | 业务员、经理 | CRM、ERP、财务 | 读 | 高（底价/毛利） | 高价值·高频 |
| T2 | 报价毛利测算 + 生成报价单/PI 草稿 | 业务员 | ERP(成本)、CRM | 读+写(草稿) | 高（成本/毛利） | 高价值·高频 |
| T3 | 订单进度与准时出货预警 | 跟单、销售 | ERP、供应商微信、Excel | 读 | 中 | 高价值·高频 |
| T4 | 单证一致性/不符点校验（发票·箱单·提单·LC） | 单证员 | 外贸ERP单证、电子口岸 | 读 | 中 | 高价值·中频 |
| T5 | 客户信用/账期与应收状态 | 销售、财务、经理 | 财务、ERP | 读 | 高（财务） | 高价值·高频 |
| T6 | 可用库存与可发货量核查（含在途） | 内贸销售、仓管 | ERP/WMS、电商ERP | 读 | 中 | 高价值·高频 |
| T7 | 本月应收对账 + 对账单生成 | 财务 | 财务、ERP、银行 | 读+写(草稿) | 高（财务） | 高价值·中频(月结高) |
| T8 | 物流轨迹追踪与到货预估 | 客服、跟单 | 电商ERP、物流/面单API | 读 | 低-中(含PII) | 中价值·高频 |
| T9 | 供应商比价与采购成本变动 | 采购 | ERP采购、SRM | 读 | 高（供应商价） | 中价值·中频 |
| T10 | 收汇核销匹配（收汇→报关单） | 财务、单证 | 财务、电子口岸 | 读+写(建议) | 高（财务） | 中价值·中频 |
| T11 | 老板销售驾驶舱（销量/毛利/欠款/压货） | 老板、经理 | ERP、财务、电商ERP | 读 | 高（全局财务） | 高价值·高频 |
| T12 | 询盘/客户背景与联系人核验 | 业务员 | CRM、外部插件 | 读 | 中（客户资产） | 中价值·中频 |

### 6.2 制造域（离散制造/生产）场景表

| # | 场景名 | 触发角色 | 涉及系统 | 读/写 | 权限敏感度 | 价值/频率 |
|---|---|---|---|---|---|---|
| M1 | 订单可承诺交期(ATP)测算 | 销售、PMC | ERP、APS、MES | 读 | 中 | 高价值·高频 |
| M2 | 物料齐套/欠料清单查询 | PMC、车间主管 | ERP、WMS、采购 | 读 | 中 | 高价值·超高频 |
| M3 | 插单/加急影响分析 | PMC、销售 | APS、MES、ERP | 读 | 中 | 高价值·中频 |
| M4 | 工单进度与当班产量实时看板 | 车间主管、厂长 | MES | 读 | 低-中 | 高价值·高频 |
| M5 | 交期延误风险预警（订单级） | PMC、销售、厂长 | ERP、APS、MES、采购 | 读 | 中 | 高价值·高频 |
| M6 | 排产建议/工单重排 | PMC | APS、MES、ERP | 读+写(需审批) | 中-高（改计划） | 高价值·中频 |
| M7 | IQC 来料合格率与让步接收判断 | 质检(IQC)、采购 | QMS/MES、SRM | 读 | 中 | 中价值·高频 |
| M8 | IPQC 制程不良趋势/SPC 预警 | 质检(IPQC)、车间 | MES/QMS(SPC) | 读 | 中 | 中价值·高频 |
| M9 | 供应商来料质量排名与降级建议 | 采购、质检、经理 | SRM、QMS | 读 | 高（供应商评价） | 中价值·中频 |
| M10 | 采购欠料比价与催货 | 采购 | ERP采购、SRM、供应商微信 | 读+写(催货/审批) | 高（供应商价） | 高价值·高频 |
| M11 | 订单实际成本核算(料工费)与差异 | 成本会计、厂长 | ERP成本、MES、财务 | 读 | 高（成本/毛利） | 高价值·中频(月结高) |
| M12 | 设备停机/稼动率与维保到期 | 设备、车间主管 | 设备管理/MES | 读 | 低-中 | 中价值·高频 |
| M13 | 厂长运营驾驶舱（OTD/良率/在制/产能） | 厂长、经理 | ERP、MES、QMS | 读 | 高（全局经营） | 高价值·高频 |
| M14 | 库存与库龄/呆滞料分析 | 仓管、成本、厂长 | WMS/ERP | 读 | 中 | 中价值·中频 |

---

## 7. 给平台设计的落地要点（提炼）

1. **先做"读+聚合+主动预警"，写操作后置且强审批**。读类场景（M2 齐套、T3 订单进度、T5 应收、M5 交期预警）价值高、风险低，是最佳切入点。[域]
2. **按系统 API 能力分层接入**：优先接有 OpenAPI 的（金蝶云星空 WebAPI、用友 Open API、电商 ERP 奇门、钉钉/企微）；老系统（U8/管家婆本地版）走只读库 + 导出，写用审批+RPA 兜底。[源][域]
3. **钉钉/企业微信作为触达与审批中枢**：Agent 的问答入口、预警推送、写操作审批都挂在这，成熟且 SME 已在用。[源：[钉钉API](https://docs.pingcode.com/baike/363112)、[企微审批](https://cloud.tencent.com/developer/article/2562567)]
4. **权限模型：角色 × 数据域双维**，成本/毛利/底价/供应商价/薪资/客户PII 为高敏感域，默认按角色脱敏或拒答。[域]
5. **一人多岗**：SME 常见，角色绑定要支持多角色叠加与最小权限取并集时的敏感域上限控制。[域]

## 8. 来源与可信度小结

- **可信度较高（一手/权威）**：金蝶 IDC/Gartner 排名、市场规模（Next Move/Technavio）、K3Cloud WebAPI 与用友 Open API 接入方式、聚水潭/奇门接口细节、钉钉/企微 API 与审批/回调机制、外贸单证与清关合规（FedEx/JD Supra/Trade Finance Global）、制造数据割裂与齐套（L2L 调研、Jodoo、SCMR、KSM）、IQC/IPQC/OQC 定义。
- **指示性（厂商/SEO 页面，需客户访谈校验）**：用友/金蝶各版本模块边界与定位、外贸 ERP 厂商功能宣称、部分中文市场份额百分比、中小厂 MES/APS 选型建议。
- **源缺口（已标注）**：泛微/致远与钉钉/企微对接的一手文档未找到；用友 U8/管家婆官方写 API 的权威规格未逐条核实（社区普遍读库）；小满 OKKI vs 孚盟 vs 焦点的逐功能对比无权威横评。
- **[域] 判断**：岗位职责、日常问题原话、单据流、权限敏感度分级、一人多岗——均为行业常识归纳，建议落地前用 2-3 家真实客户访谈校验。

