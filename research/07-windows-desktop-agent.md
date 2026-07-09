# Building the Client for an Enterprise AI Agent (Windows Desktop)

**Research date:** 2026-07-08
**Scope:** Client architecture for an enterprise AI agent that ships as a Windows desktop app, reads/writes local files, performs local "agent" operations (file management, GUI/computer automation), and talks to a cloud/on-prem backend that does the heavy reasoning, RAG, and permissioned tool calls.

> **Honesty note on sources.** Primary/authoritative sources (Microsoft Learn, Tauri v2 docs, Anthropic platform docs, RFCs, electron.build, electron/electron advisories) are cited directly and are reliable. Many framework/benchmark comparisons come from vendor-adjacent blogs; their headline numbers (bundle size, memory, "X% smaller", adoption %, Gartner stats) are **directional, not authoritative** and are flagged inline. Validate specific numbers against official docs and your own benchmarks before committing budget.

---

## 0. TL;DR Recommendation

- **Framework:** For a *net-new* client where you want a rich chat UI, a web-tech stack, and the smallest footprint with a security-by-default model, **Tauri v2** is the strongest technical fit. If your team is JS-only, needs guaranteed identical rendering across a locked-down fleet, or wants the most battle-tested ecosystem today, **Electron** is the safe pragmatic pick. If you are an all-Microsoft shop that wants deepest native Windows/Win32/UI-Automation integration and MSAL/WAM auth for free, **WinUI 3 (Windows App SDK)** or an existing **WPF** investment is defensible.
- **Tool split:** Run **file ops and local automation locally** (behind a scoped, consent-gated broker); run **reasoning, RAG, and permissioned/business tools in the backend**. Use **MCP** as the tool protocol on both sides: local stdio MCP servers on the machine, remote (Streamable HTTP) MCP servers in the cloud.
- **Auth:** **OAuth 2.0 Authorization Code + PKCE** via the **system browser + loopback redirect** (RFC 8252). On Microsoft stacks use **MSAL + WAM broker**. Store tokens in **Windows Credential Manager (DPAPI-backed)** or the OS keychain via the framework's secure-storage plugin. Offer **device code flow** for headless/air-gapped/kiosk.
- **Deployment:** **MSIX** (via **Intune**/App Installer) for modern managed fleets; **MSI** for GPO/SCCM shops with legacy needs. Code-sign with an **OV cert from a trusted CA** (EV no longer buys instant SmartScreen trust). Auto-update via App Installer `.appinstaller` (MSIX) or `electron-updater`/Tauri updater (per framework), pointed at an internal HTTPS/UNC endpoint for air-gapped.
- **Safety:** Least-privilege capability scoping, **human-in-the-loop approval for destructive/high-impact actions**, tamper-evident **local audit log** shipped to SIEM, and **prompt-injection isolation** (treat all file/web/screenshot content as untrusted).

---

## 1. Desktop App Frameworks

### 1.1 The core architectural fork

Every trade-off below traces to one decision: **how the UI is rendered.**

- **Electron** bundles a full Chromium engine + Node.js runtime in every app. Identical rendering everywhere; you ship (and must patch) a browser with each release. ([digitalapplied](https://www.digitalapplied.com/blog/desktop-apps-web-stack-tauri-electron-deno-wails-2026))
- **Tauri v2** renders in the OS-native WebView (WebView2/Chromium on Windows) with a **Rust** core (sub-600 KB). Tiny footprint; rendering can vary by machine WebView version, and browser security patches ride OS updates. ([digitalapplied](https://www.digitalapplied.com/blog/desktop-apps-web-stack-tauri-electron-deno-wails-2026), [vanja.io](https://vanja.io/tauri-2-new-default/))
- **.NET (WPF/WinUI 3/MAUI)** renders native Windows controls; deepest OS integration, C#/XAML, no web engine. WPF supported through .NET 10+; WinUI 3 is Microsoft's forward-looking Windows-first stack; MAUI only when you truly need mobile. ([wojciechowski.app](https://wojciechowski.app/en/articles/wpf-modernization-2025), [softwarelogic](https://softwarelogic.co/en/blog/the-future-of-windows-why-winui-3-is-overtaking-wpf), [telerik](https://www.telerik.com/blogs/wpf-net-maui-how-choose))
- **Flutter desktop** renders via its own Skia/Impeller engine (not native controls, not a webview); one codebase across mobile/web/desktop, Dart language. Strong for custom-drawn UI; Windows-native integration and enterprise MDM story are less mature than the above.

### 1.2 Comparison table

Numbers are directional (blog-sourced ranges); treat as order-of-magnitude, not spec.

| Dimension | **Electron** | **Tauri v2** | **.NET (WinUI 3 / WPF)** | **Flutter desktop** |
|---|---|---|---|---|
| Language | JS/TS (+ Node) | JS/TS frontend + **Rust** core | **C#/XAML** | **Dart** |
| Renderer | Bundled Chromium | OS WebView (WebView2) | Native Windows controls | Own engine (Skia/Impeller) |
| Installer size | ~80–150 MB | ~2–10 MB | ~small–moderate (needs .NET runtime/SDK) | ~15–40 MB |
| Idle memory | ~150–300 MB | ~20–50 MB | Low–moderate (native) | Low–moderate |
| Chat UI ease | Excellent (full web stack) | Excellent (full web stack) | Moderate (build in XAML or embed WebView2) | Good (rich custom UI, fewer ready chat libs) |
| Local FS access | Full (Node `fs`) — must lock down | **Scoped via capabilities/permissions** (secure by default) | Full native .NET APIs | Full via `dart:io`/plugins |
| Native Windows integration | Via native modules | Via Rust/plugins | **Best-in-class** (Win32/UIA/WinRT) | Via plugins (FFI) |
| Security model | Permissive by default; **must** enable sandbox/contextIsolation, harden IPC | **Deny-by-default** capability/scope system + Rust memory safety | OS-native; you design it | App-level; you design it |
| Windows patch model | You ship Chromium patches in app updates | WebView2 patched via OS/Edge updates | OS/.NET servicing | You ship engine in app |
| Enterprise deploy | MSI/AppX/NSIS; huge precedent (VS Code, Slack, Teams) | MSI/NSIS + updater; MSIX possible | **Native MSIX/MSI**, Intune/SCCM first-class | MSIX/MSI via tooling; less trodden |
| Auth story | DIY / any lib | DIY / any lib | **MSAL + WAM broker built-in** | DIY / plugins |
| Ecosystem maturity | **Highest** | Rising fast since 2.0 (late 2024) | High (Microsoft-backed) | High (Google-backed), desktop newest |
| Best when | JS team, need identical rendering, control patching in-app | Footprint + security-first, team OK with Rust | All-MS shop, deepest Windows/automation integration | Shared mobile+desktop custom UI |

Sources: bundle/memory ranges ([openreplay](https://blog.openreplay.com/comparing-electron-tauri-desktop-applications/), [chandrahasa](https://tech.chandrahasa.com/electron-vs-tauri-framework-matchup/), [markaicode](https://markaicode.com/vs/tauri-vs-electron/), [raftlabs](https://raftlabs.medium.com/tauri-vs-electron-a-practical-guide-to-picking-the-right-framework-5df80e360f26)); .NET guidance ([Microsoft VS Live](https://learn.microsoft.com/en-us/shows/visual-studio-live-2024/building-a-modern-native-application-for-windows-which-ui-framework-should-you-choose), [scichart](https://www.scichart.com/blog/wpf-vs-winforms-vs-maui/)).

### 1.3 Recommendation and reasoning

For a chat-centric agent client, a **web UI stack wins on chat-UI velocity** (streaming markdown, code blocks, rich components, existing React/Vue libraries). That narrows the practical choice to **Tauri vs Electron** unless you have a strong Microsoft-native mandate.

- **Choose Tauri v2** if: footprint/memory matter (many enterprise endpoints are RAM-constrained), you want a **deny-by-default filesystem/command security model out of the box** (a big deal for an agent that touches local files), and your team can own a Rust core (or keep it thin). Trade-off: per-machine WebView2 variance (mitigated in practice because WebView2 is evergreen Chromium on Windows) and a smaller ecosystem.
- **Choose Electron** if: JS-only team, you need pixel-identical rendering across a heterogeneous fleet, or you want the deepest ecosystem/precedent. Trade-off: 10–30x larger, heavier RAM, and **you own Chromium CVE patching** — recent 2026 context-isolation bypass CVEs show this is a real, ongoing burden ([securityonline](https://securityonline.info/electron-security-vulnerabilities-sandbox-escape-context-isolation/), [electron GHSA](https://github.com/electron/electron/security/advisories/GHSA-p7v2-p9m8-qqg7)).
- **Choose WinUI 3 / WPF** if: you're all-Microsoft, want MSAL/WAM auth and Win32/UI-Automation integration natively, and are fine building the chat UI in XAML or hosting a WebView2 for the transcript. Best "computer use / RPA" integration story on Windows.
- **Flutter desktop:** compelling only if you're **also** shipping the same UI to mobile with a custom (non-native) look; otherwise it adds a Dart ecosystem without a decisive desktop-agent advantage.

**Net:** Default to **Tauri v2** for a new, security-sensitive, file-touching agent client; fall back to **Electron** for team/ecosystem reasons; pick **WinUI 3** for a Microsoft-native mandate.

---

## 2. Local File Access & "Computer Use" / Automation

### 2.1 Safe local filesystem read/write

The agent will read/write user files, so the local FS surface is the primary blast radius. Principles:

1. **Never expose raw FS APIs to the UI/LLM layer.** Route every file op through a **narrow, typed broker** in the trusted core that enforces path scoping, size limits, and type checks.
2. **Path scoping / allowlisting.** Constrain operations to explicitly granted roots (e.g., a chosen project folder, `%USERPROFILE%\Documents\<app>`), reject path traversal (`..`), symlink escapes, and UNC/network paths unless explicitly allowed.
3. **User consent gates.** First access to a new folder should require an explicit user grant (folder picker), remembered as a capability. Destructive ops (delete, overwrite, bulk move) get a confirmation step.
4. **Framework mechanics:**
   - **Tauri v2** is purpose-built for this: the **capability/permission/scope** system gates which commands the WebView can call and **which paths** the FS commands accept; the Rust core has full access, the WebView reaches it only through IPC. Command **scopes** are exactly how you limit reachable paths; **capabilities** bind permissions+scopes to windows; the **Isolation Pattern** adds an IPC-validation layer; CSP constrains what the WebView loads. ([Tauri v2 security](https://v2.tauri.app/security/))
   - **Electron** requires you to build this discipline yourself: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, expose only minimal validated functions over `contextBridge`, never hand the renderer `fs`/`ipcRenderer` directly, validate all args on the main side, strict CSP. ([Electron context isolation](https://www.electronjs.org/docs/tutorial/context-isolation), [contextBridge best practices](https://openillumi.com/en/en-electron-contextbridge-security-best-practices/))
   - **.NET/Flutter:** you own the broker design end-to-end; wrap `System.IO`/`dart:io` behind a scoped service.

### 2.2 "Computer use" / GUI automation — capabilities and risks

Two families of desktop automation, with a sharp reliability/robustness trade-off:

**A. Screenshot + coordinate (vision) automation — e.g., Anthropic Computer Use, OpenAI operator-style.**
- Anthropic's **computer use tool** gives the model **screenshot capture + mouse + keyboard control**, and can be augmented with **bash** and **text editor** tools for fuller workflows. Current beta header `computer-use-2025-11-24` supports Claude Sonnet 5 / Opus 4.8 / 4.7 / 4.6 / 4.5 and Sonnet 4.6. It runs a loop: screenshot → model picks an action (click x,y / type / key) → execute → screenshot again. ([Anthropic computer use tool](https://platform.claude.com/docs/en/docs/agents-and-tools/tool-use/computer-use-tool))
- **Capabilities:** operate **any** app or website with no API/accessibility support, exactly as a human would. OSWorld benchmark reportedly climbed from <15% (2024 preview) to ~72.5% (early 2026) per secondary reporting; enterprise GA arrived via Microsoft Copilot Studio in May 2026 per a vendor blog — treat both as **directional, secondary** claims. ([aiinasia](https://aiinasia.com/guides/claude-computer-use-desktop-automation), [digitalapplied playbook](https://www.digitalapplied.com/blog/agent-computer-use-enterprise-automation-playbook))
- **Risks (from Anthropic's own docs):** high **latency** (~seconds/action) and imperfect reliability; **coordinate hallucination**; and critically **prompt injection** — "Claude will sometimes follow commands found in content [webpages/images] even when they conflict with your instructions." Anthropic's stated precautions: run in a **dedicated VM/container with minimal privileges**, **don't give access to sensitive data/accounts**, **allowlist domains**, and **require human confirmation for consequential actions** (financial transactions, ToS, cookies). A classifier flags likely injections and forces a confirmation prompt. Do not use for tasks needing perfect precision or with sensitive data without human oversight. ([Anthropic computer use tool](https://platform.claude.com/docs/en/docs/agents-and-tools/tool-use/computer-use-tool))

**B. Accessibility-tree / UI Automation (structured) — e.g., Windows UI Automation (UIA), FlaUI, Power Automate Desktop, RPA.**
- Interacts with UI **elements by property** (via the UIA provider/client model), not pixels: resolution/DPI-independent, faster, more deterministic. **FlaUI** is a .NET wrapper over UIA covering Win32/WPF/WinForms/UWP. ([FlaUI](https://mcpmarket.com/server/flaui), [MSAA vs UIA](https://learn.microsoft.com/en-us/windows/win32/winauto/microsoft-active-accessibility-and-ui-automation-compared))
- **Caveats:** depends on apps exposing a well-formed automation tree — many don't; unstable window handles, OS dialogs, DPI drift, and non-standard trees cause misses (Microsoft documents "element picker sees no elements" cases). ([accelq](https://www.accelq.com/blog/desktop-application-testing-tools/), [Power Automate troubleshooting](https://learn.microsoft.com/en-us/troubleshoot/power-platform/power-automate/desktop-flows/ui-automation/element-picker-cant-see-elements))

**Practical stance:** Prefer **structured UIA/RPA where the target app cooperates** (deterministic, auditable, cheap). Reserve **vision-based computer use for the long tail** of apps with no API/accessibility surface, and only inside a **sandboxed, minimally-privileged, human-supervised** context. Both approaches are slower and riskier than a real API — always prefer a backend tool/API call over driving a GUI when one exists.

### 2.3 Local vs remote tool execution — the split

| Run **locally** (on the client machine) | Run **remotely** (backend) |
|---|---|
| File read/write/search within scoped roots | LLM reasoning / planning / orchestration |
| Local folder org, rename, move (consent-gated) | **RAG** over corporate corpora, vector DB |
| Opening/among local apps; UIA/RPA automation | Permissioned business tools (CRM, ticketing, DBs) |
| Reading local clipboard/selection (with consent) | Anything needing secrets/service creds |
| Local git, local build/test runners | Cross-user/shared-state actions, approvals |
| Screenshot capture for computer use | Policy engine, audit aggregation, SIEM |

**Rationale:** local tools need to touch the user's machine and should run with the **user's** privileges under tight scoping; backend tools need **service credentials, shared data, and centralized policy/audit** and must never have those secrets shipped to the client. This maps cleanly onto **local MCP servers vs remote MCP servers** (next section).

---

## 3. Hybrid Architecture: Thin Client + Cloud Brain

### 3.1 The recommended shape

**Thin-ish client, cloud brain.** The client is a **UI + local tool host + secure transport**, not the reasoning engine. The backend owns the model calls, RAG, planning, policy, and permissioned tools. This keeps IP/prompts/secrets server-side, centralizes audit and rate-limiting, lets you upgrade the "brain" without reshipping the app, and shrinks the client attack surface.

But the client is **not** a dumb terminal: it hosts **local tool execution** (file ops, automation) that the cloud brain *calls back into*. The clean way to express that is **MCP**.

### 3.2 MCP as the tool fabric (local stdio + remote HTTP)

- **MCP** (Model Context Protocol, Anthropic-originated open standard) is JSON-RPC 2.0 exposing **tools, resources, prompts**. Transports: **stdio** (local child process) and **Streamable HTTP** (remote). ([Anthropic MCP](https://www.anthropic.com/news/model-context-protocol), [modelcontextprotocol.io local servers](https://modelcontextprotocol.io/docs/develop/connect-local-servers), [composio](https://composio.dev/blog/mcp-server-step-by-step-guide-to-building-from-scrtch))
- **Local MCP servers over stdio** run **on the user's machine** as child processes of the client — this is exactly how Claude Desktop does local file access with per-action permission. Data stays on the machine. ([modelcontextprotocol.io](https://modelcontextprotocol.io/docs/develop/connect-local-servers))
- **Remote MCP servers** (backend, Streamable HTTP) expose the permissioned business/RAG tools.
- **Who is the MCP client?** In this architecture you have a choice: (a) the **desktop client** is the MCP host and connects to both local stdio servers and remote servers, forwarding tool schemas to the backend model; or (b) the **backend** is the MCP host for remote tools, and calls **back** to the client for local tools via your own transport. A common robust pattern is **hybrid**: backend hosts remote MCP servers directly; the desktop app hosts local stdio MCP servers and bridges them to the backend as a "local tools" provider over the authenticated client<->backend channel. This keeps local execution local while letting the cloud brain orchestrate everything.

### 3.3 Packaging local servers: MCPB (formerly DXT / "Desktop Extensions")

- **MCPB** (`.mcpb`, renamed from DXT) is a **zip archive** containing a local MCP server + `manifest.json`, analogous to `.vsix`/`.crx`, for **one-click local MCP server install** in desktop apps. Claude for Windows/macOS loads/verifies them and provides auto-update + config UI. ([anthropics/mcpb](https://github.com/anthropics/mcpb), [Anthropic desktop extensions](https://www.anthropic.com/engineering/desktop-extensions))
- **Runtime:** Node.js is recommended because **Node ships with Claude Desktop** (zero extra install); Python/UV/binary are also supported but heavier to bundle. If you build your own client you can adopt the same format and **bundle your own Node runtime** so local servers "just work." Config/env is passed via `mcp_config.env`; full field spec in the repo's `MANIFEST.md`. ([anthropics/mcpb](https://github.com/anthropics/mcpb))
- **Enterprise controls (uncertain):** the mcpb repo/blog I reviewed **do not** document group-policy allowlists/blocklists for extensions. Claude Desktop's enterprise MDM controls for MCP exist in Anthropic's admin/enterprise docs, which I did not fully verify here — **treat extension governance as something to confirm** against current Anthropic enterprise documentation, and plan to **enforce your own allowlist** of permitted local servers in your client rather than relying on a third party's.

### 3.4 Local model option (Ollama) — worth it?

- **State of play:** local inference (Ollama/llama.cpp) is production-viable in 2026; open-weight models rival proprietary on many tasks, and consumer GPUs can run large models. Ollama now also has a cloud option. ([sitepoint](https://www.sitepoint.com/local-vs-cloud-ai-coding-performance-analysis-2026/), [effloow](https://effloow.hashnode.dev/self-hosting-llms-vs-cloud-apis-cost-performance-privacy-2026), [daily.dev](https://daily.dev/blog/running-llms-locally-ollama-llama-cpp-self-hosted-ai-developers)) (Adoption/benchmark figures are blog-sourced; directional.)
- **Verdict for this product:** **Not the primary brain, but a valuable optional tier.** Reasons:
  - Frontier agentic reasoning + RAG quality still favors the cloud/on-prem backend; hardware across an enterprise fleet is uneven (many endpoints lack a capable GPU).
  - **Where local models genuinely help:** (1) **privacy/air-gapped modes** where data cannot leave the machine, (2) **offline** operation, (3) cheap **local pre/post-processing** (PII redaction before cloud calls, quick classification, embedding for local file search). ([markaicode offline vs cloud](https://markaicode.com/vs/offline-ai-vs-cloud-ai/), [starryhope](https://www.starryhope.com/ai/ollama-cloud-vs-local-ai-hardware-2026/))
  - **Recommended pattern:** a **routing layer** — sensitive/offline/lightweight → local (Ollama); everything else → backend. For a strict on-prem customer, the "cloud brain" can itself be a **self-hosted backend**, which is a better privacy story than per-endpoint local models.

---

## 4. Auth on Desktop

### 4.1 The flow

- **Use OAuth 2.0 Authorization Code + PKCE** via the **system browser** with a **loopback (127.0.0.1) redirect**, per **RFC 8252** (OAuth for native apps). **Do not use embedded webviews** for login — an embedded browser can intercept credentials and the user can't verify the IdP. ([RFC 8252 guidance via OpenReplay](https://blog.openreplay.com/add-authentication-electron-app/), [Okta grant types](https://developer.okta.com/docs/guides/implement-grant-type/implicit/main/))
- Desktop apps are **public clients** — no securely storable client secret — which is precisely why **PKCE is mandatory** (and under OAuth 2.1, PKCE is required for all auth-code clients). ([nerdleveltech / OAuth 2.1](https://nerdleveltech.com/de/unlock-the-power-of-oauth-a-journey-to-secure-and-reliable-applications/))
- **Entra ID** and **Okta** both support this flow; Entra requires a user-agent capable of redirecting back to the app. ([Microsoft identity platform auth code flow](https://docs.microsoft.com/entra/identity-platform/v2-oauth2-auth-code-flow))
- **Device Code (Device Authorization) flow** for headless/kiosk/air-gapped or where a local browser+loopback isn't viable: user enters a code on a second device. Good fallback tier.
- **Enterprise SSO:** federate through the customer's IdP (Entra ID / Okta) so **MFA and Conditional Access** apply. Support **SCIM** provisioning where the backend needs user/group sync.

### 4.2 Microsoft stack shortcut: MSAL + WAM

If the client is .NET (or you accept a native module), **MSAL** handles the flow, token cache, and silent refresh; on Windows it can use the **Web Account Manager (WAM)** OS **authentication broker**, which integrates with accounts Windows already knows and generally improves security over self-managed tokens. Strongly recommended for Entra-centric deployments. ([MSAL token acquisition](https://learn.microsoft.com/en-us/entra/msal/dotnet/acquiring-tokens/overview), [MSAL + WAM](https://learn.microsoft.com/de-de/entra/msal/dotnet/acquiring-tokens/desktop-mobile/wam))

### 4.3 Secure token storage

- **Windows Credential Manager** is the recommended store for native Windows clients; it's **DPAPI-backed** (encryption tied to user/machine context). ([Stack Overflow / native token storage](https://stackoverflow.com/questions/68652599/where-to-store-oauth2-access-refresh-tokens-using-a-native-windows-desktop-cli), [Is Credential Manager secure](https://umatechnology.org/is-windows-credential-manager-secure/))
- Framework mapping: **Tauri** → stronghold/secure-storage or OS keychain plugin; **Electron** → `safeStorage` (DPAPI on Windows) or keytar-style; **.NET** → MSAL cache + DPAPI/Credential Manager; **Flutter** → `flutter_secure_storage`.
- **Never** store tokens in plaintext/localStorage/config files. Store **refresh tokens** in the OS store, keep **access tokens** in memory where feasible, and **revoke/delete on logout**. ([Google OAuth best practices](https://developers.google.com/identity/protocols/oauth2/resources/best-practices), [Auth0 token best practices](https://auth0.com/docs/secure/tokens/token-best-practices))
- **Known edge case:** DPAPI master-key issues in **hybrid/domain-joined** setups (e.g., error `0x80090345` after Windows 24H2 updates when off the corporate network) — build **graceful re-auth fallback**. Also test refresh-token lifetimes (reports of 24h expiry in some OTP/mobile-desktop configs vs expected ~90 days). ([Microsoft Q&A – Credential Manager](https://learn.microsoft.com/en-us/answers/questions/5516807/credential-manager-issues-(0x80090345)-after-windo), [Microsoft Q&A – refresh token](https://learn.microsoft.com/en-us/answers/questions/2284140/msal-refresh-token-expires-after-24-hours-for-mobi))

---

## 5. Enterprise Windows Deployment & Management

### 5.1 Packaging: MSIX vs MSI

- **MSIX** is Microsoft's modern format (since 2018), positioned as the successor to MSI/ClickOnce: clean install/uninstall, reduced attack surface, faster patch cycles, containerized. Best for modern managed fleets. ([MSDN MSIX](https://learn.microsoft.com/en-us/archive/msdn-magazine/2019/june/devops-msix-the-modern-way-to-deploy-desktop-apps-on-windows), [TechTarget MSI vs MSIX](https://www.techtarget.com/searchenterprisedesktop/tip/Comparing-MSI-vs-MSIX), [Camwood](https://camwood.com/blog/msix-deep-dive-enterprise-app-packaging-automation))
- **MSI** remains the workhorse for **GPO/SCCM** shops and legacy customizations; electron-builder exposes an MSI target specifically for GPO/SCCM. Many enterprises want MSI *and* MSIX during transition. ([electron-builder targets](https://www.electron.build/docs/targets))
- **Framework packaging reality:**
  - **Electron** (electron-builder): **NSIS** (default, pairs with `electron-updater`, per-user no-admin installs), **MSI** (GPO/SCCM), **AppX/MSIX** (Store/Intune). Note: **MSI and AppX/MSIX are *not* supported by electron-updater** — for those you manage updates via enterprise tooling. ([electron-builder targets](https://www.electron.build/docs/targets))
  - **Tauri**: produces MSI + NSIS; has its own **updater plugin** (signs artifacts with an updater key via `TAURI_SIGNING_PRIVATE_KEY`) against an update server or static JSON. MSIX is possible but less first-class than .NET's. ([Tauri updater](https://tauri.app/plugin/updater/), [Tauri Windows signing](https://tauri.app/distribute/sign/windows/))
  - **.NET/WinUI 3**: **native MSIX** with first-class Intune/SCCM support — the smoothest enterprise packaging story.

### 5.2 Distribution: Intune / SCCM

- **Intune** deploys MSIX silently (no user interaction); package metadata auto-populates from the package. **Signing is required before upload**; if self-signed, you must first push a **Trusted Certificate profile** to devices or installs fail. ([Deploy MSIX with Intune](https://learn.microsoft.com/en-us/windows/msix/desktop/managing-your-msix-deployment-intune), [Deploy MSIX via Intune admin center](https://learn.microsoft.com/en-us/windows/msix/desktop/managing-your-msix-deployment-mem-adminconsole))
- ISV reality check: whether IT accepts your installer often comes down to whether they can deploy it cleanly via **Intune / Configuration Manager / co-management** with the artifacts you ship. ([Codenote ISV playbook](https://www.codenote.net/en/posts/windows-desktop-app-intune-distribution-isv-playbook/))
- The **Microsoft Store** path re-signs MSIX for you (no cert management) but is usually not the enterprise channel. ([Choose a distribution path](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/choose-distribution-path), [Code signing options](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options))

### 5.3 Code signing — the 2024/2025 change

- **EV certificates no longer grant instant SmartScreen reputation.** Microsoft's change made cert types effectively equal for reputation; reputation now **builds per version starting from zero** and doesn't transfer across versions unless signed under the **same publisher identity**. Even EV-signed apps can show warnings until reputation accrues. ([DigiCert advisory](https://knowledge.digicert.com/alerts/ev-signed-application-showing-microsoft-defender-smartscreen-warnings), [Microsoft SmartScreen reputation](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation))
- **Self-signed certs do nothing for SmartScreen** (no reputation, no trusted chain). Use a cert from a **trusted CA**; **OV + consistent publisher identity** is the pragmatic choice now that EV's instant-trust edge is gone. Note the industry move to **cloud/HSM-based signing key storage**. ([community signing note](https://raw.githubusercontent.com/xt0n1-t3ch/DLSSync/HEAD/docs/signing-reality.md))

### 5.4 Auto-update

- **MSIX**: `.appinstaller` (XML) points at where the package lives and how to update (check-on-launch, hide prompt, force-latest); supports "related sets." App Installer APIs allow **programmatic, code-driven updates**. ([Auto-update and repair](https://learn.microsoft.com/en-us/windows/msix/app-installer/auto-update-and-repair--overview), [App Installer APIs](https://techcommunity.microsoft.com/blog/modernworkappconsult/getting-full-control-over-msix-updates-with-the-app-installer-apis/3371344))
- **Electron**: `electron-updater` with the **NSIS** target.
- **Tauri**: built-in updater plugin (separate signing key from OS code signing).

### 5.5 Offline / air-gapped

- **App Installer isn't preinstalled on Windows Server** and normally self-updates via the Store — in air-gapped setups you must **sideload App Installer + framework deps** as offline packages. ([Install/update App Installer](https://learn.microsoft.com/en-us/windows/msix/app-installer/install-update-app-installer), [Advanced Installer](https://www.advancedinstaller.com/enable-msix-auto-updates-through-appinstaller-file.html))
- **Point `.appinstaller` at an internal HTTPS server or UNC share**; host packages inside the boundary. Sign with a cert whose chain your fleet already trusts (**no online revocation checks** in air-gapped). ([Update non-Store apps from code](https://learn.microsoft.com/en-us/windows/msix/non-store-developer-updates))
- The **MSIX Packaging Tool driver** is a Feature-on-Demand from Windows Update — has a documented **disconnected-environment** workflow. ([Disconnected environment](https://learn.microsoft.com/en-ie/windows/msix/packaging-tool/disconnected-environment))
- **Air-gapped checklist:** sideload App Installer + deps → sign all packages with fleet-trusted cert → host MSIX + `.appinstaller` on internal HTTPS/UNC → configure update policy → optionally drive updates via App Installer APIs. Pair with an **on-prem backend** and **local model** tier for a fully offline agent.

---

## 6. Security: Guarding an Agent That Acts Locally

An agent with local file + automation power is a **new class of insider-risk surface**. The security model must assume the model can be **manipulated via prompt injection** from file contents, web pages, and screenshots.

### 6.1 Least-privilege capability boundaries

- Grant the agent only the **tools, paths, network, secrets, and budgets** the current task needs; everything else is unavailable, auditable, or requires approval. ([Devspedia sandboxing](https://devspedia.com/sandboxing-tool-using-ai-agents/))
- Enforce this in the **client core** (Tauri capabilities/scopes; Electron validated contextBridge) **and** in the **backend policy engine** — defense in depth.

### 6.2 Human-in-the-loop (HITL) for destructive/high-impact actions

- **Gate by risk, not everything** — checkpoints on high-impact/low-confidence/high-value actions to avoid oversight fatigue. ([Tines HITL](https://www.tines.com/blog/human-in-the-loop-workflows-where-intelligent-automation-meets-judgment/), [Blockchain Council HITL](https://www.blockchain-council.org/claude-ai/human-in-the-loop-engineering-safe-reliable-ai-systems/))
- **Action-level approvals:** agent proposes → system wraps with metadata → human signs off (in-app / Slack / Teams) for privileged ops. ([hoop.dev action-level approvals](https://hoop.dev/blog/how-to-keep-ai-data-lineage-ai-in-devops-secure-and-compliant-with-action-level-approvals/))
- **Concretely for this client:** require explicit confirmation for **delete / overwrite / bulk move / move outside scoped roots / execute process / any computer-use click on a consequential control** (financial, ToS, credential entry). Anthropic's computer-use guidance echoes requiring human confirmation for consequential actions. ([Anthropic computer use tool](https://platform.claude.com/docs/en/docs/agents-and-tools/tool-use/computer-use-tool))
- Default to **preview + dry-run + undo** (e.g., move-to-recycle-bin instead of hard delete; show a diff before writing).

### 6.3 Sandboxing / isolation

- For **computer use** and untrusted automation, Anthropic recommends a **dedicated VM/container with minimal privileges**, **no access to sensitive data**, and **domain allowlists**. Their reference implementation runs everything in a **Docker container with a virtual X11 display**. ([Anthropic computer use tool](https://platform.claude.com/docs/en/docs/agents-and-tools/tool-use/computer-use-tool))
- Enterprise isolation options span **Firecracker microVMs** (strongest, regulated data), **gVisor** (syscall-level), and **V8 isolates** (lightweight). ([BeyondScale sandboxing](https://beyondscale.tech/blog/ai-agent-sandboxing-enterprise-security-guide), [NVIDIA govern agents](https://developer.nvidia.com/blog/how-to-govern-autonomous-agents-in-enterprise-ai-factories))
- On the desktop, at minimum: run the local tool broker as a **separate least-privilege process**, keep the WebView **sandboxed** (Electron) or **capability-scoped** (Tauri), and consider a **VM/container for computer-use tasks** rather than driving the user's live primary desktop.

### 6.4 Prompt-injection & data-exfiltration defense

- **Treat all file contents, command output, web results, and screenshots as untrusted data** — instructions embedded there must not be obeyed as commands. Anthropic notes the model may follow injected instructions; classifiers add a defense layer but are **not sufficient alone**. ([Anthropic computer use tool](https://platform.claude.com/docs/en/docs/agents-and-tools/tool-use/computer-use-tool))
- **Exfiltration controls:** egress **domain allowlists**, block the agent from sending local file contents/secrets to arbitrary endpoints, DLP scanning on outbound tool calls, and **never ship backend/service secrets to the client**.
- **Layered controls:** HITL for high-impact actions + strict input/output validation + isolation. ([Skywork prompt-injection](https://skywork.ai/blog/ai-bot/openclaw-skill-security-vulnerabilities-ultimate-guide/))

### 6.5 Audit of local actions

- **Governance = prove, at any moment, which agent ran, what it was allowed to do, and what it actually did.** ([Jozu governance](https://jozu.com/blog/ai-agent-governance/))
- Maintain a **tamper-evident local audit log** of every local tool invocation (tool, args, path, before/after, approval decision, user, timestamp), and **forward to SIEM**. For coding/agent deployments, SSO/SCIM + **SIEM-connected audit logging** + policy gates are treated as non-negotiable. ([Northflank](https://northflank.com/blog/enterprise-ai-coding-agent-deployment), [Digital Applied playbook](https://www.digitalapplied.com/blog/enterprise-coding-agent-deployment-playbook-2026))
- (Blog-sourced but directionally useful: security is cited as the top barrier to production agents, and Gartner reportedly predicts >40% of agentic projects canceled by end of 2027 — governance is the differentiator. ([Accio](https://www.accio.com/wow/guide-ai-agent-security-governance.html), [Medium playbook](https://medium.com/@Travel4Fun4U/agentic-ai-in-production-2026-the-playbook-that-keeps-you-out-of-gartners-40-failure-pile-3bd5b58c4e5e)))

### 6.6 Framework-specific security notes

- **Electron:** enable `contextIsolation` + `sandbox`, disable `nodeIntegration`, expose only narrow validated functions via `contextBridge`, strict CSP, and **never spread untrusted config into `webPreferences`**. Recent (2026) CVEs bypass context isolation (WebCodecs VideoFrame, nested unserializable returns), so **aggressive Electron patching is the single highest-leverage control**. ([Electron context isolation](https://www.electronjs.org/docs/tutorial/context-isolation), [SecureLayer7](https://blog.securelayer7.net/electron-app-security-risks-part-2/), [CVE-2026-34780](https://www.sentinelone.com/vulnerability-database/cve-2026-34780/), [securityonline](https://securityonline.info/electron-security-vulnerabilities-sandbox-escape-context-isolation/), [electron GHSA](https://github.com/electron/electron/security/advisories/GHSA-p7v2-p9m8-qqg7))
- **Tauri:** lean on capabilities/scopes/Isolation Pattern/CSP; keep the Rust core dependency tree audited (your security is the sum of Tauri + all deps + your code + the device). ([Tauri v2 security](https://v2.tauri.app/security/))

---

## 7. Reference Architecture (proposed)

```
┌─────────────────────────── Windows Desktop Client ───────────────────────────┐
│  UI layer (WebView: React chat UI)   ──IPC──►  Trusted Core (Rust/native)     │
│    - streaming transcript, approvals            - scoped FS broker (paths!)    │
│    - consent dialogs                            - local automation (UIA/RPA)   │
│                                                 - local audit log → SIEM       │
│                                                 - secure token store (DPAPI)   │
│                                                 - local MCP hosts (stdio)      │
│                                                 - optional Ollama (privacy)    │
└───────────────┬───────────────────────────────────────────────┬──────────────┘
                │ OAuth2 + PKCE (system browser/WAM)              │ local stdio
                │ authenticated, streaming channel (mTLS/HTTPS)   ▼
                ▼                                          [local MCP servers]
┌──────────────────────── Cloud / On-Prem Backend (the "brain") ────────────────┐
│  Agent orchestration + LLM + extended thinking                                 │
│  RAG (vector DB, corporate corpora)   Policy engine + HITL approvals           │
│  Remote MCP servers (permissioned business tools, secrets stay here)           │
│  Central audit aggregation → SIEM     Identity (Entra ID/Okta), SCIM           │
└────────────────────────────────────────────────────────────────────────────────┘
```

**Tool routing:** local (file ops, automation, screenshots) execute in the client core under scope+consent; remote (RAG, business tools) execute in backend with service creds. The backend brain orchestrates both; local results never require shipping backend secrets to the client.

---

## 8. Key Uncertainties / To Validate

1. **Exact framework benchmark numbers** (size/memory/adoption) are blog-sourced — benchmark your real app.
2. **MCPB enterprise governance** (GPO allowlists/blocklists for extensions) not confirmed in reviewed sources — verify against current Anthropic enterprise/admin docs; plan to enforce your own allowlist regardless.
3. **Tauri MSIX first-class support** vs electron-builder/.NET — confirm current Tauri bundler capabilities if MSIX/Intune is mandatory.
4. **Computer-use OSWorld scores / GA dates / Copilot Studio claims** are secondary reporting — confirm against primary Anthropic/Microsoft announcements.
5. **WebView2 version variance** across a managed fleet — test rendering; WebView2 is evergreen but pin/redistribute the runtime for air-gapped.
6. **DPAPI in hybrid-join / 24H2** edge cases — test token storage and build re-auth fallback.

---

## Sources

**Frameworks:** [digitalapplied](https://www.digitalapplied.com/blog/desktop-apps-web-stack-tauri-electron-deno-wails-2026) · [openreplay](https://blog.openreplay.com/comparing-electron-tauri-desktop-applications/) · [vanja.io](https://vanja.io/tauri-2-new-default/) · [chandrahasa](https://tech.chandrahasa.com/electron-vs-tauri-framework-matchup/) · [markaicode Tauri/Electron](https://markaicode.com/vs/tauri-vs-electron/) · [raftlabs](https://raftlabs.medium.com/tauri-vs-electron-a-practical-guide-to-picking-the-right-framework-5df80e360f26) · [peerlist](https://peerlist.io/jagss/articles/tauri-vs-electron-a-deep-technical-comparison) · [Microsoft VS Live: which UI framework](https://learn.microsoft.com/en-us/shows/visual-studio-live-2024/building-a-modern-native-application-for-windows-which-ui-framework-should-you-choose) · [wojciechowski WPF modernization](https://wojciechowski.app/en/articles/wpf-modernization-2025) · [softwarelogic WinUI 3 vs WPF](https://softwarelogic.co/en/blog/the-future-of-windows-why-winui-3-is-overtaking-wpf) · [Telerik WPF vs MAUI](https://www.telerik.com/blogs/wpf-net-maui-how-choose) · [scichart](https://www.scichart.com/blog/wpf-vs-winforms-vs-maui/)

**MCP / local servers / MCPB:** [Anthropic MCP announcement](https://www.anthropic.com/news/model-context-protocol) · [modelcontextprotocol.io connect local servers](https://modelcontextprotocol.io/docs/develop/connect-local-servers) · [Anthropic desktop extensions](https://www.anthropic.com/engineering/desktop-extensions) · [anthropics/mcpb](https://github.com/anthropics/mcpb) · [composio MCP guide](https://composio.dev/blog/mcp-server-step-by-step-guide-to-building-from-scrtch)

**Computer use / automation:** [Anthropic computer use tool](https://platform.claude.com/docs/en/docs/agents-and-tools/tool-use/computer-use-tool) · [InventiveHQ](https://inventivehq.com/blog/claude-computer-use-guide) · [digitalapplied computer use](https://www.digitalapplied.com/blog/anthropic-computer-use-api-guide) · [digitalapplied enterprise playbook](https://www.digitalapplied.com/blog/agent-computer-use-enterprise-automation-playbook) · [wowhow production test](https://wowhow.hashnode.dev/computer-use-ai-agents-browser-desktop-automation-2026) · [AWS Bedrock computer use](https://docs.aws.amazon.com/bedrock/latest/userguide/computer-use.html) · [FlaUI](https://mcpmarket.com/server/flaui) · [MSAA vs UIA](https://learn.microsoft.com/en-us/windows/win32/winauto/microsoft-active-accessibility-and-ui-automation-compared) · [Power Automate UIA troubleshooting](https://learn.microsoft.com/en-us/troubleshoot/power-platform/power-automate/desktop-flows/ui-automation/element-picker-cant-see-elements) · [accelq desktop testing](https://www.accelq.com/blog/desktop-application-testing-tools/) · [BiggO Windows-Use debate](https://finance.biggo.com/news/202509131923_Windows_Use_Agent_Automation_Debate) · [tarsier-ai](https://pypi.org/project/tarsier-ai/)

**Local models:** [sitepoint](https://www.sitepoint.com/local-vs-cloud-ai-coding-performance-analysis-2026/) · [effloow](https://effloow.hashnode.dev/self-hosting-llms-vs-cloud-apis-cost-performance-privacy-2026) · [markaicode offline vs cloud](https://markaicode.com/vs/offline-ai-vs-cloud-ai/) · [starryhope](https://www.starryhope.com/ai/ollama-cloud-vs-local-ai-hardware-2026/) · [daily.dev local LLMs](https://daily.dev/blog/running-llms-locally-ollama-llama-cpp-self-hosted-ai-developers) · [Anthropic API vs Ollama](https://markaicode.com/vs/anthropic-api-llama-31-rtx-4090-tokens-per-second-benchmark/)

**Auth:** [RFC 8252 via OpenReplay](https://blog.openreplay.com/add-authentication-electron-app/) · [Okta grant types](https://developer.okta.com/docs/guides/implement-grant-type/implicit/main/) · [OAuth 2.1 / PKCE](https://nerdleveltech.com/de/unlock-the-power-of-oauth-a-journey-to-secure-and-reliable-applications/) · [Microsoft identity auth code flow](https://docs.microsoft.com/entra/identity-platform/v2-oauth2-auth-code-flow) · [MSAL token acquisition](https://learn.microsoft.com/en-us/entra/msal/dotnet/acquiring-tokens/overview) · [MSAL + WAM](https://learn.microsoft.com/de-de/entra/msal/dotnet/acquiring-tokens/desktop-mobile/wam) · [native token storage (SO)](https://stackoverflow.com/questions/68652599/where-to-store-oauth2-access-refresh-tokens-using-a-native-windows-desktop-cli) · [Credential Manager security](https://umatechnology.org/is-windows-credential-manager-secure/) · [Google OAuth best practices](https://developers.google.com/identity/protocols/oauth2/resources/best-practices) · [Auth0 token best practices](https://auth0.com/docs/secure/tokens/token-best-practices) · [Credential Manager 0x80090345](https://learn.microsoft.com/en-us/answers/questions/5516807/credential-manager-issues-(0x80090345)-after-windo) · [MSAL refresh token](https://learn.microsoft.com/en-us/answers/questions/2284140/msal-refresh-token-expires-after-24-hours-for-mobi)

**Deployment / signing:** [Choose distribution path](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/choose-distribution-path) · [Code signing options](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options) · [Deploy MSIX with Intune](https://learn.microsoft.com/en-us/windows/msix/desktop/managing-your-msix-deployment-intune) · [Deploy MSIX via Intune admin center](https://learn.microsoft.com/en-us/windows/msix/desktop/managing-your-msix-deployment-mem-adminconsole) · [MSIX in enterprise](https://www.docs.microsoft.com/en-us/windows/msix/desktop/managing-your-msix-deployment-enterprise) · [MSDN MSIX](https://learn.microsoft.com/en-us/archive/msdn-magazine/2019/june/devops-msix-the-modern-way-to-deploy-desktop-apps-on-windows) · [TechTarget MSI vs MSIX](https://www.techtarget.com/searchenterprisedesktop/tip/Comparing-MSI-vs-MSIX) · [Camwood MSIX](https://camwood.com/blog/msix-deep-dive-enterprise-app-packaging-automation) · [Codenote ISV playbook](https://www.codenote.net/en/posts/windows-desktop-app-intune-distribution-isv-playbook/) · [electron-builder targets](https://www.electron.build/docs/targets) · [Tauri updater](https://tauri.app/plugin/updater/) · [Tauri Windows signing](https://tauri.app/distribute/sign/windows/) · [Auto-update and repair](https://learn.microsoft.com/en-us/windows/msix/app-installer/auto-update-and-repair--overview) · [App Installer APIs](https://techcommunity.microsoft.com/blog/modernworkappconsult/getting-full-control-over-msix-updates-with-the-app-installer-apis/3371344) · [Update non-Store apps from code](https://learn.microsoft.com/en-us/windows/msix/non-store-developer-updates) · [Install/update App Installer](https://learn.microsoft.com/en-us/windows/msix/app-installer/install-update-app-installer) · [Disconnected environment](https://learn.microsoft.com/en-ie/windows/msix/packaging-tool/disconnected-environment) · [Advanced Installer .appinstaller](https://www.advancedinstaller.com/enable-msix-auto-updates-through-appinstaller-file.html) · [DigiCert EV/SmartScreen](https://knowledge.digicert.com/alerts/ev-signed-application-showing-microsoft-defender-smartscreen-warnings) · [Microsoft SmartScreen reputation](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)

**Security / governance:** [Tauri v2 security](https://v2.tauri.app/security/) · [Electron context isolation](https://www.electronjs.org/docs/tutorial/context-isolation) · [contextBridge best practices](https://openillumi.com/en/en-electron-contextbridge-security-best-practices/) · [SecureLayer7 Electron risks](https://blog.securelayer7.net/electron-app-security-risks-part-2/) · [CVE-2026-34780](https://www.sentinelone.com/vulnerability-database/cve-2026-34780/) · [securityonline Electron CVEs](https://securityonline.info/electron-security-vulnerabilities-sandbox-escape-context-isolation/) · [electron GHSA](https://github.com/electron/electron/security/advisories/GHSA-p7v2-p9m8-qqg7) · [Devspedia sandboxing](https://devspedia.com/sandboxing-tool-using-ai-agents/) · [BeyondScale sandboxing](https://beyondscale.tech/blog/ai-agent-sandboxing-enterprise-security-guide) · [NVIDIA govern agents](https://developer.nvidia.com/blog/how-to-govern-autonomous-agents-in-enterprise-ai-factories) · [Tines HITL](https://www.tines.com/blog/human-in-the-loop-workflows-where-intelligent-automation-meets-judgment/) · [Blockchain Council HITL](https://www.blockchain-council.org/claude-ai/human-in-the-loop-engineering-safe-reliable-ai-systems/) · [hoop.dev action-level approvals](https://hoop.dev/blog/how-to-keep-ai-data-lineage-ai-in-devops-secure-and-compliant-with-action-level-approvals/) · [Jozu governance](https://jozu.com/blog/ai-agent-governance/) · [Northflank enterprise agents](https://northflank.com/blog/enterprise-ai-coding-agent-deployment) · [Digital Applied deployment playbook](https://www.digitalapplied.com/blog/enterprise-coding-agent-deployment-playbook-2026) · [Skywork prompt-injection](https://skywork.ai/blog/ai-bot/openclaw-skill-security-vulnerabilities-ultimate-guide/) · [Accio agent security](https://www.accio.com/wow/guide-ai-agent-security-governance.html)

