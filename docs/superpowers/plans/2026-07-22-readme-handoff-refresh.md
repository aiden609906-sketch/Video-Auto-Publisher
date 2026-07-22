# V3.0 README And Handoff Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite the user-facing README and developer-facing AI handoff so both accurately describe the current `V3.0` stable release.

**Architecture:** Keep user operation and delivery guidance in `README.md`; keep source structure, workflow internals, coupling, risks, and maintenance guidance in `AI_HANDOFF.md`. Preserve accurate existing operational details while replacing stale V2 status and platform behavior.

**Tech Stack:** Markdown, Git, Windows PowerShell 5.1, Node.js/TypeScript project metadata.

## Global Constraints

- `README.md` primarily serves ordinary Windows users and includes a final delivery, sales, and support section.
- `AI_HANDOFF.md` serves developers and AI maintainers; it may name files, interfaces, coupling, tests, and internal flows.
- Xiaohongshu must be described as manual-assisted: the tool opens the publish page and video directory and copies title, body, and topics to the clipboard; the user uploads, pastes, reviews, and publishes.
- Douyin, Kuaishou, and Bilibili automate verified preparation steps but never click the final publish button.
- Stable baseline is `main` at tag `V3.0`, commit `227fe9a`.
- Do not read or reproduce `.env`, `data/ai-config.json`, browser profiles, cookies, API keys, or real account content.
- This change modifies documentation only.

---

### Task 1: Rewrite the user and delivery guide

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: visible UI behavior, batch launch files, documented directories, and the platform capability rules in the approved design.
- Produces: the primary setup, operation, troubleshooting, upgrade, delivery, and support guide for V3.0 users.

- [ ] **Step 1: Replace stale introduction and platform claims**

Write a concise V3.0 introduction and a platform matrix with these exact distinctions:

```text
抖音：自动上传视频、横竖封面、标题、正文、纯文本话题和“内容由AI生成”声明；用户最终发布。
快手：自动上传视频和封面；标题、正文及最多四个话题合并写入作品描述；自动选择AI声明；用户最终发布。
B站：自动上传视频和封面、填写标题/正文/标签、选择“含AI生成内容”；用户最终发布。
小红书：打开发布页和视频目录，并把标题、正文、话题复制到剪贴板；用户手动上传、粘贴和发布。
```

- [ ] **Step 2: Organize the ordinary-user workflow**

Present the workflow in this order:

```text
准备素材 → 双击启动 → 扫描任务 → 检查或生成文案 → 选择账号 → 打开发布 → 检查平台页面 → 手动点击最终发布 → 归档
```

Keep the accurate cover matching rules, AI configuration guidance, local URL, login profile behavior, archive behavior, and common troubleshooting steps.

- [ ] **Step 3: Add upgrade and recovery guidance**

Document that upgrades should preserve `.env` and `data/`, and give the safe source-code recovery command:

```powershell
git switch -c restore-v3 V3.0
```

Do not recommend `git reset --hard`.

- [ ] **Step 4: Add delivery, sales, and support guidance**

Include a final checklist covering browser availability, complete packaged runtime, removal of developer accounts/data/keys, customer initialization, diagnostic collection, and the fact that platform page changes may require an adapter update.

- [ ] **Step 5: Review README scope**

Confirm README contains no private method names, DOM selectors, historical debugging narrative, stale V2 HEAD, or claims that Xiaohongshu uploads automatically.

- [ ] **Step 6: Commit README**

```powershell
git add -- README.md
git commit -m "docs: refresh V3 user guide"
```

Expected: only `README.md` is included in this commit.

### Task 2: Rewrite the developer and AI handoff

**Files:**
- Modify: `AI_HANDOFF.md`

**Interfaces:**
- Consumes: `src/client/`, `src/server/`, `src/server/publish/`, `src/shared/types.ts`, test files, Git baseline, and the approved design.
- Produces: a maintenance map for diagnosing and changing the current code without relying on conversation history.

- [ ] **Step 1: Replace stale project status**

Record:

```text
Branch: main
Stable tag: V3.0
Stable commit: 227fe9a
Release relationship: v1.0.0 → v2.0.5 → V3 refactor → V3.0
```

Explain that tags are snapshots, not separate source folders or independent product branches.

- [ ] **Step 2: Document the module map and data flow**

Describe the flow:

```text
React UI
  → Express routes in src/server/index.ts
  → Store/scanner/AI configuration
  → Publisher.open()
  → manual-assisted path or V3 publish workflow
  → account lock and owned browser page
  → platform adapter/legacy compatibility implementation
  → stage results and persistence
```

Cover each source file's responsibility, including `src/server/publish/account-lock.ts`, `page-owner.ts`, `platform-adapter.ts`, `result-mapping.ts`, `types.ts`, `workflow.ts`, and `adapters/douyin.ts`.

- [ ] **Step 3: Document platform-specific behavior**

Record field limits, ordering, verification semantics, and the Xiaohongshu clipboard behavior. State that final publishing remains a user action.

- [ ] **Step 4: Document current coupling**

Describe these concrete coupling areas and their impact:

```text
publisher.ts owns browser lifecycle plus most Kuaishou/Bilibili and compatibility behavior.
index.ts combines HTTP routing, publish orchestration, progress state, and persistence.
Platform adapters depend on external DOM, Chinese labels, modal structure, and timing.
V3 StageResult/PublishOutcome is mapped back to legacy booleans for existing callers.
Account profile, persistent context, page reuse, and same-account locking must change together.
Tests reach selected private Publisher methods, so renames can require test changes.
```

- [ ] **Step 5: Add change navigation and verification guidance**

Map common changes to their source and test files. Record fresh verification commands:

```powershell
npm run check
node --import tsx --test tests/*.test.ts
git diff --check
```

Do not hard-code an old test total; describe the latest verified total only when it is produced by a fresh run.

- [ ] **Step 6: Add risks and recommended refactor order**

Recommend extracting Kuaishou and Bilibili adapters through the existing platform-adapter seam before splitting unrelated modules. Keep real-page final publish outside automated verification unless explicitly authorized.

- [ ] **Step 7: Commit AI handoff**

```powershell
git add -- AI_HANDOFF.md
git commit -m "docs: update V3 maintenance handoff"
```

Expected: only `AI_HANDOFF.md` is included in this commit.

### Task 3: Verify cross-document accuracy

**Files:**
- Verify: `README.md`
- Verify: `AI_HANDOFF.md`
- Verify: `docs/superpowers/specs/2026-07-22-readme-handoff-refresh-design.md`

**Interfaces:**
- Consumes: both completed documents and the approved design.
- Produces: verified documentation ready to push.

- [ ] **Step 1: Scan for stale or forbidden claims**

```powershell
Select-String -Path 'README.md','AI_HANDOFF.md' -Pattern '16d096c|57 个测试|v3\.0\.0|小红书.*自动上传|TODO|TBD' -Encoding UTF8
```

Expected: no matches.

- [ ] **Step 2: Verify every referenced source path exists**

Check every `src/` and `tests/` path named by `AI_HANDOFF.md` against the workspace. Expected: all referenced paths exist.

- [ ] **Step 3: Run project and whitespace checks**

```powershell
npm run check
git diff --check
```

Expected: both commands exit with code 0.

- [ ] **Step 4: Confirm documentation-only scope**

```powershell
git status --short
git diff HEAD~2..HEAD --stat
```

Expected: documentation files only; no source, test, runtime data, credentials, browser profiles, or user media.

- [ ] **Step 5: Push the completed documentation**

```powershell
git push origin main
```

Expected: local `main` and `origin/main` point to the same commit.
