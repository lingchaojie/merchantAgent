# Task 9 Implementer Report

## Status

Committed as `672efaa` (`test: verify desktop-local enterprise tool vertical`). Deterministic backend/desktop verticals, full automated matrix, Windows unpacked-app acceptance, distribution inspection, and operational documentation are complete.

## TDD and focused fixes

- Backend RED: sales write was correctly suppressed but an installed tool blocked by the Skill gate left no audit denial.
- Focused RED/GREEN: `TestLLM_AuditsInstalledToolBlockedBySkillGate`; runtime now audits/emits deny for known connector tools blocked before unlock, without invoking them. Unknown tool names remain non-executable.
- Desktop vertical RED: target test did not exist. GREEN: 3 tests cover real signed package + temp SQLite read60/write80/read80, idempotent retry, cancel, and tampered version/signature before store access.
- Release RED: after Node native rebuild, `dist/win-unpacked` carried ABI 127 and failed Electron 33.4.11 load. Packaging now forces `electron-rebuild -f -w better-sqlite3` and disables the redundant non-forced builder rebuild. GREEN probe: `33.4.11 130 1`.

## Automated evidence

- Focused: `OPENFGA_API_URL=http://localhost:18080 go test ./cmd/agentd ./e2e -run 'LocalToolVertical|SameQuestionDifferentRights' -count=1 -v` PASS; no OpenFGA skip.
- Backend: `go test -count=1 ./...` PASS.
- Backend explicit OpenFGA: `OPENFGA_API_URL=http://localhost:18080 go test -count=1 ./...` PASS.
- Desktop: `npm test` PASS, 20 files / 102 tests; final rerun also PASS after restoring Node ABI.
- Desktop: `npm run typecheck`, `npm run build`, and `npm run dist:dir` PASS.
- Distribution: capability and public-key SHA-256 match source; native module exists at `dist/win-unpacked/resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node`; Electron probe loaded it and queried SQLite (`33.4.11 130 1`).

## Windows acceptance evidence

- Started live OpenFGA and rebuilt WSL agentd from this worktree with the existing gitignored gpt-5.5 credentials and persistent `DATA_DIR`.
- Started `desktop/dist/win-unpacked/merchantAgent.exe`; reset state was achieved by deleting/observing only `%APPDATA%/merchant-agent-desktop/reference-enterprise.db`. Config and Skill DBs were not deleted.
- `u_sales1`: read SO-1001 at 60%/version 1 with no cost; update request refused with no native confirmation.
- `u_plan`: read 60%; model rendered preview; native dialog showed SO-1001, WO-1001, 60% -> 80%, note; real `确认写入` control invoked; result verified at 80%/version 2.
- `u_sales1`: read-back returned 80%/version 2.
- `u_boss`: `/audit` returned `verified=true`, tenant chain, reads plus confirmed write with execution/idempotency/before/after and sales read-back.
- Assign pane removed planner from `production-progress` in 264 ms; backend Skill roles became manager-only; a fresh planner update was immediately refused without confirmation.
- Screenshots: `.superpowers/sdd/task9-confirmation.png`, `task9-desktop.png` (1000x720), and `task9-390px.png` (390x844). At narrow size renderer client/scroll width were both 374, no out-of-bounds elements, and composer/send controls did not overlap.

## Residual concern

The real model refused the sales write before issuing any tool call, so that live audit chain contains no tool-deny entry. This is expected for prefiltered progressive disclosure: audit cannot record a tool execution decision that never occurred. The deterministic forced-attempt vertical proves the required no-local-request plus `deny/denied` audit behavior. Documentation states this explicitly.

The manual revocation intentionally persists in the existing Skill store: planner no longer has `production-progress`. It was not reset by deleting config/Skill data.

## Follow-up: Gate B evidence and operator relation

- Review exposed a contract gap: `Guard` always checked `viewer`, even for the low-risk write. Added `ToolSpec.ResourceRelation`, defaulting to `viewer`, and declared `report_production_progress` as requiring `operator`.
- TDD RED was the missing `ResourceRelation` field; focused GREEN covered both the runtime relation decision and reference tool declaration. The explicit OpenFGA full suite passed after the fix.
- For real Gate B evidence, the admin API temporarily changed `production-progress.roles` from `["manager_tier"]` to `["manager_tier","sales"]`. This intentionally bypassed only Gate A.
- In the real Windows unpacked App, `u_sales1` asked to change `SO-1001`/`WO-1001` from 80% to 90%. The model read version 2, rendered the preview, and attempted `report_production_progress`; Gate B denied it with `no operator access to business_record order/SO-1001`.
- No native confirmation appeared, the reference SQLite modification timestamp was unchanged, and `/audit` returned `verified=true`. Audit seq 3 recorded `decision=deny`, `status=denied`, `confirmed=false`, `resourceId=SO-1001`, with no execution or idempotency key.
- The admin API immediately restored `production-progress.roles` to `["manager_tier"]` and read-back confirmed the restoration. The intended post-revocation manager-only state remains persistent.
- Added direct pinned dev dependency `@electron/rebuild@3.6.1` and corrected the operational docs for port/CSP/native rebuild behavior and Gate A versus Gate B.

Follow-up committed as `f20a367` (`fix: enforce desktop write operator gate`). Fresh verification before commit:

- Focused Go relation/spec tests: PASS.
- Backend `go test -count=1 ./...`: PASS.
- Backend `OPENFGA_API_URL=http://localhost:18080 go test -count=1 ./...`: PASS with all packages exercised.
- Desktop `npm test`: PASS, 20 files / 102 tests.
- Desktop `npm run typecheck` and `npm run build`: PASS.
- Desktop `npm run dist:dir`: PASS; packaged native probe returned `33.4.11 130 1`.
- Packaged capability and public-key SHA-256 hashes matched source exactly.

## Final integrity fixes

Status: complete and ready for the branch handoff.

- Durable idempotency now validates before lookup and persists a SHA-256 fingerprint over the exact write contract: tool, order ID, work-order ID, completion rate, expected version, and optional-note presence/value. Exact retries return the stored `{data,before,after}` across reopen without another version increment; any changed binding returns typed `source_conflict` without mutation.
- Store initialization upgrades legacy `tool_idempotency` tables in place with a nullable `request_fingerprint`. Rows created before trustworthy fingerprints existed fail closed instead of replaying an unrelated result.
- The privileged executor preserves omitted-note semantics through confirmation rather than converting omission to an empty string.
- Runtime dispatch resolves installed connector names before argument parsing. Malformed or null JSON for an installed but locked connector records exactly one `deny/failed` terminal audit with tool-call, role, device, version, execution, and risk attribution; the tool is not invoked. Unknown names remain unexecuted and unaudited.
- Migration 002 now tells the model to present the preview and call the write tool; privileged desktop confirmation happens inside execution. The implementation overview and backend README now describe `business_record`, declared record relations (`viewer` default, `operator` write), and current planner access.

TDD evidence:

- RED desktop: same-process changed arguments, close/reopen changed arguments, and legacy rows all replayed the old success; omitted notes became empty strings. RED runtime: malformed `{` and `null` calls for an installed locked connector produced zero audit entries, while unknown-name controls remained unaudited. RED migration: the registry still contained the pre-confirmation wording.
- Focused GREEN: desktop store/executor/vertical 35/35; runtime dispatch regression suite PASS; migration contract PASS; desktop typecheck PASS.
- Full backend GREEN: `go test -count=1 ./...` PASS, followed by `OPENFGA_API_URL=http://localhost:18080 go test -count=1 ./...` PASS with every package exercised.
- Full desktop GREEN: `npm test` PASS, 20 files / 107 tests; `npm run typecheck`, `npm run build`, and `npm run dist:dir` PASS. After restoring Node ABI and rerunning tests/typecheck, the final distribution was rebuilt again.
- Packaged ABI probe: Electron `33.4.11`, module ABI `130`, SQLite query result `1` (`33.4.11 130 1`).

Operational note: this is a pre-release correction to migration 002. A development registry that already recorded version 2 retains its stored playbook until it is reset or updated through the admin path; fresh registries receive the corrected wording.
