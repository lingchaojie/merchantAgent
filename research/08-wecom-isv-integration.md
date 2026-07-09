# WeCom (企业微信) ISV Integration — Implementation Research for a Multi-Tenant Agent SaaS

Research date: 2026-07-08. Author: technical integration research pass.
Scope: How a 服务商/ISV builds a multi-tenant SaaS on 企业微信, covering app models, identity/SSO,
通讯录, robots/messaging, 会话存档, distribution/billing, limits, plus a recommended blueprint and an
OpenFGA mapping.

> Confidence & sourcing note. Facts below are drawn primarily from the official developer docs at
> `developer.work.weixin.qq.com` (fetched directly this session) and Tencent Cloud docs. Endpoint
> fields I read on the official page are marked "verified (official)". Items I could only corroborate
> from community/third-party sources or infer are marked "UNVERIFIED" or "inferred". The WeCom docs
> change often; re-check exact fields against the live page before building.

---

## 0. TL;DR / Executive summary

- For a multi-tenant SaaS sold to many companies, you build a **第三方应用 (third-party app)** published
  by a **服务商 (service provider)**. This is the only model that scales one codebase across many tenants
  with a marketplace listing and per-seat billing. **代开发应用 (delegated/entrusted development)** is a
  secondary option for bespoke deployments at big clients who want a "self-built-like" app but outsource
  the build to you. **自建应用 (self-built)** does not apply to an ISV (single-enterprise only).
- The service-provider authorization backbone is: receive `suite_ticket` (pushed every ~10 min) →
  `get_suite_token` → `get_pre_auth_code` → optional `set_session_info` → admin authorizes via the
  `3rdapp/install` page → you receive a temporary `auth_code` → `get_permanent_code` (returns
  `permanent_code`, `auth_corp_info.corpid`, `auth_info.agent[].agentid`) → `get_corp_token` per tenant.
- Identity: OAuth2 web login (`getuserinfo3rd`) returns per-tenant `corpid`+`userid` and a provider-global
  `open_userid`. Use `open_userid` as the stable cross-app user key; scope everything else by `corpid`.
- Per-tenant isolation is enforced by WeCom's design: one `permanent_code` and one `access_token` per
  (corpid, suite). You must key all storage by `corpid`.
- Desktop (Windows) SSO: use **扫码登录 (QR login)** via the service-provider endpoint
  `open.work.weixin.qq.com/wwopen/sso/3rd_qrConnect`, or embed an OAuth2 webview. There is no
  offline/private SSO — every login round-trips WeCom's cloud.
- Contacts (通讯录): read departments/members/tags with the corp `access_token`; sensitive fields
  (mobile/email/avatar) are gated behind admin authorization + member OAuth2 consent since 2022.
- Robots/messaging: three surfaces — (a) **应用消息** `message/send` (push to app, rich types),
  (b) **群机器人** incoming webhook (outbound only, 20 msg/min), (c) **智能机器人 / API 回调** which is the
  bidirectional AI-agent path and the only one supporting **streaming** replies (3-min reply window,
  2048 bytes/response — verified on Tencent Cloud doc).
- 会话内容存档: separate paid product, SDK-based (WeWorkFinanceSdk), requires employee consent, uses
  enterprise RSA private key. Effectively a self-built/internal-operated capability; not a standard
  third-party app permission.
- Billing: **接口许可 (interface license)** is the per-account paid mechanism (base account + external
  account), bought by the provider and activated per member. App Market supports order/pay/cancel
  callbacks to the provider's `/suite/receive` endpoint.
- Gotchas: public HTTPS domain with **ICP备案** whose filing entity matches the enterprise entity;
  callback URL verification (msg_signature + AES); IP allowlists for API calls; rate limits
  (errcode 45009/45033/60020). A fully private/on-prem story is largely incompatible with WeCom cloud.

---

## 1. Application models — 自建 vs 第三方 vs 代开发

WeCom offers three app-build models. They differ in who owns the credentials, how many enterprises can
use one build, the authorization flow, and the feature/permission surface.

### 1.1 自建应用 (Self-built app)
- Built by an enterprise for its own internal use. Uses the enterprise's own `corpid` + app `secret` +
  `agentid`. Simplest credential model (`gettoken` with corpid/secret → access_token).
- Not reusable across enterprises; a single-tenant model. **Does not fit an ISV** selling to many
  companies. (Source: WeCom 第三方应用开发概述, /document/path/90593; community comparisons.)

### 1.2 第三方应用 (Third-party app) — the ISV/SaaS model
- Built by a **服务商 (service provider)**, published to the **应用市场 (App Market)**, and installed/
  authorized by any number of enterprises. One `suite_id`/`suite_secret` serves all tenants; each
  authorizing enterprise yields its own `corpid` + `permanent_code`.
- This is the model for a productized multi-tenant SaaS. You maintain one `suite_access_token` per suite
  and exchange it per tenant into that enterprise's `access_token`.
- Tradeoffs: one build → many tenants (scales), marketplace distribution, per-seat billing via interface
  license. But: reduced default data access vs a self-built app (sensitive contact fields gated), you
  operate under marketplace review, and some capabilities (e.g., 会话存档) are not standard third-party
  permissions.

### 1.3 代开发应用 (Delegated / entrusted development)
- Hybrid: the service provider develops an app **on behalf of a specific enterprise**, but delivered
  through the service-provider (third-party) authorization framework rather than the enterprise's own
  internal credentials. The `suite_id` for a co-development template starts with `dk` (verified: the
  `get_suite_token` doc states suite_id "starts with ww/wx" for third-party apps or "starts with dk" for
  代开发 templates).
- The enterprise gets a tailored, "self-built-like" app without doing the dev; the provider builds under
  a delegated model. Note: 代开发自建应用 uses a **separate identity endpoint** — the third-party
  `getuserinfo3rd` explicitly does not accept 代开发 (verified on /document/path/91121). 代开发 uses the
  self-built `cgi-bin/auth/getuserinfo` path instead.
- Tradeoffs: more per-client customization and typically fuller permissions than a generic marketplace
  app, at the cost of per-client setup (not a single shared listing).

### 1.4 Which model for our agent SaaS?
Primary: **第三方应用** (marketplace, one build, many tenants, per-seat billing). Secondary:
**代开发应用** for large/regulated clients who want a dedicated app instance, deeper contact permissions,
or an on-their-terms deployment. Avoid 自建 except for your own internal dogfooding.

### 1.5 Service-provider authorization flow (verified against official docs)

All endpoints are under `https://qyapi.weixin.qq.com`. Steps:

**Step 0 — Receive `suite_ticket` (callback).** WeCom pushes `suite_ticket` to your **指令回调 URL**
about every 10 minutes (actual validity 30 min, tolerates 2 consecutive fetch failures). Always store
the latest. Delivered as an encrypted callback event (`InfoType`/`SuiteId`). (/document/path/90600,
/document/path/90593)

**Step 1 — `get_suite_token`.** `POST /cgi-bin/service/get_suite_token` with
`{suite_id, suite_secret, suite_ticket}` → `suite_access_token` (max 512 bytes), `expires_in` 7200s.
Cache it; errcode only returned on failure. (verified, /document/path/90600)

**Step 2 — `get_pre_auth_code`.** `GET /cgi-bin/service/get_pre_auth_code?suite_access_token=...` →
`pre_auth_code` (max 512 bytes), `expires_in` example 1200s (20 min). Used for security verification
during authorization. (verified, /document/path/90601)

**Step 3 (optional) — `set_session_info`.** `POST /cgi-bin/service/set_session_info?suite_access_token=...`
with `{pre_auth_code, session_info:{appid:[...], auth_type}}`. `auth_type`: **0 = formal, 1 = test**
(default 0; verified — note some community posts mislabel this). `appid` = which apps in the suite the
admin may authorize (legacy multi-app suites; new single-app developers can omit). (verified,
/document/path/90602)

**Step 4 — Admin authorizes.** Redirect the enterprise admin to:
```
https://open.work.weixin.qq.com/3rdapp/install?suite_id=SUITE_ID&pre_auth_code=PRE_AUTH_CODE&redirect_uri=REDIRECT_URI&state=STATE
```
(`redirect_uri` URL-encoded; `state` a-zA-Z0-9 ≤128 bytes.) Two entry points, both supported at once:
your own website, or the App Market listing. After the admin confirms, WeCom redirects to:
```
redirect_uri?auth_code=xxx&expires_in=600&state=xx
```
The temporary `auth_code` expires in 10 minutes — exchange it immediately. Per enterprise per app, the
permanent code and auth info are unique and must be stored securely. (verified, /document/path/90597)

**Step 5 — `get_permanent_code`.** `POST /cgi-bin/service/get_permanent_code?suite_access_token=...`
with `{auth_code}` → returns `permanent_code`, `auth_corp_info` (incl. `corpid`, corp name),
`auth_info.agent[]` (incl. `agentid`, app name, privileges), and `auth_user_info` (the installing
admin's userid/name). Store `permanent_code` keyed by `corpid`. (documented step; fields per official
flow — exact JSON confirm on /document/path/90603.)

**Step 6 — `get_corp_token`.** `POST /cgi-bin/service/get_corp_token?suite_access_token=...` with
`{auth_corpid, permanent_code}` → the tenant's `access_token` (+ `expires_in`). This is what you use for
all enterprise-facing API calls (contacts, message send, etc.) on behalf of that tenant.

**Related:** `get_auth_info` (re-read an enterprise's authorized apps/scopes), `get_provider_token`
(`POST /cgi-bin/service/get_provider_token` with `{corpid, provider_secret}` → `provider_access_token`,
represents the provider identity, used for SSO / registration / license-order APIs — verified,
/document/path/90593). Callbacks also include 授权成功/变更/取消通知, reset-permanent-code, admin-change,
and member/department/tag change events.

**Token cache summary (per suite / per tenant):**
| Token | Scope | How obtained | TTL |
|---|---|---|---|
| suite_access_token | per suite (app) | suite_id+secret+ticket | 7200s |
| provider_access_token | per provider | corpid+provider_secret | 7200s |
| access_token (corp) | per tenant (corpid) | suite_token + permanent_code | 7200s |
| pre_auth_code | per authorization | suite_token | ~1200s |
| auth_code (temp) | per authorization | admin authorize redirect | 600s |

---

## 2. Identity & SSO

### 2.1 OAuth2 web login (网页授权登录)
Construct an authorize link to get a `code`:
```
https://open.weixin.qq.com/connect/oauth2/authorize?appid=CORPID&redirect_uri=REDIRECT_URI&response_type=code&scope=snsapi_base&state=STATE&agentid=AGENTID#wechat_redirect
```
- `scope=snsapi_base`: **silent** auth, returns basic identity (UserId).
- `scope=snsapi_privateinfo`: **manual** auth, returns sensitive info (avatar, QR code, gender); member
  must be within the app's visible range, and `agentid` is required (else it silently degrades to
  snsapi_base). (verified, /document/path/91022)
- Redirect returns `redirect_uri?code=CODE&state=STATE`. `code` ≤512 bytes, single-use, auto-expires
  after 5 min unused.

### 2.2 Exchanging code → identity
- **Self-built / 代开发:** `GET /cgi-bin/auth/getuserinfo?access_token=...&code=...` → `userid`,
  `user_ticket` (only with snsapi_privateinfo, TTL 1800s), optional `open_userid`/`external_userid`.
  (verified, /document/path/91023)
- **Third-party (ISV):** `GET /cgi-bin/service/auth/getuserinfo3rd?suite_access_token=...&code=...` →
  `corpid`, `userid`, `user_ticket`, `open_userid` (globally unique per provider), `expires_in`.
  Non-enterprise users return `openid` instead. **Not usable by 代开发** (use the self-built path).
  (verified, /document/path/91121)
- **Sensitive detail:** third-party `POST /cgi-bin/service/auth/getuserdetail3rd?suite_access_token=...`
  with `{user_ticket}` → `corpid`, `userid`, `name` (deprecated for new apps — render via 通讯录展示组件),
  `gender`, `avatar`, `qr_code` (all gated behind snsapi_privateinfo consent). Note: mobile/email are
  **not** in this endpoint's response. (verified, /document/path/91122)

### 2.3 Cross-tenant identity model (critical for a multi-tenant SaaS)
Two identity keys, from the official `getuserinfo3rd` doc:
1. **Per-enterprise:** the pair `(corpid, userid)` locates a user within one enterprise. Without an
   authorization relationship the `userid` is returned encrypted; with one it follows the ID-upgrade
   strategy (plaintext or ciphertext).
2. **Provider-global:** `open_userid` is globally unique for a given service provider and **stable across
   the same provider's different apps** for the same member ("对于同一个服务商，不同应用获取到企业内同一个
   成员的open_userid是相同的"). Only third-party apps can obtain it.

Implication: **use `open_userid` as the canonical, provider-stable user identity** in our system; store
`(corpid, userid, open_userid)` and scope authorization/data by `corpid`. This also lets us recognize the
same person if we later ship multiple WeCom apps.

### 2.4 扫码登录 (QR login) — for web and desktop
- Self-built: `https://open.work.weixin.qq.com/wwopen/sso/qrConnect?appid=CORPID&agentid=AGENTID&redirect_uri=...&state=...`
- **Service provider / third-party:** `https://open.work.weixin.qq.com/wwopen/sso/3rd_qrConnect?appid=SUITE_ID&redirect_uri=...&state=...&usertype=admin`
  (`usertype` restricts who may scan: `admin`/`member`/`all` — values reported by community, verify
  against live docs). On success, redirects back with a `code`, exchanged the same way as OAuth2.
  (Sources: community threads; endpoints are current. Marked partially UNVERIFIED for exact param list.)

### 2.5 Desktop (Windows) app SSO
There is **no offline SSO**; WeCom identity always round-trips its cloud. Practical options for a Windows
desktop agent client:
1. **Embedded webview OAuth2/QR flow.** Open the `3rd_qrConnect` (or OAuth2) URL in a system browser or
   embedded webview; capture the `code` on your `redirect_uri` (a loopback or hosted callback), then your
   backend exchanges `code`→identity and issues your own app session/JWT. This is the standard "desktop
   app uses browser for IdP" pattern and works with WeCom.
2. **Run inside WeCom's own client.** If the desktop surface is a WeCom workbench/side-panel H5 app, you
   get JS-SDK + silent snsapi_base auth without a separate scan. But that's WeCom-hosted, not your own
   native window.
3. **Device pairing.** Desktop shows a QR generated from your backend session; user scans with WeCom
   mobile to authorize; backend binds the desktop session to the resulting identity. (This is app-level
   pairing built on top of the QR/OAuth flow — inferred pattern, not a distinct WeCom API.)

Key constraint: the `redirect_uri` domain must match a configured **trusted domain** (see §7); a pure
`localhost` loopback may not satisfy trusted-domain checks, so most desktop flows use a hosted callback
that then deep-links back to the app.

---

## 3. Org structure & permissions (通讯录)

### 3.1 Reading contacts
With the tenant's corp `access_token` (from `get_corp_token`):
- **Member:** `GET /cgi-bin/user/get?access_token=...&userid=...` → `name`, `department` (id list, **only
  those the app can see**; in member-authorization mode fixed to root dept id `1`), `position`,
  `is_leader_in_dept` (per-department leader flags), `direct_leader` (≤1 direct manager, within visible
  range), `order`, `main_department`, `status` (1 active / 2 disabled / 4 not-activated / 5 quit),
  `open_userid`, plus optional mobile/gender/email/avatar/qr_code/address. For third-party apps, `userid`
  is returned as `open_userid`. (verified, /document/path/90196)
- **Departments:** `GET /cgi-bin/department/list?access_token=...&id=ID` → `department[]` with `id`,
  `name`, `name_en`, `department_leader` (contacts app only), `parentid` (root = 1), `order`. Only
  departments in the app's scope are returned. WeCom recommends the higher-performance
  **获取子部门ID列表** (`department/simplelist`, /document/path/95350) + single-department detail instead.
  (verified, /document/path/90208)
- **Department members:** `user/simplelist` (基础) and `user/list` (detail) under
  /document/path/90200 & 90201 (nav-confirmed; fetch for exact fields).
- **Tags (标签):** tag management API family — create/list tags and members; usable to drive role-like
  grouping.

### 3.2 Sensitive-field gating (major 2022 change)
Since **2022-06-20**, newly created self-built and 代开发 apps, plus non-sync base apps (客户联系, 微信客服,
会话存档, 日程, etc.), **no longer return** avatar, gender, mobile, email, biz_mail, personal QR code, or
address from `user/get`. Those now require **OAuth2 manual authorization (snsapi_privateinfo)** by both
admin and member. For 代开发 apps, even `position`, `telephone`, `extattr`, `external_profile` require
admin authorization; mobile/gender/email/avatar/etc. additionally require member OAuth2 consent.
(verified, /document/path/90196)

Implication: **do not assume you can read phone/email**. Design the product to work off `userid` /
`open_userid` + department + tags. Treat PII as opt-in.

### 3.3 通讯录同步 (contacts sync)
- A dedicated **通讯录同步** app/secret exists for full directory sync. Since **2022-08-15**, IPs newly
  added under "管理工具 - 通讯录同步" **can no longer call `user/get` or `department/list`** — you must use
  **获取成员ID列表** and **获取部门ID列表** to enumerate, then fetch detail via allowed endpoints.
  (verified, /document/path/90196 & 90208)
- Change events (member/department/tag add/update/delete) are pushed to your callback (授权变更/通讯录变更
  events under the suite callback), enabling incremental sync rather than polling.

### 3.4 Data isolation per tenant (corpid isolation)
WeCom enforces tenant isolation structurally: each authorized enterprise has its own `corpid`,
`permanent_code`, and `access_token`. An app can only read within its **visible range** for that
enterprise. **Every read is implicitly scoped to one corpid** — there is no cross-corp contacts call.
Your storage must therefore be keyed by `corpid`, and your permission model must never let tenant A's
identity resolve against tenant B's data. `open_userid` is provider-global but still only meaningful in
combination with its owning `corpid` for org/data purposes.

---

## 4. 智能机器人 / 群机器人 / 应用消息 — how an AI agent connects

There are three distinct messaging surfaces. They are frequently confused; they have different
capabilities and are the crux of "how does our AI agent talk to users."

### 4.1 应用消息 (Application message) — `message/send`
- `POST /cgi-bin/message/send?access_token=...` with `agentid` + `touser|toparty|totag`.
- `touser` ≤1000 (or `@all`), `toparty`/`totag` ≤100. Types: text, image, voice, video, file, textcard,
  news, mpnews, markdown, miniprogram_notice, **template_card** (5 interactive card types incl. buttons,
  vote, multi-select). (verified, /document/path/90236)
- Size limits: text/markdown content ≤2048 bytes; mpnews content ≤666K; textcard title ≤128 chars, etc.
- **Rate limits (verified):** per app ≤ (account-cap × 200) recipient-sends/day; per app to the **same
  member ≤30/min and ≤1000/hour** (excess dropped). Avoid firing on the hour/half-hour.
- Interactive cards return `response_code` (valid 72h, single-use) for updating the card after a user
  clicks. `msgid` supports recall.
- This is a **push** channel (outbound). To receive user replies/clicks you also need the callback (§4.4).

### 4.2 群机器人 (Group robot) — incoming webhook (outbound only)
- `POST /cgi-bin/webhook/send?key=KEY` with JSON. Types: text, markdown, markdown_v2, image, news, file,
  voice, template_card. `text`/`markdown` support `@` via `mentioned_list`/`mentioned_mobile_list`.
  (verified, /document/path/91770)
- **Rate limit: 20 messages/min per robot.** Sizes: text ≤2048 bytes, markdown ≤4096 bytes, image ≤2MB.
- Media upload: `POST /cgi-bin/webhook/upload_media?key=KEY&type=file|voice` → `media_id` valid 3 days.
- **Limitation:** this is a one-way push into a specific group. The classic 群机器人 webhook does **not**
  by itself receive messages — for inbound you need the callback-configured robot / smart robot.

### 4.3 智能机器人 (Smart robot) — the bidirectional AI-agent path (supports streaming)
This is the surface built for AI agents. Key facts (verified on Tencent Cloud
`intl.cloud.tencent.com/document/product/1254/78022`, corroborated across Aliyun integration guides):
- A smart robot is added to group chats (users `@bot`) or used in 1:1 private chat. **An application can
  be published to only one smart robot.**
- **Supports streaming responses** ("thinking process and streaming output") — regular WeCom apps do not.
  This is the main reason to use the smart-robot path for an LLM agent.
- **Reply window: the bot must respond within 3 minutes**; unfinished replies are truncated after the
  limit. **Max 2048 bytes per response.** (verified, Tencent Cloud doc)
- Connection: **API/callback (URL) mode** — WeCom pushes user messages to your HTTPS callback; you
  configure Enterprise ID, Bot ID, a server URL on your own **备案** domain, Token, and EncodingAESKey.
  Because WeCom enforces domain restrictions, a reverse proxy (nginx) on your filed domain is commonly
  used. User can type "新建会话/New conversation" to reset session id, "清除上下文" to reset context.
- The exact streaming reply **payload schema** (field names like `stream_id`, `finish`, msg items) is
  **NOT publicly documented in a fetchable page** — I could not retrieve the official
  `developer.work.weixin.qq.com` robot-stream page content. **UNVERIFIED**: treat the stream envelope as
  implementation detail to confirm against the live console/doc when you build. What is verified is the
  behavior (streaming supported, 3-min window, 2048-byte cap).
- **Edition constraint:** the robot feature requires a WeCom edition that supports robots; the
  private-deployment (专属/私有化) edition does **not** support it (verified, Tencent Cloud 1270/71789).

### 4.4 Receiving messages & events (callback) — the encryption/verification contract
Applies to app callbacks, suite (command/data) callbacks, and robot callbacks. (verified,
/document/path/90930)
- Three config values: **URL**, **Token** (≤32 alnum), **EncodingAESKey** (43 alnum).
- **URL verification (GET):** WeCom sends `msg_signature, timestamp, nonce, echostr`. You recompute the
  SHA1 signature from `token+timestamp+nonce+echostr`, compare, decrypt `echostr`, and **echo the
  decrypted plaintext within 1 second** (no quotes/BOM/newline).
- **Receiving (POST):** body is `<xml><ToUserName>(CorpID; = suiteid for third-party callbacks)</ToUserName>
  <AgentID/><Encrypt/></xml>`. Verify `msg_signature`, decrypt `Encrypt` (AES-256-CBC with EncodingAESKey;
  yields random(16)+msg_len(4)+msg+receiveid).
- **Timeout: respond within 5 seconds** or WeCom drops the connection and **retries up to 3 times**.
  Best practice: ack immediately, process asynchronously, and reconcile out-of-band (don't hard-depend on
  callbacks).
- **Passive reply:** return `<xml><Encrypt/><MsgSignature/><TimeStamp/><Nonce/></xml>` (all required),
  or return empty string / `success` when no reply.
- **Callback source IPs:** `GET /cgi-bin/getcallbackip?access_token=...` → `ip_list` for firewalling
  (pull daily).

### 4.5 How our external AI agent connects — summary
- **Best for an AI assistant with streaming:** the **智能机器人 API-callback** path. WeCom → your callback
  (encrypted) → your agent runtime → streamed reply within 3 min / 2048 bytes per chunk.
- **For proactive/rich notifications and cards inside a first-class app:** `message/send` (push) +
  app callback for button/click events (template_card `response_code`).
- **For simple group broadcasts/alerts:** 群机器人 webhook (20/min, outbound).
- **Connection style:** WeCom is **webhook/callback-based** (HTTPS push to you), not a long-lived
  connection you open to them. There is a WebSocket-style "bot mode" mentioned by some integration
  guides, but the authoritative WeCom path for third-party is the HTTPS callback. Plan for a public
  HTTPS endpoint, not an outbound long-connection.

---

## 5. 会话内容存档 (Session content archive)

### 5.1 What it is
A compliance feature that lets an enterprise archive and audit employees' work communications (1:1,
internal groups, and external customer chats) for regulatory/audit needs. Aimed at regulated sectors
(finance, government, education, research). (verified overview, /document/path/91360)

### 5.2 How it works (SDK-based, not a normal REST resource)
Retrieved via the official **WeWorkFinanceSdk** (C/C++/Java/etc.), not plain HTTP JSON. (verified,
/document/path/91774)
- `NewSdk` → `Init(corpid, archive_secret)` (the archive `secret` lives in admin console under
  管理工具 → 聊天内容存档).
- `GetChatData(seq, limit)` — seq/cursor pagination; **≤1000 records/call**, **≤4000 calls/min**. Start
  at `seq:0`, pass the largest returned seq next time. **Only the last 5 days are retrievable** — you must
  pull continuously.
- Each record carries `encrypt_random_key` + `encrypt_chat_msg`. Decrypt `encrypt_random_key` with the
  **enterprise's RSA private key** (2048-bit, PKCS1; public key configured by the enterprise in admin
  console, versioned via `publickey_ver`), then `DecryptData(random_key, encrypt_chat_msg)` → JSON.
- `GetMediaData` for media (chunked, ≤25000 calls/min).
- `get_permit_user_list` (获取会话内容存档开启成员列表, /document/path/91614) lists members with archiving on.

### 5.3 Consent & compliance
- **Employee consent is built into the data model.** Message stream contains `agree`/`disagree` message
  types carrying `userid` + timestamp, and there is a "客户同意进行聊天内容存档事件" callback for external
  customers. `获取会话同意情况` tracks consent status. (verified, /document/path/91360 & 91774)
- Legally, archiving employee/customer communications implicates China PIPL and labor/notice obligations;
  the platform surfaces consent hooks but the enterprise (data controller) bears the compliance duty.
  **Get explicit consent; expose consent state in the product; do not archive non-consenting members.**
  (This is a legal matter — not legal advice.)

### 5.4 Can an ISV agent access it?
- **Practically, this is an enterprise-operated / self-built-style capability.** Access is via the
  enterprise's own `corpid` + archive `secret` + the enterprise's RSA private key, all configured in that
  enterprise's admin console. The official SDK docs sit under 企业内部开发.
- I found **no authoritative statement that a standard third-party (marketplace) app permission grants
  session-archive access.** Third-party vendors do build archive products, but they operate by having the
  **client enterprise enable the official archiving service and hand over/host the archive secret + keys**
  — i.e., a per-client, self-built/entrusted arrangement, not a generic third-party scope. **UNVERIFIED**
  whether 代开发 can carry archive permission; treat as per-client enablement.
- Implication for our agent: **do not architect the core product around reading 会话存档.** If a regulated
  client wants the agent to use archived conversations, treat it as a bespoke, per-tenant, consent-gated
  add-on where the client enables archiving and provisions keys to a (likely 代开发 or on-their-infra)
  deployment. Keep it isolated from the multi-tenant core for privacy blast-radius reasons.

---

## 6. Distribution & billing

### 6.1 App Market (应用市场) listing
- Third-party apps are published to the WeCom **应用市场**; enterprises discover and install/authorize
  them there (or via your own site's `3rdapp/install` link — both entry points coexist).
- Becoming a 服务商 requires registering a provider account, and listing requires solution entry +
  review/上架 (community/course sources: 服务商注册, 解决方案录入, 应用上架). Marketplace review applies.
- The install triggers the §1.5 authorization flow; you receive 授权成功 callbacks.

### 6.2 接口许可 (Interface license) — the per-seat/per-account billing mechanism
This is WeCom's current paid mechanism for third-party/代开发 apps (replaced the older model around
2022-05). (verified, /document/path/95644)
- **Per-account licensing.** Two account types, purchasable in one order:
  - **基础账号 (base account)** — for internal members using the app.
  - **互通账号 (external-contact / interoperability account)** — for external-contact scenarios.
  - Each up to 1,000,000 (test enterprises capped at 1,000 each).
- **Provider buys on behalf of the enterprise, then activates per member.** Since 2023-06-30, buying a
  license first checks the enterprise's app-order status.
- **Pricing basis = duration × accounts.** `account_duration` = `months*31 + days` days; min 1 month
  (31 days), max 60 months (1860 days). Test enterprises: 1 month only.
- **Order/activation APIs** (provider_access_token):
  - `POST /cgi-bin/license/create_new_order` (→ `order_id`; body has `corpid`, `buyer_userid`,
    `account_count{base_count, external_contact_count}`, `account_duration{months, days}`)
  - renew, list orders, order detail, accounts-in-order, cancel order, buy multi-enterprise accounts,
    **pay-with-balance** (`支付完成之后，订单才能生效`)
  - `activate account`, activation-code detail, enterprise account list, member activation detail.

### 6.3 How our SaaS charges "per seat" through WeCom
Two layered options:
1. **Sell through WeCom's interface license** (recommended when you want WeCom-native billing): you, as
   provider, place license orders sized to the client's seat count; the enterprise pays (console or
   balance); you activate licenses against the specific members who use the agent. Renewals/expiry map to
   subscription lifecycle. This ties "seat" to an activated WeCom account.
2. **Bill out-of-band** (your own contract/invoice), using WeCom only for identity + delivery. Simpler
   commercially but you don't get marketplace payment rails.
- **Order/payment callbacks:** WeCom pushes order events to your **`/suite/receive`** callback as XML.
  Verified example: **取消订单 (`InfoType=cancel_order`)** carries `SuiteId`, `PaidCorpId`, `OrderId`
  (≤32 chars, WeCom-generated) — you pull purchase info by `OrderId`. (verified, /document/path/99392)
  Purchase-success / refund events follow the same callback pattern.

---

## 7. Limits & gotchas

### 7.1 Rate limits & tokens (verified)
- `access_token` / `jsapi_ticket`: cache server-side, valid ~2h — do NOT re-fetch each call.
- **errcode 45009** — API freq out of limit. Minute-level blocks auto-clear after ~1 min; hourly/daily/
  monthly similar. Some blocks self-unlock via the 频率自助解封工具. Debug mode (`debug=1`) is throttled to
  **5 calls/min** — remove before production.
- **errcode 45033** — per-corp per-interface **concurrency** cap (e.g., customer-list fetches); lower
  concurrency. **45035** — concurrent edit conflict on the same record.
- `message/send`: per-app (account-cap × 200) sends/day; per-app-per-member 30/min & 1000/hour (§4.1).
- 群机器人: 20 msg/min (§4.2). 会话存档: GetChatData ≤4000/min, GetMediaData ≤25000/min (§5.2).
- Repeated wrong `secret` → **IP banned 1 hour**. Phone→userid conversion errors >20% of headcount →
  1-day block.
- The precise per-corp/per-app numeric quotas for each endpoint live on 主动调用频率限制
  (/document/path/90319) which did not render fetchably — **UNVERIFIED exact numbers**; confirm live.

### 7.2 Domain / ICP备案 (major gotcha)
- Callback and OAuth redirect targets must be on a **配置的可信域名 (trusted domain)** for the app.
- The trusted domain must be **ICP-filed (备案) in mainland China**, and the **filing entity must match
  (or be affiliated with) the enterprise/provider entity** — WeCom does a 主体校验. Reported error:
  "域名主体校验未通过，需配置备案主体与当前企业主体相同或有关联关系的域名". (community-verified;
  matches Aliyun/Tencent smart-robot docs' "domain filing entity must match the verified entity".)
- Domain-ownership file check: place a WeCom-issued verification file at the domain root; else "未验证域名
  归属，JS-SDK 功能受限". Non-standard ports must be included in the trusted-domain entry.

### 7.3 Callback server verification & IP allowlists
- Callback URL verification handshake (GET echostr) + AES message decryption is mandatory (§4.4).
- **errcode 60020 (不安全的访问IP):** calling IPs must be allowlisted.
  - Self-built / 通讯录同步助手: caller must be the enterprise server IP, set in **企业可信IP** (provider
    IPs cannot call these).
  - Third-party / 代开发: caller IP must be added in the **provider admin console → IP白名单**.
  - Allowlist changes take ~1 min to take effect.

### 7.4 What needs a public domain / what complicates private/on-prem
- You **need a public HTTPS, ICP-filed domain** for: OAuth/QR redirects, all callbacks (suite command/
  data, app, robot, order), smart-robot API mode, and JS-SDK.
- **A fully private/air-gapped/on-prem story is largely incompatible with the WeCom cloud path:** identity,
  messaging, and robots all round-trip WeCom's servers, and the **smart robot feature is not available on
  the private-deployment (专属/私有化) edition** (verified, Tencent Cloud 1270/71789). 会话存档 can be
  processed on-prem (SDK + your keys), but the enterprise still enables it via WeCom cloud.
- Practical consequence for our platform: even an "on-prem-feeling" enterprise deployment needs a
  cloud-reachable relay (public callback endpoint + WeCom API egress). Plan a hosted ingress tier per
  region, or a 代开发 arrangement where the client hosts the relay on a filed domain.

---

## 8. Recommended integration blueprint (multi-tenant agent SaaS on WeCom)

### 8.1 App model
- Ship **one 第三方应用 (third-party suite)** as the productized SaaS. Add a **代开发** track for large/
  regulated clients needing dedicated instances, deeper contact permissions, or client-hosted relays.
- Register as 服务商, publish to 应用市场, support both marketplace-install and your-site-install entry.

### 8.2 Backend components
1. **Suite ticket keeper** — endpoint that receives `suite_ticket` (10-min push), stores latest, and a
   token service that maintains `suite_access_token` (7200s cache) and `provider_access_token`.
2. **Onboarding/authorization service** — generates `pre_auth_code`, builds the `3rdapp/install` link,
   handles the `redirect_uri` `auth_code`, calls `get_permanent_code`, and persists per-tenant
   `{corpid, permanent_code, agentid, auth_corp_info, admin userid}`.
3. **Per-tenant token manager** — `get_corp_token` per `corpid`, cached with refresh; all enterprise API
   calls go through it. Keyed strictly by `corpid`.
4. **Callback ingress** (public, ICP-filed HTTPS) — one hardened endpoint doing signature verify + AES
   decrypt, then routing by event type: suite (authorize/change/cancel, contacts change, order events)
   and app/robot (user messages, card clicks). Ack in <5s; enqueue for async processing.
5. **Identity service** — OAuth2/QR login (`3rd_qrConnect` + `getuserinfo3rd`), mints your own session/
   JWT keyed on `open_userid` + `corpid`. Powers web and desktop SSO.
6. **Directory sync** — initial pull via ID-list endpoints + detail; then incremental via contacts-change
   callbacks. Store departments, members, tags, leader flags per `corpid`.
7. **Agent delivery** — a **智能机器人** per tenant for the conversational AI (streaming, 3-min/2048B), plus
   `message/send` for proactive cards/notifications and `response_code` handling for interactive cards.
8. **Billing** — 接口许可 order/activate service tied to subscription lifecycle; consume order callbacks on
   `/suite/receive`; reconcile seat counts with activated accounts.

### 8.3 Data model (per tenant, keyed by corpid)
```
tenant(corpid, corp_name, permanent_code[secret], agentid, install_admin_userid, edition, status)
user(corpid, userid, open_userid, name?, status, main_department, is_leader_in_dept[])
department(corpid, dept_id, name, parentid, order, leader_userids[])
membership(corpid, userid, dept_id, order)
tag(corpid, tag_id, name) / tag_member(corpid, tag_id, userid)
license(corpid, order_id, base_count, external_count, expire_at, activated_userids[])
```
Secrets (`permanent_code`, archive keys) in a KMS/secret store, never in app DB plaintext.

### 8.4 Desktop (Windows) client
- Use the hosted OAuth2/QR flow (§2.5 option 1): open `3rd_qrConnect` in browser/webview → callback on
  your filed domain → exchange → issue app JWT → deep-link back to the desktop app. Refresh via your own
  session, not by re-scanning.

### 8.5 Sequence (tenant onboarding → user chat)
```
Admin clicks install (market/your site)
  → 3rdapp/install(pre_auth_code) → admin authorizes
  → redirect auth_code → get_permanent_code → store {corpid, permanent_code, agentid}
  → get_corp_token(corpid) → sync 通讯录 → provision 智能机器人 + activate licenses
User @bot / DM
  → WeCom callback (encrypted) → verify+decrypt → resolve (corpid, open_userid)
  → OpenFGA check → agent runtime → stream reply (≤3min, ≤2048B/chunk)
```

---

## 9. Feeding WeCom identity/org data into an OpenFGA per-role permission model

### 9.1 Mapping principles
- **Tenant = corpid.** Model each authorized enterprise as a top-level `tenant` (aka organization) object.
  Every other object (department, agent, resource) is namespaced under its tenant. This mirrors WeCom's
  structural isolation and prevents cross-tenant leakage.
- **User identity = `open_userid` (provider-global), always paired with `corpid`.** Use
  `user:<open_userid>` as the FGA user id. Because `open_userid` is stable across your apps and unique per
  provider, it's the safest canonical subject. Keep `(corpid, userid)` as attributes for API calls.
- **Departments → hierarchical group objects.** WeCom's `parentid` tree maps to FGA `department` objects
  with a `parent` relation, enabling inherited permissions down the org tree.
- **Roles come from three WeCom signals:** (1) department membership, (2) `is_leader_in_dept` /
  `direct_leader` (managerial role), (3) tags (标签) as ad-hoc role groups. Admins come from
  `auth_user_info` / admin-list callbacks.

### 9.2 Sketch FGA model (DSL-style)
```
model
  schema 1.1

type user

type tenant
  relations
    define admin: [user]
    define member: [user]

type department
  relations
    define tenant: [tenant]
    define parent: [department]
    define leader: [user]
    define member: [user] or member from parent      # inherited membership downward
    define manager: leader or manager from parent      # managers inherit down the subtree

type role                                              # from tags / job roles
  relations
    define tenant: [tenant]
    define assignee: [user, department#member, role#assignee]

type agent                                             # a deployed AI agent / capability
  relations
    define tenant: [tenant]
    define can_configure: admin from tenant
    define can_use: [user, department#member, role#assignee] or manager from ... or member from tenant
    define can_view_audit: admin from tenant
```
(Illustrative — tune relations to your actual resource types: knowledge bases, tools, data connectors.)

### 9.3 Tuple sync from WeCom → OpenFGA
On onboarding and on every contacts-change callback, upsert tuples:
- `tenant:<corpid>#admin@user:<open_userid>` for each install/admin (from auth_user_info + admin callbacks).
- `tenant:<corpid>#member@user:<open_userid>` for each active member (status=1).
- `department:<corpid>/<dept_id>#tenant@tenant:<corpid>` and `#parent@department:<corpid>/<parentid>`.
- `department:<corpid>/<dept_id>#member@user:<open_userid>` per membership; `#leader@user:...` where
  `is_leader_in_dept` is true.
- `role:<corpid>/<tag_id>#assignee@user:<open_userid>` (or `@department:...#member`) from tags.
- Resource grants (`agent#can_use@...`) driven by your product's per-role config, expressed against
  departments/roles rather than individuals where possible.
- **Deletions matter:** on member quit (status=5) or dept delete callbacks, remove tuples to avoid stale
  access. Treat the contacts-change callback as the source of truth for incremental tuple maintenance.

### 9.4 Runtime check
On each agent invocation: resolve `(corpid, open_userid)` from the decrypted callback/session →
`fga.check(user:<open_userid>, can_use, agent:<corpid>/<agent_id>)`. Because everything is namespaced by
`corpid`, a check can never traverse into another tenant. Managerial/broad permissions flow through
`manager`/`member from parent` inheritance, so per-role policies (e.g., "all of Sales dept can use the
sales agent", "only dept leaders can view analytics") map cleanly onto department/role relations.

### 9.5 Cautions
- **PII gating:** don't rely on mobile/email being present (§3.2). Key everything on `open_userid`.
- **ID upgrade / encryption:** without an authorization relationship, `userid` may be ciphertext; prefer
  `open_userid` for FGA subjects to avoid churn from the ID-upgrade strategy.
- **Consistency:** WeCom callbacks can retry/duplicate and are not guaranteed — make tuple sync idempotent
  and run a periodic full reconciliation (re-pull directory) as a backstop.

---

## 10. Open questions / to verify against live docs
- Exact **smart-robot stream reply payload schema** (field names, `stream_id`, continuation/finish
  semantics). Behavior verified (streaming, 3-min, 2048B) but envelope not fetchable. **UNVERIFIED.**
- Exact **numeric rate limits** per endpoint on 主动调用频率限制 (/document/path/90319). **UNVERIFIED.**
- Whether **代开发** apps can carry **会话存档** permission, and the precise third-party archive
  enablement path. **UNVERIFIED** — treat as per-client enablement.
- Full `3rd_qrConnect` parameter list and allowed `usertype` values. **Partially UNVERIFIED** (community).
- `get_permanent_code` full JSON (auth_info.agent structure, privileges). Flow verified; confirm exact
  fields on /document/path/90603.

## 11. Sources
Official WeCom developer docs (fetched this session, `developer.work.weixin.qq.com`):
- 第三方应用开发概述 / tokens — /document/path/90593
- 授权流程总览 & get_suite_token — /document/path/90600
- get_pre_auth_code — /document/path/90601
- set_session_info (auth_type) — /document/path/90602
- 企业授权应用 (3rdapp/install, auth_code) — /document/path/90597
- get_permanent_code — /document/path/90603
- getuserinfo3rd (third-party identity, open_userid) — /document/path/91121
- getuserdetail3rd (sensitive info) — /document/path/91122
- getuserinfo (self-built/代开发 identity) — /document/path/91023
- OAuth2 网页授权链接 (scope) — /document/path/91022
- 读取成员 user/get (sensitive-field gating, sync rules) — /document/path/90196
- 获取部门列表 department/list — /document/path/90208
- 接收消息与事件 / callback verify+encrypt (5s timeout) — /document/path/90930
- 发送应用消息 message/send (types, size, rate) — /document/path/90236
- 群机器人 webhook (types, 20/min) — /document/path/91770
- 会话内容存档 overview — /document/path/91360
- 会话存档 SDK (WeWorkFinanceSdk, RSA, seq) — /document/path/91774
- 接口许可 create_new_order (accounts, duration) — /document/path/95644
- 取消订单 callback (/suite/receive, cancel_order) — /document/path/99392

Tencent Cloud / Aliyun (smart robot behavior):
- Deploy Application to WeCom Smart Robot (streaming, 3-min, 2048B, proxy) —
  https://intl.cloud.tencent.com/document/product/1254/78022
- WeCom Robot Management (edition constraint; private edition unsupported) —
  https://intl.cloud.tencent.com/document/product/1270/71789
- Aliyun DataWorks WeCom URL-callback integration —
  https://help.aliyun.com/en/dataworks/user-guide/dataclaw-integrates-enterprise-wechat
- Aliyun chatbot WeCom integration (domain entity match) —
  https://help.aliyun.com/en/beebot/intelligent-dialogue-robot-tongyi-version/integration-example-enterprise-wechat

Community / corroborating (lower confidence, marked in text):
- 3rd_qrConnect usertype examples — developers.weixin.qq.com community threads
- ICP备案 / 主体校验 error — github.com/zhayujie/chatgpt-on-wechat issue #1092; en.wikipedia.org/wiki/ICP_license
- zsmhub/workweixin Go SDK (third-party + 代开发 dimensions) — github.com/zsmhub/workweixin
- 会话存档 vendor/impl examples — github.com/zhimaAi/qiweidoc; cloud.tencent.com/developer/article/1875001

_End of report._











