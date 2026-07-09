# Open-Source Foundations for an Enterprise Agent Platform

**Research date:** 2026-07-08
**Author:** Technical research analyst
**Scope:** Evaluate open-source projects as a foundation for a general-purpose enterprise agent platform with: connectors into companies' internal systems, per-role "skills", enterprise + personal knowledge bases, strict permission isolation, MCP-native tooling, and an eventual **Windows desktop app with local file read/write**. Backend-first, sold as a **commercial product**.

> **Verification note.** Every license in this report was verified by me directly against the raw `LICENSE` file (via `curl`/GitHub API) on 2026-07-08 — licenses are the decision-critical facts. Star counts and feature claims are cited inline; framework star counts are marked *approx (early 2026)* where the live API rate-limited me. Uncertainty is flagged explicitly. Treat all vendor/enterprise-tier and pricing claims as needing a direct sales confirmation.

---

## 1. Executive summary & recommendation

**No single open-source project delivers the whole stack** (multi-tenant RBAC + permission-filtered RAG + MCP + desktop + commercial-friendly license) out of the box. The market splits cleanly into three tiers, and the **license is the first filter** — it eliminates the most feature-complete platforms before features even matter.

**Recommended primary path — build on a permissive foundation, own the platform layer:**

1. **AnythingLLM (MIT)** — the closest turnkey base to our requirements. It already ships the hard-to-build piece: a **Windows desktop app with local file read/write** (File System Agent), plus MCP client support, workspace-scoped document isolation, and server-side multi-user + RBAC. MIT means we can fork, rebrand, and sell closed-source. We would build the org/tenant hierarchy, fine-grained RBAC, and per-user retrieval filtering on top.

2. **LibreChat (MIT)** — the strongest *permission model* of any turnkey app: every entity (agents, prompts, MCP servers, files, conversations) carries its own ACL with per-user/group/role sharing. MCP-native with per-user context injection, pgvector RAG. Web-first (no desktop), so it's the better base if permission-filtered multi-tenancy matters more than the desktop head-start.

**Recommended framework layer (if we build more of the platform ourselves):**
- **LlamaIndex (MIT)** for the RAG/knowledge layer — metadata-filtered retrieval is the native mechanism for per-user/per-role permission-scoped RAG.
- **LangGraph (MIT)** or **Microsoft Agent Framework (MIT)** for agent orchestration; both have first-class MCP support. MAF is especially relevant given a Windows/.NET desktop target.
- **Goose (Apache 2.0)** as a reference for MCP-native desktop agent architecture (now a Linux Foundation project).

**Avoid as a commercial product base (licensing):**
- **Dify** and **FastGPT** — modified Apache 2.0 that **prohibits operating a multi-tenant environment without a written commercial license** (a per-company agent platform is exactly multi-tenant). Both also lock branding.
- **n8n** — Sustainable Use License restricts use to "internal business purposes"; selling a product substantially derived from n8n requires a commercial license.
- **Open WebUI** — BSD-3 + branding clause: cannot remove "Open WebUI" branding above 50 users without an enterprise license — a white-label product needs a negotiated license.
- **Flowise** — Apache 2.0 core, but the exact enterprise features we need (SSO, RBAC, workspaces) live in a `enterprise/` directory under a **commercial** license.

**Avoid due to missing platform layer (not licensing):** LangChain/LangGraph, LlamaIndex, CrewAI, Autogen/Semantic Kernel, Letta are **libraries** — permissively licensed and excellent, but ship **no** multi-tenancy, RBAC, user management, or permission-filtered KB. They are ingredients, not a base.

---

## 2. Comparison table

Stars/recency as of mid-2026 (verified inline in Section 4). License column reflects **direct LICENSE-file verification**.

| Project | License | Commercial product OK? | Multi-tenant / isolation | RBAC | MCP | Perm-filtered RAG | Desktop (Win + local files) | Stars (approx) |
|---|---|---|---|---|---|---|---|---|
| **AnythingLLM** | **MIT** | **Yes, unrestricted** | Workspaces = real doc isolation; flat (no org layer) | 3 global roles (server only) | Client | Workspace-level only | **Yes — ships it** | ~61k |
| **LibreChat** | **MIT** | **Yes, unrestricted** | User/group; per-entity ACLs | **Granular per-entity ACLs** | Client (+per-user ctx) | Via ACL on files/agents | No (web) | ~30k+ |
| **RAGFlow** | **Apache 2.0** | **Yes, cleanest** | Team + KB governance | Coarse (Owner/Member) | Client + Server | KB/team-level only | No (server) | ~78–84k |
| **Goose** | **Apache 2.0** | Yes | None (single-user) | None | **Native, central** | None built-in | **Yes (desktop app)** | ~50k |
| **Letta** | **Apache 2.0** | Yes | Library/runtime | None | Client | Via memory/archival | No | ~18k* |
| **LangGraph** | **MIT** | Yes (library) | **You build it** | **You build it** | Adapters (client) | You build (metadata) | You build | ~18k* |
| **LangChain** | **MIT** | Yes (library) | You build it | You build it | Adapters | You build | You build | ~110k* |
| **LlamaIndex** | **MIT** | Yes (library) | You build it | You build it | Client/server pkgs | **Yes — metadata filters** | You build | ~40k* |
| **MS Agent Framework** (Autogen+SK) | **MIT** (code) | Yes (library) | You build it | You build it | **Native** | You build | You build (.NET native) | 75k+ combined* |
| **CrewAI** | **MIT** | Yes (library) | You build it | You build it (role-based crews) | Client (adapter) | You build | You build | ~35k* |
| **Dify** | Apache 2.0 **+ restrictions** | **No** (multi-tenant forbidden w/o license) | Workspaces (had cross-tenant CVEs) | Coarse fixed roles | Client + Server | External Knowledge API only | No | ~148k |
| **FastGPT** | Apache 2.0 **+ restrictions** | **Conditional** (branding + SaaS clause) | Team isolation; multi-team = commercial | **Genuine per-resource** (incl. `agentSkill`) | Client + Server | Team-level only | No | ~29k |
| **n8n** | **Sustainable Use License** | **No** (internal use only) | Projects (Enterprise-only) | Mostly Enterprise-gated | Client + Server | No native KB | Deprecated | ~195k |
| **Flowise** | Apache 2.0 core **+ commercial `enterprise/`** | Core yes; **RBAC/SSO/workspaces paywalled** | Enterprise-only | Enterprise-only | Client + Server | Workspace-level | No | ~54k |
| **Open WebUI** | BSD-3 **+ branding clause** | **Conditional** (white-label >50 users needs license) | Single-instance + Groups | **Free + granular** | Client (v0.6.31) + mcpo | **Yes — retrieval-time** | Web shell only | ~145k |

\* Framework star counts are approximate from early-2026 knowledge (live GitHub API rate-limited during research); order-of-magnitude reliable, exact figure not re-verified 2026-07-08.

### Weighted scores for OUR use case

Weights reflect this product: **License 30%** (a bad license is fatal), **Permission isolation/RBAC 20%**, **Perm-filtered RAG 15%**, **MCP 10%**, **Desktop+local-files 10%**, **Skill/tool system 5%**, **Maturity/community 5%**, **Extensibility for custom client 5%**. Scores 1–5; total normalized to 100.

| Project | License (30) | RBAC/Isolation (20) | RAG-perms (15) | MCP (10) | Desktop (10) | Skills (5) | Maturity (5) | Extens. (5) | **Total /100** |
|---|---|---|---|---|---|---|---|---|---|
| **AnythingLLM** | 5 | 3 | 3 | 4 | 5 | 4 | 4 | 4 | **80** |
| **LibreChat** | 5 | 5 | 4 | 4 | 1 | 4 | 4 | 4 | **80** |
| **LlamaIndex + LangGraph** (build) | 5 | 2¹ | 5 | 5 | 2¹ | 4 | 5 | 5 | **77** |
| **RAGFlow** | 5 | 2 | 3 | 4 | 1 | 3 | 4 | 4 | **68** |
| **MS Agent Framework** (build) | 5 | 2¹ | 3¹ | 5 | 3¹ | 4 | 4 | 5 | **72** |
| **Goose** | 4 | 1 | 1 | 5 | 5 | 4 | 4 | 4 | **62** |
| **Open WebUI** | 2 | 4 | 5 | 4 | 2 | 3 | 5 | 3 | **62** |
| **FastGPT** | 2 | 4 | 3 | 4 | 2 | 4 | 4 | 3 | **57** |
| **Flowise** | 2 | 2 | 3 | 4 | 1 | 3 | 4 | 3 | **48** |
| **Dify** | 1 | 3 | 3 | 4 | 1 | 4 | 5 | 3 | **48** |
| **n8n** | 1 | 3 | 1 | 5 | 1 | 3 | 5 | 3 | **42** |

¹ Libraries score low on RBAC/desktop because you build those yourself — the score reflects "provided out of the box," not achievable ceiling. Their high license/RAG/MCP/extensibility scores reflect that they impose *no* ceiling on what you build.

**Read:** AnythingLLM and LibreChat tie at the top for opposite reasons — AnythingLLM for the desktop head-start, LibreChat for the permission model. The build-it-yourself library stack (LlamaIndex + LangGraph/MAF) scores nearly as high because a permissive license plus best-in-class RAG/orchestration removes every ceiling, at the cost of building the platform. The feature-rich turnkey platforms (Dify, n8n, Open WebUI, Flowise) are dragged down almost entirely by **license**.

---

## 3. The licensing landscape (the decisive filter)

For a commercial, multi-tenant, white-labeled product, licenses sort into three buckets:

**Clean permissive (build & sell closed-source freely):**
- **MIT:** AnythingLLM, LibreChat, CrewAI, LlamaIndex, LangChain, LangGraph, Semantic Kernel (and MS Agent Framework code). Autogen is MIT for code + CC-BY-4.0 for docs (verified: `LICENSE-CODE` = MIT, `LICENSE` = CC-BY-4.0).
- **Apache 2.0 (unmodified):** RAGFlow, Goose, Letta. Only obligation is attribution/NOTICE.

**Modified permissive with commercial-gating clauses (a trap for our use case):**
- **Dify** — "modified Apache 2.0" (verified). Verbatim: *you "may not use the Dify source code to operate a multi-tenant environment"* without written authorization, where **one tenant = one workspace**; plus a logo/branding lock when using its frontend. A per-company agent platform is textbook multi-tenant → **needs a commercial license**.
- **FastGPT** — "FastGPT Open Source License" = Apache 2.0 + two conditions (verified): (a) may not operate a **multi-tenant SaaS similar to FastGPT** without written authorization; (b) may not remove/modify the console **LOGO or copyright**. Backend-as-a-service and "delivering to enterprises as a platform" are explicitly *allowed*, but our branding removal trips (b).
- **Flowise** — split license (verified): everything outside `packages/server/src/enterprise/**` is Apache 2.0; the enterprise dir (incl. `IdentityManager.ts` = SSO/RBAC/workspaces) is **Commercial**. You can sell on the core, but **the multi-tenancy/RBAC we need is the paywalled part**.

**Source-available / branding-restricted:**
- **n8n** — Sustainable Use License (fair-code, *not* OSI). Use limited to "internal business purposes"; you may not sell a product/service whose value derives substantially from n8n without a commercial/Embed license, and OEM explicitly won't white-label. **Disqualified as a product base.**
- **Open WebUI** — BSD-3 + a **branding clause** (verified verbatim): you may not alter/remove "Open WebUI" branding *except* (i) ≤50 end users per rolling 30 days, (ii) written permission, or (iii) an enterprise license. A rebranded >50-user product = **mandatory enterprise-license negotiation**.

---

## 4. Detailed findings by category

### 4A. Turnkey LLM/RAG platforms with commercial-gating licenses

#### Dify (`langgenius/dify`) — ~148k stars
- **License:** modified Apache 2.0; **multi-tenant operation forbidden without written license**; frontend branding lock. Verdict: **not viable** for a multi-tenant commercial agent platform. Building your own frontend sidesteps *only* the branding clause, not the multi-tenant clause.
- **Maturity:** most polished agent/workflow builder here; 1M+ apps claimed; Series Pre-A ~$30M at ~$180M (Mar 2026). v1.15.0 stable, 2.0 in beta (GA date unconfirmed); Enterprise on separate 3.x versioning.
- **Multi-tenancy/RBAC:** workspace-as-tenant, shared-DB row scoping; fixed roles (Owner/Admin/Editor/Member), no custom roles in OSS. **Caveat:** the June 2026 "DifyTap" disclosure (CVE-2026-41947/41948) was a *cross-tenant* message-exfiltration + path-traversal class of bug, patched v1.14 — a red flag for a product selling isolation.
- **MCP:** both client and server, bidirectional, since **v1.6.0 (~Jul 2025)**; HTTP transport only.
- **RAG/perms:** strong retrieval (parent-child chunking, hybrid + rerank, metadata filtering v1.1). **No native per-user/per-role retrieval filtering** — KB access is coarse (Only me / All team / Partial team) and governs management, not query-time retrieval. Per-user isolation only via the **External Knowledge API** (you host retrieval + enforce ACLs).
- **Skills/tools:** redesigned plugin system + marketplace; **scoped per workspace, not per role**; code execution isolated via DifySandbox.

#### FastGPT (`labring/FastGPT`) — ~29k stars
- **License:** Apache 2.0 + (a) no multi-tenant SaaS similar to FastGPT w/o license, (b) no branding removal. Verdict: **conditional** — a branded product trips the LOGO clause → commercial conversation with Sealos (China-based). Contact: dennis@sealos.io.
- **RBAC — standout:** genuine **per-resource** permissions (read/write/manage/owner) over resources `{team, app, dataset, model, agentSkill}`, with members/departments/groups and a Linux-style permission bitmask. **`agentSkill` is a first-class permissioned resource** — directly maps to our "per-role skills" requirement. (Verified from `packages/global/support/permission/` per prior research.)
- **Multi-tenancy:** real `teamId` data isolation in vector queries; **but OSS is effectively single-team** — full multi-team management + billing is the Commercial Edition (`fastgpt-pro`, private). A cross-team IDOR (CVE-2026-40252) is on record, fixed v4.14.10.4.
- **MCP:** both (MCP Server ≥ v4.9.6, MCP Client in workflows), ~mid-2025, hardened since.
- **RAG/perms:** vector/full-text/hybrid + rerank; **query filtered by `teamId` + `datasetIds`, NO per-user (`tmbId`) filter** — team-level isolation only. Per-user ACLs via custom API dataset or retrieval proxy.
- **Tools:** separate `fastgpt-plugin` repo + marketplace; strong sandboxing (`code-sandbox` + K8s-operator `opensandbox` with CRDs). Latest v4.15.1 (Jul 2026), weekly releases.

#### RAGFlow (`infiniflow/ragflow`) — ~78–84k stars
- **License:** **standard, unmodified Apache 2.0** (verified — no Commons Clause, no multi-tenant clause, no branding rider). **Cleanest license of any turnkey platform here.** Sell closed-source freely; only preserve notices and don't use the "RAGFlow" trademark.
- **RAG — best-in-class:** DeepDoc layout-aware parsing (tables, scanned PDFs/OCR, multi-column), template chunking, hybrid retrieval by default, GraphRAG + RAPTOR, chunk-level citations. If RAG *quality* is the priority, this is the strongest engine in the field.
- **Perms:** coarsest RBAC here — Owner vs Member + binary Only-me/Team per resource. **No per-user/per-document retrieval ACL** — retrieval scope = which KBs are bound to an assistant. v0.24 added KB governance + agent memory; v0.20 added the agentic-workflow foundation.
- **MCP:** both — MCP **Server** (~v0.18, exposes datasets as tools) and MCP **Client** (agents call external servers).
- **Maturity/caveats:** still **pre-1.0** (v0.26.x), heaviest footprint (16 GB+ RAM; ES/Infinity + MySQL + Redis + MinIO), API being rewritten in Go for scale. A post-auth RCE was reported ~2026 (verify patch vs your version). No first-party desktop; backed by InfiniFlow (Shanghai; Sinovation Ventures among investors).
- **Fit:** best used as the **RAG/knowledge subsystem** behind our own platform, not the whole platform.

### 4B. Workflow / chat-UI platforms

#### n8n (`n8n-io/n8n`) — ~195k stars
- **License:** Sustainable Use License (fair-code). **Internal-use-only; a product substantially derived from n8n needs a commercial/Embed license, and OEM won't white-label.** Verdict: **not a product base.** Best treated as an internal automation tool.
- Strong self-host, ~700 releases, very active; $180M Series C at $2.5B (~Oct 2025).
- **MCP:** both directions + instance-level (client + server trigger nodes, ~Apr 2025) — genuine strength.
- **Multi-tenancy/RBAC:** Projects (Enterprise-only; vars/tags still global); nearly all real RBAC + SSO is Enterprise-gated.
- **Tools:** community/custom nodes are npm packages with **full host access, not sandboxed**. No native KB (assemble vector-store nodes; no per-user retrieval filtering). Desktop app deprecated/archived Aug 2025.

#### Flowise (`FlowiseAI/Flowise`) — ~54k stars
- **License:** Apache 2.0 core + `enterprise/**` under Commercial (verified). Sell on the core, but **SSO, RBAC, workspaces = the paywalled `enterprise/` dir** — i.e., the platform features we need aren't in the free tier. Acquired by **Workday (Aug 2025)** — roadmap/licensing now under Workday (strategic risk).
- **MCP:** both (client via `CustomMCP` node ~Mar 2025; server ~Apr 2026) — in the Apache tier.
- **RBAC:** granular per-action-type per resource, but **whole system is enterprise-gated**; per-action, not per-instance. Multi-tenancy plumbing exists but OSS is hard-locked to one org/workspace.
- **RAG:** Document Store → vector DB; workspace scoping; **no per-user retrieval filtering**. No desktop app.

#### AnythingLLM (`Mintplex-Labs/anything-llm`) — ~61k stars
- **License:** **stock MIT** (verified — standard, unmodified; grants use/modify/**sell**). **Unrestricted commercial use**; keep the notice, rebrand freely, keep mods proprietary. Audit sub-modules (e.g., `open-computer` ships a different license) and transitive deps before shipping.
- **Desktop — KEY DIFFERENTIATOR:** ships a **Windows/macOS/Linux desktop app** with a **File System Agent** doing allow-listed **local file read/write**, custom skills making OS-level calls, and MCP working. This is the single hardest requirement, **substantially already built** — as a **single-user** app (multi-user/RBAC are Docker-only).
- **Multi-tenancy:** Workspaces = **real** isolation (own documents + own vector namespace, verified in prior research). **But flat** — no org/tenant layer above workspaces; multi-user mode is irreversible. A **cross-workspace auth-bypass bug was fixed PR #5784 (2026-07-07)** — isolation is still maturing.
- **RBAC:** exactly 3 global roles (admin/manager/default) — **coarse, global, not per-resource**; free (MIT) but gated behind Docker multi-user mode.
- **MCP:** **client only** (`MCPHypervisor`, each server → `@@mcp_{name}` tool; stdio/sse/streamable). **Config is a single instance-global JSON — not per-workspace/role.** Added v1.8.0 (Apr 2025). Works in Docker + Desktop.
- **RAG/perms:** default LanceDB (+ PGVector/Chroma/Milvus/Pinecone/Qdrant/Weaviate/etc.); **workspace scopes documents (physically separate namespaces)** but **no per-user filtering within a workspace** — the workspace IS the boundary. Model personal-vs-enterprise KBs as workspaces + membership.
- **Fit:** best turnkey **starting point** — MIT + desktop + local files + MCP; we'd add the org/tenant hierarchy, fine-grained RBAC, per-role skill scoping, and per-user RAG filtering, and harden isolation.

#### Open WebUI (`open-webui/open-webui`) — ~145k stars
- **License:** BSD-3 + **branding clause** (verified verbatim). Sellable, but a rebranded **>50-user** product **requires an enterprise license** (non-public, quote-based). Verdict: **conditional** — a hard, un-costable commercial dependency for white-label.
- **RBAC — genuine strength (and free):** 3 roles + **group-based additive permissions**; **per-resource ACLs are real** — Models, Prompts, Knowledge, Tools each Private / group / user-shared. LDAP/OAuth/SSO + SCIM 2.0 in the OSS distribution.
- **RAG — strongest fit:** built-in Knowledge collections; **permission-filtered retrieval enforced at the retrieval layer** — knowledge tools *silently exclude files the user can't read*. **Personal vs enterprise KBs separable via ACL.** (App-layer filtering over a shared vector store, not per-tenant vector isolation.)
- **MCP:** native client v0.6.31 (**Streamable HTTP only, admin-only** — runs in the connecting user's full scope), + **mcpo** proxy bridges stdio/SSE as OpenAPI.
- **Caveats:** no true multi-tenancy (single-instance + Groups). **Tools/Functions/Pipelines are UNSANDBOXED in-process Python** (docs equate Tool-creation to "shell access"; CVE-2026-0765 by design). No native local-file desktop (web shell/PWA only). Small core team + broad CLA + two 2025 relicensings = key-person/relicensing risk.
- **Fit:** the reference implementation for **permission-filtered RAG + RBAC**, but the branding license and lack of desktop/local-files hurt for our exact product.

### 4C. MCP-native agent runtimes & desktop agents

#### Goose (`aaif-goose/goose`, formerly `block/goose`) — ~50k stars
- **License:** **Apache 2.0** (verified). Commercial use fine. **Governance win:** moved from Block to the **Agentic AI Foundation (AAIF) under the Linux Foundation** (~Apr 2026) — vendor-neutral, alongside MCP itself and the AGENTS.md standard.
- **MCP:** **native and central** — extensions *are* MCP servers; 30+ LLM providers. This is the cleanest MCP-first architecture of any candidate.
- **Desktop — strong:** real **Goose Desktop** app + CLI; local-first (can run fully local on Ollama); local file read/write is the point. Windows supported.
- **Gaps:** **single-user** — no multi-tenancy, no RBAC, no built-in permission-filtered RAG. It's an *agent runtime*, not a platform.
- **Fit:** best **architectural reference** (and possible embeddable engine) for the MCP-native desktop agent core; the enterprise platform layer is entirely ours to build.

#### Letta (`letta-ai/letta`, formerly MemGPT) — ~18k stars*
- **License:** **Apache 2.0** (verified). Commercial use fine.
- **Focus:** stateful agents with OS-inspired tiered **memory** (MemGPT lineage); self-hostable, local mode, MCP-compatible. Free tier (≤3 agents) / Pro $20/mo / Enterprise.
- **Gaps:** memory-first runtime, **not** a multi-tenant/RBAC platform; no turnkey permission-filtered enterprise RAG. Relevant if long-lived agent memory becomes a core differentiator.

#### LibreChat (`danny-avila/LibreChat`) — ~30k+ stars
- **License:** **MIT** (verified). **Unrestricted commercial use.**
- **RBAC — best-in-class among turnkey apps:** every shareable entity (agents, prompts, **MCP servers**, files, conversations) has its own **ACL**; each feature independently enabled/restricted **per user, group, role, or public**. This is the closest turnkey match to "strict permission isolation + per-role skills."
- **MCP:** configured in `librechat.yaml`; supports **per-user context injection** (`X-User-ID: {{LIBRECHAT_USER_ID}}`) — meaning MCP tools can act with the calling user's identity/permissions. Strong fit for per-role tool scoping.
- **RAG:** separate FastAPI **RAG API** service (PostgreSQL + **pgvector**); file retrieval augmentation, ACL-governed via file/agent permissions.
- **2026 roadmap (Feb 2026):** GUI Admin Panel, **Agent Skills**, Programmatic Tool Calling, interactive workflows.
- **Gaps:** **no desktop app** (web-first) — the Windows/local-files requirement is net-new. Some permission fields are being migrated (deprecated interface side-effect fields seeding role perms).
- **Fit:** the strongest base if **permission model** outranks the desktop head-start; pair with a separate desktop client (or Goose-style agent) later.

### 4D. Frameworks / libraries (permissive, but no platform layer)

These are **ingredients**, not bases. All permissively licensed; **none** ships multi-tenancy, RBAC, user management, or permission-filtered KB — you build the entire platform layer. Their value is imposing **no ceiling** on what you build.

#### LangChain / LangGraph (`langchain-ai/*`) — LangChain ~110k*, LangGraph ~18k*
- **License:** **MIT** (both verified). Commercial-friendly.
- **Layer:** LangGraph = durable, stateful agent orchestration (graphs, checkpointing, human-in-the-loop) — the strongest general orchestration substrate. LangChain = integrations/abstractions.
- **MCP:** first-class via **`langchain-mcp-adapters`** (stdio + Streamable HTTP + SSE; `MultiServerMCPClient`; custom auth headers). LangGraph Platform can also expose an MCP endpoint.
- **Commercial layer:** LangGraph Platform / LangSmith are the hosted/observability upsell — the OSS libs stand alone.
- **Fit:** the orchestration engine if we build the platform ourselves (Python/JS).

#### LlamaIndex (`run-llama/llama_index`) — ~40k*
- **License:** **MIT** (verified). Commercial-friendly.
- **RAG — the reason to use it:** the strongest OSS RAG data framework. **Metadata filtering is native**, and the documented multi-tenancy pattern embeds a user/tenant id into document metadata at indexing time, then filters at query time → **this is the mechanism for per-user/per-role permission-scoped retrieval** that the turnkey platforms lack. LlamaCloud/LlamaParse are the commercial upsell.
- **Fit:** our **knowledge/RAG layer** — the cleanest path to permission-filtered retrieval done right.

#### Microsoft Agent Framework (MAF) — Autogen + Semantic Kernel merged
- **License:** **MIT** for code (verified: Autogen `LICENSE-CODE` = MIT, Semantic Kernel = MIT).
- **2026 development:** **MAF 1.0 GA'd ~Apr 2026**, the official successor merging Autogen (multi-agent orchestration) + Semantic Kernel (type-safe **skills/plugins**, threads, filters, telemetry). Unified SDK for **.NET and Python**; MCP supported; BUILD 2026 added Agent Harness, Hosted Agents, CodeAct.
- **Fit — notably strong for a Windows target:** SK's "plugins/skills" model maps directly to our per-role skills concept, and **.NET-native** orchestration is a natural fit for a Windows desktop client. Best framework choice if we go .NET.

#### CrewAI (`crewAIInc/crewAI`) — ~35k*
- **License:** **MIT** (verified). Commercial-friendly.
- **Layer:** role-based multi-agent "crews" (agent = role + goal + backstory) — conceptually aligned with per-role agents. MCP via adapter (`MCP Servers as Tools`, docs v1.15) + an enterprise-mcp-server for deployment control. `crewAI-tools`/`crewAI-examples` repos recently archived (consolidation).
- **Fit:** an orchestration option, but LangGraph/MAF are more general for durable stateful production workflows; no platform layer.

---

## 5. Deep dive: the 5 strongest candidates for THIS use case

### 5.1 AnythingLLM — best turnkey starting point
- **License:** MIT — build/sell closed-source, rebrand, keep mods private. Cleanest possible.
- **Multi-tenancy & RBAC OOTB:** workspaces give real per-workspace document + vector isolation, but the model is **flat** (no org above workspace) and RBAC is 3 coarse global roles (Docker-only). **We build:** org/tenant hierarchy, fine-grained/per-resource RBAC, per-workspace roles.
- **Skills/tools & isolation:** built-in + custom Node.js skills + no-code agent builder + MCP tools. **Not sandboxed** (run with server privileges) and **enabled per-workspace but not isolated per role/tenant**. "Open Computer" (per-agent QEMU VM) is WIP + separately licensed. **We build:** per-role skill scoping and sandboxing.
- **MCP:** client only, **instance-global config** — we'd rework to per-tenant/role MCP scoping.
- **KB/RAG & permission filtering:** workspace-scoped only; **we build** per-user filtering within a shared KB (or model personal-vs-enterprise KBs as workspaces).
- **Desktop client:** ✅ already ships Windows desktop + local file R/W (File System Agent, allow-listed) — the biggest head-start. Single-user today; multi-user story is Docker-only, so the desktop↔server auth/identity bridge is **net-new**.
- **Production readiness:** mature, active (v1.15, pushes daily), but the just-fixed cross-workspace bug (PR #5784) means **isolation must be independently hardened/audited** before selling on "strict isolation."

### 5.2 LibreChat — best permission model
- **License:** MIT — unrestricted.
- **Multi-tenancy & RBAC OOTB:** the **strongest turnkey permission system** — per-entity ACLs (agents, prompts, MCP servers, files, conversations) with per-user/group/role/public sharing. Closest thing to "strict permission isolation" available for free.
- **Skills/tools & isolation:** agents + MCP servers are ACL-governed entities; **per-user MCP context injection** lets tools run scoped to the caller's identity — a genuine per-role-skill primitive. 2026 roadmap adds first-class Agent Skills.
- **MCP:** native, `librechat.yaml`, per-user context.
- **KB/RAG & permission filtering:** pgvector RAG API; retrieval augmentation governed by file/agent ACLs (stronger than AnythingLLM's workspace-only model, though not as retrieval-layer-native as Open WebUI).
- **Desktop client:** ❌ none — **net-new** Windows/local-files work. This is its one big gap for us.
- **Production readiness:** mature, active, secure multi-user auth is a core selling point.

### 5.3 LlamaIndex + LangGraph (or MAF) — best "build it right" foundation
- **License:** all MIT — no ceiling.
- **What you get:** LlamaIndex = permission-filterable RAG via metadata filters (the correct mechanism for per-user/role retrieval); LangGraph/MAF = durable multi-agent orchestration with native MCP.
- **What you build:** *everything else* — user/tenant management, RBAC, KB governance, connectors, the desktop client. Highest effort, highest control, zero licensing/branding constraints, no cross-tenant CVE inherited from someone else's isolation code.
- **When to choose:** if "strict permission isolation" is the core product promise, owning the isolation layer end-to-end (rather than inheriting and patching a turnkey app's) is the lower-risk long-term path. MAF specifically if the team is .NET/Windows-oriented (SK skills model + .NET-native desktop).

### 5.4 RAGFlow — best RAG engine, as a subsystem
- **License:** clean Apache 2.0. Use it as the **knowledge/parsing/retrieval microservice** behind our platform (DeepDoc parsing is the differentiator), and enforce permissions in *our* layer above it. Don't adopt it as the whole platform (coarse RBAC, pre-1.0, heavy).

### 5.5 Goose — best MCP-native desktop reference / embeddable core
- **License:** Apache 2.0, now Linux Foundation-governed (neutral, low abandonment risk). MCP-native desktop with local files — architecturally exactly our agent core, but **single-user with no platform layer**. Use as reference architecture or an embeddable engine; build tenancy/RBAC/RAG around it.

---

## 6. Recommended architecture (synthesis)

Because no project is a complete fit, the pragmatic build is a **permissive turnkey base + owned platform layer + best-of-breed subsystems**:

- **Base / desktop client:** Fork **AnythingLLM (MIT)** to inherit the Windows desktop + local-file-R/W + MCP client, *or* pair **LibreChat (MIT)** (for its ACL model) with a new desktop client. Decision hinges on: *is the desktop head-start (AnythingLLM) or the permission model (LibreChat) more expensive to build ourselves?* — for a product whose promise is **strict isolation**, LibreChat's ACL foundation is the harder thing to replicate, tilting toward LibreChat + custom desktop; if time-to-desktop dominates, AnythingLLM.
- **RAG / knowledge layer:** **LlamaIndex (MIT)** for metadata-filtered, per-user/per-role permission-scoped retrieval; optionally **RAGFlow (Apache 2.0)** as the document-parsing/ingestion subsystem for hard documents.
- **Agent orchestration:** **LangGraph (MIT)** (Python/JS) or **Microsoft Agent Framework (MIT)** (.NET/Windows-native, SK skills model) — both MCP-native.
- **MCP:** central to the tool/skill/connector model regardless of base. Now a Linux-Foundation-governed standard — safe to bet on.
- **What we must build ourselves on any base:** org/tenant hierarchy, fine-grained per-resource RBAC, **per-role skill scoping + sandboxing** (universal gap — every candidate runs tools with server privileges), and **per-user permission-filtered retrieval** (only Open WebUI does this natively, and its license is the problem).

### Security note
Two things recur across the field and must be owned by us: (1) **tool/skill sandboxing** — no candidate isolates plugin/tool code per role/tenant; treat every inherited tool system as "shell access" until we sandbox it; (2) **cross-tenant isolation bugs** — Dify, FastGPT, and AnythingLLM all shipped cross-tenant/cross-workspace vulnerabilities patched in 2026. Any inherited isolation layer needs an independent security audit before we sell "strict permission isolation."

---

## 7. Honest uncertainty / caveats
- **Verified directly (2026-07-08):** all 16 licenses (raw LICENSE files/GitHub API).
- **From subagent research (primary-sourced, high confidence):** feature/RBAC/MCP/RAG internals for Dify, FastGPT, RAGFlow, n8n, Flowise, AnythingLLM, Open WebUI, incl. the cross-tenant CVEs and the AnythingLLM PR #5784 fix.
- **From my paced searches (good confidence, 2026-dated sources):** Goose→Linux Foundation move, MAF 1.0 GA, LibreChat ACL/MCP/roadmap, LlamaIndex metadata-filter multi-tenancy pattern, LangGraph MCP adapters.
- **Approximate / unverified:** framework star counts (live GitHub API rate-limited — order-of-magnitude only); Dify 2.0 GA date; RAGFlow enterprise feature matrix and k8s support; exact CVE patch levels (verify against NVD/GHSA for your pinned version); all vendor pricing/OEM figures (need direct sales confirmation); enterprise-tier feature boundaries for Open WebUI and Flowise.
- **Legal note:** license *interpretation* for a specific commercial scenario (especially the Dify/FastGPT "multi-tenant" definitions and Open WebUI's branding thresholds) should be confirmed with counsel and/or the vendor before committing — this report identifies the clauses, not a legal opinion.





