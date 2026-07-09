# Chinese Enterprise AI Agent / Assistant Platforms — Competitive & Reference Research

Research date: 2026-07-08
Scope: Chinese "enterprise agent platform" (企业智能体平台) products that connect to internal enterprise systems and help employees across roles boost productivity. Prepared as competitor/reference input for a merchant/enterprise agent platform.

Honesty note: Chinese enterprise-software vendors publish far more marketing than architecture. Where a claim rests on vendor marketing or a single secondary source, it is marked. Items I could not verify are marked **[UNVERIFIED]**. Numbers quoted from vendor pages (accuracy %, client counts) are vendor self-reported unless stated otherwise.

---

## 0. Key up-front finding: "腾讯乐享/WorkBuddy" is actually TWO different Tencent products

The brief names the main reference as "腾讯乐享/WorkBuddy 企业智能助手." Research shows these are **two distinct Tencent products** that are easy to conflate:

1. **腾讯乐享 (Tencent Lexiang / "LearnShare" / lexiangla.com)** — an **enterprise AI knowledge-management platform** (knowledge base + training + culture community, with an AI Q&A layer called LeAsk and an agent-facing OpenAPI/MCP skill). This is the closest match to "an enterprise assistant that connects to internal knowledge and answers employees by role." **This is very likely the true reference.**

2. **WorkBuddy (Tencent Cloud, built by the CodeBuddy team)** — an **agentic AI "desktop workstation"** launched ~March 2026 that plans and executes office tasks end-to-end via a marketplace of skills and 100+ "domain experts," driven from IM apps. This is a productivity-agent product, sold on a token/seat model, and is only loosely "enterprise."

A third relevant Tencent piece is **Tencent Cloud ADP (Agent Development Platform / 大模型知识引擎)**, the developer platform underneath much of this. Both are covered below; ADP + 企业微信 + 元器 are covered in the Tencent-cloud section.

---

## 1. Tencent 乐享 (Lexiang / LearnShare) — PRIMARY REFERENCE

### What it does & target users
Tencent Lexiang is Tencent's enterprise-grade AI knowledge-management platform, positioned as a one-stop "smart, accurate, agile, secure" corporate knowledge base. It historically served three scenarios — **企业培训 (training), 知识管理 (knowledge management), 企业文化 (culture/community)** — and has been re-centered around an LLM-powered knowledge base with intelligent Q&A and AI content creation. Target users: enterprises and organizations of all sizes; strongest in knowledge-heavy sectors (government, legal, education) and internal product/delivery/design teams. A secondary source cites "over 300,000 enterprise clients" (vendor-scale claim, treat as marketing).

### Architecture / how agents are built
Lexiang is primarily a **knowledge platform with an AI Q&A layer (LeAsk)**, not a general agent-orchestration studio. The intelligence stack:
- **Enterprise RAG Q&A** built on **DeepSeek-R1**, vendor-reported **92.1% accuracy** and **2.64% hallucination rate**, with multi-knowledge-domain routing, web search, and deep parsing of video/tables.
- **AI creation**: auto-generate PPT, mind maps, knowledge infographics; a guided "learning mode."
- Agents are built *on top of* Lexiang by connecting external agent runtimes to its knowledge via API/MCP (see below), rather than Lexiang being the agent builder itself.

### How custom skills/plugins are created, and by whom
Two integration surfaces, both aimed more at **developers / technical admins** than pure no-code business users:
- **`lexiang-openapi-skill`** (public GitHub, MIT): a REST-API "skill" package for AI agents. Ships as an Anthropic-style **`SKILL.md`** (usable as system prompt/context) plus `references/*.md` API docs and helper scripts. Exposes KB management (CRUD), team/member management, online-doc block editing, AI search & Q&A, file upload/download, task management.
- **MCP is the recommended path**: `lexiangla.com/mcp` for MCP-capable agents (CodeBuddy, Cursor, Claude Desktop, etc.), plus a separate `lexiang-mcp-skill` for OpenClaw. OpenAPI skill is the fallback when MCP isn't supported.
- Credentials (AppKey/AppSecret/StaffID) are issued from the enterprise admin console (开发 → 接口凭证管理). Install via the CodeBuddy skill marketplace, OpenClaw, or manual `SKILL.md`.

### Integration model with enterprise systems
- **240+ API endpoints**; deep native integration with **企业微信 (WeCom), Tencent Meeting, Tencent Docs**.
- One-click knowledge import from **Confluence, iWiki, Tencent Docs, WeChat public articles, Tencent Meeting recordings**; **102+ file formats** (docs, sheets, PPT, PDF, video, audio, images).
- **MCP protocol support** for connecting external AI agents — notable, since it means the KB is designed to be *consumed by* agents, not just humans.

### Permission / role isolation model (STRONG — directly relevant)
This is Lexiang's most relevant feature for role-isolated agents:
- **4-tier permission isolation**: enterprise → team → knowledge base → individual document. Operations (view / edit / download / manage) are configurable by **department, role, or individual**.
- **Application-side user permissions**: different end-users of the same app can be scoped to **different knowledge bases**, with isolation rules by **department, position, or customer type**. This means a manager-facing assistant and a staff-facing assistant can be given genuinely different knowledge scopes.
- **API/bot scoping**: a `system-bot` credential can only retrieve **"public" knowledge** (knowledge every employee may access) — i.e., automated agents are constrained to the least-privileged tier unless acting as a specific staff identity (StaffID).
- 7 international compliance certifications (vendor-reported).

### Knowledge base / RAG
Core of the product (see above): multi-source, multimodal, DeepSeek-R1 RAG, multi-domain routing, web search. Personal vs enterprise KB: knowledge lives at org/team/KB tiers with per-user access scoping rather than a distinct "personal KB" concept (Tencent's separate **iMA** product is the personal-knowledge-assistant play).

### Deployment model
SaaS (lexiang.tencent.com) with **private deployment support** advertised. Registration uses Tencent unified identity; access management is documented in Tencent Cloud IAM. There is a published **SaaS SLA**. (Exact private/on-prem packaging and pricing not found on the open web — **[UNVERIFIED]**.)

### Pricing
Free registration/trial tier exists. Detailed paid tiers / private-deployment pricing were **not found publicly [UNVERIFIED]** — likely quote-based via Tencent Cloud sales/partners.

### Delivery / FSE ("someone goes on-site to build skills") model
No evidence of a Tencent-run **on-site field-engineer (驻场/FSE)** model for Lexiang on the open web. The design leans **self-service + partner/服务商 ecosystem**: admins configure KBs and permissions; developers wire agents via MCP/OpenAPI. **[UNVERIFIED whether Tencent offers paid on-site skill-building; likely via 服务商/partners rather than Tencent FSEs.]**

### Strengths & weaknesses
**Strengths:** best-in-class knowledge ingestion (102+ formats, one-click imports); genuinely granular 4-tier permission model that maps cleanly to role-isolated agents; agent-native (MCP + Anthropic-style skills); tight WeCom/Docs/Meeting integration; private-deployment option.
**Weaknesses:** it's a *knowledge platform*, not a full agent-orchestration studio — complex multi-step "do work across systems" agents need an external runtime (ADP, WorkBuddy, or a custom agent) on top; no-code agent authoring is limited vs DingTalk/Feishu; pricing/on-prem opacity; heavy tie to the Tencent ecosystem.

---

## 2. Tencent WorkBuddy (Tencent Cloud / CodeBuddy team) — agentic desktop workstation

### What it does & target users
WorkBuddy is a **scenario-based agentic AI "workbench/desktop workstation"**: one plain-language instruction triggers full task planning + execution, returning a finished, verifiable deliverable ("let AI handle your entire business process with one sentence"). Launched ~**March 2026**; a secondary source reports it was piloted by **2,000+ non-technical employees** across **HR, admin, and operations**. Target users span **individuals/one-person companies** up to **teams/enterprises** (differentiated by plan). It's the office-work sibling of **CodeBuddy** (software dev). Runs as a **desktop agent with local file access** and as a bot reachable from IM.

### Architecture / how agents are built
- **"100+ domain experts"** form a virtual team (operations, design, data, development); **multiple experts run in parallel** ("one person = a whole team").
- Capabilities expand through **"MCP ecosystem + customizable Skills."**
- **TokenHub** = unified model-token management with **one-click model switching** across ~14 models (DeepSeek, MiniMax, Kimi, GLM, etc.).

### How custom skills are created, and by whom
- **Skills Marketplace** with prebuilt tasks (cross-border e-commerce product selection, standalone-site building, webpage protection, IM/conversational customer service).
- Skills are **customizable** and MCP-extensible — leans toward **technical/power users** to author new skills, though prebuilt skills are point-and-use. This is where Lexiang's `lexiang-openapi-skill` plugs in (WorkBuddy is explicitly listed as an MCP host that can install the Lexiang skill).

### Integration model with enterprise systems
- **Remote/driven from IM**: Slack, Telegram, Discord, WeCom (企业微信), QQ, DingTalk, Feishu, Yuanbao. So you delegate tasks from chat and it executes on the desktop.
- **MCP protocol support** + skill plugins; secondary source says it integrates with enterprise platforms like WeCom and DingTalk.
- Backed by Tencent Cloud services (COS storage, Lighthouse servers, TokenHub).

### Permission / role isolation model
- Team plan adds **unified seat management, admin console, unified billing, enterprise efficiency dashboard**. Fine-grained per-role *data* isolation is **not clearly documented [UNVERIFIED]** — WorkBuddy leans on the underlying skills/KBs (e.g., Lexiang's permission tiers) for data scoping rather than its own RBAC.

### Knowledge base / RAG
No first-party enterprise KB of its own; its customer-service skills operate "based on knowledge base" and it consumes external KBs (e.g., Lexiang) via skills/MCP. Documents/artifacts stored in COS.

### Deployment model
Primarily **desktop app + cloud SaaS**. Self-hosted/standalone deployment is offered via **Lighthouse** lightweight servers (one-click deploy, e.g., 2c2g/2c4g). No explicit private-cloud/on-prem *enterprise* language beyond Lighthouse self-hosting **[UNVERIFIED]**.

### Pricing (public — unusually transparent for this market)
- **Personal Pro:** ~1,000 points/month; promo **$9.95/mo** or **$119.40/yr** (regular $19.90/mo).
- **Team:** **$40/seat/month** or **$480/seat/year**; 1,000 credits/seat/month + shared team pool, admin console, unified billing, IDE/CLI/plugin support.
- Token/credit model via TokenHub (1M free credits to start).

### Enterprise vs consumer split (governance signal — relevant)
Tencent deliberately built **WorkBuddy separately for internal enterprise use "with its own security layer and controlled skill packages,"** rather than shipping the raw consumer runtime (**QClaw**, a one-click installer putting OpenClaw agents inside WeChat/QQ, launched same day March 9 2026). The consumer QClaw is explicitly described as having **"no audit trail, no approval workflow, and no role-based access."** So the enterprise differentiators Tencent itself flags are: **governance guardrails, RBAC, approval workflows, audit trails, multi-agent orchestration, and integration with systems like Salesforce/ServiceNow/SAP via APIs.** (This is a strong signal for what an enterprise merchant-agent platform must have that a consumer agent does not.)

### Delivery / FSE model
Self-service SaaS/desktop; no on-site engineer model evident. **[UNVERIFIED]**

### Strengths & weaknesses
**Strengths:** true end-to-end task execution (not just chat); local file/desktop control; MCP + skill marketplace; transparent pricing; drive-from-any-IM UX; multi-model.
**Weaknesses:** thin native enterprise RBAC/KB (relies on external skills like Lexiang); "enterprise" story is newer/less proven than DingTalk/Feishu; desktop-agent security surface (local file access) needs governance; consumer/prosumer positioning more than deep enterprise.

---

## 3. Tencent Cloud ADP + 企业微信 (WeCom) + 腾讯元器 (Yuanqi) — the Tencent agent stack

A key structural insight: these are **not independent competitors but a vertical stack**. **腾讯混元 Hunyuan (foundation model) → 腾讯元器 / 腾讯云 ADP (agent-building layers) → 企业微信 WeCom (delivery channel to employees).** Lexiang and WorkBuddy plug into this stack.

### 3a. 腾讯云智能体开发平台 ADP (Agent Development Platform) — enterprise-grade builder
**Naming note:** 腾讯云大模型知识引擎 (Large Model Knowledge Engine) was **rebranded/upgraded to ADP**. Domestic docs = product 1759; international = product 1254. **ADP 4.0** is positioned as an "enterprise-grade AgentOps platform" (develop, connect, distribute, govern).

- **What/who:** enterprise platform combining LLM + RAG + workflows + multi-agent collaboration. Target: enterprises + developers, both business and technical teams. Scenarios: customer service, KB Q&A, in-vehicle assistant, marketing, inventory. Real deployments in automotive, hospitality, pharma, logistics.
- **Architecture (well-verified):** 3-tier hierarchy **企业 (Enterprise) → 工作空间 (Workspace) → 智能体应用 (Agent App)**. Enterprise = one Tencent Cloud primary account, up to **20 workspaces**; Workspace = team/project space that shares apps/KBs/connectors/prompts internally, **data isolated across workspaces**; App built in one of 3 modes: 标准 (standard), 单工作流 (single-workflow), or Multi-Agent.
- **Multi-agent orchestration:** Free Handoff, Workflow Orchestration, Plan-and-Execute. Workflow node types: Parameter Extractor, LLM Intent Recognizer, Knowledge Retrieval, Code Node, Conditional Branch, Agent Node.
- **Skills/plugins & who builds:** **Tool** = one API for one task; **Plugin** = collection of tools (marketplace or bring-your-own). Visual/low-code for business users ("business users iterate without developers") **plus** full developer toolchain + API 3.0 — so **both audiences**.
- **Integration + MCP (verified):** explicit **MCP support** — create custom tools via 连接器与工具 → 自定义工具 → MCP (SSE and streamableHTTP transports, one-click JSON add, custom auth headers; servers must implement `initialize`, `tools/list`, `tools/call`). Also API tools with APIKey/OAuth 2.0; **VPC integration** with enterprise systems (CRM etc.), IP whitelisting, regional deployment.
- **Permission / role isolation (STRONGLY VERIFIED — standout):** two distinct systems.
  - *Platform-side (builders):* Enterprise roles = 超级管理员 / 空间创建员 / 普通用户 (fixed); Workspace roles = Administrator + custom; functional vs data permissions; sub-accounts via Tencent Cloud CAM.
  - *Application-side (end-users):* controls **which knowledge scope each end user accesses within one app.** Method 1 — **Role-Based Access Control**: define roles (e.g., "Product Dept: only product KB"; "Finance: only finance KB"), bind users to roles, union-of-scopes for multi-role users; user maps to **`visitor_biz_id`** passed in every API call → **a manager's agent vs a staff agent differ purely by role binding** (manager = broad scope, staff = narrow). Method 2 — **External Privilege System**: for enterprises with existing OA/permission systems; ADP recalls candidate KB slices, sends them + user identity to the external system for per-slice access decisions, then filters before the model. **Isolation carries through to the published API layer via `visitor_biz_id`.**
- **Knowledge base / RAG (verified):** **hybrid model** — each app has a **default KB (app-scoped, non-shareable)** PLUS optional **platform-level (平台级) KBs shareable across apps** (maps directly to "personal/app-private vs enterprise-shared KB"). Types: 文档 / 问答 / 数据库. 28+ document formats, multimodal, tag/metadata-scoped retrieval (tags → API `custom_variables`). RAG cold-start ~40–60% of deployment time.
- **Deployment (verified):** **公有云 SaaS** (subscription) or **云部署/License** (customer self-manages on their own Tencent Cloud **TKE cluster** in their dedicated VPC/account; "minute-level delivery," claims >50% hardware reduction vs older private ver). **Nuance:** this is *customer-managed-on-Tencent-Cloud-IaaS*, **not true air-gapped on-prem** — no public doc confirms fully-offline on-prem for ADP itself. (Hunyuan model weights *are* open-sourced on GitHub and deployable via **TI-ONE** on private TKE for genuine local model hosting — but that's the model layer, not ADP.)
- **Pricing (well-verified — concrete):** subscription + PU model, **1 PU = 0.001 RMB**, PU resets monthly:
  | Tier | Price | PU/month | Workspaces | Collab |
  |---|---|---|---|---|
  | 免费 Free | ¥0 (1-mo trial) | 15,000 | 1 | 3 |
  | Skill Plan | ¥88/mo | 89,000 | 1 | — |
  | 专业版 Pro | ¥188/mo | 150,000 | 3 | 5 |
  | 企业版 Enterprise | ¥4,880 | 3,000,000 | 1,000 | 1,000 |

  Only 企业版 supports all third-party models. Token pricing in PU/1k tokens (e.g., DeepSeek-V3.2 in 2/out 3; hunyuan-pro in 30/out 100). 专属并发 (dedicated concurrency) for Pro/Enterprise billed by concurrency, no token fees (e.g., DeepSeek-V3.2 @1 concurrency = ¥9,600/mo).

### 3b. 企业微信 (WeCom) — native AI + delivery channel
- **WeCom 5.0 (~Aug 2025)** added native AI: **智能机器人 (Smart Robot / "AI colleague")**, 智能搜索, 智能总结, 智能表格 AI (batch classify/extract, reads invoices/IDs), 智能客户管理, 智能邮件.
- **Smart Robot build = low/no-code + self-serve:** admin can "describe a scenario in one sentence and AI auto-generates a Smart Robot"; flexible model + KB config; advanced setup supports **API and MCP plugins** to reach internal systems, plus **workflows**; exposes reasoning + tool call-chain for debugging.
- **大元 (Dayuan) agent (~June 2026):** DeepSeek-V4-powered agent rolling out to select WeCom users; analyzes the user's own group chats/emails/calendar, drafts weekly reports and daily industry briefs. Moat = data already resident in WeCom.
- **Connection to ADP (verified):** ADP publishes into WeCom two ways — (1) **发布到企微智能机器人** (WebSocket long-connection, recommended, no public domain/Nginx needed; or URL callback); limits: 1 app↔1 robot, 3-min reply window, 2048-byte max response. (2) **发布到企业微信自建应用** (paste ADP link as app homepage, or Nginx-proxied custom method needing 备案 domain). **Role/knowledge isolation set in ADP is preserved through the published API via `visitor_biz_id`.**
- **wecom-cli** open-sourced ~March 2026 exposing 7 office capability categories (messages, calendar, docs, meetings, todos, contacts, smart sheets) to external AI agents [single secondary source].

### 3c. 腾讯元器 (Yuanqi) — consumer/creator no-code agent platform
- **What/who:** one-stop **no-code agent creation & distribution**, built on Hunyuan, leaning **individual creators, brands, 公众号 operators** — NOT the enterprise-isolation platform (that's ADP). Tencent's own materials sometimes blur Yuanqi vs ADP.
- **Build:** no-code "捏" model = Prompt + Plugins + Knowledge Base + Workflow. Official plugins (WeChat 搜一搜, PDF parsing, Hunyuan image-gen) + custom plugins; low-code flowchart workflow.
- **Distribution:** to **WeChat 公众号, websites, OpenAPI (REST)**; can publish to 企业微信 via API.
- **Permission/KB:** per-creator KB attached per agent; **no ADP-style per-role KB isolation** [UNVERIFIED any enterprise role isolation]. Public SaaS only. Freemium pricing.

### Delivery / FSE for the Tencent stack
ADP positioned as **self-serve + "dedicated customer success team" + SLA** (stated build timelines: FAQ agents 1–2 wks; multi-scenario 4–6 wks; multi-agent 8–12 wks) and explicitly emphasizes business users iterating without developers. A Partner Ecosystem Program + hackathons exist. **A dedicated Tencent-run on-site/驻场 FSE program is NOT verified in public docs** — real vertical deployments imply professional-services/partner involvement, likely handled via direct sales/partners off-doc. **[UNVERIFIED — flag for follow-up]**

---

## 4. Alibaba — DingTalk 悟空 Wukong / DEAP / 阿里云百炼 Bailian / 通义 Qwen

**Big structural finding:** Alibaba's enterprise-agent story reorganized in early 2026. **悟空 (Wukong)**, launched **March 17, 2026**, is now the flagship enterprise agent platform, sitting on a rebuilt DingTalk. The older 2024 "in-app DingTalk AI Assistant" still exists but is being subsumed. Launched by the new **Alibaba Token Hub (ATH)** group (DingTalk's group renamed the "Wukong Division").

### 4a. 悟空 Wukong — flagship enterprise agent platform
- **What/who:** "enterprise-grade AI-native work platform"; pitch is *action* AI — "operates your computer like a real assistant" to edit docs, update sheets, fill approval forms, transcribe meetings, deep research. Spans large enterprises (existing DingTalk orgs) and SMEs/solo (via OPT bundles).
- **Architecture:** DingTalk **rebuilt as a CLI + open API layer ("全面CLI化")** so agents operate DingTalk functions natively instead of simulating clicks — the key bet. Includes **RealDoc** AI-native file system with fine-grained permissions; a decision/runtime layer plans multi-step tasks.
- **Skills — no-code + marketplace:** modular **"Skills"** (built-in + user-defined = "expert modules"). Creation is **no-code/conversational**: click **+New Skill**, describe in natural language, a "skill creation assistant" generates it; OR **upload a `SKILL.md` or ZIP** (Anthropic-style, **compatible with open-source Skills**). A **toB Skill market** with dev→review→listing→distribution pipeline; Alibaba's own B-side capabilities (Taobao/Tmall/1688/Alipay/Alibaba Cloud) connected "as Skills."
- **Integration:** native DingTalk; roadmap for **WeCom, Feishu, Slack, Teams, WeChat** + self-built systems via API. OPT skills reach tax/invoicing, online banking, resume DBs, 1688/Amazon/Taobao, Douyin/Bilibili/YouTube.
- **Permission / role isolation (VERIFIED — headline differentiator):** Wukong **inherits the enterprise's existing DingTalk permission system** — "intelligent operations within the user's existing permissions… data permissions consistent with DingTalk APP." So **a manager's agent vs a staff agent differ because their underlying DingTalk permissions differ** — the AI only sees/does what that employee already can. **"Data permissions isolated from the human dimension"** (per-person, not one shared org bot). Org-level data requires switching to enterprise identity + **applying for permission** (admin approves via DingTalk Management Assistant); **sensitive operations require employee re-confirmation**, never autonomous. Runs in an **auditable sandbox**; claims 20+ security/compliance certs (ISO/SOC/等保/AI management standard — DingTalk Wukong got the world's first international AI Management System cert).
- **Knowledge base:** emphasizes **long-term personal memory** ("the more you use it, the smarter"); RAG/KB handled more at the Bailian/DEAP layer than surfaced as a first-class Wukong feature (partial gap).
- **Deployment:** **local desktop client** (Win 10 1909+/macOS 14+, both Beta), **DingTalk client** (IM bot + H5, offline→mobile sync), **cloud security sandbox**; separate **"Global Wukong"** overseas. Invite-only beta at launch. Private deploy via DEAP/Bailian layer.
- **Pricing (verified):** Free (no 算粒/"grains", standard+premium models) / **Ordinary ¥39/person/mo** (1,000 grains, adds flagship models) / **Premium ¥99/person/mo** (3,000 grains, all + custom models). Grain-based consumption (no published token→grain rate); enterprise grains deducted before personal, no carryover. **Free to existing paid DingTalk customers "for now."** CTO signaled possible shift to **pay-per-performance / per-API-call**.
- **Strengths:** permission-inheritance + sandbox + audit is a strong enterprise-trust story; huge DingTalk base (~20M+ orgs); real desktop action (Excel/browser) vs web-only rivals; pre-packaged OPT industry suites. **Weaknesses:** invite-only/Beta maturity; desktop OS constraints; opaque grain pricing; KB less clearly architected than the trust layer.

### 4b. OPT (One-Person Team) — Wukong's vertical packaging
Wukong's answer to "who builds my agent" = **pre-built industry bundles** (skill suite + workflow + industry data), first batch = **10 industries** (e-commerce, cross-border, creators, software dev, retail, design, manufacturing, legal, finance/tax, recruitment). User "only makes decisions and accepts results." (Source conflict on acronym; "One-Person Team" is the primary reading.)

### 4c. DEAP — DingTalk Enterprise AI Platform (enterprise control/build backend)
"One-stop platform to create, manage, distribute, operate AI assistants." Claims **"largest enterprise MCP capability square in China — 6,000+ enterprise MCP capabilities"** in first batch (DingTalk's own tools + third-party: text-to-image/video, Gaode Maps, Ant Sesame Credit, AIPPT) — clearest evidence of **native MCP** in the DingTalk stack. 150+ multimodal industry models; **private deployment** (secure cloud, AI all-in-one machines, 5–50% cost advantage). DEAP is where admins manage **seats, quotas, enterprise-skill visibility** for Wukong. [6,000-MCP / 150-model figures = single-outlet media, medium confidence.]

### 4d. Native DingTalk AI Assistant + Agent Marketplace (2024 lineage — being absorbed)
- Jan 2024 AI Assistant introduced; ~Apr 2024 **AI Agent Store (~200 agents)** — both third-party SaaS ISVs and individual developers build/share; **developers must apply for approval before listing**; multimodal, up to 500 pages.
- Jun 2024 (Make conference): **AI Search** over internal data (docs/chats/meeting notes → knowledge network/mind maps); **opened model layer to 6 partners** (MiniMax, Moonshot, Zhipu, OrionStar, 01.AI, Baichuan; default 通义千问); multi-agent + teach-by-demonstration.
- Aug 2024 (AI DingTalk 1.0): AI Startup Assistant for SMEs. Dec 2025 (1.1): **Agent OS** + human-AI collaboration.
- **Per-skill visibility UI of the older native 个人AI助理 (仅自己/部门/组织) could NOT be confirmed from official docs [UNVERIFIED]** — the verified role-isolation story now lives in Wukong.

### 4e. 阿里云百炼 Bailian (Model Studio) — the developer builder layer
The build platform beneath everything (powers DingTalk AI robots).
- **App types:** Agent (single) / Workflow (visual orchestration) / Agent orchestration (Agent Group — a decision model coordinates sub-agents) / legacy process orchestration.
- **Node types:** flow control (Start/End/Condition/Intent Classification/Loop/Batch); intelligence (LLM, Parameter Extraction, Create Agent, Agent Group); data/RAG (Knowledge Base, Variable, **Script** JS/Python); integration (**MCP** — one tool per node, official cloud-deployed or custom; **API**; **Plugin** — Quark Search/Calculator/Python + custom; Function Compute, AppFlow, Data Connector); multimodal parsing/gen. **DSL import/export incl. one-click Dify import.**
- **Built by whom:** mainly **no-code/low-code drag-drop** (developers, usable by capable business users); Script node for code; published apps expose an API (`DASHSCOPE_API_KEY`).
- **Standard "no-code DingTalk AI robot w/ private KB" recipe = Bailian Agent app (Qwen-Plus) + RAG KB + AppFlow (HTTP) → DingTalk robot.** (Security note: that AppFlow webhook must be validated as DingTalk-only or it's an open unauthenticated endpoint.)
- **KB/RAG:** upload docs via File Connector (parse ~1–6 min), Standard Edition KB, optional **ADB-PG** shared vector store, "Always Call" attach — **org/app-scoped KB** per application.
- **Deployment:** public SaaS + **private/VPC/hybrid**; dedicated model deployment, fine-tuning, Compute Nest one-click, PAI EAS.
- **Pricing:** **token-based** (input/output separate; some models tiered by context up to 1M); agent apps not charged separately (cost = model tokens); per-model free quotas that don't pool; token subscription plans exist.

### 4f. 通义灵码 / Qoder CN (Lingma) — enterprise coding assistant
Renamed **Qoder CN**. Editions: Individual; **Enterprise Standard** (user mgmt, IdP/SSO, unified permissions, **org KB Q&A**, codebase-aware); **Enterprise Dedicated** (customizable, dev access controls, company KB, **role permissions**); **Enterprise VPC**. Deployment VPC/private; fully-private quote-based. Pricing = seats + Credits (one tier **¥59/mo**; adjusted May 20 2026). Good comp for role-isolated enterprise code KBs.

### Alibaba delivery / FSE
**No verified official on-site/驻场 build service.** Model is deliberately **self-serve + admin-managed** (seats/quotas/skills in DEAP); Wukong offers a "free appointment with a service expert" (consultation, not on-site build). Alibaba's answer to "build it for me" = **pre-packaged OPT industry suites** + "pay-by-result" marketplace. 驻场 exists in the ecosystem but via **third-party ISVs/服务商**, not official Alibaba capability (promotional sources only).

---

## 5. ByteDance — Feishu (Lark) 智能伙伴 / aily / 扣子 Coze

**Disambiguation:** "Aily Labs" (ailylabs.com) is an **unrelated** European decision-intelligence company — NOT ByteDance's aily. All ByteDance products below run on the **豆包/Doubao** model family via **火山引擎 (Volcengine)**.

### 5a. 飞书 aily vs 扣子 Coze — the key distinction (specific ask)
Both are ByteDance, but positioned differently:
- **扣子 Coze** = general-purpose, one-stop **no-code/low-code agent/Bot builder** ("ByteDance's GPTs"). Drag-and-drop workflow nodes, plugin marketplace, RAG KB, multi-channel publish (WeChat, web, IM). Audience: **developers, creators, general users**. Editions: international **coze.com**, domestic **扣子** (run by Volcengine), and **open-source Coze Studio** (self-hostable). Typical scenarios: content creation, chatbots, plugin monetization.
- **飞书 aily** = **enterprise-grade agent application platform deeply embedded in the Feishu office suite** — wired into Feishu Docs, 多维表格 (Base), approvals, and org structure. Audience: **enterprise employees + management scenarios**, integrating existing enterprise data/business systems. Deployment: enterprise SaaS inside the Feishu environment.
- One-liner: **Coze is an open, general agent "factory" anyone uses to build & distribute bots; aily is an in-Feishu, enterprise-office/business-system agent "internal employee."**

### 5b. 飞书 aily (Feishu Intelligent Partner / enterprise agent platform)
- **What/who:** enterprise-grade AI assistant + agent-app development platform for daily office work, targeting enterprises already on Feishu. 2026 "全新升级" per Feishu community.
- **Architecture / build:** builds agent applications that connect enterprise data + business systems; leverages Feishu's native collaboration primitives (docs, Base, approvals). Leans toward **low-code enterprise app builder** more than pure chat. (Detailed node/orchestration model **not fully verified from official docs on open web [UNVERIFIED]**.)
- **Integration:** via **Feishu Open Platform self-built apps** (admin creates app in developer console, configures, submits for approval); Feishu Open API for org/robot capabilities; Base (多维表格) as a data/agent surface. MCP-style ecosystem emerging via community skills/OpenClaw integrations (community, not first-party).
- **Permission / role isolation:** inherits **Feishu's admin-console permission model** — member file/operation permissions, permission auditing, and app permissions that **require admin approval before an app can access data**. So role isolation is realistic but is inherited from Feishu's RBAC rather than a documented per-agent RBAC. **[Feishu RBAC verified; aily-specific per-agent role isolation UNVERIFIED.]**
- **Knowledge base / RAG:** built on Feishu Docs/Wiki/Base as the knowledge substrate + Doubao RAG. Personal vs org KB maps to Feishu doc/wiki permissions. Exact ingestion spec **[UNVERIFIED]**.
- **Deployment:** enterprise SaaS in Feishu (public cloud). **No clearly documented official private/on-prem for aily on the open web [UNVERIFIED]** — Feishu does have a privatized/deployed enterprise offering, but aily-specific on-prem is unconfirmed.
- **Pricing:** not cleanly public **[UNVERIFIED]**; bundled with Feishu enterprise plans.
- **Strengths:** deepest office-suite integration of any competitor (docs/Base/approvals native); strong for employee-in-the-flow productivity. **Weaknesses:** locked to Feishu ecosystem; thinner public architecture/on-prem docs; aily and Coze positioning can confuse buyers.

### 5c. 扣子 Coze (enterprise & self-host angle)
- **Enterprise edition:** migrate personal workspaces into an enterprise for enterprise-level privileges; OAuth (PKCE, JWT) auth flows for programmatic bot/API access with scoped permissions (BOT mgmt, session mgmt).
- **Knowledge base:** built-in RAG KB per bot; document ingestion; used for commercial-grade customer-service agents (zero-code).
- **Private deployment:** **open-source Coze Studio** is self-hostable (Docker/Pagoda-panel guides) — the recommended path for strict data-privacy/air-gapped needs, since the cloud enterprise edition keeps data on ByteDance infra. This is a genuine on-prem route (via the OSS edition).
- **Strengths:** fastest general no-code agent build; OSS self-host escape hatch; plugin ecosystem. **Weaknesses:** consumer/creator DNA; enterprise RBAC lighter than ADP/Wukong; cloud edition data-residency concerns push serious enterprises to the OSS self-host.

### ByteDance delivery / FSE
No evidence of ByteDance sending **on-site/驻场 engineers** to build agents. Model = self-serve (Coze no-code, aily in-Feishu) + **partner/ISV ecosystem** for delivery. **[UNVERIFIED for any official FSE program.]**

---

## 6. Baidu — 文心智能体平台 (AgentBuilder) / 千帆 Qianfan / 如流 Ruliu

### 6a. 文心智能体平台 / AgentBuilder (formerly 灵境矩阵)
- **What/who:** Baidu's **no-code/low-code agent creation platform** built on the **文心/ERNIE** model; create agents via natural-language interaction, drag-and-drop tools, prompt engineering, workflows, and custom KBs. Consumer + developer + brand facing (distribution into Baidu Search etc.).
- **Enterprise route = 千帆 Qianfan** (大模型服务及Agent开发平台): positioned as the **enterprise-grade entry point** for ERNIE model services with a full gen-AI dev toolchain (model hosting, fine-tuning, RAG, agent orchestration).
- **Integration / permissions:** enterprise access control via **Baidu AI Cloud IAM** (centralized role-based resource permissions, assign by role); MCP/plugin ecosystem on Qianfan **[MCP support likely but not confirmed on open web — UNVERIFIED]**.
- **Knowledge base / RAG:** custom KBs in AgentBuilder; enterprise RAG on Qianfan. Details **[partially UNVERIFIED]**.
- **Deployment:** AgentBuilder = public SaaS; **Qianfan supports private/proprietary deployment** for enterprises (Baidu AI Cloud). 
- **Pricing:** AgentBuilder free/low-cost for creators; Qianfan = cloud consumption/token + private-deploy quotes **[UNVERIFIED specifics]**.

### 6b. 如流 Ruliu (Infoflow)
Baidu's enterprise collaboration/IM + knowledge platform (Baidu's DingTalk/Feishu analog), integrating ERNIE-based AI assistant + enterprise search over internal knowledge. **Specific 如流 × AgentBuilder KB/permission integration NOT confirmed on the open web [UNVERIFIED].** Likely the internal delivery channel analogous to WeCom/DingTalk/Feishu.

**Strengths:** strong base model (ERNIE), Qianfan is a mature enterprise MLOps/agent platform, private deploy. **Weaknesses:** 如流 has far smaller enterprise footprint than WeCom/DingTalk/Feishu; agent story more developer/model-centric than office-suite-native; thinner public role-isolation docs.

### Baidu delivery / FSE
Baidu AI Cloud runs **solution/industry delivery teams** for large accounts (typical of Chinese cloud vendors), but a documented **agent-specific 驻场/FSE** program is **[UNVERIFIED]**. Self-serve for AgentBuilder; account-managed/partner delivery for Qianfan.

---

## 7. Huawei — 盘古 Pangu / 华为云 agent platform / WeLink

### 7a. 盘古 Pangu large models + Huawei Cloud agentic AI
- **What/who:** Pangu is packaged as **industry models** (mining, government, automotive, weather, medicine, virtual humans, R&D) on **Ascend AI Cloud**. At **Huawei Cloud INSPIRE 2026 (June 5, 2026)** Huawei introduced an **"Agentic Infra"** paradigm + an **enterprise-grade agent platform** for enterprise agentic AI. Target: **large enterprises, government, regulated/industrial sectors**.
- **Architecture:** cloud-edge synergy ("intelligent brain + intelligent factory"); multiple foundation models (CV, GNN, multimodal, NLP) composed per industry. New-gen training/inference platform + agent platform announced 2026.
- **Integration / build:** enterprise model + agent toolchain on Huawei Cloud; industry-model fine-tuning; API references published (Pangu 8.3.1 API Reference for Huawei Cloud Stack). Skill/agent authoring is **developer/integrator-oriented** rather than mass no-code.
- **Permission/KB:** enterprise IAM + industry-specific KBs; specifics **[UNVERIFIED on open web]**.
- **Deployment (key strength):** **Pangu ships in Huawei Cloud Stack — Huawei's on-premises/hybrid offering** → genuine **private-datacenter / on-prem deployment**, driven by security & compliance. This is the strongest true-on-prem story among the majors.
- **Pricing:** enterprise/project-based, quote-driven **[UNVERIFIED]**.

### 7b. WeLink
Huawei's collaborative office platform (video, IM, directory, one-stop enterprise services); third-party apps integrate via API gateway. AI-assistant features exist; **WeLink × Pangu agent × on-prem as one packaged offering NOT found as a single official page [UNVERIFIED].**

### Huawei delivery / FSE (strongest FSE story)
Huawei is **known for heavy delivery/implementation teams and on-site presence** for large government/industrial deployments. While a single official "agent 驻场" product page wasn't found, Huawei's whole enterprise motion is **solution-delivery + integrator/partner + on-site engineering** (compliance/security-driven private deployments). This most closely matches an **FSE / "someone goes on-site to build it"** model among the majors — though verified more by Huawei's general enterprise delivery reputation than an agent-specific doc. **[Directionally verified; agent-specific FSE UNVERIFIED.]**

**Strengths:** best true on-prem (Huawei Cloud Stack), industry-model depth, heavy delivery muscle for regulated sectors. **Weaknesses:** developer/integrator-heavy (not no-code employee self-serve); WeLink small vs WeCom/DingTalk/Feishu; least "employee productivity agent" flavored, most "industry AI platform" flavored.

---

## 8. Vertical "digital employee" (数字员工) — RPA + LLM vendors

These matter as a **delivery-model reference** (RPA is historically consultant/驻场-delivered) and for **UI-automation integration** with legacy systems that lack APIs. **Model strategy:** all are **model-agnostic** (plug in DeepSeek/Qwen/GLM) EXCEPT **实在智能** (own TARS vertical LLM) and 达观 (own 曹植). The category repositioned rule-based RPA as the "hands" for LLM "brains" → "agentic automation / 数字员工 3.0."

**Name-collision caution:** 实在智能's LLM is literally named **TARS**, colliding with (a) ByteDance's **UI-TARS** GUI-agent model, (b) Tencent's **Tars** RPC framework, and (c) **hellotars** (a Western no-code chatbot builder). Unrelated — filtered out below.

### 8a. 影刀 RPA (YingDao) + 影刀 AI Power — most self-serve / lowest 驻场
- **What/who:** block-based (积木式) zero-code RPA (client = "ShadowBot"; international brand = "Automa"/goautoma.com). Claims 30,000+ enterprises, strongest in e-commerce. "人人可用" citizen-developer-first, serving SME + large enterprise. Series C $100M (Apr 2022, Goldman Sachs; Hillhouse/GGV/Tencent/GSR).
- **Architecture ("AI as brain, RPA as hands"):** RPA layer = non-invasive UI automation + Chrome-extension runtime (~1M users). AI layer (影刀AI): **魔法指令 (Magic Commands)** NL→instruction blocks (LIVE); **魔法流程 (Magic Flow)** NL→full auto-built flow (NOT yet released); **影刀AI角色 (AI Roles)** personas + rules + attachable KB docs. **影刀AI Power** = no-code AI-app builder aggregating third-party LLMs. A newer **影刀AI Weave** (agent orchestration) appears in the sitemap but renders empty [UNVERIFIED].
- **Build & by whom:** primarily **no-code business users** (block designer, 影刀学院 academy, instruction/app marketplaces). Pro-code (embedded Python/JS) secondary. Enterprise ed. adds reusable module packaging + private marketplace.
- **Integration + MCP:** UI automation primary + APIs/databases; ERP/CRM connectors (SAP/Salesforce/Oracle "1,000+ connectors" internationally). Open API is **enterprise-only**. **MCP: yes** — official "Yingdao RPA MCP Server" (Apr 25 2025), local + enterprise-OpenAPI modes, bridges to Claude Desktop/Cursor.
- **Permission/role isolation:** enterprise console + RBAC/SSO/MFA/audit-logs/credential-vaults claimed (strongest on the Automa/English side; "role-based marketplace access"). **Gap:** granular per-role *data* isolation & multi-tenant specifics NOT publicly documented (help docs login-gated) — public-vs-private-cloud is the main hard boundary. [Per-role data isolation UNVERIFIED.]
- **KB/RAG:** 知识小站 (upload docs/images/text/web) feeds AI apps; AI Roles attach KB docs; international brand claims "RAG Q&A." No public vector store/embedding/chunking disclosure [UNVERIFIED].
- **Deployment:** Desktop (Win/Mac/信创: 统信UOS, 银河麒麟/Android); enterprise supports **both public and private cloud**; air-gap under enterprise/custom. Non-invasive posture.
- **Pricing:** 社区版 (free) / 创业版 / 企业版 / 教育版; **module-based billing**. No public list prices (quote-based).
- **Delivery model (KEY):** standout — product-led and **explicitly low-驻场**. FAQ verbatim: they *prefer customers self-build* ("影刀更倾向于让客户自己来进行应用的开发"). Implementation exists but de-emphasized; scaled to "thousands of customers without a sales team." Exception: **数据连接器** is a fully-managed (全托管) e-commerce data service.
- **Strengths:** self-serve at scale, low barrier, full stack (RPA→AI→AI Power→MCP), 信创 + private cloud, well-funded. **Weaknesses:** deepest agentic pieces (Magic Flow, AI Weave) unreleased/opaque; RAG & per-role data isolation undisclosed; no price transparency; UI-automation brittleness.

### 8b. 实在智能 / TARS (Intelligence Indeed) — CV-grounded agent + own vertical LLM
- **What/who:** RPA + vertical-LLM "digital employee" vendor. Founded Aug 2018 (founder 孙林君), ~300+ staff (53%+ R&D), Series C ~¥200M. Dual-track: marquee large-enterprise/gov/SOE logos (China Unicom Finance, 北方华创/NAURA, Geely, Bank of Hangzhou, provincial courts) **and** SME-friendly (free Community Edition, 1M+ community users). Customer count conflicts across own sites (EN "4000+" vs CN "5000多家").
- **Architecture (key finding — orchestrated stack, "strong brain, flexible hands, keen eyes"):** NOT a single end-to-end model.
  - **Brain = TARS 大模型** — their OWN vertical LLM (Aug 2023): conversation, intent, task planning. Trained on 千亿级 vertical tokens (pre-train/SFT/RLHF); concrete **TARS-Finance-7B** co-built with 湘财证券 (also an investor — cross-corroborating). [Params beyond 7B, benchmarks, "China's first RPA vertical LLM" UNVERIFIED.]
  - **Eyes = ISSUT** (智能屏幕语义理解技术) — computer-vision screen understanding to locate on-screen elements; positioned as "surpassing the purely large-model approach."
  - **Hands = RPA execution.** **Z-Agent / 实在Agent** runs the plan-then-act loop. TARS = a **vertical-domain LLM, NOT an agent framework, NOT a general foundation model.**
- **Build & by whom:** no-code/low-code + developers, 3 paths: (1) visual no-code designer (with Python-syntax source-view escape hatch); (2) **NL-to-automation ("所说即所得")** — TARS generates RPA modules, ISSUT fills element attributes; (3) marketplace reuse (智能体市场 claims 5000+ prebuilt agents).
- **Integration + MCP:** primary = UI automation/screen-scraping ("像真人一样操作," no API needed) + ISSUT CV grounding where no stable selectors/APIs. **MCP: yes, confirmed** — 实在Agent page states "丰富的组件与 MCP 工具." Connects ERP/CRM, domestic browsers/office; Windows/信创/Android.
- **Permission/role isolation (best-documented here):** via **RPA 控制器 (Commander)** B/S hub: "功能和数据多层级权限控制" (multi-level function AND data permissions), configurable org + roles (RBAC), separate authorization for designers vs robots, 2000+ concurrent-robot dispatch, full log+video audit. Manager vs staff access can differ. [No explicit row-level/多租户 isolation proven — partial.]
- **KB/RAG (thin disclosure):** TARS supports KB + doc Q&A ("你问我答"); **IDP (文档审阅)** ingests contracts/cards/invoices; **数据大脑/Shiyun Brain** = annotation + model training/deploy (MLOps, not a RAG store). [Actual RAG stack NOT disclosed; UNVERIFIED.]
- **Deployment:** private/on-prem heavily emphasized ("全面支持私有化部署" + model quantization). Strong **信创** (统信UOS, 麒麟; 鲲鹏/飞腾; 达梦DB; 55+ certs; 等保三级, ISO27001, CMMI5). Community Edition downloadable.
- **Pricing:** ~**¥30,000–50,000/year per digital employee** (own RPA-College doc, ~2021, indicative — likely one bot seat, excl. implementation). Most concrete per-seat figure of the group. Enterprise/私有化 quote-based.
- **Delivery model:** hybrid — self-serve no-code (free Community Edition, 1M+ community, 实在学院) + partner/channel-led (1000+ partners) + vendor-assisted for large accounts (Unicom Finance: 15+ scenarios, 13,000+ stable hours). [Specific 驻场/FSE intensity UNVERIFIED.] Standard = no-code/partner; complex enterprise = vendor/partner solution + implementation.
- **Strengths:** CV-grounded agent (ISSUT) + own vertical LLM (TARS) differentiated; deep 信创 (gov/SOE/finance); full stack; MCP + NL-to-automation + marketplace; low-cost/free tier; private deploy + quantization. **Weaknesses:** data-sync latency in complex flows (per comparison article); UI-automation brittleness; RAG undisclosed; multi-tenant isolation unproven; TARS name-collision.

### 8c. 来也科技 (Laiye) — WEP / APA / ADP / ACX; best-documented role isolation
- **Correction to common lore:** 2022 acquisition was **Mindsay** (French conversational AI), NOT MindMeld. 2019 merged with **Awesome Technology** → UiBot.
- **What/who:** "China's answer to UiPath." Founded 2015; unifies RPA + IDP + Conversational AI into one platform. Overwhelmingly **large-enterprise + government** (claims 300+ Fortune-500/China-500 customers, 600+ partners, 800K+ developers). Only Chinese vendor in Gartner MQ across RPA + IDP + Conversational AI (per Laiye). Funding ~$201M; none surfaced after 2022.
- **Architecture:** umbrella = **Work Execution Platform (WEP)**: **APA** (Agentic Process Automation = RPA), **ADP** (Agentic Document Processing = IDP, Sep 2025), **ACX** (Agentic Customer Experience, 2025). Agents = Planning + Memory + Tool-Use. Execution = "Code + LLM + Computer Use Agent." Two orchestration modes: workflow-based (rigid/compliant) and autonomous-planning (own caveat: "weaker on accuracy and stability"). **Model-agnostic**; **no proprietary foundation model.**
- **Build & by whom:** no-code business user ("Magic Hat" Describe→Generate→Verify; NL SOPs; zero/one-shot IDP) + pro-code developer (500+ commands, Python/C#/Java plugins, 3-level cert). **UB Store** = historical UiBot marketplace, now the **Agent Marketplace** inside WEP (1,000+ bots; no-commission monetization). "Spec-as-Contract" dual doc+code view is the authoritative agent-generation source.
- **Integration + MCP:** UI automation + Computer Use Agent (survives UI redesigns) + APIs to ERP/CRM/OA/financial; IDP outputs JSON, writes back via RPA. **MCP: yes.** ACX unifies Feishu/WeCom/WhatsApp/WeChat mini-programs/Douyin.
- **Permission/role isolation (BEST-documented of the group):** Automation Commander = **5 preset roles** (system admin, ops/maintenance, **department head**, **process developer**, **business personnel**) + departments up to **8 levels** + **per-tenant root-folder isolation** (menus like "Unattended" only expose Workers in scope). ACX adds "RBAC + tenant data isolation + module-level permissions" + user-group tag segmentation. Dept-head vs business-personnel get different visible bots/functions.
- **KB/RAG (weakest-documented):** legacy Wulai KB = classic NLP similarity matching (word seg + "standard question + similarity questions" + threshold), NOT modern embedding RAG. ACX (2025) = unified multimodal knowledge store + "knowledge attribution analysis," but no vector DB/embedding named [modern RAG UNVERIFIED].
- **Deployment:** cloud + on-prem + hybrid; ADP supports offline + local-model + China MLPS (等保). Desktop Worker (attended + unattended) + Linux Commander. Free Community vs Enterprise.
- **Pricing:** quote-based/tiered (scales by users + processes). Aggregators cite ~$49/mo entry [low confidence]. ADP free tier (100 credits/mo). Positions cheaper than UiPath/AA/Blue Prism + ships a migration tool.
- **Delivery model:** hybrid, **partner-led + customer-CoE**, not pure Laiye-builds-all. Clearest case (Digital China, 5-yr partner): the customer's **own** RPA team builds the full lifecycle, ~20–30 working days per solution; Laiye supplies platform + training + customer success. Big-Four/SI partners (Deloitte/KPMG/EY/PwC) do heavy implementation. [Explicit Laiye-branded 驻场/FSE offering NOT confirmable — partner/consultant-built delivery is core.]
- **Strengths:** unique full-stack "trinity" (RPA+IDP+Conversational) in WEP; strong on-prem + local-model + 等保; model-agnostic + MCP + Computer Use Agent; large dev community + marketplace + migration tooling; global footprint. **Weaknesses:** opaque pricing; RAG undocumented; enterprise-heavy/weak SME motion; rebranding churn (UiBot→Laiye, Wulai→ACX, IDP→ADP, UB Store→Marketplace); no funding after 2022; real implementation burden despite "no-code" marketing.

### 8d. Others (brief scan)
- **弘玑 Cyclone** (Shanghai, 2015): most aggressively agent-pivoted (RPA→Hyperautomation 2022→APA "AI行动智能体平台" 2024). Explicit **RAG知识决策平台** + decision agents; **model-agnostic** ("MaaS混合模型底座"). 信创-native, 央国企/finance/gov; implementation-heavy; no proprietary model.
- **云扩 Encoo** (Shanghai, 2017): cleanest **no-code/low-code self-serve + SaaS** profile (Studio/Robot/Console + marketplace + Spark process discovery). AI = DocReader + AI Hub + ViCode; muted agent branding [distinct agent SKU UNVERIFIED]. Most SaaS-friendly billing.
- **金智维 Kingsware:** finance/SOE specialist ("all six state-owned banks + 1300+ clients"). 数字员工 1.0→2.0→3.0(agent) roadmap; K-APA + **Ki-Agent 企业级智能体平台** + AI开放平台. Claims IDC "RPA+AI #1" [vendor self-cited, UNVERIFIED]. Almost certainly on-prem + heavy implementation.
- **艺赛旗 (iS-RPA):** rebranded around 智能体 (iS-Agent + iS-RPA + iS-RPM process mining + iS-CDA); 2025 detail thin [UNVERIFIED].
- **达观 Datagrand:** document-intelligence angle (NLP+OCR+RPA) with its own **"曹植" (Cao Zhi) LLM** + 数字员工; knowledge/document-centric.
- **百应 (Baiying) "AI 超级员工":** markets **private-deployment** "AI super employee" [third-party promo; verify directly].
- **Market landscape:** IDC / 头豹 China RPA & "AI Agent 1Q25" reports are **paywalled** — vendor percentages unverifiable. Multiple vendors self-claim "#1" under different scopes (Kingsware "RPA+AI"; Laiye IDC MarketScape + Gartner MQ; UiPath global ~35.8%). Treat all "#1" claims as scope-dependent [UNVERIFIED].

### Digital-employee segment: delivery/FSE takeaway
This is the segment where **on-site/驻场 implementation is closest to the norm** (inherited from RPA delivery culture) and where **UI-automation + CV grounding (实在's ISSUT, Laiye's Computer Use Agent)** bridges legacy no-API systems. Important nuance: **none of the enterprise players clearly advertise a first-party on-site 驻场/FSE program in primary sources** — heavy implementation is largely delivered through **SI/channel partners (incl. Big Four) and customer Centers-of-Excellence**, with marketplaces as the reusable-asset counterweight. 影刀 is explicitly the LOW-驻场, self-serve outlier ("prefer customers self-build"); 来也/弘玑/金智维 are the implementation-heavy end; 实在 and 云扩 sit in between. **Private deployment is a universal selling point** (data sovereignty, 信创). Role isolation best-documented at **来也** (5 roles + 8-level departments + per-tenant folder scoping) and **实在** (multi-level function + data RBAC). RAG internals are a **universal weak spot** — every vendor offers "upload docs" KB/Q&A but **none publicly discloses a full modern vector/embedding/retrieval architecture** [treat all RAG-internals as UNVERIFIED].

---

## 9. Comparison table

| Product | Positioning | Build model (who) | Skill/plugin mechanism | MCP | Role/permission isolation | Knowledge base (personal vs org) | Deployment | Pricing (public?) |
|---|---|---|---|---|---|---|---|---|
| **腾讯乐享 Lexiang** ★ | Enterprise AI knowledge platform + AI Q&A | Admins config KB; devs wire agents via API/MCP | `SKILL.md` (Anthropic-style) + 240 APIs; MCP-first | **Yes** (lexiangla.com/mcp) | **Strong: 4-tier** (enterprise→team→KB→doc); app-side per-user KB scoping; bot=public-only | Org/team/KB-tiered w/ per-user scoping (iMA = personal) | SaaS + **private deploy** advertised | Free tier; paid **[UNVERIFIED]** |
| **WorkBuddy** (Tencent) | Agentic desktop workstation | Prebuilt skills point-and-use; power users author | MCP ecosystem + Skills marketplace; 100+ experts | **Yes** | Team seat mgmt; **native RBAC thin** (leans on external skills/KBs) | Consumes external KBs (e.g. Lexiang); COS artifacts | Desktop + SaaS; Lighthouse self-host | **Yes**: Pro $9.95–19.9/mo; Team $40/seat/mo |
| **Tencent Cloud ADP** | Enterprise agent dev platform | Low-code (business) + API 3.0 (devs) | Tool/Plugin marketplace; custom MCP tools | **Yes** (SSE/streamableHTTP) | **Strong: workspace isolation + app-side RBAC** via `visitor_biz_id` + external privilege system | **Hybrid: app-default KB + platform-shared KB**; 28+ formats | SaaS + **License on own TKE/VPC** (not air-gapped) | **Yes**: PU model; Free→¥88→¥188→¥4,880 |
| **企业微信 WeCom** | IM + native AI + delivery channel | No-code ("describe in 1 sentence") | Smart Robot + API/MCP plugins + workflows | **Yes** | Inherits WeCom org perms; ADP isolation preserved via API | WeCom-resident data; KB via ADP | SaaS | **[UNVERIFIED]** for AI features |
| **腾讯元器 Yuanqi** | Consumer/creator no-code agents | No-code "捏" (Prompt+Plugin+KB+Workflow) | Plugin marketplace + custom | Partial | **Weak** (creator-oriented, no enterprise role isolation) | Per-creator KB per agent | Public SaaS | Freemium |
| **DingTalk 悟空 Wukong** (Alibaba) ★ | Enterprise AI-native work platform | **No-code** (+New Skill, describe NL) + `SKILL.md`/ZIP upload | Skill Center + toB Skill market; OSS-skill compatible | **Yes** (via DEAP 6,000+) | **Strong: inherits DingTalk perms per-person** ("isolated from human dimension"); sandbox + re-confirm | Long-term personal memory; org RAG via Bailian/DEAP | **Desktop client + DingTalk + sandbox**; private via DEAP | **Yes**: Free/¥39/¥99 per person/mo (grains) |
| **DEAP** (Alibaba) | Enterprise AI control/build backend | Admin-managed | 6,000+ MCP capabilities square | **Yes (huge)** | Seat/quota/skill-visibility mgmt | Enterprise RAG | Private deploy (all-in-one machines) | **[UNVERIFIED]** |
| **阿里云百炼 Bailian** | Developer agent/model builder | Low-code drag-drop + Script; Dify import | Plugin + MCP node + API + AppFlow | **Yes** (MCP node) | Cloud IAM/RAM; per-app | Org/app-scoped KB (ADB-PG vectors) | SaaS + **private/VPC/hybrid** | **Yes**: token-based |
| **飞书 aily** (ByteDance) ★ | In-Feishu enterprise agent platform | Low-code enterprise app builder | Feishu Open Platform apps; Base | Emerging (community) | Inherits **Feishu RBAC** (admin approval); per-agent **[UNVERIFIED]** | Feishu Docs/Wiki/Base substrate + Doubao RAG | Enterprise SaaS in Feishu; on-prem **[UNVERIFIED]** | Bundled **[UNVERIFIED]** |
| **扣子 Coze** (ByteDance) | General no-code agent/Bot builder | No-code/low-code (all users) | Workflow nodes + plugin marketplace | Community/plugins | Enterprise ed. privileges + OAuth scopes; RBAC lighter | Per-bot RAG KB | Cloud + **OSS Coze Studio self-host** (true on-prem) | Free + enterprise ed. |
| **Baidu AgentBuilder / 千帆** | No-code agents (ERNIE) / enterprise MLOps | No-code (AgentBuilder) + dev (Qianfan) | Tools/plugins; workflows | **[UNVERIFIED]** | Baidu Cloud **IAM** role-based | Custom KB (AgentBuilder) + Qianfan RAG | SaaS + **Qianfan private deploy** | Freemium + cloud/quote |
| **Huawei Pangu / Cloud agent** | Industry models + agentic infra | Developer/integrator | Model + agent toolchain; API | **[UNVERIFIED]** | Enterprise IAM; industry KBs **[UNVERIFIED]** | Industry KBs | **On-prem via Huawei Cloud Stack** (strongest true on-prem) | Project/quote |
| **影刀 / Laiye / 实在 / 金智维** (RPA+LLM) | Digital employees (数字员工) | No-code RPA + LLM apps | Flow designer + AI Power; MCP bridges | Emerging | Vendor-specific; often per-bot | RAG KBs (vendor-specific) | Desktop + server + **private deploy** | Seat/bot + **implementation** |

★ = closest references for a merchant/enterprise agent platform.

---

## 10. Synthesis — answers to the three special-attention questions

### (A) Skill / role isolation — how a manager-agent differs from a staff-agent
There are **two dominant patterns**, and they are the most important design lesson:

1. **Inherit the existing enterprise permission system (identity-scoped).** *DingTalk 悟空 Wukong* is the clearest: the agent acts *as the employee* and can only see/do what that person's existing DingTalk permissions allow — "data permissions isolated from the human dimension," with admin approval for org-level data and re-confirmation for sensitive actions. *Feishu aily* similarly inherits Feishu RBAC. *Lexiang* constrains bots to "public" knowledge unless acting as a specific StaffID.

2. **Explicit per-role knowledge scoping at the platform layer.** *Tencent Cloud ADP* is best-in-class: application-side **Role-Based Access Control** (define roles → bind users → union-of-scopes) with the user identity passed as **`visitor_biz_id` on every API call**, so isolation is enforced even through the published API. Plus an **External Privilege System** to delegate per-slice access decisions to the enterprise's own OA system. *Lexiang's* 4-tier model (enterprise→team→KB→document) is the knowledge-storage equivalent.

**Design takeaway for the merchant-agent platform:** support **both** — (a) identity-passthrough so the agent respects the caller's existing permissions, and (b) an explicit role→knowledge-scope binding carried on every retrieval/API call (the `visitor_biz_id` pattern). A manager-agent vs staff-agent should differ by *role binding + identity*, not by cloning separate agents.

### (B) FSE-style deployment (someone goes on-site to build skills)
**None of the big platform vendors (Tencent, Alibaba, ByteDance, Baidu) document an official on-site/驻场 field-engineer program for building agents.** Their explicit strategy is the opposite:
- **Self-serve no-code** authoring (Wukong +New Skill, WeCom "describe in one sentence," Coze, AgentBuilder).
- **Pre-packaged vertical bundles** instead of bespoke on-site builds — Alibaba's **OPT (One-Person Team)** industry suites (skills+workflow+data for 10 industries) is the sharpest example; Tencent ADP quotes fixed build timelines + "dedicated customer success team."
- **Partner / ISV / 服务商 ecosystems** carry the hands-on delivery off-doc.

**Where FSE-style on-site delivery IS the norm:** the **RPA / 数字员工 vendors** (影刀, 来也/Laiye, 实在, 金智维) — inherited from RPA's consulting-heavy delivery culture — and **Huawei**, whose entire enterprise motion is solution-delivery + on-site engineering for regulated/government/industrial clients (compliance-driven private deployments). 

**Takeaway:** an FSE-led "we come on-site and build your skills" model is a **genuine differentiator vs the BAT self-serve platforms**, and is well-precedented in the RPA/Huawei enterprise segment. It fits best where clients have legacy no-API systems, strict data sovereignty, and low internal AI skills — exactly the merchant/enterprise segment. Pair it with a self-serve authoring layer so clients can maintain skills after handoff.

### (C) Knowledge base architecture (personal vs enterprise)
The mature pattern is a **two-tier (hybrid) KB**, verified most clearly in **Tencent Cloud ADP**: each agent app has a **default, app-scoped, non-shareable KB** PLUS optional **platform-level KBs shared across apps** — with **tag/metadata-scoped retrieval** and per-role access. **Lexiang** adds the richest **ingestion** story (102+ formats; one-click import from Confluence/iWiki/Tencent Docs/WeChat/Meeting recordings) and a **4-tier permission isolation** over that knowledge, with DeepSeek-R1 RAG. **Feishu aily** uses Docs/Wiki/Base as the substrate; **Bailian** uses app-scoped KB + shared ADB-PG vector store.

**Design takeaways for the merchant-agent platform:**
- Offer **personal/app-scoped KB + enterprise-shared KB** as distinct tiers, with retrieval scoped by role/tag.
- Invest heavily in **ingestion breadth** (formats + connectors to existing systems) — vendors consistently report **knowledge cold-start is 40–60% of deployment effort** and the #1 failure mode (format fragmentation, chunking, table blindness).
- Enforce **permission at retrieval time** (filter candidate chunks by the caller's role/identity before they reach the model), optionally delegating to the enterprise's own permission system.
- **MCP is now table-stakes**: Lexiang, ADP, WeCom, DingTalk/DEAP, Bailian all expose or consume MCP. An `SKILL.md`/Anthropic-style skill format is emerging as a de-facto standard (Lexiang and Wukong both use it).

---

## 11. Sources (major)

**Tencent 乐享 / WorkBuddy / ADP:**
- Lexiang skill (README, capabilities, 4-tier perms, MCP, DeepSeek-R1 RAG): https://github.com/tencent-lexiang/lexiang-openapi-skill
- Lexiang official: https://lexiang.tencent.com/ ; API docs: https://lexiang.tencent.com/wiki/api/ ; MCP: https://lexiangla.com/mcp
- Lexiang 4-tier permissions / FAQ: https://www.tencentcloud.com/document/product/1250/67449
- App-side user permissions: https://intl.cloud.tencent.com/document/product/1254/72504
- Tencent AI knowledge management: https://completeaitraining.com/news/tencent-integrates-ai-into-knowledge-management-tools-to/
- WorkBuddy: https://www.tencentcloud.com/act/pro/workbuddy ; guide: https://www.tencentcloud.com/techpedia/144100?lang=en
- WorkBuddy/QClaw enterprise split: https://beam.ai/agentic-insights/tencent-launches-qclaw-what-the-ai-agent-mainstream-moment-means-for-enterprise
- ADP how-enterprises-build-agents: https://adp.intl.cloud.tencent.com/en/blog/how-enterprises-build-ai-agents
- ADP publish-to-WeCom: https://www.cloud.tencent.com/document/product/1759/121473 ; MCP: https://www.cloud.tencent.com/document/product/1759/117855 ; pricing: https://www.cloud.tencent.com/document/product/1759/127342
- WeCom 5.0 AI: https://it-consultis.com/insights/wecom-5-0-integrates-ai-china/ ; Yuanqi: https://yuanqi.tencent.com/

**Alibaba DingTalk / Bailian / Qwen:**
- Wukong: https://wukong.dingtalk.com/docs/en/about/ ; privacy/permissions: https://wukong.dingtalk.com/docs/en/quick-start/privacy-and-security/ ; skills: https://wukong.dingtalk.com/docs/en/core-features/skills-center/ ; pricing: https://wukong.dingtalk.com/docs/en/enterprise-membership/faq/
- Wukong AI Management System cert: https://www.aibase.com/news/29204
- Reuters launch: https://www.reuters.com/world/asia-pacific/alibaba-launches-new-ai-agent-platform-enterprises-2026-03-17/
- DEAP / 6000 MCP: https://eu.36kr.com/en/p/3610743632446728
- Bailian workflow/nodes/MCP: https://help.aliyun.com/en/model-studio/workflow-application/ ; DingTalk RAG robot recipe: https://help.aliyun.com/en/model-studio/add-an-ai-assistant-to-your-dingtalk
- 200-agent marketplace / 6 model partners: https://techbullion.com/alibabas-dingtalk-upgrades-ai-and-launched-a-marketplace-of-200-ai-powered-agents ; https://www.kr-asia.com/alibabas-dingtalk-integrates-with-six-ai-partners-unveils-new-ai-search-feature

**ByteDance Feishu / aily / Coze:**
- aily intro: https://toolin.ai/blog/feishu-aily-assistant ; Feishu community: https://www.feishu.cn/community
- Feishu permissions/audit: https://www.feishu.cn/hc/en-US/articles/152388446470 ; file perms: https://www.feishu.cn/hc/en-US/articles/791060103354
- Coze Studio (OSS self-host): https://github.com/coze-dev/coze-studio ; enterprise auth: https://docs.coze.cn/developer_guides_update_authorization
- Coze private deploy guide: https://www.kdjingpai.com/en/jiyu-docker-yubao/
- (Disambiguation: Aily Labs unrelated — https://www.ailylabs.com/)

**Baidu:**
- AgentBuilder / Wenxin: https://moge.ai/en/product/wenxin-agent-platform ; https://navtools.ai/tool/baidu-agentbuilder
- Baidu AI Cloud IAM (role-based perms): https://intl.cloud.baidu.com/en/doc/IAM/s/1jwvyby75-intl-en
- Qianfan enterprise entry: https://cloud.baidu.com/ (千帆) ; AppBuilder docs: https://ai.baidu.com/ai-doc/index/AppBuilder

**Huawei:**
- Huawei Cloud INSPIRE 2026 agentic AI: https://www.huawei.com/en/news/2026/6/inspire-agenticera-agenticinfra
- Pangu industry models / Ascend: https://huawei.com/en/news/2023/9/ascend-aicloud-service
- Pangu on Huawei Cloud Stack (on-prem) API ref: https://support.huawei.com/enterprise/en/doc/EDOC1100371047
- Enterprise AI agent engineering: https://e.huawei.com/mx/blogs/2026/industries/finance/banking-ai-agent-evolution

**RPA / 数字员工:**
- 影刀 YingDao: https://www.yingdao.com/ (ai/, ai-power/, buy/, connector/) ; Automa (intl): https://goautoma.com/enterprise ; MCP server (Apr 2025): https://www.pulsemcp.com/servers/ying-dao-rpa ; community MCP: https://github.com/catinair/aipower-rpa-mcp-server
- 实在智能 Intelligence Indeed: https://en.ai-indeed.com/products/tars (TARS vertical LLM) ; /products/agentRpa (Z-Agent = TARS brain + ISSUT eyes) ; /aboutNews/7414.html (TARS Aug 2023, ISSUT) ; https://www.ai-indeed.com/products/commander (Commander RBAC: function+data perms, audit) ; /products/itai (信创) ; https://rpa-college.ai-indeed.com/doc/691.html (~¥30–50k/yr per digital employee, ~2021)
- 来也 Laiye: https://laiye.com/en/product (WEP/APA/ADP/ACX, MCP, multi-LLM) ; /en/ai-agent (Planning/Memory/Tool-Use) ; /en/product/apa-creator (Magic Hat) ; /en/product/agent-marketplace (= old UB Store) ; https://documents.laiye.com/rpa-commander/en/docs/system/ (5 roles, 8-level depts) ; /en/success-stories/digital-china (partner-led, 20–30 day build) ; /en/about (history, Mindsay 2022)
- Others: 弘玑 https://cyclone-robotics.com ; 云扩 https://encoo.com ; 金智维 http://kingsware.cn/ ; IDC "AI Agent 1Q25" (paywalled) https://www.idc.com/getdoc.jsp?containerId=CHC53057025

---

## Confidence summary
- **High:** Lexiang (from official skill README + docs), WorkBuddy pricing/positioning, ADP architecture/permissions/pricing, Wukong permissions/pricing, Coze OSS self-host; 来也/实在/影刀 architecture + delivery model + role isolation (from official product pages).
- **Medium:** DEAP 6,000-MCP/150-model figures (single-outlet media); WeCom AI feature specifics; Baidu Qianfan/AgentBuilder enterprise details; Huawei on-prem (verified) but agent-specific features (unverified); RPA-vendor pricing (实在's ¥30–50k is a vendor ~2021 indicative figure) and per-role *data* isolation.
- **Low / flagged [UNVERIFIED]:** aily per-agent role isolation & on-prem; 如流 × AgentBuilder integration; TARS param counts/benchmarks; all vendors' explicit first-party FSE/驻场 programs (delivery is partner/CoE-led; directionally inferred, not doc-confirmed); RAG internals (vector store/embedding/chunking) for essentially every vendor; all "#1 market share" claims; most private-deploy pricing.


