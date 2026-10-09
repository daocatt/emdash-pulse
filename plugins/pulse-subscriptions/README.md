# pulse-subscriptions

Suda Pulse **读者订阅**沙箱插件（自研，替代 bulletin 依赖）。

## 能力与存储

- capabilities：`email:send`、`network:request`（直连 Resend REST + 接收 Webhook）、`content:read`（摘要读取 `articles`）
- allowedHosts：`api.resend.com`
- storage：
  - `subscribers`（唯一索引 `emailHash`；索引 `status` / `createdAt` / `tokenHash`）
  - `groups`（订阅分组；索引 `active` / `sortOrder`；**slug 即记录 id，创建后不可变**）
  - `events`（订阅事件日志，append-only；索引 `subscriberId` / `type` / `at`）
  - `broadcasts`（群发历史；索引 `createdAt`）
  - `digest_runs`（摘要运行留痕 + 幂等判据；索引 `cadence` / `sentAt`；**不声明 unique**）

状态机：`pending`（待确认）→ `confirmed`（已确认）→ `unsubscribed`（已退订），
外加只能由后台进出的 `paused`（暂停投递，记录保留）。
确认 / 退订 token 明文只出现在邮件链接中，存储只留 SHA-256 哈希。

**订阅分组**是叠加在订阅之上的细分段：订阅记录用 `groups: string[]`（slug 列表）持有，
一个都不勾 = 主刊订阅者。停用分组只影响前台表单，不解除已有订阅关系。

**事件日志**是旁路：每次状态流转（提交 / 确认 / 退订 / 暂停 / 恢复 / 改分组 / 订阅被拦截）
都追加一条，后台按订阅者回放时间线，也是「退订记录」的来源。写日志失败不影响主流程。
Resend 侧的回执（`email.delivered` / `bounced` / `complained` / `opened` / `clicked`）与同步
失败（`resend_sync_failed`）也落同一张表。

## 路由

| 路由 | 方法 | 可见性 | 权限 | 说明 |
| --- | --- | --- | --- | --- |
| `subscribe/request` | POST | 公开 | — | 提交邮箱 + 可选 `groups` → 建 pending + 发确认邮件；已确认则幂等返回（可顺手更新分组）；命中 `paused` 则不改状态、只记 `request_blocked` |
| `subscribe/confirm` | POST | 公开 | — | 凭确认 token 转 confirmed，转出退订用途 token 并发欢迎邮件 |
| `unsubscribe` | POST | 公开 | — | 凭退订 token 转 unsubscribed，可带 `reason` |
| `preferences` | POST | 公开 | — | 读者自助（token 即凭证）：`{token}` 只读返回 `{email,status,groups,cadence,cadences,available}`；带 `groups` / `cadence` 则写入 |
| `groups/public` | POST | 公开 | — | 只读启用中的分组（前台订阅表单用）。**不加 IP 限流**——SSR 取不到真实 IP |
| `resend/webhook` | POST | 公开 | — | 投递回执（当前 transport 验签，Resend 用 Svix，`request: { body: "text" }`）。未配置签名密钥 → 503；验签失败 → 401 |
| `subscribers/list` | POST | 私有 | `plugins:manage` | 订阅者列表（`status` / `group` / `q` / `limit` 过滤）+ 各状态计数 |
| `subscribers/update` | POST | 私有 | `plugins:manage` | 行级操作：`pause` / `resume` / `unsubscribe` / `set_groups` |
| `subscribers/events` | POST | 私有 | `plugins:manage` | 某订阅者的事件时间线 |
| `groups/list` | POST | 私有 | `plugins:manage` | 分组列表（含 `members` 计数） |
| `groups/save` | POST | 私有 | `plugins:manage` | 新建（`create:true`，slug 必须不存在）/ 更新分组 |
| `groups/delete` | POST | 私有 | `plugins:manage` | 删除分组，并先从订阅者记录里摘掉该 slug |
| `digest/run` | POST | 私有 | `plugins:manage` | 手动触发某档摘要（忽略总开关与去重） |
| `digest/resync` | POST | 私有 | `plugins:manage` | 重新同步全部已确认订阅者到远端受众（含节奏受众）；上线后跑一次 backfill |
| `digest/runs` | POST | 私有 | `plugins:manage` | 摘要运行历史 |
| `admin` | — | 私有 | `plugins:manage` | 后台四页（Block Kit，靠 `input.page` 分派） |

公开路由为 `response: "raw"`（返回真实 400/401/409/429/503 状态码）。

MCP 工具：`listSubscribers`（含 `group` / `q`）、`listGroups`、`listDigestRuns`、`runDigest`、`resyncDigestAudience`。

## 订阅摘要（每周 / 每月）

按**订阅节奏**自动向读者发送上一周期的内容精选。见 `src/digest.ts`（内容 + 运行）、`src/schedule.ts`（定时注册）。

- **节奏**（cadence）：订阅者记录上的 `cadence: "weekly" | "monthly"`；缺省用设置 `defaultCadence`。
  读者可在**订阅管理页**自助切换（`preferences` 路由的 `cadence` 字段）。
- **受众**：节奏是**平行的受众维度** —— `confirmed` 订阅者除分组 segment 外，还会被同步进
  「`前缀 + 每周/每月`」segment（id 缓存在 `ctx.kv`，见 `segments.ts` 的 `cadenceAudienceId`）。
- **调度**：`ctx.cron.schedule("digest-weekly" / "digest-monthly", …)`（幂等 upsert）。
  **时区固定 UTC**（本站 CST = UTC+8，默认 `0 0 * * 1` = 周一 08:00、`0 0 1 * *` = 每月 1 日 08:00）。
  注册时机：`plugin:activate`（首次安装 / 后台重启用）；后台「订阅摘要」页加载时会再调一次**自愈**
  —— 宿主**不是每次启动**都触发 activate。
- **内容**：`上一个完整自然周 / 自然月`（CST 对齐）内发布的文章，按「头条候选 → 版面权重 → 时间」
  排序取前 N 篇。插件侧 `ctx.content.list` **不支持按 `published_at` 区间过滤**，故取一批后**在 JS 里裁剪**。
- **投递**：走当前 transport 的 `send()`（Resend Broadcasts，面向节奏受众）。
- **幂等**：每档最近一条 `digest_runs` 的 `windowUntil >= 本期 until` 时跳过；窗口内无文章不发。
- **手动**：后台「订阅摘要」页可「立即发送本期」（忽略去重）与「重新同步受众」（backfill）。

## 后台

manifest `admin.pages` 注册四个页面，共用同一个 `admin` 路由（宿主会给每个交互补上 `page`）：

- `/subscribers`（订阅者）：统计 + 筛选（状态 / 分组 / 邮箱关键词）+ 订阅者表
  （邮箱脱敏；行级操作：暂停 / 恢复 / 退订 / 改分组 / 订阅记录）+ 显式分页。
- `/groups`（订阅分组）：统计 + 新建 / 编辑表单 + 分组表（名称 / slug / 订阅人数 / 状态 / 排序）。
- `/broadcast`（订阅群发）：选目标分组 + 主题 + HTML 正文 → 走 Resend Broadcast 立即发送；
  下方是本地群发历史（主题 / 分组 / 状态 / 时间 / 详情）。
- `/digest`（订阅摘要）：开关与通道状态、每周 / 每月任务的下次运行时间（**本地时区展示**）、
  节奏订阅者计数、立即发送本期、重新同步受众、运行历史表。

实现要点（踩过的坑，见 `src/admin.ts` 顶部注释）：

- 宿主**只回传** `block_action.value` / `form_submit.values` / `form_submit.block_id`，
  **不带**上一次的表单值 ⇒ 筛选条件内嵌进分页按钮的 value（`encodeState`），否则一翻页筛选就丢。
- 分组是数组字段，插件存储建不了索引 ⇒ 订阅者列表走内存扫描 + 内存分页，
  `MAX_SCAN = 1000` 护栏，触顶用 `banner` 显式提示收窄筛选。
- 行级操作照仓库既有约定用 `"<action>:<id>"` 冒号编码（见 pulse-agent）。
- Block Kit 的块与元素是两层：`menu` / `select` / `checkbox` 等元素必须嵌在
  `actions` / `form` / `table` 的 element 列里，不能直接放进 `blocks[]`。

## 设置

`admin.settingsSchema`：`autoConfirm`（单确认，无邮件服务时可用）、`replyTo`、
`confirmSubject`、`welcomeSubject`、`confirmPath`、`unsubscribePath`、
`broadcastProvider`（群发投递通道，默认 `resend`）、
`digestEnabled`（摘要总开关）、`defaultCadence`（默认节奏）、`weeklySchedule` / `monthlySchedule`
（**UTC** cron）、`digestMaxArticles`、`weeklySubject` / `monthlySubject`（支持 `{site}` / `{count}`）、
`resendSyncEnabled`、`resendSegmentPrefix`、`resendWebhookSecret`。

## 邮件

走 `ctx.email`（需 `email:send` 能力 + 站点已配置 provider）。**未配置 provider 或投递失败时不报错**，
而是把邮件快照落库为 `pendingEmail`（`subscribers/list` 的 `pending_email` 字段可见）。

## 邮件投递（transport 抽象；当前实现为 Resend）

分组同步、群发、投递回执都走一层 **transport 抽象**（`src/transport/`），订阅主流程只依赖
`BroadcastTransport` 接口，不直接依赖任何具体邮件服务。当前唯一实现是 **Resend**
（`src/transport/resend.ts`），底层 REST 客户端仍是 `src/resend.ts`。

- **语义接口**：`isConfigured` / `fromAddress` / `ensureAudience`（分组 → 远端受众，幂等）/
  `syncContact`（建改联系人 + 覆盖受众归属）/ `send`（创建并立即群发）/ `verifyWebhook` /
  `mapWebhookEvent`。受众 id 对调用方是**不透明字符串**。
- **怎么接新 provider**（如 Rilay / 其它服务）：① 新增 `src/transport/<provider>.ts` 实现接口；
  ② 在 `src/transport/index.ts` 的 `TRANSPORT_LABELS` 与 `resolveTransport()` 登记；
  ③ manifest 的 `broadcastProvider` 选项加一项、把该服务 host 加进 `allowedHosts`。
- **选择 provider**：设置项 `broadcastProvider`（默认 `resend`），见 `resolveTransport()`。

Resend 实现的具体约定：

- **凭证复用**「Resend」插件（id `emdash-resend`）的 `apiKey` / `fromAddress`，本插件不重复配置。
  插件设置按 plugin id 隔离，跨插件读只能靠 `loadHost()`（动态 `import("emdash")` 拿
  `getPluginSetting`）——**specifier 必须是运行时变量**，否则 rolldown 静态解析失败、`tsc`
  拉进 EmDash 整张类型图后 OOM（见 `src/resend.ts` 注释）。
- **同步是旁路**：`syncSubscriber` 永不抛错，任何失败只记一条 `resend_sync_failed` 事件。
  状态映射：`confirmed` → `unsubscribed:false` + 所属分组的 segment；`paused` / `unsubscribed`
  → `unsubscribed:true` 且清空分组；`pending` 跳过（邮箱未确认，不该进联系人表）。
- **分组 ↔ segment**：首次同步按「前缀 + 分组名」找 segment，找不到就创建，id 缓存回组记录的
  `resendSegmentId`（字段名沿用历史，语义 = 当前 transport 的受众 id；见 `src/segments.ts`）。
- **群发**：走 Resend Broadcasts，收件人池由 Resend 按 segment 展开，自动插入退订链接
  （`{{{RESEND_UNSUBSCRIBE_URL}}}`）、跳过已退订联系人，本地不维护投递名单。
- **Webhook**：`resend/webhook`（路由名沿用，已配置的 URL 不变）用 Svix 方案验签
  （`svix-id` / `svix-timestamp` / `svix-signature` + `whsec_` 密钥，WebCrypto HMAC-SHA256）。
  必须声明 `request: { body: "text" }` —— 验签对象是原始字节，先 `JSON.parse` 再 `stringify`
  会改字节导致必失败。回执只留痕，**不自动改订阅状态**（软退信 ≠ 用户不想收，处置交人工）。

## 前台接线

- `src/utils/subscriptions.ts`：`fetchActiveGroups` / `callPreferences` / `resolveManageOutcome`。
- `SubscribeForm.astro`：可选渲染分组勾选；提交始终带 `groups`（**不含节奏**，新读者用默认节奏）。
- 两套主题的 `pages/subscribe.astro` 传 `groups`，`pages/subscribe/unsubscribe.astro` 即**订阅管理页**
  （GET 只读，退订 / 改分组 / 改节奏走原生 POST）。

## 命令

```bash
npm run build   # 构建 dist/*
npm run test    # validate + vitest
```

本地灌测试数据（分组 / 事件 / 暂停态订阅者）：`node scripts/seed-test-engagement.mjs`（仓库根）。
