# pulse-subscriptions

Suda Pulse **读者订阅**沙箱插件（自研，替代 bulletin 依赖）。

## 能力与存储

- capabilities：`email:send`、`network:request`（直连 Resend REST + 接收 Webhook）
- allowedHosts：`api.resend.com`
- storage：
  - `subscribers`（唯一索引 `emailHash`；索引 `status` / `createdAt` / `tokenHash`）
  - `groups`（订阅分组；索引 `active` / `sortOrder`；**slug 即记录 id，创建后不可变**）
  - `events`（订阅事件日志，append-only；索引 `subscriberId` / `type` / `at`）
  - `broadcasts`（群发历史；索引 `createdAt`）

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
| `preferences` | POST | 公开 | — | 读者自助（token 即凭证）：`{token}` 只读返回 `{email,status,groups,available}`；带 `groups` 则写入 |
| `groups/public` | POST | 公开 | — | 只读启用中的分组（前台订阅表单用）。**不加 IP 限流**——SSR 取不到真实 IP |
| `resend/webhook` | POST | 公开 | — | Resend 投递回执（Svix 验签，`request: { body: "text" }`）。未配置 `resendWebhookSecret` → 503；验签失败 → 401 |
| `subscribers/list` | POST | 私有 | `plugins:manage` | 订阅者列表（`status` / `group` / `q` / `limit` 过滤）+ 各状态计数 |
| `subscribers/update` | POST | 私有 | `plugins:manage` | 行级操作：`pause` / `resume` / `unsubscribe` / `set_groups` |
| `subscribers/events` | POST | 私有 | `plugins:manage` | 某订阅者的事件时间线 |
| `groups/list` | POST | 私有 | `plugins:manage` | 分组列表（含 `members` 计数） |
| `groups/save` | POST | 私有 | `plugins:manage` | 新建（`create:true`，slug 必须不存在）/ 更新分组 |
| `groups/delete` | POST | 私有 | `plugins:manage` | 删除分组，并先从订阅者记录里摘掉该 slug |
| `admin` | — | 私有 | `plugins:manage` | 后台三页（Block Kit，靠 `input.page` 分派） |

公开路由为 `response: "raw"`（返回真实 400/401/409/429/503 状态码）。

MCP 工具：`listSubscribers`（含 `group` / `q`）、`listGroups`。

## 后台

manifest `admin.pages` 注册三个页面，共用同一个 `admin` 路由（宿主会给每个交互补上 `page`）：

- `/subscribers`（订阅者）：统计 + 筛选（状态 / 分组 / 邮箱关键词）+ 订阅者表
  （邮箱脱敏；行级操作：暂停 / 恢复 / 退订 / 改分组 / 订阅记录）+ 显式分页。
- `/groups`（订阅分组）：统计 + 新建 / 编辑表单 + 分组表（名称 / slug / 订阅人数 / 状态 / 排序）。
- `/broadcast`（订阅群发）：选目标分组 + 主题 + HTML 正文 → 走 Resend Broadcast 立即发送；
  下方是本地群发历史（主题 / 分组 / 状态 / 时间 / 详情）。

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
`resendSyncEnabled`、`resendSegmentPrefix`、`resendWebhookSecret`。

## 邮件

走 `ctx.email`（需 `email:send` 能力 + 站点已配置 provider）。**未配置 provider 或投递失败时不报错**，
而是把邮件快照落库为 `pendingEmail`（`subscribers/list` 的 `pending_email` 字段可见）。

## Resend 集成（Segments / Contacts / Broadcasts）

订阅分组同步到 Resend 的 **Segments**，群发走 **Broadcasts** —— 收件人池由 Resend 按
segment 展开，自动插入退订链接、跳过已退订联系人，本地不维护投递名单。

- **凭证复用**「Resend」插件（id `emdash-resend`）的 `apiKey` / `fromAddress`，本插件不重复配置。
  插件设置按 plugin id 隔离，跨插件读只能靠 `loadHost()`（动态 `import("emdash")` 拿
  `getPluginSetting`）——**specifier 必须是运行时变量**，否则 rolldown 静态解析失败、`tsc`
  拉进 EmDash 整张类型图后 OOM（见 `src/resend.ts` 注释）。
- **同步是旁路**：`syncSubscriber` 永不抛错，任何失败只记一条 `resend_sync_failed` 事件。
  状态映射：`confirmed` → `unsubscribed:false` + 所属分组的 segment；`paused` / `unsubscribed`
  → `unsubscribed:true` 且清空分组；`pending` 跳过（邮箱未确认，不该进联系人表）。
- **分组 ↔ segment**：首次同步按「前缀 + 分组名」找 segment，找不到就创建，id 缓存回组记录的
  `resendSegmentId`（见 `src/segments.ts`）。
- **Webhook**：`resend/webhook` 用 Svix 方案验签（`svix-id` / `svix-timestamp` / `svix-signature`
  + `whsec_` 密钥，WebCrypto HMAC-SHA256）。必须声明 `request: { body: "text" }` —— 验签对象是
  原始字节，先 `JSON.parse` 再 `stringify` 会改字节导致必失败。回执只留痕，**不自动改订阅状态**
  （软退信 ≠ 用户不想收，处置交人工）。

## 前台接线

- `src/utils/subscriptions.ts`：`fetchActiveGroups` / `callPreferences` / `resolveManageOutcome`。
- `SubscribeForm.astro`：可选渲染分组勾选；提交始终带 `groups`。
- 两套主题的 `pages/subscribe.astro` 传 `groups`，`pages/subscribe/unsubscribe.astro` 即**订阅管理页**
  （GET 只读，退订 / 改分组走原生 POST）。

## 命令

```bash
npm run build   # 构建 dist/*
npm run test    # validate + vitest
```

本地灌测试数据（分组 / 事件 / 暂停态订阅者）：`node scripts/seed-test-engagement.mjs`（仓库根）。
