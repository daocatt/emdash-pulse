# 07 · 插件选型

EmDash 插件分两类：

- **沙箱插件（Sandboxed）**：独立运行时，仅能使用声明的能力，可从注册表安装。**优先**。
- **原生插件（Native）**：与站点同进程，可用 React admin、Portable Text 渲染组件、注入 HTML。需部署，仅信任依赖。

> 原则：能用官方/社区插件就不自研；自研一律**沙箱**，除非确需 React admin / PT 组件 / 页面片段。

---

## 1. 采用清单（已确认）

> 决策：D4 订阅用 **`bulletin`**；D5 邮件传输用 **Resend**；D14 评论 AI 审核用 **Cloudflare Workers AI**。

| 需求 | 插件 | 来源 | 状态 | 说明 |
| --- | --- | --- | :-: | --- |
| **邮件传输** | `emdash-plugin-resend` | 官方 | ✅ **选定** | Resend，独占 `email:deliver` |
| 邮件传输（备选） | `@msale.com/resend` / `@masonjames.com/emdash-smtp` / `@numoteq.com/forward-email` / `@cfreear.bsky.social/emdash-cf-email-sending` | 社区 | 备选 | 如需切换 |
| **邮件订阅 / newsletter** | `@meekmedia.bsky.social/bulletin` | 社区 | ✅ **选定** | 双确认 + 文章转邮件，隐私优先 |
| **评论 AI 审核** | `@emdash-cms/plugin-ai-moderation` | 官方 | ✅ **选定** | Cloudflare Workers AI / Llama Guard |
| 评论反垃圾 | `@peachfinthemes.com/comment-spam-protection` | 社区 | ✅ | 敏感词/链接/语言/重复/限速（与 AI 审核互补） |
| 评论通知 | `@lasymphonieagency.com/comment-notify` | 社区 | ✅ | 新评论邮件通知管理员 |
| 审计日志 | `@emdash-cms/plugin-audit-log` | 官方 | ✅ | 内容/媒体变更审计 |
| Webhook 通知 | `@emdash-cms/plugin-webhook-notifier` | 官方 | ✅ | 内容变更外发 |
| 表单（联系/投稿） | `@emdash-cms/plugin-forms` | 官方 | ✅ | 表单 + 提交存储 + 邮件通知 |
| 嵌入内容 | `@emdash-cms/plugin-embeds` | 官方 | ✅ | YouTube/Vimeo/Twitter/Bluesky 等 |
| 发布前校验 | `@emdashplugins.bsky.social/publish-check` | 社区 | 可选 | 标题/描述/alt/链接检查 |
| 发布策略 | `@jammaru.com/preflight` | 社区 | 可选 | 确定性发布策略 |
| SEO 套件 | `@nookeshk.bsky.social/seo-suite` | 社区 | 可选 | JSON-LD / 重定向 / SEO 健康度 |
| 图片优化 | `@verco.app/image-optimizer` | 社区 | 可选 | 媒体库图片体积优化 |
| 分析 | `@eisbachcode.de/analytics` / `@shane.bsky.shas.am/emdash-umami-analytics` | 社区 | 可选 | Cloudflare / Umami |
| AT 协议分发 | `@emdash-cms/plugin-atproto` | 官方 | 可选 | 同步 Bluesky/standard.site |
| 字段增强 | `@emdash-cms/plugin-field-kit` / `plugin-color` | 官方 | 可选 | json 组件 / 颜色选择 |

> ⚠️ 邮件传输类插件**独占** `email:deliver`，同时只能启用一个。本项目**选定 Resend**。

---

## 2. 自研插件清单

| 插件 | 格式 | 职责 | 关键能力 | 优先级 |
| --- | --- | --- | --- | :-: |
| `pulse-editorial` | Sandboxed | **编辑台**：选题分发（创建/列出/结束）+ 投稿审核发布 | `content:read`、`content:write`、`content:publish` | P0 |
| `pulse-agent` | Sandboxed | **Agent 侧**：注册/审批、选题领取、投稿、订阅意向 | `content:read`、`content:write`、`taxonomies:read`、`taxonomies:write` | P0 |
| `pulse-review` | Sandboxed | 审核策略：发布策略 + 评论审核策略 + 通知 | `hooks.content-policy:register`、`comments:moderate`（+`users:read`）、`content:read` | P0 |
| ~~`pulse-subscriptions`~~ | — | **不做了**：改用社区 `bulletin` | — | — |
| `pulse-digest` | Sandboxed | 摘要邮件（若 `bulletin` 的活动能力不足） | `content:read`、`email:send`、`cron` | P2（按需） |

> 订阅（双确认/退订/文章转邮件）由 **`bulletin`** 承担，不重复自研。仅在需要**自定义摘要格式**时才做 `pulse-digest`。

### 2.1 拆分原则（**实施后修订**）

- **身份必须与使用它的路由同处一个插件**：沙箱插件的 storage 按插件 ID 隔离，两个插件无法共享 agent 注册表。因此 `pulse-agent` 独占身份（`agents` 存储），并承载全部 Agent 侧路由。
- **`pulse-editorial` 只做编辑侧**，走 EmDash 会话/令牌 + RBAC，**不需要** agent 身份 → 可以拆出，且**独占 `content:publish`**（Agent 侧插件不持有发布权，最小权限）。
- **共享状态**是 EmDash `assignments` collection（两插件都经 `ctx.content` 访问），不是插件存储。
- **凭证头**：沙箱路由收不到 `Authorization`/`Cookie`，agent token 走自定义头 `X-Agent-Token`（路由 `request.headers` 显式声明）。
- **MCP 限制**：MCP 工具只能挂「私有 + POST + JSON」路由 → 编辑侧全部可作为 MCP 工具；Agent 侧是公开路由，**不作** MCP 工具（改由 HTTP 调用）。

### 2.2 `pulse-editorial`（编辑台）

- 路由（全部私有）：`assignments/create`(`content:create`)、`assignments/list`(`content:read`)、`assignments/close`(`content:edit_any`)、`review/queue`(`content:read_drafts`)、`review/get`(`content:read_drafts`)、`review/approve`(`content:publish_any`)、`review/reject`(`content:edit_any`)、`review/request-changes`(`content:edit_any`)。
- MCP 工具：`createAssignment`/`listAssignments`/`closeAssignment`/`reviewQueue`/`getSubmission`/`approveArticle`/`rejectArticle`/`requestArticleChanges`。
- `review/approve` = 设 `review_status=approved` → `getVersioned` → `publish`（受 `pulse-review` 策略约束）。

### 2.3 `pulse-agent`（Agent 侧）

- 存储：`agents`（唯一 `slug`；索引 `status`/`createdAt`/`tokenHash`/`registrationSecretHash`）。
- 公开路由（`X-Agent-Token` + 限流）：`agents/register`、`agents/status`、`agents/whoami`、`assignments/available`、`assignments/claim`、`submissions/submit`、`submissions/mine`、`subscriptions/subscribe|unsubscribe`。
- 私有路由（`plugins:manage`）：`agents/list`、`agents/approve`、`agents/reject`、`agents/revoke`，以及 Block Kit 后台审批页 `/agents`。
- MCP 工具：`listAgentRegistrations`/`approveAgent`/`rejectAgent`/`revokeAgent`。
- 投稿强制 `pending_review`；`source_url` 幂等；`author_agent` 取自身份；`body` 为 markdown（插件内转 Portable Text）。

### 2.4 `pulse-review`
- `content:beforePublish` / `beforeSchedule`：非 `approved` 拒绝（含人类 Author 与 Agent）。
- `comment:moderate`（独占）：与 CF Workers AI 审核配合（AI 给出建议 → 规则/人工决策）。
- 可选 `content:afterSave`：投稿进入 `pending_review` 时通知编辑。
- 可选 Block Kit 后台页：待审队列 + 一键通过/驳回。

---

## 3. 插件 vs 原生决策表

| 需求 | 需要 React admin？ | 需要 PT 渲染组件？ | 需要页面片段？ | 结论 |
| --- | :-: | :-: | :-: | --- |
| 审核策略 | 否 | 否 | 否 | Sandboxed |
| 审核队列 UI | 否（Block Kit 足够） | 否 | 否 | Sandboxed |
| MCP 工具 | 否 | 否 | 否 | Sandboxed |
| 订阅管理 | 否 | 否 | 否 | Sandboxed |
| 摘要邮件 | 否 | 否 | 否 | Sandboxed |
| 自定义 PT 块（如报纸引言） | 是 | 是 | 否 | **Native** |

> 结论：本期自研插件**全部可用 Sandboxed**；仅当需要自定义 Portable Text 块时才考虑 Native（可后置）。

---

## 4. 插件开发流程（自研）

```sh
pnpm dlx @emdash-cms/plugin-cli init pulse-review
cd pulse-review
pnpm install
pnpm run test
# 实现 src/plugin.ts + emdash-plugin.jsonc
pnpm exec emdash-plugin validate
pnpm run build
```

- 运行时逻辑在 `src/plugin.ts`（`SandboxedPlugin` 默认导出）。
- 权限/路由/MCP/storage 声明在 `emdash-plugin.jsonc`。
- 测试：`createPluginTestHost()`（快）与 `createPluginRuntimeTestHost()`（真实内容/评论/邮件路径）。
- 生产边界优先于 skill 示例：以导出类型与实际运行测试为准。

---

## 5. 安装与授权注意

- 从注册表安装会展示**声明的能力与 MCP 工具**，需管理员**逐项批准**。
- 新增能力 / 路由转公开 / 新增 MCP 工具 → **需重新授权**。
- 沙箱插件无环境变量、文件系统、其他插件存储、未声明主机的访问权。
- 邮件类插件为独占传输，切换需重新配置并验证。

---

## 5.1 Phase 1 安装实测（本地）

**官方插件（npm，沙箱描述符，直接加入 `sandboxed: []`）**

| 插件 | 状态 | 说明 |
| --- | :-: | --- |
| `@emdash-cms/plugin-audit-log@0.2.3` | ✅ 已装并验证写入 | 能力 `content:read/write`、`media:read`；storage `entries`；hooks `content:beforeSave/afterSave`、`content:beforeDelete/afterDelete`、`media:afterUpload` |
| `@emdash-cms/plugin-ai-moderation@0.2.2` | ⏸️ 暂缓 | 该版本 `main`/`exports` 指向 **TS 源码**（`src/descriptor.ts`，无 `dist`），Astro config 加载时报 `Stripping types is currently unsupported for files under node_modules`；且需 CF Workers AI binding。待部署 CF 时一并解决 |

启动日志证据：
```
EmDash: Loaded sandboxed plugin pulse-review:0.1.0 with capabilities: [hooks.content-policy:register]
EmDash: Loaded sandboxed plugin audit-log:0.2.3 with capabilities: [content:read, content:write, media:read]
```

audit-log 写入证据（建一篇草稿后 `_plugin_storage` 出现一条 `entries`）：
```json
{"timestamp":"2026-10-05T15:57:24.358Z","action":"create","collection":"articles",
 "resourceId":"01M46CHEZB1V9TGKMWN835E60W","resourceType":"content",
 "userId":"01M46BBZQW4F01BGRQ28T2E7CR",
 "changes":{"after":{"title":"审计探针","review_status":"draft", ...}},
 "metadata":{"slug":"audit-probe","status":"draft"}}
```

**社区插件（注册表安装）**

| 插件 | 状态 | 说明 |
| --- | :-: | --- |
| `@peachfinthemes.com/comment-spam-protection` | ⏸️ 暂缓 | 注册表 `POST /_emdash/api/admin/plugins/registry/install` 返回 `DID_RESOLUTION_FAILED`（见下） |
| `@lasymphonieagency.com/comment-notify` | ⏸️ 暂缓 | 同上；且依赖邮件传输（Resend） |
| `@meekmedia.bsky.social/bulletin` | ⏳ 待凭证 | Spike 2；`did:plc:wozauaevxsfzdcdxdfwogyg4` |
| `@msale.com/resend` | ⏳ 待凭证 | Spike 3；`did:plc:53aijmlljtpzteewxptwa2xm` |

**注册表安装失败根因**：`emdash/src/registry/publisher-handle.ts` 的 `boundedFetch` 对非 `DIRECTORY_ORIGINS`（`plc.directory`、`cloudflare-dns.com`）的请求走 SSRF 校验（`resolveAndValidateExternalUrl`），其 DNS 解析用 **Cloudflare DoH**。本环境 `cloudflare-dns.com` 不可达（TLS 被断），故发布者校验失败。
> 直接在 Node 用 `@atcute/identity-resolver` 的 `PlcDidDocumentResolver` 解析同一 DID **成功** —— 说明 `plc.directory` 可达，问题在 DoH 依赖。
> 结论：**在能访问 Cloudflare DoH 的网络（或部署到 CF）重试注册表安装**；本地开发可先用 npm 官方插件与自研沙箱插件。

**`emdash-plugin` CLI 可用命令**：`search` / `info`（只读发现），`init` / `build` / `dev` / `bundle` / `validate`（自研），`publish` / `release`（发布到 atproto 注册表）。**无本地安装命令** —— 安装走 Admin UI / registry API。

---

## 5.2 Phase 4b 自研插件实测（本地）

三个自研沙箱插件经 npm workspaces 链接，`npm run plugin:build`（`--workspaces`）与 `npm run plugin:test` 全绿。

| 插件 | 路由数 | MCP 工具 | 测试 |
| --- | :-: | :-: | :-: |
| `pulse-review` | 0（仅 hooks） | — | 4 用例（发布门禁） |
| `pulse-editorial` | 8 | 8 | 9 用例（审核流转 + 选题） |
| `pulse-agent` | 14 | 4 | 28 用例（注册/审批/token/限流 12 + MD→PT 11 + 投稿 5） |

HTTP 冒烟（`/_emdash/api/plugins/<slug>/<route>`）：

| 调用 | 结果 |
| --- | --- |
| `POST /pulse-agent/agents/register` | `200`，返回 `agent_id` + 一次性 `registration_secret` |
| `GET /pulse-agent/agents/whoami`（无 token） | `200` + `{ok:false,error:"UNAUTHORIZED"}`（应用级错误） |
| `GET /pulse-agent/submissions/mine`（无 token） | 同上 |
| `POST /pulse-editorial/review/queue`（未登录） | `401 UNAUTHORIZED`（宿主强制鉴权） |

注意：公开路由的响应被 EmDash 包在 `{ success: true, data }` 信封里；私有路由未通过宿主鉴权时直接 `401`。


---

## 6. 已确认

- ✅ **D4**：订阅采用社区 **`bulletin`**（不自研 `pulse-subscriptions`）。
- ✅ **D5**：邮件传输采用 **Resend**（`emdash-plugin-resend`）。
- ✅ **D14**：评论 AI 审核采用 **Cloudflare Workers AI**（`@emdash-cms/plugin-ai-moderation`）+ 反垃圾插件互补。
- ✅ 部署：**Cloudflare Workers + D1 + R2 + Workers AI**。
- ⏳ 待定：分析插件（Cloudflare vs Umami）、SEO 套件是否引入。
