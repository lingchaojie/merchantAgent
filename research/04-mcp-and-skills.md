# MCP and Agent Skills: Architecture & Best Practices for an Enterprise Agent Platform

**Research date:** 2026-07-08
**Author:** Technical research (for the enterprise FSE-authored, role-scoped skill platform)
**Scope:** Model Context Protocol (MCP), the Agent "Skills" pattern, and how to combine them with a general agent loop for enterprise connectors that are permission-gated by job role.

> **Honesty / uncertainty note.** Where a claim rests on the official spec or Anthropic docs it is marked as such. Some "2026" details circulating in blogs are unverified or contradicted by the official spec (notably a claimed "MCP Spec 1.2 ratified June 2026," which I could **not** confirm — see §1.2). Treat vendor-blog claims as secondary. Spec revisions are dated (`YYYY-MM-DD`); the current authoritative revision as of this research is **2025-11-25**.

---

## Executive summary

- **MCP** = the *connection* layer. An open standard (originally Anthropic, Nov 2024) that gives any model a uniform client-server way to reach external systems via **tools, resources, and prompts** over JSON-RPC 2.0. Now community-governed under the **Agentic AI Foundation** (Linux Foundation) after Anthropic's Dec 2025 donation; adopted by OpenAI and Google.
- **Skills** = the *instruction / procedural-knowledge* layer. Folders built around a `SKILL.md` file (YAML frontmatter + Markdown body + optional bundled scripts/resources), loaded via **progressive disclosure**. Published as an open standard at **agentskills.io** (Oct 2025).
- **Per-user/per-role auth** in MCP is done by treating the MCP server as an **OAuth 2.1 Resource Server** that validates tokens from a separate Authorization Server and enforces **scopes**. Enterprises add a **gateway** doing **RFC 8693 token exchange** (on-behalf-of) to downscope broad tokens into least-privilege, per-server tokens and to propagate user identity across hops.
- **Role-scoped skill library** maps cleanly onto Skills' scoping model (**enterprise / personal / project / plugin**) plus **plugins** as the versioned, shareable distribution unit, with `allowed-tools` frontmatter gating which capabilities each skill may invoke.
- **Top risks to design around:** tool poisoning / rug-pulls, prompt injection, confused deputy, token passthrough, and over-broad scopes. Skills add a supply-chain risk (a skill is executable code + instructions — audit like a dependency).

---

# 1. Model Context Protocol (MCP)

## 1.1 Core architecture (hosts, clients, servers; tools, resources, prompts)

MCP follows a **client-server architecture** using **JSON-RPC 2.0** messages over stateful connections with capability negotiation. Three participants (per the [official architecture docs](https://modelcontextprotocol.io/docs/learn/architecture) and [spec](https://modelcontextprotocol.io/specification/latest)):

- **MCP Host** — the AI application (e.g., Claude Code, Claude Desktop, VS Code) that coordinates one or more clients and manages the LLM.
- **MCP Client** — a connector *inside* the host; the host creates **one client per server**, each maintaining a dedicated connection.
- **MCP Server** — a program that provides context/capabilities. Can run **locally** or **remotely**; the term refers to the program regardless of where it runs.

Example from the docs: VS Code (host) instantiates one client for the Sentry MCP server and another client for a local filesystem server — each a dedicated 1:1 connection.

**Server-offered features (primitives):**
| Primitive | What it is | Who it's for |
|---|---|---|
| **Tools** | Executable functions the model can call to take actions / retrieve info | AI model |
| **Resources** | Structured data/content supplying context | User or model |
| **Prompts** | Templated messages / workflows | Users |

**Client-offered features (server can request these back):**
- **Sampling** — server-initiated LLM calls (recursive/agentic behavior).
- **Roots** — server inquiries into filesystem/URI boundaries it may operate in.
- **Elicitation** — server-initiated requests for more information from the user. (Elicitation is a relatively recent addition, present in current revisions.)

**Additional utilities:** configuration, progress tracking, cancellation, error reporting, logging, and **notifications** (e.g., `notifications/tools/list_changed`) that let servers tell clients the tool list changed so the client re-fetches — important because "tools may come and go based on server state, external dependencies, or **user permissions**."

MCP is explicitly modeled after the **Language Server Protocol (LSP)** — standardize one integration surface so the whole ecosystem interoperates ("USB-C for AI"). MCP deliberately does **not** dictate how the host uses the LLM or manages context.

## 1.2 Spec status & versioning (as of July 2026)

- Spec revisions are **date-stamped**. Known published revisions: **2025-03-26** (first authorization flow), **2025-06-18** (major auth restructure + dedicated security best-practices doc), and **2025-11-25** (current `latest` at research time; schema at `schema/2025-11-25/schema.ts`).
- The **2025-06-18** revision made a key structural change: the MCP server is now purely a **Resource Server** — it no longer issues tokens itself; a **separate Authorization Server** does. This resolved the earlier "server plays both roles" complexity.
- **Uncertainty flag:** A blog ([promptgenius.net](https://promptgenius.net/blog/mcp-spec-1-2-remote-servers)) claims an "MCP Specification 1.2 ratified June 2026" standardizing remote servers. I could **not** verify this against modelcontextprotocol.io, which uses **date-stamped** revisions, not "1.x" numbers. The official `latest` resolves to **2025-11-25**. Do not design around the "1.2" claim.

Sources: [spec/latest](https://modelcontextprotocol.io/specification/latest), [architecture](https://modelcontextprotocol.io/docs/learn/architecture), [auth spec 2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization).

## 1.3 Transports: local vs remote

| Transport | Use | Cardinality |
|---|---|---|
| **stdio** | Local dev; server is a subprocess launched by the host | Typically **one client per server** |
| **Streamable HTTP** | Remote servers | Typically **many clients per server** |
| **HTTP + SSE** | Earlier remote transport | Being superseded by Streamable HTTP |

- **Local (stdio):** e.g., Claude Desktop launches a filesystem server as a child process. Simple, no network auth needed, runs with the user's local privileges.
- **Remote (Streamable HTTP):** a single shared service serves many users/clients — this is the deployment mode that **forces the auth problem** (see §1.4). "Streamable HTTP" replaced the older dual-endpoint SSE model and is the direction of travel for remote servers.

**Design implication for us:** on-site FSE-built connectors that touch company systems will mostly be **remote Streamable HTTP servers** (shared, multi-user), so per-user/per-role auth is mandatory rather than optional.

Sources: [architecture](https://modelcontextprotocol.io/docs/learn/architecture), [Accio guide](https://www.accio.com/wow/guide-model-context-protocol-mcp.html).

## 1.4 Authentication & authorization (the OAuth-based auth spec)

MCP standardized on **OAuth 2.1** for HTTP/remote transports. The model (2025-06-18 onward):

1. The **MCP server is an OAuth 2.0 Resource Server** — it *validates* tokens and enforces scopes; it does **not** mint them.
2. A **separate Authorization Server** (your enterprise IdP — Entra ID, Okta, Auth0, etc.) authenticates users and issues tokens.
3. **Discovery flow:** an unauthenticated call gets **HTTP 401** with a pointer to **Protected Resource Metadata (RFC 9728)**. That metadata tells the client which Authorization Server to use. The client runs the OAuth flow, obtains an access token, and resends the request with `Authorization: Bearer <token>`.
4. The server validates the token (signature via **JWKS**, expiry, issuer, and **audience**) and enforces scopes before executing a tool.

**Supporting RFC stack** (per [kane.mx deep dive](https://kane.mx/posts/2025/mcp-authorization-oauth-rfc-deep-dive/)):
- **OAuth 2.1** (`draft-ietf-oauth-v2-1`) — base framework
- **RFC 7636 (PKCE)** — required, mitigates code interception
- **RFC 9700** — OAuth 2.0 security best practices
- **RFC 7519 (JWT)** — token structure
- **RFC 8707 (Resource Indicators)** — binds a token to a specific audience (critical against token passthrough — §1.7)
- **RFC 9728 (Protected Resource Metadata)** — the 401 discovery mechanism

Sources: [auth spec 2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization), [Obsidian Security](https://www.obsidiansecurity.com/academy/mcp-authentication-security), [Authgear](https://www.authgear.com/post/mcp-authentication/), [Spring AI OAuth2](https://spring.io/blog/2025/05/19/spring-ai-mcp-client-oauth2), [Logto review](https://medium.com/@logto/in-depth-review-of-the-mcp-authorization-spec-2025-03-26-edition-26c112e47d0b).

## 1.5 Enforcing per-user / per-role permissions

MCP gives you the *mechanism* (validated tokens + scopes); **you** build the RBAC on top. Patterns from the field:

- **Scope-based authorization + tool-level access control.** The server maps OAuth **scopes → roles → allowed tools**. A user's token carries scopes derived from their job role in the IdP; the server rejects tool calls whose required scope isn't present. Critically, **claimed scopes in a token are not sufficient — the server must run its own server-side authorization logic** (per the spec's "common mistakes").
- **Least-privilege / progressive scopes.** Start with a minimal scope set (e.g., `mcp:tools-basic`, read-only discovery). When a privileged tool is first attempted, the server issues a **`WWW-Authenticate` challenge with `scope="..."`** to elevate incrementally, rather than requesting an omnibus scope up front. Servers should **accept down-scoped tokens** and log elevation events with correlation IDs.
- **Dynamic tool exposure by permission.** Because MCP supports `list_changed` notifications, a server can present a **different tool list per role** and refresh it as permissions change.
- **Enterprise MCP Gateway (the important pattern for us).** Put a gateway in front of MCP servers that:
  - authenticates the user against the enterprise IdP and validates the bearer token,
  - performs **RFC 8693 OAuth 2.0 Token Exchange** to swap a broad user token for a **narrowly-scoped, per-server token** (downscoping),
  - propagates user identity across multi-hop chains using the **`subject_token`** (the user) + **`actor_token`** (the agent) distinction — so audit trails stay intact and each downstream service only gets a token scoped to itself,
  - falls back to a secret store (e.g., **Vault**) for legacy backends that only support PATs/API keys instead of OAuth2,
  - enforces **delegation-chain limits and token-lifetime caps** so an agent can never exceed the user's permissions or mint tokens that outlive the session.

Sources: [Codilime (JWT + tool-level access)](https://codilime.com/blog/mcp-server-security-for-network-automation/), [WorkOS MCP auth guide](https://workos.com/blog/mcp-auth-developer-guide), [Red Hat MCP Gateway](https://developers.redhat.com/articles/2025/12/12/advanced-authentication-authorization-mcp-gateway), [GitGuardian enterprise patterns](https://blog.gitguardian.com/oauth-for-mcp-emerging-enterprise-patterns-for-agent-authorization/), [Solo.io agentgateway OBO](https://docs.solo.io/agentgateway/2.2.x/mcp/token-exchange/obo/delegation/), [Gravitee 4.11](https://www.gravitee.io/blog/trusted-on-behalf-of-agent-delegation-in-gravitee-4.11), [MuleSoft Agent Fabric identity propagation](https://blogs.mulesoft.com/dev-guides/identity-propogation-mulesoft-agent-fabric/), [RFC 8693](https://www.rfc-editor.org/info/rfc8693/), [prateekcodes multi-hop delegation](https://prateekcodes.com/multi-hop-delegation-oauth-on-behalf-of-ai-agents/).

## 1.6 Ecosystem maturity & adoption (2025-2026)

- **Nov 2024:** Anthropic creates & open-sources MCP.
- **~Mar 2025:** OpenAI begins embracing MCP (moving off its proprietary Assistants integration layer).
- **Apr 9, 2025:** **Google** confirms it will support MCP.
- **May 2025:** OpenAI's **Responses API** adds support for remote MCP servers; OpenAI joins the MCP **steering committee**.
- **Dec 2025:** Anthropic **donates MCP to the Agentic AI Foundation** (a Linux Foundation fund co-founded by Anthropic, Block, and OpenAI) — MCP is now **community-governed**, not a single-vendor standard.
- **Dec 2025:** **Google** announces official MCP support for Google services (globally consistent endpoint for clients like Gemini CLI) plus **MCP support in Apigee**.

By early 2026, industry write-ups report a large share of Fortune 500 companies running agents in production with a meaningful subset having deployed MCP servers (vendor-sourced figure — treat as directional, not audited).

**Takeaway:** MCP is now the de facto cross-vendor standard and is under neutral governance, which de-risks building on it long-term.

Sources: [ZDNet (Google adopts)](https://zdnet.com/article/google-joins-openai-in-adopting-anthropics-protocol-for-connecting-ai-agents-why-it-matters), [TechCrunch](https://techcrunch.com/2025/04/09/google-says-itll-embrace-anthropics-standard-for-connecting-ai-models-to-data/), [OpenAI Responses API](https://openai.com/index/new-tools-and-features-in-the-responses-api/), [Anthropic donation announcement](https://www.anthropic.com/news/donating-the-model-context-protocol-and-establishing-of-the-agentic-ai-foundation), [Google Cloud MCP support](https://cloud.google.com/blog/products/ai-machine-learning/announcing-official-mcp-support-for-google-services), [Wikipedia: MCP](https://en.wikipedia.org/wiki/Model_Context_Protocol).

## 1.7 Security considerations / known risks

The spec ships a dedicated **[Security Best Practices](https://modelcontextprotocol.io/specification/2025-06-18/basic/security_best_practices)** document alongside the auth spec. Key risks:

### Tool poisoning / rug-pulls
- Term coined by **Invariant Labs (Apr 2025)**; demonstrated rug-pull attacks against WhatsApp/GitHub MCP servers. **Hidden instructions embedded in a tool's description or schema** execute with host privileges when the agent reads/calls the tool — the model sees them, the user usually doesn't.
- The spec explicitly warns: **tool descriptions/annotations must be treated as untrusted unless from a trusted server.**
- "Rug-pull" = a server serves a benign tool definition initially, then silently swaps in a malicious one after install.

### Prompt injection
- MCP tools become a client-side attack vector: injected content (from a resource, a tool result, or an external page) carries instructions that redirect the agent. It's also the **most common trigger for a confused-deputy** situation.
- Operational reality check (Aptible): everyday governance gaps — **no audit trail, borrowed agent identity, no access differentiation** — cause more real-world harm than exotic injections.

### Confused deputy
- Occurs when an MCP **proxy** server uses its own **elevated stored privileges / static client ID** to perform actions the initiating user shouldn't be authorized for.
- **Vulnerable conditions (all must hold):** proxy uses a **static client ID** with a 3rd-party AS; proxy lets clients **dynamically register**; the 3rd-party AS sets a **consent cookie** after first auth; proxy **skips per-client consent** before forwarding.
- **Mitigation:** the MCP proxy **MUST obtain per-client consent** before forwarding to the third-party authorization server (don't let a prior consent cookie silently authorize a new dynamically-registered client).

### Token passthrough
- **Rule: an MCP server MUST NOT accept a token that was not issued for it.** Validate the **audience (`aud`)** claim (RFC 8707 Resource Indicators). Passing a user's broad token straight through to downstream APIs means a compromised server can impersonate the agent everywhere.
- **Mitigation:** audience-bind tokens; use gateway **token exchange (RFC 8693)** to issue per-server tokens.

### Over-broad scopes
- Omnibus scopes (`*`, `all`, `full-access`) expand blast radius, complicate revocation, enable privilege chaining, and cause consent fatigue.
- **Mitigation:** least-privilege progressive scopes (§1.5); never publish the whole scope catalog in `scopes_supported` or in every challenge.

### Other
- **SSRF**, supply-chain compromise (npm typosquatting of MCP server packages), and session hijacking are covered in hardening guides. Recommended controls: OAuth 2.1, input validation, human-in-the-loop for high-risk tools, sandboxing/isolation, and audit logging.

Sources: [MCP Security Best Practices](https://modelcontextprotocol.io/specification/2025-06-18/basic/security_best_practices), [Invariant/glasp tool poisoning](https://glasp.co/articles/mcp-security-tool-poisoning-supply-chain), [Microsoft: state of MCP security 2026](https://techcommunity.microsoft.com/blog/microsoft-security-blog/the-state-of-mcp-security-in-2026/4531327), [Elastic Security Labs](https://elastic.co/security-labs/mcp-tools-attack-defense-recommendations), [Aptible](https://www.aptible.com/mcp-security/mcp-prompt-injection), [Glama zero-trust guide](https://glama.ai/blog/2025-11-04-mcp-security-survival-guide-architecting-for-zero-trust-tool-execution), [Codersera hardening](https://codersera.com/blog/how-to-secure-mcp-servers-2026/), [Microsoft Wassette threat model](https://microsoft.github.io/wassette/latest/design/mcp-threat-model.html).

## 1.8 MCP for enterprise connectors

- MCP is the natural **connector abstraction**: one protocol, reused across models (Claude/GPT/Gemini), instead of N bespoke integrations. Each company system (CRM, ticketing, inventory, ERP) becomes an **MCP server exposing role-appropriate tools/resources**.
- For our platform, FSE-built connectors should be **remote Streamable HTTP servers behind an MCP gateway** that does IdP auth + RFC 8693 downscoping, so a single connector safely serves many users at different roles.
- The connector's tool list can be **role-filtered** (via scopes + `list_changed`), so an FSE tech and a store manager see different capabilities from the same server.
- Non-OAuth legacy systems are bridged via the gateway + Vault fallback (§1.5).

---

# 2. The Agent "Skills" pattern

## 2.1 What a Skill is & how it's defined

Anthropic defines Skills as **"organized folders of instructions, scripts, and resources that agents can discover and load dynamically."** The analogy used throughout the docs: building a skill is like **onboarding a new hire** — you capture procedural knowledge once instead of hand-crafting a separate agent per use case.

Structure — a skill is a **directory** containing a **`SKILL.md`** file:

```yaml
---
name: pdf-processing
description: Extract text and tables from PDF files, fill forms, merge documents.
  Use when working with PDF files or when the user mentions PDFs, forms, or document extraction.
---

# (Markdown body: plain-English instructions, workflows, examples)
```

- **YAML frontmatter** — required `name` + `description`; **only this metadata is preloaded** (~30-50 tokens/skill) so the agent knows *when* a skill applies. The `description` is the trigger — it should state **both what the skill does and when to use it**.
- **Markdown body** — the detailed instructions, loaded only when the skill is deemed relevant. Best practice: keep it **under ~500 lines**; split overflow into separate files.
- **Bundled files** — scripts, templates, reference docs (e.g., the PDF skill ships `reference.md`, `forms.md`, and a Python form-extraction script) loaded **on demand**.

**Optional frontmatter fields** reported for Claude Code / SDK skills: **`allowed-tools`** (restricts which tools the skill may invoke — the permission lever), `argument-hint`, `disable-model-invocation`, `user-invocable`, `model`, `context`. *(These are from Claude Code docs + third-party write-ups; the two universally-required fields are `name` and `description`.)*

Sources: [Agent Skills overview](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview), [Anthropic engineering blog](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills), [best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices), [SKILL.md anatomy](https://agentman.ai/blog/build-your-first-agent-skill-skillmd-anatomy), [Claude Code skills config](https://vineetagarwal-code-claude-code-76.mintlify.app/configuration/skills).

## 2.2 Discovery & loading — progressive disclosure (3 levels)

The **core design principle**. Detail loads only when needed, so bundled context is "effectively unbounded" while startup cost stays tiny:

| Level | Content | When loaded | Cost |
|---|---|---|---|
| **1 — Metadata** | `name` + `description` | Always, at startup, injected into system prompt | ~30-50 tokens/skill |
| **2 — SKILL.md body** | Full instructions | When the request matches the description | Whole file (keep <500 lines) |
| **3 — Bundled files** | Scripts, refs, templates | On demand, as the task requires | Only what's opened |

Anthropic's analogy: *"a well-organized manual that starts with a table of contents, then specific chapters, and finally a detailed appendix."* Concision still matters at Level 2 — once loaded, every token competes with conversation history.

**Skills can carry executable code.** Rationale: deterministic work (e.g., sorting, PDF form extraction) is cheaper and more reliable run as a **script** than generated token-by-token. Code can serve as both a runnable tool and as reference documentation — authors should make clear which.

## 2.3 Skills vs. Tools / MCP — the key distinction

| | **Skills** | **Tools / MCP** |
|---|---|---|
| Answers | *"How do I do this?"* (procedure, know-how) | *"What can I connect to / do?"* (capability) |
| Nature | Instructions + optional bundled code/resources | Live connection to external systems |
| Loaded | Dynamically, progressive disclosure | Tool list advertised by server; called at runtime |
| Analogy | Onboarding manual / playbook | The hands and eyes (APIs, DBs, browsers) |

- **Not a system prompt:** a system prompt is static, loaded once; a **skill is discovered and loaded only when relevant**, and can execute code.
- **Complementary, not competing.** Anthropic: it will "explore how **Skills can complement MCP servers** by teaching agents more complex workflows that involve external tools and software." Mental model: **MCP connects; Skills instruct.** A skill can *teach the agent how to orchestrate a sequence of MCP tool calls* to accomplish a role-specific workflow.

Sources: [Anthropic engineering blog](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills), [intuitionlabs Skills vs MCP](https://intuitionlabs.ai/articles/claude-skills-vs-mcp), [ravichaganti](https://ravichaganti.com/blog/agent-skills-vs-model-context-protocol-how-do-you-choose/), [verdent.ai](https://www.verdent.ai/es/guides/claude-skills-vs-mcp-agents-comparison), [mcsaguru](https://mcsaguru.com/claude-code-skills-vs-mcp-vs-subagents).

## 2.4 Scoping, versioning, sharing & permission-gating

### Scopes (where skills live) — the directory model
| Scope | Location | Applies to |
|---|---|---|
| **Personal / user** | `~/.claude/skills/<name>/SKILL.md` | All the user's projects |
| **Project** | `.claude/skills/<name>/SKILL.md` (repo root) | Committed, shared with the team via the repo |
| **Plugin** | inside a plugin's `skills/` dir, referenced namespaced as `plugin-name:skill-name` | Anyone who installs the plugin |
| **Enterprise / managed** | deployed org-wide via managed settings | Whole org, admin-controlled |

**Precedence on name collision (reported):** **enterprise > personal (user) > project.** Note this is the **opposite** of subagents/MCP servers (where project beats personal). *Caveat: this ordering comes from third-party write-ups, not a single canonical Anthropic page — verify against official claude-code docs before relying on it for security decisions.*

### Permission-gating
- **`allowed-tools` frontmatter** restricts which tools a skill may invoke — the primary in-skill permission control. A role's skill can be constrained to only the MCP tools that role is allowed to touch.
- **Runtime environment differs by surface:**
  - **claude.ai** — network access varies by user/admin settings; **no centralized admin/org-wide distribution of custom skills** (a real limitation for enterprise governance on claude.ai specifically).
  - **Claude API** — **no network access, no runtime package installs**, pre-configured packages only. (Also: Skills are **not** eligible for Zero Data Retention.)
  - **Claude Code** — full network access (same as any local program); local package installs only.
- **SDK gotcha:** with the Agent SDK you must set `settingSources: ['user','project']` **and** include `"Skill"` in `allowed_tools`, or skills won't load at all.

### Versioning & sharing → Plugins
- Loose files are fine while a skill is **personal**. **Promote to a plugin** when it needs to be **shared, namespaced, versioned, and distributed** to a team.
- A **plugin** is a self-contained, versioned directory bundling **skills + subagents + hooks + MCP server configs + slash commands**. **Marketplaces** (often just a GitHub repo) make plugins discoverable/installable — "personal → team → org" progression; Anthropic named the failure mode this solves **"tribal knowledge" (May 2026)**.
- **Open standard:** Skills were published as a cross-platform standard at **agentskills.io**, so the SKILL.md format is portable across Claude Code, and (per third-party reports) other agent CLIs.
- **Supply-chain hygiene:** treat any third-party skill like a code dependency you'd audit (read bundled files, watch dependencies, flag instructions that reach untrusted network sources).

Sources: [Claude Code skills docs](https://docs.claude.com/en/docs/claude-code/skills), [Agent SDK skills](https://docs.claude.com/en/api/agent-sdk/skills), [overview (runtime constraints)](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview), [precedence: Sherlock](https://sherlock.xyz/post/how-to-write-skills-for-claude-code-and-cowork) / [wmedia.es](https://wmedia.es/en/tips/claude-code-config-precedence-who-wins), [plugins guide](https://hidekazu-konishi.com/entry/claude_code_plugins_complete_guide.html), [plugin marketplaces](https://code.claude.com/docs/en/plugin-marketplaces), [claudefa.st distribution](https://claudefa.st/blog/tools/mcp-extensions/plugins-distribution).

## 2.5 Mapping to a "per-role skill library shared across a company"

This maps almost 1:1 onto the platform's requirement (FSE builds per-role skills on-site; skills visible/shared by job role):

- **Skill = the unit of role-specific procedural knowledge.** One skill per role-task ("close-out a store inventory count," "run the nightly reconciliation"), with `description` written so it triggers for that role's language.
- **Plugin = the per-role library.** Bundle a role's skills (+ its MCP connector configs + `allowed-tools` limits + any hooks) into a **role plugin** (e.g., `role-store-manager`, `role-field-tech`). Version it; distribute via an internal marketplace (private GitHub repo).
- **Visibility by role** = install the right role-plugin(s) for a user, and/or gate at the **enterprise/managed** scope. Since only `name`+`description` are preloaded, an agent isn't cluttered with skills for roles the user doesn't hold.
- **`allowed-tools` ties skills to permitted MCP tools**, so a role's skills can only drive the connectors that role is authorized for — this dovetails with the MCP scope/role enforcement in §1.5.
- **Caveat to design around:** native **centralized org-wide skill management is a claude.ai gap**; for a governed enterprise product you'll likely run on **Claude Code / Agent SDK / your own host** and manage distribution through **plugins + an internal marketplace + managed settings**, not claude.ai's consumer surface.

---

# 3. Combining MCP + Skills + a general agent loop (enterprise)

## 3.1 The layered architecture

```
┌─────────────────────────────────────────────────────────────┐
│ Agent loop (host)  — plans, calls tools, reads results, iterates
│   • Preloads Level-1 skill metadata for the user's role(s)
│   • On matching request → loads SKILL.md (procedure)
│   • Skill instructs which MCP tools to call, in what order
│                                                               │
│   ├── SKILLS  (how)      role plugins, allowed-tools gated    │
│   └── MCP CLIENTS (what) ── connect to ──┐                    │
└──────────────────────────────────────────┼───────────────────┘
                                            │  OAuth2.1 Bearer
                                   ┌────────▼─────────┐
                                   │  MCP GATEWAY     │  IdP auth, RFC 8693
                                   │  downscope/OBO   │  token exchange, audit
                                   └────────┬─────────┘
                        ┌───────────────────┼───────────────────┐
                   MCP server A         MCP server B         MCP server C
                   (CRM connector)     (inventory)          (ticketing)
                   role-filtered tools, resource-server token validation
```

**Division of labor:**
- **Agent loop** = orchestration (plan → act → observe → repeat).
- **Skills** = the *role-specific playbook* telling the agent how to sequence work (loaded progressively, so context stays lean).
- **MCP** = the *live capabilities* the skill drives, one connector per company system.
- **Gateway + IdP** = identity, per-role scoping, downscoping, and audit.

## 3.2 Recommended design decisions for the platform

1. **Connectors as remote MCP servers behind a gateway.** FSE builds a connector once; the gateway (RFC 8693 OBO + IdP) makes it safely multi-user and per-role. Don't put long-lived system credentials in the connector — use gateway token exchange + Vault fallback.
2. **Roles drive both layers.** A job role determines (a) which **role-plugin (skill library)** is installed/visible and (b) which **OAuth scopes** the user's token carries → which **MCP tools** resolve. Keep these two definitions in sync (ideally generated from one role model in the IdP).
3. **`allowed-tools` on every skill.** Constrain each skill to the minimal MCP toolset its role needs — defense-in-depth alongside server-side scope checks.
4. **Least-privilege, progressive scopes** at the MCP layer; **human-in-the-loop** confirmation for high-risk tools.
5. **Treat FSE-authored skills and connectors as reviewed artifacts.** They're executable code + model-facing instructions → same review bar as a dependency. Sign/version via plugins; distribute via a private marketplace; audit tool descriptions for poisoning.
6. **Audit everything at the gateway** with correlation IDs and preserved user identity (subject/actor tokens) across hops.

## 3.3 Security must-haves (consolidated)

- Validate token **audience** — never passthrough (RFC 8707/8693).
- **Per-client consent** at any OAuth proxy (confused-deputy).
- Treat **tool descriptions & skill instructions as untrusted** input; guard against poisoning/injection; pin & review skill/connector versions (rug-pull defense).
- **No omnibus scopes**; least-privilege + incremental elevation.
- Sandbox skill code execution; restrict network egress where the surface allows.
- Full **audit trail**, per-role access differentiation, and no borrowed/shared agent identity (the governance gaps that bite most teams in practice).

---

# 4. Key uncertainties & things to verify before building

1. **Current spec revision.** `latest` resolved to **2025-11-25** during this research; confirm at build time — revisions are date-stamped and evolving. The blog-claimed **"MCP Spec 1.2 (June 2026)" is unverified** and inconsistent with the official date-stamp scheme — do **not** design around it.
2. **Skill precedence order** (enterprise > personal > project) is from secondary sources; verify against official Claude Code docs if it drives a security boundary.
3. **`allowed-tools` and other optional frontmatter fields** are documented for Claude Code / SDK; behavior can differ across host surfaces (claude.ai vs API vs Claude Code). Validate on your target host.
4. **Org-wide skill governance on claude.ai is limited** today; plan to run on Claude Code / Agent SDK / your own host for enterprise distribution and admin control.
5. **Adoption/market-share figures** from vendor blogs are directional, not audited.

---

## Appendix: primary sources

**MCP — official:** [spec/latest](https://modelcontextprotocol.io/specification/latest) · [architecture](https://modelcontextprotocol.io/docs/learn/architecture) · [authorization 2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization) · [security best practices](https://modelcontextprotocol.io/specification/2025-06-18/basic/security_best_practices) · [authorization tutorial](https://modelcontextprotocol.io/docs/tutorials/security/authorization) · [Anthropic: donation to Agentic AI Foundation](https://www.anthropic.com/news/donating-the-model-context-protocol-and-establishing-of-the-agentic-ai-foundation)

**Skills — official:** [overview](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview) · [best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices) · [Anthropic engineering blog](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills) · [Claude Code skills](https://docs.claude.com/en/docs/claude-code/skills) · [Agent SDK skills](https://docs.claude.com/en/api/agent-sdk/skills) · [plugin marketplaces](https://code.claude.com/docs/en/plugin-marketplaces)

**Auth / enterprise / security (secondary):** [RFC 8693 token exchange](https://www.rfc-editor.org/info/rfc8693/) · [Red Hat MCP Gateway](https://developers.redhat.com/articles/2025/12/12/advanced-authentication-authorization-mcp-gateway) · [GitGuardian OAuth patterns](https://blog.gitguardian.com/oauth-for-mcp-emerging-enterprise-patterns-for-agent-authorization/) · [Solo.io agentgateway OBO](https://docs.solo.io/agentgateway/2.2.x/mcp/token-exchange/obo/delegation/) · [Gravitee 4.11](https://www.gravitee.io/blog/trusted-on-behalf-of-agent-delegation-in-gravitee-4.11) · [WorkOS MCP auth](https://workos.com/blog/mcp-auth-developer-guide) · [Microsoft: state of MCP security 2026](https://techcommunity.microsoft.com/blog/microsoft-security-blog/the-state-of-mcp-security-in-2026/4531327) · [Invariant/glasp tool poisoning](https://glasp.co/articles/mcp-security-tool-poisoning-supply-chain) · [Elastic Security Labs](https://elastic.co/security-labs/mcp-tools-attack-defense-recommendations)
