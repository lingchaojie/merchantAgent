# M6 Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every remaining desktop-UI, browser-mock, test, and documentation gap in the existing M6 management milestone.

**Architecture:** Keep the existing REST/IPC/backend projection stack unchanged. Add small pure UI helpers, complete the existing React panes in place, and replace the fixed browser admin mock with an isolated in-memory implementation that obeys the real API contract.

**Tech Stack:** React 18, TypeScript strict mode, Vitest, `react-dom/server` for dependency-free markup tests, Electron Vite, Go, SQLite, OpenFGA.

## Global Constraints

- Do not change backend data models or `/admin/*` route shapes.
- Do not add frontend runtime or test dependencies.
- Keep Gate A (skill roles) and Gate B (data-domain grants) separate.
- Treat frontend admin detection as UX only; backend `requireAdmin` remains authoritative.
- Do not address config-DB/OpenFGA cross-store transactions or manufacturing scheduling M6.
- Preserve existing Chinese UI copy and compact admin layout.

---

### Task 1: Typed Admin Actions and Pure UI State Helpers

**Files:**
- Create: `desktop/src/renderer/src/admin-ui.ts`
- Create: `desktop/src/renderer/src/admin-ui.test.ts`
- Modify: `desktop/src/renderer/src/admin.ts`
- Modify: `desktop/src/renderer/src/admin.test.ts`

**Interfaces:**
- Produces: `moveItem<T>(items: T[], index: number, delta: -1 | 1): T[]`.
- Produces: `newSkillDraft(tenantId: string): Skill`.
- Produces: `AdminClient.createBlankSkill(skill)`, `AdminClient.cloneTemplate(templateId)`.
- Consumes: existing `Skill`, `AdminReq`, and `AdminResp` types.

- [ ] **Step 1: Write failing helper tests**

```ts
import { describe, expect, it } from "vitest";
import { moveItem, newSkillDraft } from "./admin-ui";

describe("admin UI state", () => {
  it("moves an item without mutating the input", () => {
    const source = ["a", "b", "c"];
    expect(moveItem(source, 1, -1)).toEqual(["b", "a", "c"]);
    expect(source).toEqual(["a", "b", "c"]);
  });

  it("does not move an item outside the list", () => {
    expect(moveItem(["a", "b"], 0, -1)).toEqual(["a", "b"]);
    expect(moveItem(["a", "b"], 1, 1)).toEqual(["a", "b"]);
  });

  it("creates an empty tenant-scoped skill draft", () => {
    expect(newSkillDraft("mock-corp-001")).toEqual({
      tenantId: "mock-corp-001", skillId: "", name: "", description: "",
      playbookMd: "", allowedTools: [], dataDomains: [], roles: [],
    });
  });
});
```

- [ ] **Step 2: Extend the admin-client test with missing typed actions**

```ts
it("builds typed blank-skill and template-clone requests", async () => {
  const admin = vi.fn().mockResolvedValue({ ok: true, data: undefined });
  const client = makeAdminClient(admin, "u_boss");
  const skill = {
    tenantId: "mock-corp-001", skillId: "shipping", name: "物流",
    description: "", playbookMd: "", allowedTools: [], dataDomains: [], roles: [],
  };

  await client.createBlankSkill(skill);
  await client.cloneTemplate("order-360");
  await client.deleteSkill("shipping");

  expect(admin).toHaveBeenNthCalledWith(1, {
    method: "POST", path: "/admin/skills", userId: "u_boss", body: { skill },
  });
  expect(admin).toHaveBeenNthCalledWith(2, {
    method: "POST", path: "/admin/skills", userId: "u_boss", body: { templateId: "order-360" },
  });
  expect(admin).toHaveBeenNthCalledWith(3, {
    method: "DELETE", path: "/admin/skills/shipping", userId: "u_boss",
  });
});
```

- [ ] **Step 3: Run the focused tests and verify RED**

Run: `npx vitest run src/renderer/src/admin-ui.test.ts src/renderer/src/admin.test.ts`

Expected: FAIL because `admin-ui.ts`, `createBlankSkill`, and `cloneTemplate` do not exist.

- [ ] **Step 4: Implement the pure helpers**

```ts
import type { Skill } from "./admin";

export function moveItem<T>(items: T[], index: number, delta: -1 | 1): T[] {
  const target = index + delta;
  if (index < 0 || index >= items.length || target < 0 || target >= items.length) return [...items];
  const next = [...items];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

export function newSkillDraft(tenantId: string): Skill {
  return {
    tenantId, skillId: "", name: "", description: "", playbookMd: "",
    allowedTools: [], dataDomains: [], roles: [],
  };
}
```

- [ ] **Step 5: Replace the generic skill-create helper with typed actions**

In `makeAdminClient`, expose these exact methods:

```ts
createBlankSkill: (skill: Skill) => call<void>("POST", "/admin/skills", { skill }),
cloneTemplate: (templateId: string) => call<void>("POST", "/admin/skills", { templateId }),
updateSkill: (id: string, skill: Skill) => call<void>("PUT", `/admin/skills/${id}`, skill),
deleteSkill: (id: string) => call<void>("DELETE", `/admin/skills/${id}`),
```

- [ ] **Step 6: Run the focused tests and verify GREEN**

Run: `npx vitest run src/renderer/src/admin-ui.test.ts src/renderer/src/admin.test.ts`

Expected: both files pass.

- [ ] **Step 7: Commit**

```bash
git add desktop/src/renderer/src/admin-ui.ts desktop/src/renderer/src/admin-ui.test.ts desktop/src/renderer/src/admin.ts desktop/src/renderer/src/admin.test.ts
git commit -m "test(desktop): define M6 admin UI actions and state helpers"
```

---

### Task 2: Stateful Browser Admin Mock

**Files:**
- Create: `desktop/src/renderer/src/mock-admin.ts`
- Create: `desktop/src/renderer/src/mock-admin.test.ts`
- Modify: `desktop/src/renderer/src/agent.ts`

**Interfaces:**
- Produces: `createMockAdmin(): (req: AdminReq) => Promise<AdminResp>`.
- Consumes: `Role`, `Rule`, `Skill`, `Template`, `Domain`, and `Grant` from `admin.ts`.
- Preserves: non-admin 403 behavior and browser-only lifetime.

- [ ] **Step 1: Write failing contract tests**

```ts
import { describe, expect, it } from "vitest";
import { createMockAdmin } from "./mock-admin";

describe("browser admin mock", () => {
  it("rejects non-admin callers", async () => {
    const admin = createMockAdmin();
    expect(await admin({ method: "GET", path: "/admin/roles", userId: "u_sales1" }))
      .toMatchObject({ ok: false, status: 403 });
  });

  it("persists role updates and deletes their references", async () => {
    const admin = createMockAdmin();
    await admin({ method: "POST", path: "/admin/roles", userId: "u_boss",
      body: { roleId: "logistics", label: "物流", description: "发运" } });
    await admin({ method: "PUT", path: "/admin/roles/logistics", userId: "u_boss",
      body: { label: "物流主管", description: "发运管理" } });
    const listed = await admin({ method: "GET", path: "/admin/roles", userId: "u_boss" });
    expect(listed.ok && listed.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ roleId: "logistics", label: "物流主管" }),
    ]));
  });

  it("persists ordered rules, blank skills, clones, and grants", async () => {
    const admin = createMockAdmin();
    const rules = [{ match: ["物流"], roleId: "staff" }, { match: ["销售"], roleId: "sales" }];
    await admin({ method: "PUT", path: "/admin/rules", userId: "u_boss", body: rules });
    await admin({ method: "POST", path: "/admin/skills", userId: "u_boss", body: { skill: {
      tenantId: "mock-corp-001", skillId: "shipping", name: "物流", description: "",
      playbookMd: "", allowedTools: [], dataDomains: [], roles: [],
    } } });
    await admin({ method: "POST", path: "/admin/skills", userId: "u_boss",
      body: { templateId: "order-360" } });
    const subject = "role:mock-corp-001/staff#assignee";
    await admin({ method: "POST", path: "/admin/domains/cost/grants", userId: "u_boss",
      body: { subject } });

    const gotRules = await admin({ method: "GET", path: "/admin/rules", userId: "u_boss" });
    const gotSkills = await admin({ method: "GET", path: "/admin/skills", userId: "u_boss" });
    const gotDomains = await admin({ method: "GET", path: "/admin/domains", userId: "u_boss" });
    expect(gotRules.ok && gotRules.data).toEqual(rules);
    expect(gotSkills.ok && gotSkills.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ skillId: "shipping" }),
      expect.objectContaining({ sourceTemplateId: "order-360" }),
    ]));
    expect(gotDomains.ok && gotDomains.data).toMatchObject({
      grants: expect.arrayContaining([{ domainId: "cost", subject }]),
    });
  });
});
```

- [ ] **Step 2: Run the mock test and verify RED**

Run: `npx vitest run src/renderer/src/mock-admin.test.ts`

Expected: FAIL because `mock-admin.ts` does not exist.

- [ ] **Step 3: Implement isolated seed state**

Create typed seed constants for seven existing roles, the six ordered backend rules, `cost`/`pricing` domains, valid user/department grants, `order360`/`customer360` skills, and the `order-360` template. Clone seed arrays inside `createMockAdmin` so tests and browser sessions cannot share mutations.

Use these exact routing rules:

```ts
const rolePath = req.path.match(/^\/admin\/roles\/([^/]+)$/);
const skillPath = req.path.match(/^\/admin\/skills\/([^/]+)$/);
const grantPath = req.path.match(/^\/admin\/domains\/([^/]+)\/grants$/);

if (!ADMINS.has(req.userId)) return fail(403, "admin only");
if (req.method === "GET" && req.path === "/admin/roles") return ok(copy(roles));
if (req.method === "POST" && req.path === "/admin/roles") {
  const role = req.body as Role;
  if (!role?.roleId || !role.label) return fail(400, "role id and label required");
  if (roles.some((item) => item.roleId === role.roleId)) return fail(400, "role already exists");
  roles = [...roles, copy(role)];
  return ok();
}
if (req.method === "PUT" && rolePath) {
  const roleId = decodeURIComponent(rolePath[1]);
  const body = req.body as Pick<Role, "label" | "description">;
  const index = roles.findIndex((item) => item.roleId === roleId);
  if (index < 0) return fail(404, "role not found");
  roles = roles.map((item, i) => i === index ? { ...item, label: body.label, description: body.description } : item);
  return ok();
}
if (req.method === "DELETE" && rolePath) {
  const roleId = decodeURIComponent(rolePath[1]);
  const subject = `role:${TENANT_ID}/${roleId}#assignee`;
  roles = roles.filter((item) => item.roleId !== roleId);
  rules = rules.filter((item) => item.roleId !== roleId);
  skills = skills.map((item) => ({ ...item, roles: item.roles.filter((id) => id !== roleId) }));
  grants = grants.filter((item) => item.subject !== subject);
  return ok();
}
if (req.method === "GET" && req.path === "/admin/rules") return ok(copy(rules));
if (req.method === "PUT" && req.path === "/admin/rules") { rules = copy(req.body as Rule[]); return ok(); }
if (req.method === "GET" && req.path === "/admin/tools") return ok(copy(tools));
if (req.method === "GET" && req.path === "/admin/templates") return ok(copy(templates));
if (req.method === "GET" && req.path === "/admin/skills") return ok(copy(skills));
if (req.method === "POST" && req.path === "/admin/skills") {
  const body = req.body as { skill?: Skill; templateId?: string };
  if (body.skill) {
    if (!body.skill.skillId || !body.skill.name) return fail(400, "skill id and name required");
    if (skills.some((item) => item.skillId === body.skill!.skillId)) return fail(400, "skill already exists");
    skills = [...skills, { ...copy(body.skill), tenantId: TENANT_ID }];
    return ok();
  }
  const template = templates.find((item) => item.templateId === body.templateId);
  if (!template) return fail(400, "template not found");
  let skillId = template.templateId;
  for (let suffix = 1; skills.some((item) => item.skillId === skillId); suffix++) {
    skillId = `${template.templateId}-${suffix}`;
  }
  skills = [...skills, {
    tenantId: TENANT_ID, skillId, name: template.name, description: template.description,
    playbookMd: template.playbookMd, allowedTools: copy(template.allowedTools),
    dataDomains: copy(template.dataDomains), roles: copy(template.suggestedRoles),
    sourceTemplateId: template.templateId,
  }];
  return ok();
}
if (req.method === "PUT" && skillPath) {
  const skillId = decodeURIComponent(skillPath[1]);
  const index = skills.findIndex((item) => item.skillId === skillId);
  if (index < 0) return fail(404, "skill not found");
  const skill = req.body as Skill;
  skills = skills.map((item, i) => i === index ? { ...copy(skill), tenantId: TENANT_ID, skillId } : item);
  return ok();
}
if (req.method === "DELETE" && skillPath) {
  const skillId = decodeURIComponent(skillPath[1]);
  skills = skills.filter((item) => item.skillId !== skillId);
  return ok();
}
if (req.method === "GET" && req.path === "/admin/domains") return ok({ domains: copy(domains), grants: copy(grants) });
if ((req.method === "POST" || req.method === "DELETE") && grantPath) {
  const domainId = decodeURIComponent(grantPath[1]);
  const { subject } = req.body as { subject?: string };
  if (!subject) return fail(400, "domain and subject required");
  if (req.method === "POST" && !grants.some((item) => item.domainId === domainId && item.subject === subject)) {
    grants = [...grants, { domainId, subject }];
  }
  if (req.method === "DELETE") {
    grants = grants.filter((item) => item.domainId !== domainId || item.subject !== subject);
  }
  return ok();
}
return fail(404, "not found");
```

The `ok`, `fail`, and `copy` helpers must return `AdminResp` without exposing mutable internal arrays. Validate ids as non-empty and reject duplicate role/skill ids with status 400.

- [ ] **Step 4: Wire the factory into the browser agent**

Remove the fixed `mockAdmin` function and seed object from `agent.ts`, then add:

```ts
import { createMockAdmin } from "./mock-admin";

const mockAdmin = createMockAdmin();
```

Keep `mockAgent.admin(req)` delegating to `mockAdmin(req)`.

- [ ] **Step 5: Run the mock tests and verify GREEN**

Run: `npx vitest run src/renderer/src/mock-admin.test.ts src/renderer/src/admin.test.ts`

Expected: both files pass.

- [ ] **Step 6: Commit**

```bash
git add desktop/src/renderer/src/mock-admin.ts desktop/src/renderer/src/mock-admin.test.ts desktop/src/renderer/src/agent.ts
git commit -m "feat(desktop): make browser admin mock stateful and contract-correct"
```

---

### Task 3: Complete Roles and Ordered Rules UI

**Files:**
- Create: `desktop/src/renderer/src/components/admin/RolesPane.test.tsx`
- Modify: `desktop/src/renderer/src/components/admin/RolesPane.tsx`
- Modify: `desktop/src/renderer/src/components/admin/RulesPane.tsx`
- Modify: `desktop/src/renderer/src/app.css`

**Interfaces:**
- Produces: exported presentational `RoleRow` for dependency-free markup testing.
- Consumes: `AdminClient.updateRole`, `moveItem`, and existing role/rule APIs.

- [ ] **Step 1: Write the failing role-row markup test**

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { RoleRow } from "./RolesPane";

describe("RoleRow", () => {
  it("renders editable label and description fields", () => {
    const html = renderToStaticMarkup(<RoleRow
      role={{ roleId: "sales", label: "销售", description: "业务" }}
      editing
      busy={false}
      onEdit={vi.fn()} onCancel={vi.fn()} onSave={vi.fn()} onDelete={vi.fn()}
    />);
    expect(html).toContain('name="role-label"');
    expect(html).toContain('name="role-description"');
    expect(html).toContain("保存");
  });
});
```

- [ ] **Step 2: Run the role test and verify RED**

Run: `npx vitest run src/renderer/src/components/admin/RolesPane.test.tsx`

Expected: FAIL because `RoleRow` and its editing contract do not exist.

- [ ] **Step 3: Implement role create/edit/delete state**

Export `RoleRow` with the props used by the test. In editing mode it owns draft label/description state initialized from `role`, renders named inputs, and calls `onSave(label, description)`. In display mode it renders label, description, immutable id, Edit, and Delete controls.

Update `RolesPane` to:

```ts
const [description, setDescription] = useState("");
const [editingId, setEditingId] = useState<string | null>(null);
const [busy, setBusy] = useState(false);
const [ok, setOk] = useState("");

const update = async (roleId: string, label: string, description: string) => {
  setBusy(true); setErr(""); setOk("");
  try {
    await client.updateRole(roleId, label, description);
    setEditingId(null); await load(); setOk("已生效");
  } catch (e) { setErr(String(e)); }
  finally { setBusy(false); }
};
```

Pass the optional create description to `createRole`, disable mutations while busy, and preserve inputs on failure.

- [ ] **Step 4: Add rule movement controls**

Import `moveItem` into `RulesPane`. Each row receives two symbol buttons with tooltips:

```tsx
<button className="icon-btn" title="上移" disabled={i === 0 || busy}
  onClick={() => setRules((items) => moveItem(items, i, -1))}>↑</button>
<button className="icon-btn" title="下移" disabled={i === rules.length - 1 || busy}
  onClick={() => setRules((items) => moveItem(items, i, 1))}>↓</button>
```

Add `busy` and `ok` state. Await `putRules(cleaned)`, reload from the server, and display `已生效`; keep edited rules on failure.

- [ ] **Step 5: Add compact form and status styles**

Add `.pane-ok`, `.pane-actions`, `.role-edit`, and `.icon-btn` rules using existing color, border, spacing, and focus tokens. Keep buttons at stable dimensions and avoid layout shift between display/edit modes.

- [ ] **Step 6: Run tests, typecheck, and verify GREEN**

Run: `npx vitest run src/renderer/src/components/admin/RolesPane.test.tsx src/renderer/src/admin-ui.test.ts`

Run: `npm run typecheck`

Expected: tests and both TypeScript projects pass.

- [ ] **Step 7: Commit**

```bash
git add desktop/src/renderer/src/components/admin/RolesPane.tsx desktop/src/renderer/src/components/admin/RolesPane.test.tsx desktop/src/renderer/src/components/admin/RulesPane.tsx desktop/src/renderer/src/app.css
git commit -m "feat(desktop): complete role CRUD and ordered position rules"
```

---

### Task 4: Complete Skills UI and Admin Entry Gate

**Files:**
- Create: `desktop/src/renderer/src/components/admin/SkillsPane.test.tsx`
- Create: `desktop/src/renderer/src/components/TopBar.test.tsx`
- Modify: `desktop/src/renderer/src/components/admin/SkillsPane.tsx`
- Modify: `desktop/src/renderer/src/components/TopBar.tsx`
- Modify: `desktop/src/renderer/src/App.tsx`
- Modify: `desktop/src/renderer/src/app.css`

**Interfaces:**
- Produces: exported presentational `SkillEditor` with all editable fields.
- Changes: `TopBar` receives `canAdmin: boolean | null`.
- Consumes: `newSkillDraft`, `createBlankSkill`, `cloneTemplate`, `listDomains`.

- [ ] **Step 1: Write failing skill-editor and admin-entry tests**

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SkillEditor } from "./SkillsPane";

it("renders every editable skill field and supplied domains", () => {
  const html = renderToStaticMarkup(<SkillEditor
    skill={{ tenantId: "t", skillId: "s", name: "技能", description: "说明",
      playbookMd: "剧本", allowedTools: [], dataDomains: [], roles: [] }}
    isNew busy={false} tools={[]} roles={[]}
    domains={[{ domainId: "custom", label: "自定义域" }]}
    onChange={vi.fn()} onSave={vi.fn()} onCancel={vi.fn()}
  />);
  expect(html).toContain('name="skill-id"');
  expect(html).toContain('name="skill-description"');
  expect(html).toContain("自定义域");
});
```

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { TopBar } from "./TopBar";

it("disables management entry for a non-admin", () => {
  const html = renderToStaticMarkup(<TopBar title="会话" userId="u_sales1"
    onCommand={vi.fn()} view="chat" onToggleView={vi.fn()} canAdmin={false} />);
  expect(html).toContain("disabled");
  expect(html).toContain("需要管理员身份");
});
```

- [ ] **Step 2: Run both tests and verify RED**

Run: `npx vitest run src/renderer/src/components/admin/SkillsPane.test.tsx src/renderer/src/components/TopBar.test.tsx`

Expected: FAIL because `SkillEditor` and `canAdmin` do not exist.

- [ ] **Step 3: Implement complete skill creation and editor**

Load skills, tools, roles, templates, and domains together; surface every rejected load instead of silently swallowing it. Add `busy` and `ok` state.

Export `SkillEditor` with the tested props. It renders:

- immutable `skillId` input, enabled only for `isNew`;
- name input and description input;
- playbook textarea;
- tool checkboxes from `tools`;
- data-domain checkboxes from `domains` with “声明，非授权” copy;
- role checkboxes for Gate A;
- Save and Cancel buttons.

Use these operations:

```ts
const createBlank = () => setEdit(newSkillDraft(tenantId));
const save = async () => {
  if (!edit) return;
  setBusy(true); setErr(""); setOk("");
  try {
    if (isNew) await client.createBlankSkill(edit);
    else await client.updateSkill(edit.skillId, edit);
    setEdit(null); setIsNew(false); await load(); setOk("已生效");
  } catch (e) { setErr(String(e)); }
  finally { setBusy(false); }
};
const clone = async () => { await client.cloneTemplate(tplId); };
const remove = async (skillId: string) => { await client.deleteSkill(skillId); };
```

Render New Blank, Clone, Edit, and Delete controls. Require `skillId` and name before saving a new skill.

- [ ] **Step 4: Implement the admin-entry probe**

In `App`, add:

```ts
const [canAdmin, setCanAdmin] = useState<boolean | null>(null);
useEffect(() => {
  let active = true;
  setCanAdmin(null);
  adminClient.listRoles()
    .then(() => { if (active) setCanAdmin(true); })
    .catch(() => { if (active) setCanAdmin(false); });
  return () => { active = false; };
}, [adminClient]);
```

If identity changes while the admin view is open and the probe becomes false, return to chat. Pass `canAdmin` to `TopBar`.

In `TopBar`, disable the config button unless `view === "admin" || canAdmin === true`; use title `正在检查管理员权限` while null and `需要管理员身份` while false. The back-to-chat action remains enabled.

- [ ] **Step 5: Run focused tests and typecheck**

Run: `npx vitest run src/renderer/src/components/admin/SkillsPane.test.tsx src/renderer/src/components/TopBar.test.tsx src/renderer/src/mock-admin.test.ts`

Run: `npm run typecheck`

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add desktop/src/renderer/src/components/admin/SkillsPane.tsx desktop/src/renderer/src/components/admin/SkillsPane.test.tsx desktop/src/renderer/src/components/TopBar.tsx desktop/src/renderer/src/components/TopBar.test.tsx desktop/src/renderer/src/App.tsx desktop/src/renderer/src/app.css
git commit -m "feat(desktop): complete skill management and gate admin entry"
```

---

### Task 5: Full Verification and M6 Documentation Closure

**Files:**
- Modify: `docs/实现进度.md`
- Modify only if browser acceptance finds a defect: files already listed in Tasks 1-4 and their matching tests.

**Interfaces:**
- Verifies: complete desktop workflow, real OpenFGA projection tests, and documentation consistency.
- Produces: one consistent M6 completion statement.

- [ ] **Step 1: Run the complete desktop verification**

Run: `npm test -- --run`

Expected: every Vitest file passes with zero failures.

Run: `npm run typecheck`

Expected: node and web TypeScript checks exit 0.

Run: `npm run build`

Expected: main, preload, and renderer bundles build successfully.

- [ ] **Step 2: Run backend and live OpenFGA M6 tests**

From PowerShell, run:

```powershell
wsl.exe -e bash -lc 'cd /mnt/d/merchantAgent/backend && go test -count=1 ./...'
wsl.exe -e bash -lc 'cd /mnt/d/merchantAgent/backend && OPENFGA_API_URL=http://localhost:18080 go test -count=1 -v ./config ./skill ./wire ./cmd/agentd'
```

Expected: all packages pass; LLM-key-gated tests may skip, but Projector delete and admin add/remove tests must run and pass.

- [ ] **Step 3: Run browser acceptance against the stateful mock**

Start: `npx vite src/renderer --host 127.0.0.1 --port 4174`

Use the in-app browser at `http://127.0.0.1:4174/` and execute the seven steps in the completion spec §5.2. Verify every save can be read back, non-admin entry is disabled, all five panes fit at desktop and mobile viewport widths, and console logs contain no errors.

- [ ] **Step 4: Fix any acceptance defect with a new failing test first**

For each defect, add the smallest Vitest reproduction to the nearest existing test file, run it to see the expected failure, apply one focused fix, and rerun the focused test before returning to Step 1.

- [ ] **Step 5: Make the progress document consistent**

Change the Phase 1 table M6 row from `⬜` to `✅ 完成`. Update the M6 section to state that role editing, ordered rules, blank/template skill lifecycle, admin-entry gating, stateful browser mock, and automated/browser verification are complete. Preserve the existing out-of-scope transaction and tag-role notes.

- [ ] **Step 6: Review the final diff**

Run: `git diff --check`

Run: `git diff --stat HEAD~4..HEAD`

Confirm no generated output, database files, secrets, or unrelated line-ending rewrites are included.

- [ ] **Step 7: Commit documentation closure**

```bash
git add docs/实现进度.md
git commit -m "docs: close M6 after full management UI verification"
```

---

## Self-Review

- **Spec coverage:** Tasks 1-4 cover roles, ordered rules, blank/template skill lifecycle, both assignment gates, admin-entry UX, stateful mock, errors, and tests. Task 5 covers browser/OpenFGA acceptance and the contradictory status table.
- **Scope:** No backend schema/API changes, transaction redesign, OAuth, tag-role UI, manufacturing scheduling, or new dependency is included.
- **Type consistency:** `Skill`, `Role`, `Rule`, `Domain`, `Grant`, `AdminReq`, and `AdminResp` retain their current shapes. New client names are used consistently by the tests and `SkillsPane`.
- **Test discipline:** Every new helper, mock contract, and presentational interface begins with a focused failing test; browser-found defects require the same red-green loop.
