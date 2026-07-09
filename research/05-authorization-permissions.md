# Permission Isolation for a Multi-Tenant Enterprise AI Agent Platform

**Research date:** 2026-07-08
**Scope:** Authorization models, authz engines, AI-agent-specific authorization, multi-tenancy isolation, audit/compliance.
**Confidence note:** This space is moving very fast (2025-2026). Vendor blogs dominate the literature and are biased toward their own products; I flag this where relevant. Model/API details from primary docs (OpenFGA, Auth0, OWASP) are more reliable than vendor comparison pages.

---

## Table of Contents
1. Authorization Models: RBAC vs ABAC vs ReBAC (+ Zanzibar)
2. Authorization Engines Compared (OpenFGA, SpiceDB, Cerbos, Oso, Casbin, Ory Keto, +)
3. Authorization for AI Agents
4. Multi-Tenancy Isolation Patterns
5. Audit Logging & Compliance
6. Recommended Architecture for Our Platform

## 0. TL;DR Recommendation

For a multi-tenant platform where an agent's capabilities and data access must differ by user role across many tenant companies, use a **layered authorization architecture**:

- **Model:** ReBAC as the core (Zanzibar-style relationship graph) for fine-grained, per-resource, tenant-scoped decisions, complemented by **RBAC as a coarse guardrail** and **ABAC/conditions** for contextual rules (time, region, risk). No single model survives production alone.
- **Engine:** **OpenFGA** (CNCF, Apache-2.0, Zanzibar-based) as the primary fine-grained decision point. It is the same engine behind Auth0 FGA, has first-party RAG-authorization and agent-authorization guidance, and self-hosts cleanly. Consider **SpiceDB** if you need strict Zanzibar consistency (New-Enemy protection) and can absorb the operational cost. Consider **Cerbos** as a stateless PDP for pure attribute/policy checks if relationships are shallow.
- **Identity propagation:** OAuth 2.0 Token Exchange (RFC 8693) with **delegation** (`actor`/`act` claim) so the agent acts on-behalf-of the user with an audience-scoped, short-lived, attenuated token. Never hand agents standing broad credentials.
- **Tool-level authz:** Every tool/skill invocation triggers a real-time FGA check; enforce **intersection of user ∩ agent permissions** so an agent can never exceed the delegating user.
- **Data-level authz:** ACL-filtered RAG — sync source ACLs into the authz graph, filter retrieval with `ListObjects` (pre-filter) or `BatchCheck` (post-filter) so the LLM only ever sees authorized chunks.
- **Multi-tenancy:** Shared authz store with tenant boundaries modeled in the graph; reserve store-per-tenant / silo for strict-compliance tenants.
- **Audit:** Tamper-evident, replayable trail capturing input, reasoning step, tool call, authorizing identity, and output for every agent action.

---

## 1. Authorization Models: RBAC vs ABAC vs ReBAC

### 1.1 The three models

**RBAC (Role-Based Access Control).** Permissions attach to roles; users get roles. Simple to reason about, great for governance and coarse guardrails ("staff" vs "manager" vs "admin"). Breaks down at scale: *role explosion* once you go past a handful of roles, and it cannot cleanly express context or relationships (e.g., "editor of *this specific* document" or "manager of *this specific* team"). Most sources agree RBAC remains useful as a baseline layer but is "no longer enough" on its own for modern SaaS/AI workloads.

**ABAC (Attribute-Based Access Control).** Decisions evaluate attributes of subject, resource, action, and environment ("role = engineer AND region = EU AND time < 18:00"). Handles arbitrary/dynamic policy logic and context, but pushes policy authoring into languages like XACML, Rego, or CEL, adding real authoring/debugging complexity. Excellent for contextual/risk-based rules.

**ReBAC (Relationship-Based Access Control).** Popularized by Google's Zanzibar paper. Models permissions as a graph of relationships between entities: `user:anne` is `editor` of `doc:1`, which is in `folder:x`, shared with `team:eng`. Decisions traverse that graph. Scales to billions of objects, and naturally expresses ownership, hierarchy, group membership, sharing chains, and delegation — exactly the primitives a multi-tenant, resource-level, collaborative platform needs.

### 1.2 The consensus: blend, don't pick one

A recurring theme across the literature: teams typically start with RBAC in app code, then blend RBAC + ABAC + ReBAC as requirements grow. "Pure single-model approaches rarely survive contact with production." Modern engines increasingly blur the line — SpiceDB added **Caveats** (CEL conditions) to bolt ABAC onto ReBAC; Cerbos supports RBAC/ABAC/ReBAC-via-attributes in one policy language. WorkOS frames the practical formula as **"FGA = RBAC + hierarchy"**: apply roles to nodes in a resource graph so access inherits *downward* (vertical) but never leaks *sideways or upward* ("no lateral movement").

### 1.3 Which fits a multi-tenant enterprise agent platform

For our use case (agent capability + data access differ by role, per-resource, across many tenants):
- **ReBAC is the right core.** Tenant isolation, per-resource grants, team/org hierarchy, and delegation are all relationship problems. ReBAC expresses "user X in tenant T can view resource R" natively.
- **RBAC as the coarse guardrail.** "Is this a manager-agent or staff-agent?" is a role question and maps to which tool set and which top-level scopes are even eligible.
- **ABAC/conditions for context.** Time-of-day, geo/residency, request risk, "only during an approved session" — layer these as conditions (OpenFGA conditions / SpiceDB caveats / Cerbos CEL).

### 1.4 Google Zanzibar (the foundation of ReBAC)

Zanzibar is Google's centralized authorization system powering Gmail, Drive, YouTube, Maps, Calendar, Cloud, Photos. It answers "can user U do action A on object O?" in **tens of milliseconds at billion-tuple scale**. Core ideas we should adopt:

- **Relationship tuples** of the form `(object, relation, user)` — e.g., `(doc:1, viewer, user:anne)`.
- **A schema / userset-rewrite language** that composes relations into permissions (e.g., `viewer` of a doc = direct viewers ∪ `viewer` of its parent folder).
- **Consistency tokens ("zookies")** — snapshot tokens that let you request a "new-enough" read, protecting against the **"New Enemy" problem** (stale ACLs letting a just-removed user still see data, or a newly-restricted doc leaking under an old snapshot).

Zanzibar is often described as extending both RBAC and ABAC by factoring entity relationships into decisions. It is the direct ancestor of SpiceDB, OpenFGA, Permify, Warrant, and Topaz.

**Sources:**
- Choosing an Authorization Model (CIAM Compass): https://guptadeepak.com/ciam-compass/guides/rbac-vs-abac-vs-rebac/
- Permit.io — RBAC vs ABAC vs ReBAC: https://www.permit.io/blog/rbac-vs-abac-and-rebac-choosing-the-right-authorization-model
- Auth0 — authorization model for multi-tenant SaaS: https://auth0.com/blog/how-to-choose-the-right-authorization-model-for-your-multi-tenant-saas-application
- Oso — best access policy paradigm: https://www.osohq.com/learn/rbac-vs-abac-vs-rebac-what-is-the-best-access-policy-paradigm
- Permit.io — RBAC vs ReBAC for AI agents: https://www.permit.io/blog/rbac-vs-rebac-for-ai-agents
- Zanzibar explained (CIAM Compass): https://guptadeepak.com/ciam-compass/guides/zanzibar-explained/
- AuthZed — intro to Google Zanzibar: https://authzed.com/learn/google-zanzibar
- WorkOS — What is Google Zanzibar: https://workos.com/guide/google-zanzibar
- Annotated Zanzibar paper: https://zanzibar.tech/
- Wikipedia — Google Zanzibar / ReBAC: https://en.wikipedia.org/wiki/Google_Zanzibar

---

## 2. Authorization Engines Compared

The tools split into two camps by underlying model — the most important distinction when choosing:
- **ReBAC / graph-based (Zanzibar family):** OpenFGA, SpiceDB, Permify, Ory Keto, Warrant, Topaz. Store relationships as tuples in a dedicated datastore; answer by graph traversal.
- **Policy-as-code / attribute-based:** Cerbos, Oso, Casbin, OPA, AWS Cedar. Evaluate policies against attributes supplied at request time; typically stateless (you bring the data).

### 2.1 Comparison table

| Engine | Model | License | Self-host | Consistency / datastore | Scale & latency | Best fit | Watch-outs |
|---|---|---|---|---|---|---|---|
| **OpenFGA** (CNCF; basis of Auth0 FGA) | ReBAC (Zanzibar) + Conditions (ABAC) | Apache-2.0 | Yes, first-class; single binary + Postgres/MySQL | Tuple store; conditions/contextual tuples at query time | Sub-50ms typical; Zanzibar-derived; horizontal scale | Fine-grained, multi-tenant, per-resource; RAG + agent authz (first-party docs) | Consistency model less strict than SpiceDB; verify staleness tolerance |
| **SpiceDB** (AuthZed) | ReBAC (Zanzibar) + Caveats (CEL/ABAC) | Apache-2.0 | Yes; best on Kubernetes; Cloud/Dedicated too | Full Zanzibar: ZedTokens (zookies), New-Enemy protection; prefers Spanner/CockroachDB w/ serializable isolation | "Google-scale," billions of objects; per-request tunable consistency | Strictest consistency needs; deep nested hierarchies at large scale | Highest operational complexity; steep learning curve; dual-write burden |
| **Cerbos** | Policy-as-code (RBAC/ABAC/PBAC; ReBAC via attributes) | Apache-2.0 (PDP); optional Cerbos Hub | Yes; stateless sidecar, **no DB**, air-gap friendly | Stateless — caller supplies context each request | Sub-ms decisions, thousands/sec/instance, in-memory | Attribute/policy-driven decisions; high-security/air-gapped; simple reviewable YAML policies | No central relationship graph → deep ReBAC/sharing chains awkward |
| **Oso (Oso Cloud)** | Unified RBAC/ReBAC/ABAC via **Polar** DSL | OSS library; richest features in paid Oso Cloud | Library embeddable; strongest features are managed cloud | Can query data from your app DBs (avoids syncing tuples) | Oso Cloud targets single-digit-ms; data-filtering returns SQL `WHERE` (great for list endpoints) | Teams wanting one DSL; authorizing list/index endpoints without N+1 | Polar (logic programming) is novel; policy couples to DB schema; best features are commercial |
| **Casbin** | Pluggable (RBAC/ABAC/ACL) via PERM meta-model | Apache-2.0 | Library, embedded in-process (many languages) | In-process; you provide adapter/storage | Very fast (in-proc); no network hop | Embedding authz directly in a service; simple RBAC/ABAC; polyglot | Library not a service; no built-in central graph/consistency; you build the platform around it |
| **Ory Keto** | ReBAC (Zanzibar) | Apache-2.0 | Yes; part of Ory stack | Tuple store (Zanzibar-style) | Zanzibar-derived | Teams already on Ory (Kratos/Hydra) wanting OSS ReBAC | Smaller ecosystem/community momentum vs OpenFGA/SpiceDB |
| **Permit.io** | Policy-as-code over OPA/Rego + Cedar; no-code UI | Core engines open (+ OSS OPAL) | SaaS control plane + self-hosted Edge PDP (sidecar) | Local PDPs; OPAL pushes live policy/data | Local PDP low latency | Startups wanting fast fine-grained authz + UI on a budget | Many moving parts; MAU-based billing hard to predict |
| **PlainID** | PBAC (ABAC/XACML lineage) | Commercial (no OSS) | Enterprise PDP/PAP/PIP platform | Real-time across heterogeneous estate | Enterprise-grade | Large enterprises governing apps/APIs/data + **AI/agent pipelines (LangChain integration)** | Sales-led, heavy footprint; weaker for relationship-graph authz |
| **AWS Verified Permissions** | PBAC via **Cedar** | Managed (Cedar lang is OSS) | Managed AWS service | Per-tenant or shared policy store options | AWS-scale | AWS-native shops; per-tenant policy stores for isolation | AWS lock-in; Cedar ReBAC less mature than Zanzibar engines |

### 2.2 SpiceDB vs OpenFGA (the two leading ReBAC engines)

Both are open-source, Apache-2.0, Zanzibar-inspired. The main divergences:

- **Consistency (biggest differentiator).** SpiceDB implements the full Zanzibar consistency model with **ZedTokens** (zookies) and explicitly protects against the **New-Enemy problem**, offering per-request tunable consistency (`minimize_latency`, `at_least_as_fresh`, `fully_consistent`). This is why it favors databases with true serializable isolation (Spanner, or CockroachDB configured correctly). OpenFGA is lighter to adopt and aligned with the Auth0/Okta ecosystem; confirm its consistency semantics against your staleness tolerance.
- **Operational cost.** SpiceDB is powerful but heavy: custom schema, dedicated datastore, run as its own service. OpenFGA is a simpler entry point (single binary + standard SQL DB).
- **Ecosystem.** OpenFGA is a CNCF project and the engine behind **Auth0 FGA**, which matters for us because Auth0's "Auth for GenAI" RAG/agent tooling builds directly on it. First-party OpenFGA docs exist for both **RAG authorization** and **agent authorization**.

**Recommendation basis:** For our platform, OpenFGA's ecosystem alignment (Auth0 for AI Agents, first-party RAG + agent docs), Apache-2.0 license, and lower operational cost make it the pragmatic primary choice. SpiceDB is the escalation path if we hit strict consistency requirements (e.g., regulated tenants that cannot tolerate any stale-ACL window).

### 2.3 Which is best for fine-grained, multi-tenant, per-resource authz?

- **Relationship-heavy (nested groups, org/team/project hierarchy, sharing, large scale):** OpenFGA or SpiceDB. This is our dominant pattern → **ReBAC engine wins**.
- **Attribute/context-driven only (no deep hierarchy):** Cerbos or Oso.
- Many production systems run **both**: a coarse RBAC/policy layer plus a fine-grained ReBAC engine. The line is blurring (SpiceDB Caveats, OpenFGA Conditions).

**Sources:**
- guptadeepak — Top 5 PBAC tools 2026 (AuthZed/Oso/Permit/Cerbos/PlainID): https://guptadeepak.com/tools/top-5-authorization-pbac-tools-2026/
- Oso — SpiceDB alternatives: https://www.osohq.com/learn/spicedb-alternatives-authorization-tools-comparison
- Oso — OpenFGA alternatives: https://www.osohq.com/learn/openfga-alternatives
- AuthZed — OpenFGA alternatives: https://authzed.com/learn/openfga-alternatives
- AuthZed — SpiceDB consistency / New Enemy: https://authzed.com/blog/consistency-is-the-key-to-performance-and-safety , https://authzed.com/blog/prevent-newenemy-cockroachdb/ , https://authzed.com/blog/zedtokens
- AuthZed — ABAC with SpiceDB Caveats: https://authzed.com/blog/abac-example
- OpenFGA — ABAC vs ReBAC: https://openfga.dev/docs/learn/abac-vs-rebac
- Cerbos — OPA alternative: https://www.cerbos.dev/blog/opa-alternative
- Permit.io — graph vs code based authz: https://dev.to/permit_io/google-zanzibar-vs-opa-graph-vs-code-based-authorization-3c9b
- SpiceDB consistency deep dive: https://akoserwal.medium.com/spicedb-consistency-a-deep-dive-into-performance-vs-accuracy-trade-offs-76e2fb2f29b9

---

## 3. Authorization for AI Agents (the emerging, critical area)

### 3.1 The core problem: agents are confused deputies by default

A **confused deputy** is a privileged program tricked into misusing its authority on behalf of a less-privileged caller. Multiple 2025-2026 sources argue this is the *default* architecture for AI agents, not an edge case: agents hold broad credentials while ingesting untrusted content (prompts, retrieved docs, tool outputs). The root cause identified in an arXiv analysis: frameworks **conflate tool exposure with authorization** — giving an agent a tool implicitly grants the right to use it.

Scale of the problem (cited surveys — treat exact figures as indicative):
- ~90% of AI agents are reported over-permissioned; ~80% of IT workers had seen agents act without explicit authorization.
- A 2026 report (n=205 CISOs/architects) found ~70% of orgs grant AI systems more access than a human in the same role; over-privileged AI correlated with a 76% incident rate vs 17% for least-privilege teams (~4.5x).
- **ForcedLeak (July 2025):** CVSS 9.4 flaw in Salesforce AgentForce — hidden instructions in a Web-to-Lead form drove a support agent to exfiltrate CRM data using permissions the agent legitimately held. Textbook confused deputy.

### 3.2 Principle: an agent must never exceed the delegating user's permissions

This is the central requirement. Techniques, in order of importance:

**(a) Identity propagation / On-Behalf-Of (OBO) via OAuth 2.0 Token Exchange (RFC 8693).**
- RFC 8693 defines grant type `urn:ietf:params:oauth:grant-type:token-exchange`, trading one token for another.
- Request carries a **`subject_token`** (the user) and optionally an **`actor_token`** (the agent).
- **Delegation model** (both tokens) produces a composite token with an **`act` (actor) claim** — a clear, auditable delegation chain (user is subject, agent is actor).
- **Impersonation model** (subject only) rescopes for a new audience but hides the intermediary — less auditable; prefer delegation for agents.
- The issued token is **audience-scoped** to the downstream service, which is what defeats the confused deputy: a token minted for API B cannot be replayed against API C, and it carries only attenuated scopes (never "trade up" to admin).
- **Auth0 Token Vault** implements this: user signs into a provider (Google/Slack/GitHub); provider refresh tokens go into secure storage; the **agent never touches provider refresh tokens** — it holds only an Auth0 token and exchanges it for short-lived, provider-scoped federated access tokens on demand (`getAccessTokenForConnection`). Revocation invalidates the vault entry so future exchanges fail. Propagation chain: **user → IdP (Auth0) → agent → downstream API.**

**(b) Intersection check (user ∩ agent).** For OBO agents, the authorization policy must require **both** the user and the agent to have access before granting — computing the *intersection* of permissions (scope attenuation). WorkOS: in shared/multi-audience contexts, intersect permissions across **all** audience members and check **at output**, not only at retrieval. Agent-to-agent delegation should attenuate at **each hop** (each sub-agent constrained to a narrower sub-tree), yielding a verifiable "chain of custody" = intersection of every entity in the lineage.

**(c) Zero standing privilege / just-in-time (JIT) elevation.** The production-grade 2026 direction: agents have **no standing authority**; a task triggers a temporary, short-lived, task-scoped role/permission that auto-expires ("Just-in-Time Agency"). SANS advocates a **credential broker** that mediates access rather than handing agents standing credentials. Semgrep revives 1970s **capability-based security** — authority tied to unforgeable, scoped tokens rather than ambient identity.

**(d) Human-in-the-loop for sensitive actions.** Auth0 (GA Nov 2025) and WorkOS both add **human confirmation / approval gates** and **async authorization** for critical actions. Token Vault handles delegated *access*; approval gates are a separate, complementary control.

### 3.3 Tool-level authorization (which tools/skills a role may invoke)

- **Every tool invocation triggers a real-time authz check**, not a static role lookup. WorkOS example: when an MCP server receives `read_file(path="/secrets.json")`, it runs `check(subject=Agent, role=viewer, resource=file:secrets.json)` and returns a precise 403 dynamically. FGA is positioned as the **"logic layer for MCP"** because MCP and OAuth 2.1 scopes are too coarse, and RAR (RFC 9396) is only a request *format* with no decision logic.
- **Descope Agentic Identity Hub 2.0** and **WorkOS AuthKit** both add **OAuth 2.1 + tool-level scopes** to MCP servers, treating agents as first-class identities.
- **Tool-combination risk:** individually safe tools (DB query + file writer + email sender) can be chained into harmful workflows (WorkOS "tool misuse"). This maps to OWASP **ASI02: Tool Misuse & Exploitation**. Mitigation: validate tool arguments, constrain tool graphs, and re-authorize on privilege escalation between chained calls.
- **For us:** the manager-agent vs staff-agent distinction is primarily a *tool-eligibility* (RBAC) gate layered over *per-resource* (ReBAC) checks on the arguments each tool touches.

### 3.4 Data-level authorization (permission-aware / ACL-filtered RAG)

The failure mode: a naive RAG pipeline embeds everything and returns the most *similar* chunks regardless of authorization; the LLM then summarizes restricted content straight back to the user. **Enforce permissions on retrieval results before the model sees any tokens.** Relying on the LLM itself for access control is an explicit anti-pattern.

OpenFGA's first-party RAG-authorization pattern (directly applicable):
- **Model:** `folder` has `owner`/`viewer`; `document` has a `folder` relation plus `owner`/`viewer`, where `viewer = direct viewers ∪ viewer from folder`. Grants can be folder-wide or per-document. Tuples come either from your app (first-party sharing) or a **sync pipeline mirroring source-system ACLs** (Google Drive, Confluence, SharePoint).
- **Post-filtering (common):** retrieve candidates from the vector DB, then call **`BatchCheck`** (one request, `user`/`relation`/`object` + `correlation_id`; `maxBatchSize` default 50, `maxParallelRequests` default 10) to keep only `allowed: true` docs. Tip: **over-fetch 2-3x** to survive filtering.
- **Pre-filtering:** call **`ListObjects`** (`user`, `relation`, `type:"document"`) to get authorized IDs, then pass them as a **metadata filter** to the vector query. Guarantees exact top-K are all authorized.
- **Choosing:** few candidates → post-filter; user sees few docs → pre-filter; user sees most docs → post-filter. **Hybrid** (coarse pre-filter on synced ACL metadata + fine-grained post-filter check) is what most enterprise sources converge on.
- **Placement:** the check must sit **after retrieval, before the LLM** — framework-agnostic (LangChain custom retriever, LlamaIndex node postprocessor, or a step in a custom pipeline).
- **Agent memory** is also a protected resource: tag every embedding with a source `resource_id` and filter memory retrieval through the same FGA check; use ephemeral memory shards in high-security setups (maps to OWASP ASI06 memory/context poisoning).
- Microsoft (Entra-based document-level security in Azure AI Search; "Security Filters in Agent Loop") and Descope (performant ReBAC for RAG) offer platform implementations of the same idea.

### 3.5 2025-2026 vendor & standards guidance (map)

- **Auth0 "Auth for GenAI" / Auth0 for AI Agents:** Jan 2025 announced → Apr 2025 dev preview (User Auth, Token Vault, Async Authorization, **FGA for RAG**) → **GA Nov 2025** (user control over agent actions/data, human confirmation for critical actions). Built on OpenFGA.
- **WorkOS:** FGA as the authorization layer for agents; "FGA = RBAC + hierarchy"; intersection checks for OBO; session-scoped authorization (Pipes + MCP); AuthKit as OAuth 2.1 server for MCP.
- **Descope:** Agentic Identity Hub 2.0 — agents as first-class identities, OAuth 2.1 + tool-level scopes for internal/external MCP servers, enterprise policy enforcement.
- **OWASP Top 10 for Agentic Applications 2026** (published Dec 2025, ASI01-ASI10). Authorization-relevant items:
  - **ASI01 Agent Goal Hijack** — objectives/decision logic manipulated.
  - **ASI02 Tool Misuse & Exploitation** — legitimate tools used unsafely / chained into sensitive APIs.
  - **ASI03 Identity & Privilege Abuse** — exploiting dynamic trust, cached credentials, delegation chains, implicit identity to act beyond intent.
  - **ASI07 Insecure Inter-Agent Communication** — weak authn/encryption between agents (mitigate with mTLS).
  - **ASI10 Rogue Agents** — agents deviating from authorized scope.
  - Cross-cutting mitigations: least privilege, unique bounded identities with short-lived credentials, re-authorization on escalation, argument validation.
- **OWASP Non-Human Identities (NHI) Top 10 (2025):** machine identities now vastly outnumber humans (~82:1 cited); agents act with *real* permissions, so identity is central to agentic risk.
- **Oso / AuthZed:** ReBAC + conditions/caveats as the fine-grained substrate for agent + RAG authorization.

**Sources:**
- Auth0 — Token Vault / secure token exchange (RFC 8693): https://auth0.com/blog/auth0-token-vault-secure-token-exchange-for-ai-agents/
- Auth0 — Auth for GenAI announce: https://auth0.com/blog/auth-for-genai/ ; Introducing Auth0 for AI Agents: https://auth0.com/blog/introducing-auth0-for-ai-agents/ ; GA: https://www.auth0.com/blog/auth0-for-ai-agents-generally-available ; Identity-chained authorization: https://auth0.com/blog/identity-chained-authorization-auth0-token-vault
- Auth0 — OWASP agentic lessons: https://auth0.com/blog/owasp-top-10-agentic-applications-lessons
- WorkOS — authorization layer for agents: https://workos.com/blog/agents-need-authorization-not-just-authentication ; tool misuse: https://workos.com/blog/ai-agent-tool-misuse ; session-scoped (Pipes+MCP): https://workos.com/blog/pipes-mcp ; MCP auth: https://workos.com/blog/introduction-to-mcp-authentication
- Descope — Agentic Identity Hub 2.0: https://www.descope.com/press-release/agentic-identity-hub-2.0 ; ReBAC for RAG: https://www.descope.com/blog/post/rebac-rag
- OpenFGA — RAG authorization: https://openfga.dev/docs/modeling/agents/rag-authorization ; use-case: https://openfga.dev/docs/use-cases/rag-authorization
- OWASP Top 10 Agentic Applications (Teleport summary): https://goteleport.com/blog/owasp-top-10-agentic-applications/ ; NHI Top 10: https://owasp.org/www-project-non-human-identities-top-10/2025/top-10-2025/
- Palo Alto — OWASP agentic 2026: https://www.paloaltonetworks.com/blog/cloud-security/owasp-agentic-ai-security/
- Confused deputy / over-privilege: https://tianpan.co/blog/2026-04-20-rbac-ai-agents-authorization , https://tianpan.co/blog/2026-04-15-ai-agent-permission-creep , https://tianpan.co/blog/2026-04-09-agent-authorization-production-service-account-footgun
- SANS — credential broker: https://www.sans.org/blog/your-ai-agent-easily-confused-deputy-why-cloud-security-needs-credential-broker
- Semgrep — capabilities for agentic web: http://www.semgrep.dev/blog/2026/security-like-its-1977-capabilities-for-the-modern-agentic-web
- CIAM Compass — JIT/delegation/constraints: https://guptadeepak.com/ciam-compass/guides/authorization-patterns-for-agentic-workflows/
- ForcedLeak / least privilege: https://beyondscale.tech/blog/ai-agent-authorization-security-least-privilege
- arXiv — confused-deputy in LLM agent frameworks: https://arxiv.org/html/2606.28679v1

---

## 4. Multi-Tenancy Isolation Patterns

### 4.1 Where isolation is enforced (the spectrum)
Isolation runs from **infrastructure-enforced** (single-tenant / multi-instance) to **application-enforced** (shared runtime). A system only counts as multi-tenant if tenants are isolated *in practice*.

- **Silo model** — dedicated resources per tenant (DB-per-tenant, index-per-tenant). Strongest isolation, smallest blast radius, best for compliance/regulated tenants, eliminates noisy-neighbor. Heavier ops; painful to migrate strategies later.
- **Pool model** — shared resources, logical separation (tenant-ID column, shared namespace). Cheapest, simplest ops; pushes the entire isolation burden onto correct application logic + authorization. A single missing `tenant_id` predicate = cross-tenant leak.
- **Bridge/hybrid** — shared app tier, per-tenant data stores for sensitive tenants. Common enterprise compromise.

### 4.2 Authorization store topology (per-tenant vs shared)
Mirrors the DB decision (AWS Verified Permissions guidance generalizes to any engine):
- **Per-tenant policy/authz store:** supports different authz models per tenant, eliminates noisy-neighbor, narrows blast radius when a policy/deploy goes bad. Heavier to operate.
- **Shared store:** simpler to operate, but wider noisy-neighbor exposure and broader impact from a bad deploy.

**OpenFGA guidance:** default to a **single shared store with tenant boundaries modeled inside the authorization graph** (a `tenant`/`organization` type that all resources relate to). Cheaper than per-tenant stores; tuple count grows linearly. Reserve **store-per-tenant** for strict compliance/isolation tenants. **Do not** encode tenant+org+project+role into flat role-name strings (`acme_org_marketing_project_editor`) — that explodes tuple counts and creates a rigid, unextendable hierarchy. Instead model resource *types* and *relationships*; use **contextual tuples** to inject "user is acting in tenant X right now" at query time (via organization-context authorization), rather than persisting every session relationship.

### 4.3 Noisy neighbor (esp. for LLM/agent workloads)
One tenant's load degrading others sharing resources. Harder for LLM infra than for databases (token throughput, GPU contention, context windows). Mitigations: **per-tenant rate limits, spend caps, and prompt/queue isolation**; the classic trap is picking a pool model early with few tenants and never revisiting until a noisy tenant forces stronger isolation. For multi-tenant RAG specifically: **namespace isolation with fine-grained access control** (pool) vs **index-per-tenant** (silo); isolation must be **deterministic at the data layer** — never rely on the LLM for access control.

**Sources:**
- WorkOS — SaaS multi-tenant architecture guide: https://workos.com/blog/developers-guide-saas-multi-tenant-architecture
- Aquilax — tenant isolation failures / cross-tenant leakage: https://aquilax.ai/blog/saas-multi-tenancy-isolation-failures
- AWS — per-tenant policy store: https://docs.aws.amazon.com/prescriptive-guidance/latest/saas-multitenant-api-access-authorization/avp-design-per-tenant-store.html ; shared store: https://docs.aws.amazon.com/prescriptive-guidance/latest/saas-multitenant-api-access-authorization/avp-design-shared-store.html
- OpenFGA — multi-tenant SaaS: https://openfga.dev/docs/use-cases/multi-tenant-saas ; org-context authz: https://openfga.dev/docs/modeling/organization-context-authorization ; contextual tuples: https://openfga.dev/docs/interacting/contextual-tuples
- OpenFGA multi-tenant lessons: https://medium.com/@aakash_rana/what-two-years-of-openfga-in-a-multi-tenant-saas-taught-me-about-modeling-authority-0225777cca49
- Truto — multi-tenant RAG isolation: https://truto.one/blog/how-to-architect-strict-data-isolation-in-multi-tenant-rag-pipelines/
- Tianpan — noisy neighbor in LLM infra: https://tianpan.co/blog/2026-04-17-multi-tenant-llm-noisy-neighbor-isolation
- LoginRadius — multi-tenant authorization: https://www.loginradius.com/blog/identity/what-is-multi-tenant-authorization

---

## 5. Audit Logging & Compliance

### 5.1 What an agent audit trail must capture
A **tamper-evident, chronological** record answering "what did this agent do, and on whose authority?" Fields converged on across sources: the **input** received, the **decision/reasoning step**, the **tool called** (+ arguments), the **output** produced, the **authorizing identity** (user + agent + delegation chain), model/version, tenant, and timestamp. Standard request/response logging breaks down once agents autonomously plan and chain tool calls, so capture **replayable events** and **traceable state changes**.

### 5.2 Multi-agent bar: attributability + reversibility
For multi-agent systems, passing enterprise audit requires:
- **Attributability** — each output segment traces to a specific agent, model version, and authorizing spec.
- **Reversibility** — any output can be rolled back without cascading failures.
Plus **cryptographic integrity** (e.g., hash-chained / append-only logs) so records survive a breach and hold up in an audit.

### 5.3 Compliance expectations
- No separate "SOC 2 for AI." When an AI system handles customer/personal data it's evaluated against the existing **AICPA Trust Services Criteria** — same logical-access, monitoring, change-management, vendor controls. Auditor test: if asked what the AI said to a specific user on a specific date, you either produce the record or have a documented design decision for its absence.
- Baseline enterprise expectations for agentic AI: **SOC 2 Type II, encryption at rest, key rotation, immutable audit trails.**
- A cited 2025 survey: ~78% of enterprises want comprehensive audit trails in place *before* putting agents in production; **EU AI Act** mandates traceability for high-risk systems.

**Sources:**
- Superblocks — 7 things to log for compliance: https://www.superblocks.com/blog/ai-audit-trail
- Galileo — agent compliance/governance/audit trails: https://galileo.ai/blog/ai-agent-compliance-governance-audit-trails-risk-management
- Augment Code — multi-agent audit (attributability/reversibility): https://www.augmentcode.com/guides/multi-agent-outputs-n-pass-enterprise-audit
- Omnithium — forensic traceability in agentic workflows: https://omnithium.hashnode.dev/ai-agent-audit-trails-ensuring-forensic-traceability-in-agentic-workflows
- Teamazing — SOC2/ISO evidence for AI: https://www.teamazing.com/blog/ai-audit-evidence-soc2-iso27001/
- fast.io — AI agent audit logging guide: https://fast.io/resources/ai-agent-audit-logging/
- Anyreach — SOC2 for agentic systems: https://blog.anyreach.ai/enterprise-ai-security-how-soc2-compliance-and-data-protection-build-trust-in-agentic-systems/

---

## 6. Recommended Architecture for Our Platform

**Goal restated:** one agent platform where capabilities (which tools/skills) and data access differ by user role (manager-agent vs staff-agent) across many tenant companies, with hard tenant isolation.

### 6.1 Layered model
1. **RBAC (coarse guardrail):** role determines *agent persona* and *tool eligibility set* — a manager-agent may invoke approval/reporting/team-wide tools; a staff-agent gets a strict subset. Cheap first gate.
2. **ReBAC (fine-grained core):** OpenFGA graph with a top-level `tenant` (organization) type; every resource, team, user, tool, and document relates into it. Resolves per-resource, per-tenant, hierarchical access. This is where "manager of *this* team can see *these* records" lives.
3. **ABAC/conditions (context):** OpenFGA Conditions / contextual tuples for time, region/residency, session-scope, and risk.

### 6.2 Engine choice
- **Primary: OpenFGA** (Apache-2.0, CNCF, Zanzibar). Reasons: ecosystem alignment with **Auth0 for AI Agents** (Token Vault + FGA-for-RAG built on OpenFGA), first-party **RAG-authorization** and **agent-authorization** docs, lighter self-host than SpiceDB, native multi-tenant modeling + contextual tuples.
- **Escalation: SpiceDB** if any tenant demands strict Zanzibar consistency (ZedTokens / New-Enemy protection) that OpenFGA's staleness window can't meet.
- **Optional: Cerbos** as a stateless PDP if some decisions are purely attribute/policy based with no relationships.

### 6.3 Identity propagation
- Users authenticate to the platform via the IdP (Auth0/Okta or equivalent OIDC).
- Agent acts **on-behalf-of** the user using **OAuth 2.0 Token Exchange (RFC 8693) delegation** — composite token with `act` claim (user = subject, agent = actor), **audience-scoped** to each downstream API/tool, **short-lived**, **attenuated**.
- Downstream/provider credentials live in a **Token Vault** (broker pattern); the agent never holds provider refresh tokens and never gets standing broad credentials. Aim for **zero standing privilege + JIT elevation** per task.

### 6.4 Tool-level authorization
- Every tool/skill invocation → real-time `Check(subject, action, resource)` against OpenFGA (the "logic layer for MCP").
- Enforce **intersection: allow only if BOTH the user AND the agent are authorized** for the specific resource the tool touches. This structurally prevents an agent from exceeding the delegating user (confused-deputy defense).
- Validate tool arguments; re-authorize on privilege escalation between chained tool calls; constrain the tool graph to block harmful combinations.
- Sensitive/irreversible actions → **human-in-the-loop approval gate** (async authorization).

### 6.5 Data-level authorization (RAG)
- **Sync source-system ACLs** into the OpenFGA graph (docs → folders → teams → tenant), refreshed as sources change.
- **Hybrid filtering:** coarse **pre-filter** via `ListObjects` (authorized doc IDs → vector metadata filter, scoped to the tenant namespace) + fine-grained **post-filter** via `BatchCheck` on candidates, over-fetching 2-3x. Check sits **after retrieval, before the LLM**.
- Apply the **same FGA filter to agent memory** (tag embeddings with `resource_id` + tenant); ephemeral memory shards for high-security tenants.
- Never rely on the LLM for access control; isolation is deterministic at the data layer.

### 6.6 Multi-tenancy
- **Shared OpenFGA store**, tenant boundary modeled as a `tenant` type in the graph; **store-per-tenant** only for strict-compliance tenants.
- Vector store: **namespace-per-tenant** (pool) by default; **index-per-tenant** (silo) for regulated tenants.
- **Per-tenant rate limits + spend caps + queue isolation** to contain noisy neighbors on the LLM tier.
- Every authz check and retrieval carries the tenant scope; a missing tenant predicate must fail closed.

### 6.7 Audit
- Emit a **tamper-evident, append-only (hash-chained)** event per agent action: input, reasoning step, tool + args, authorizing identity (user + agent + `act` delegation chain), tenant, model/version, output, and the authz decision (allow/deny + policy reason).
- Ensure **attributability + reversibility**; retain for the compliance window; map to **SOC 2 Type II** Trust Services Criteria and **EU AI Act** traceability.

### 6.8 Build sequence (suggested)
1. Stand up OpenFGA + tenant/resource schema; migrate RBAC roles into it as coarse relations.
2. Wire IdP + RFC 8693 delegation + Token Vault; kill standing agent credentials.
3. Add per-tool `Check` with user∩agent intersection at the MCP/tool boundary.
4. Implement ACL sync + hybrid RAG filtering (ListObjects pre-filter + BatchCheck post-filter).
5. Add tenant namespacing, rate/spend limits, and the hash-chained audit log.
6. Add human-in-the-loop gates + JIT elevation for sensitive actions.
7. Pen-test for confused-deputy / prompt-injection-driven tool misuse (OWASP ASI01/02/03).

### 6.9 Honest uncertainties
- Exact survey percentages (over-privilege rates, incident correlations) come from vendor/analyst posts and should be treated as directional, not precise.
- OpenFGA's precise consistency guarantees vs your staleness tolerance need validation in a spike; if regulated tenants can't tolerate any stale-ACL window, prototype SpiceDB early.
- Standards for agent-to-agent delegation (multi-hop OAuth extensions) are still in flux (IETF drafts); design the delegation chain so it can adopt the finalized standard.
- Some cited arXiv/blog URLs use future-dated identifiers (2606.x, 2605.x) reflecting the source snapshot; treat those as pointers and re-verify before citing formally.

