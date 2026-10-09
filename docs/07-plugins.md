# 07 · 插件选型

EmDash 插件分两类：

- **沙箱插件（Sandboxed）**：独立运行时（Workers 上需 Worker Loader 绑定 = 付费计划），仅能使用声明的能力，可从注册表安装。
- **标准 / 原生插件（in-process）**：与站点同进程，经 `plugins: []` 加载；标准格式由 `adaptSandboxEntry` 适配，能力门禁照旧。

> 原则：能用官方/社区插件就不自研；自研一律**标准格式**。
>
> **本项目实际选择**：全部插件都放 `plugins: []`（宿主进程内）。历史上 CF Workers 上唯一的沙箱后端 Worker Loader 需付费计划（免费计划下 `sandbox()` 返回 `undefined`，沙箱插件会静默全部不加载），迁到 VPS/Node 后仍统一走 in-process —— 本地与生产同一条路径（详见 [02-architecture.md](./02-architecture.md) §9）。代价是失去 isolate 隔离；本项目插件全部自研，风险可控。

---

## 1. 采用清单（已确认）

> 决策：D4 订阅**自研 `pulse-subscriptions`**（修订，原定 `bulletin`）；D5 邮件传输用 **Resend**；D14 评论审核用 **规则 + AI**（AI 经自研 `pulse-ai` 网关，provider 可换）。

| 需求 | 插件 | 来源 | 状态 | 说明 |
| --- | --- | --- | :-: | --- |
| **邮件传输** | `emdash-plugin-resend@0.2.0` | 官方 npm | ✅ **已接入** | Resend，独占 `email:deliver`；后台「Resend」页填 API key / From。**缺它则 magic link 503、订阅确认信只落 `pendingEmail`** |
| 邮件传输（备选） | `@msale.com/resend` / `@masonjames.com/emdash-smtp` / `@numoteq.com/forward-email` / `@cfreear.bsky.social/emdash-cf-email-sending` | 社区 | 备选 | 如需切换 |
| **邮件订阅 / newsletter** | ~~`@meekmedia.bsky.social/bulletin`~~ → **自研 `pulse-subscriptions`** | 社区 → 自研 | 🔁 **D4 修订** | 需要自有订阅表与 Agent 订阅意向对齐；双确认 + 退订 + 订阅者管理，邮件发送抽象为「有 provider 就发，没有就落库待发」 |
| **评论 AI 审核** | 自研 `pulse-review` + `pulse-ai` | 自研 | ✅ **已接入** | 规则引擎 + AI（经 `pulse-ai` 网关，provider 可换），失败降级不自动通过 |
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
| `pulse-editorial` | Sandboxed | **编辑台**：选题分发（创建/列出/结束）+ 投稿审核发布 | `content:read`、`content:write`、`content:publish`、`content:revisions:read` | P0 |
| `pulse-agent` | Sandboxed | **Agent 侧**：注册/审批、选题领取、投稿、订阅意向 | `content:read`、`content:write`、`taxonomies:read`、`taxonomies:write` | P0 |
| `pulse-review` | Sandboxed | 编审策略：发布门禁 + 评论审核（规则 + AI） | `hooks.content-policy:register`、`users:read`、`network:request` | P0 |
| `pulse-subscriptions` | Sandboxed | **读者订阅**：双确认 / 退订 / 订阅者管理 + **每周/每月摘要**（替代 `bulletin`） | `email:send`、`network:request`、`content:read` | P0 |
| `pulse-seo` | **Trusted** | **结构化数据**：为公开页面贡献唯一 JSON-LD（文章 `NewsArticle` / 其余 `WebSite`） | 无（`page:metadata` 无能力要求） | P1 |
| `pulse-theme` | Sandboxed | **前台主题**：后台「前台主题」页写插件设置，供 `src/middleware.ts` 运行期切换 | 无（只写自己的插件设置） | P2c |
| ~~`pulse-digest`~~ | — | ~~摘要邮件~~ **已并入 `pulse-subscriptions`**（插件存储按 plugin id 隔离，新插件读不到 `subscribers`） | — | ✅ 不做 |

> 订阅由自研 `pulse-subscriptions` 承担（**D4 修订**，见 [11-phase3-comments-subscriptions.md](./11-phase3-comments-subscriptions.md)）。**摘要不单独建插件**：订阅者存储、transport、退订 token 都在 `pulse-subscriptions`，且插件存储/设置按 plugin id 隔离，新建插件读订阅者只能靠公开路由或动态 `import("emdash")`，得不偿失。详见 [17-subscriber-digests.md](./17-subscriber-digests.md)。

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

- `content:beforePublish` / `content:beforeSchedule`：非 `approved` 拒绝（含人类 Author 与 Agent）。
- `comment:moderate`（**独占**，`timeout: 10s`）：注册后**替换**内置审核器 `emdash-default-comment-moderator`，故**必须复刻内置逻辑**（`commentsModeration=none` / `commentsAutoApproveUsers` + 已登录 / `first_time` + `priorApprovedCount>0` → 自动通过；其余 pending）。
- 能力注意：`comment:moderate` 要求 **`users:read`**（不是 `comments:moderate`）；能力不匹配时 hook 会被**静默跳过**。
- 规则引擎（`src/moderation.ts`）：链接数 / 黑名单词 / 联系方式 / 重复字符 / 原始 HTML / 作者名是 URL。命中 spam 直接判 spam（不调 AI）。
- AI（可选，默认关）：**委托 `pulse-ai`**（provider / 模型 / 凭据都在「AI 网关」页配置，`pulse-review` 不再自带 AI 凭证设置）；`unsafe` → spam，**失败/超时 → 降级到规则结论，绝不自动通过**。
- 设置：`rulesEnabled` / `bannedWords` / `maxLinks` / `maxLength` / `minLength` / `aiEnabled` / `aiAutoApprove` / `aiTimeoutMs`。

### 2.5 `pulse-subscriptions`（读者订阅）

- 存储：`subscribers`（唯一 `emailHash`；索引 `status`/`createdAt`/`tokenHash`）、`groups`（订阅分组，slug 即记录 id）、`events`（append-only 事件日志）、`broadcasts`（群发历史）、`digest_runs`（摘要运行留痕 + 幂等判据）。状态机 `pending → confirmed → unsubscribed`，外加只能后台进出的 `paused`。
- 公开路由（`response: "raw"` + IP 限流）：`subscribe/request`（建 pending + 发确认邮件，可带分组/节奏）、`subscribe/confirm`（token → confirmed，发欢迎邮件）、`unsubscribe`（token → unsubscribed，可带原因）、`preferences`（读者自助读/改**分组与节奏**）；`groups/public` 只读启用中的分组（**刻意不限流**，SSR 取不到真实 IP）。
- 私有路由（`plugins:manage`）：`subscribers/list`（列表 + 计数 + 按分组/关键词过滤）、`subscribers/update`（暂停/恢复/退订/改分组）、`subscribers/events`、`groups/{list,save,delete}`、`digest/{run,resync,runs}`；MCP 工具 `listSubscribers` / `listGroups` / `listDigestRuns` / `runDigest` / `resyncDigestAudience`。
- Block Kit 后台**四页**（`/subscribers`、`/groups`、`/broadcast`、`/digest`）共用同一个 `admin` 路由，靠宿主补的 `input.page` 分派。
- **邮件投递走 transport 抽象**（`src/transport/`）：分组同步 / 群发 / Webhook 回执只依赖 `BroadcastTransport` 接口，当前实现是 Resend（分组 → **Segments**，群发 → **Broadcasts**，回执 → **Webhook** 验签）；设置项 `broadcastProvider` 选择生效 provider，换服务只需新增一个实现并在 `resolveTransport()` 登记。
- **订阅摘要（每周 / 每月）**（`src/digest.ts` + `src/schedule.ts`）：节奏（cadence）是**平行受众维度**，`confirmed` 订阅者同时并入分组 segment 与节奏 segment；每档一个插件 cron 任务（`ctx.cron.schedule`，**UTC** 时区）在周期结束时向节奏受众群发「上一自然周 / 自然月」的文章精选。**`plugin:activate` 非每次启动触发** ⇒ 后台「订阅摘要」页加载时自愈重注册。`digest_runs` 做同周期去重与留痕。
- **同一 token 贯穿确认与退订**（确认后用途翻转，不轮换）→ 重复点击确认/退订链接**幂等**。
- 事务邮件走 `ctx.email`（`email:send`）；**provider 缺失或投递失败不报错**，落库为记录的 `pendingEmail`。`autoConfirm` 设置可在无邮件服务时走单确认。
- 前台接线：提交走**浏览器 fetch**（端点按客户端 IP 限流，SSR 代理会丢失真实 IP）；确认/退订/读改分组与节奏走 **SSR**（`getPublicPluginApiRouteHandler`，token 即凭证）。`/subscribe/unsubscribe` 即**订阅管理页**（GET 只读，退订/改分组/改节奏走原生 POST）。

### 2.6 `pulse-seo`（结构化数据）

- **唯一可信插件**（`plugins: []`，宿主进程内）：只注册 `page:metadata` 钩子，放沙箱会让**每个公开页面渲染**都起一次 isolate，得不偿失。
- 背景：EmDash `<EmDashHead>` 会自动为公开页面输出一个 JSON-LD（文章 `BlogPosting`，其余 `WebSite`）；模板此前又各自手工注入一份 → **同页两个冲突实体**。
- 机制：`page:metadata` 贡献按 `id` **首个胜出**去重，插件排在 base 之前。故以 `id: "primary"` 贡献唯一实体，覆盖默认块：
  - 文章页 → `NewsArticle`（报刊语义，优于默认 `BlogPosting`）
  - 其余页 → `WebSite`
- 数据只取自 `PublicPageContext`（标题/描述/时间/作者/图片/站点名），**零额外查询**；图片会补成绝对 URL（JSON-LD `image` 建议绝对地址）。
- 模板侧不再手工注入 JSON-LD（`Base.astro` 的 `jsonLd` 属性已移除）。

### 2.7 `pulse-theme`（前台主题切换）

- **零能力沙箱插件**：只注册一个后台 `admin` 路由（Block Kit 页），把选择写进**插件设置** `plugin:pulse-theme:settings:theme`（`ctx.settings.set`）—— 不碰内容 / 媒体 / 用户 / 网络，所以 `capabilities` 与 `storage` 都为空。
- **消费方是宿主信任代码**，不是插件：`src/middleware.ts` 用 `getPluginSetting("pulse-theme", "theme")` 读同一个键（两者都落 options 表），取不到 / 非法则回退 `__DEFAULT_SITE_THEME__`（`astro.config.mjs` 的 `vite.define`）。
- `THEMES` 名称必须与 `astro.config.mjs` 的 `THEME_NAMES` 一致（后者注入 `/_t/<theme>/…` 路由前缀）。
- 详见 [04-frontend-themes.md](./04-frontend-themes.md) §1.1。

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
- **能力门禁在 in-process 下仍然生效**（`adaptSandboxEntry` 保留 `capabilities` 校验、路由头白名单、storage 隔离），但**不再有 isolate 级隔离**：插件与宿主同进程，理论上可触及环境变量 / 文件系统。本项目插件全部自研（见 §1 的选型说明），故风险可控。
- 邮件类插件为独占传输，切换需重新配置并验证。

---

## 5.1 Phase 1 安装实测（本地）

**官方插件（npm，标准描述符，加入 `plugins: []`；Phase 5e 前曾用 `sandboxed: []`，见 §1）**

| 插件 | 状态 | 说明 |
| --- | :-: | --- |
| `@emdash-cms/plugin-audit-log@0.2.3` | ✅ 已装并验证写入 | 能力 `content:read/write`、`media:read`；storage `entries`；hooks `content:beforeSave/afterSave`、`content:beforeDelete/afterDelete`、`media:afterUpload` |
| `@emdash-cms/plugin-ai-moderation@0.2.2` | ❌ 弃用 | 该版本 `main`/`exports` 指向 **TS 源码**（`src/descriptor.ts`，无 `dist`），Astro config 加载时报 `Stripping types is currently unsupported for files under node_modules`；且绑死 CF Workers AI binding。已由自研 `pulse-review` + `pulse-ai` 取代（provider 可换） |

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
| `@meekmedia.bsky.social/bulletin` | ❌ 不再需要 | 原 Spike 2 计划；**D4 修订**后改自研 `pulse-subscriptions` |
| `@msale.com/resend` | ❌ 改用官方 | Spike 3 社区备选；实际接入官方 `emdash-plugin-resend@0.2.0`（npm，见 §2） |

**注册表安装失败根因**：`emdash/src/registry/publisher-handle.ts` 的 `boundedFetch` 对非 `DIRECTORY_ORIGINS`（`plc.directory`、`cloudflare-dns.com`）的请求走 SSRF 校验（`resolveAndValidateExternalUrl`），其 DNS 解析用 **Cloudflare DoH**。本环境 `cloudflare-dns.com` 不可达（TLS 被断），故发布者校验失败。
> 直接在 Node 用 `@atcute/identity-resolver` 的 `PlcDidDocumentResolver` 解析同一 DID **成功** —— 说明 `plc.directory` 可达，问题在 DoH 依赖。
> 结论：**在能访问 Cloudflare DoH（`cloudflare-dns.com`）的网络重试注册表安装**；本地开发可先用 npm 官方插件与自研插件。

**`emdash-plugin` CLI 可用命令**：`search` / `info`（只读发现），`init` / `build` / `dev` / `bundle` / `validate`（自研），`publish` / `release`（发布到 atproto 注册表）。**无本地安装命令** —— 安装走 Admin UI / registry API。

---

## 5.2 Phase 4b 自研插件实测（本地）

自研插件经 npm workspaces 链接（Phase 5e 起统一 in-process，见 §1），`npm run plugin:build`（`--workspaces`）与 `npm run plugin:test` 全绿。

| 插件 | 路由数 | MCP 工具 | 测试 |
| --- | :-: | :-: | :-: |
| `pulse-review` | 0（仅 hooks） | — | 40 用例（发布门禁 4 + 评论审核 36） |
| `pulse-editorial` | 8 | 8 | 9 用例（审核流转 + 选题） |
| `pulse-agent` | 14 | 4 | 29 用例（注册/审批/token/限流 12 + MD→PT 11 + 投稿 6） |
| `pulse-subscriptions` | 16 | 5 | 118 用例（token/邮件 + Resend 客户端/验签 + 同步/群发 + **摘要窗口/取数/幂等/调度** + 后台四页 + 路由） |

HTTP 冒烟（`/_emdash/api/plugins/<slug>/<route>`）：

| 调用 | 结果 |
| --- | --- |
| `POST /pulse-agent/agents/register` | `200`，返回 `agent_id` + 一次性 `registration_secret` |
| `POST /pulse-agent/agents/register`（非法 slug） | `400` + `{ok:false,error:"INVALID_INPUT",issues:[…]}` |
| `GET /pulse-agent/agents/whoami`（无 token） | `401` + `{ok:false,error:"UNAUTHORIZED"}` |
| `GET /pulse-agent/submissions/mine`（无 token） | `401` |
| `POST /pulse-editorial/review/queue`（未登录） | `401 UNAUTHORIZED`（宿主强制鉴权） |

**响应契约**：`pulse-agent` 的**公开路由**声明 `response: "raw"` 并返回 `pluginResponse()`，因此 body 是**裸 JSON**（无 `{success,data}` 信封），且状态码有语义（400 输入错 / 401 未鉴权 / 404 未找到 / 409 冲突 / 429 限流 + `Retry-After`）。私有路由（如 `pulse-editorial` 全部路由、`pulse-agent` 的 `agents/list|approve|reject|revoke`）保持 JSON 信封；未通过宿主鉴权时直接 `401`。

---

## 5.3 Phase 3 实测（评论审核 + 读者订阅）

| 调用 | 结果 |
| --- | --- |
| `POST /pulse-subscriptions/subscribe/request` | `200 {ok:true,status:"pending",delivered:true}` |
| 非法邮箱 | `400 INVALID_INPUT` |
| `GET /subscribe/confirm?token=<确认邮件 token>` | `200`「订阅已确认」；再次访问「该邮箱此前已完成订阅」（幂等） |
| `GET /subscribe/unsubscribe?token=<同一 token>` | `200`「已退订」 |
| `GET /subscribe/confirm?token=bogus` | `200`「确认失败」 |

本地 dev 由 EmDash 内置 console email provider（`emdash-console-email`，dev 自动注册）承接投递，邮件正文打印到 dev 日志 → 确认/退订 token 可从中读取，**无需真实邮件服务即可端到端验证**。生产需配置 Resend（否则记录停在 `pendingEmail`）。详见 [11-phase3-comments-subscriptions.md](./11-phase3-comments-subscriptions.md)。

## 5.4 Phase 4c 实测（MCP 接入）

| 调用 | 结果 |
| --- | --- |
| `PUT /_emdash/api/admin/plugins/<id>/mcp`（`{enabled:true}`） | 200；editorial / agent / subscriptions 三者 `mcpToolsEnabled: true` |
| `POST /_emdash/api/mcp` `tools/list`（Bearer `ec_pat_`，scope 含 `mcp:tools`） | **85 个工具**（72 内置 + 13 插件） |
| `tools/call` `pulse-subscriptions__listSubscribers` | `{ok:true,total:1,…}` |
| `tools/call` `pulse-editorial__reviewQueue` | `{ok:true,count:0,submissions:[]}` |
| 仅 `content:read` token 调插件工具 | `isError:true`，`_meta.code=INSUFFICIENT_SCOPE`（requires `mcp:tools:pulse-subscriptions`） |

**要点**：`/_emdash/api/mcp` **仅接受 Bearer token**（session/dev-bypass 不参与，未带 token 即 401）；响应是 **SSE**（`event: message` / `data:`）；插件工具需 scope + RBAC 双层授权。详见 [06-mcp-agents.md §2/§6](./06-mcp-agents.md)。

## 5.5 Phase 4d 实测（Agent 新闻室端到端）

`node scripts/agent-e2e.mjs` 在真实 dev 站点跑通全链路（编辑侧走 MCP，agent 侧走公开 raw 路由），**26/26 通过**：

```
注册(pending) → 编辑批准(MCP,签发 token) → whoami
  → 编辑建选题(MCP) → agent 见选题 → 领取(条目行=claimed, 移出 available)
  → 投稿(条目行=submitted + 回填 submitted_article, 幂等)
  → 发布门禁: pending_review 直接 publish → PUBLISH_REJECTED
  → 待审队列(MCP) → 详情 → 批准并发布 → 前台 200
  → agent token 当 Bearer 调 MCP → 401(隔离)
```

**该 E2E 暴露并修复了两个真实 bug**（单测宿主掩盖、只有真实站点能现形）：`pulse-agent` 把 `assignment`（relation 型 reference）写进 `data` 导致投稿 400；`assignments` 开 drafts/revisions 导致 `update` 只写草稿、选题可被重复领取。详见 [10-phase0-report.md Phase 4d](./10-phase0-report.md)。

## 5.6 Phase 5 实测（SEO / 结构化数据）

新增**可信插件 `pulse-seo`**（`plugins: []`，4 用例）覆盖模板重复注入的 JSON-LD。构建期探针确认注册面：`Hooks: page:metadata` / `Routes: (none)`。

实测（真实 dev 站点）：

| 页面 | 结果 |
| --- | --- |
| `/articles/suda-pulse-launch` | **1** 个 `ld+json`，`@type=NewsArticle`（原先 2 个：`BlogPosting` + `NewsArticle`） |
| `/` | **1** 个 `ld+json`，`@type=WebSite`（含 `description`） |
| `/sections/top`、`/editions/2026-w41` | 各 **1** 个 `ld+json`（`WebSite`） |

插件单测合计 **109**（review 40 + agent 29 + editorial 9 + subscriptions 27 + seo 4）。

---

## 6. 已确认

- 🔁 **D4（修订）**：订阅**自研 `pulse-subscriptions`**（原定社区 `bulletin`）。理由：需要自有订阅表与 Agent 订阅意向对齐，且本地可完整验证数据流；邮件传输仍不锁定单一 provider。
- ✅ **D5**：邮件传输采用 **Resend**（`emdash-plugin-resend`）—— 待凭证。
- ✅ **D14**：评论审核**规则 + AI**（`pulse-review` 独占 `comment:moderate`；AI 委托 `pulse-ai` 网关，失败降级不自动通过）。
- ✅ 部署：**VPS + Docker 三容器（Node + PostgreSQL + Redis）**；AI 经 `pulse-ai`（provider 可换）。
- ✅ 结构化数据：**自研 `pulse-seo`**（可信插件）统一 JSON-LD，不引入第三方 SEO 套件（见 §2.6）。
- ⏳ 待定：分析插件（Cloudflare vs Umami）。
