# 订阅摘要（每周 / 每月）规划

> 状态：**待确认（本文档为实施前规划，确认后再编码）**
> 归属插件：`pulse-subscriptions`（扩展，不新建插件）
> 关联：[11-phase3-comments-subscriptions.md](./11-phase3-comments-subscriptions.md)、[07-plugins.md](./07-plugins.md)、[16-vps-deployment.md](./16-vps-deployment.md)

---

## 1. 背景与目标

读者可以订阅站点，但目前只有「事务性邮件」（确认 / 欢迎 / 退订），**没有「按节奏给订阅者发内容」的机制**。

目标：

1. 订阅者可在**前台自助修改订阅节奏**（每周 / 每月）。
2. 系统按节奏**自动生成并投递**该周期内的内容摘要。
3. 复用现有投递链路（transport → Resend Broadcasts / Segments），不新增发送通道。

**已确认决策（2026-10-09，用户拍板）**：

| 决策 | 结论 |
| --- | --- |
| 投递机制 | **按 cadence 群发**（cadence 作为受众维度，走 transport `send()` / Broadcasts） |
| 节奏档位 | **只有每周 / 每月**（**不做每天**） |
| 内容来源 | **时间窗口** |
| 窗口口径 | **自然周 / 自然月**（上一个完整周期，**非滚动**） |
| 插件位置 | **扩展 `pulse-subscriptions`**（不新建 `pulse-digest`） |
| 订阅表单 | **不加**节奏选择（新读者一律用 `defaultCadence`，之后在管理页改） |
| 老订阅者 backfill | **仅后台手动按钮**（不做自动 backfill） |

> 为什么扩展而不新建：EmDash 插件存储**按 plugin id 隔离**，`subscribers` 集合只有 `pulse-subscriptions` 能直接读；新建插件要么靠公开路由、要么动态 `import("emdash")` 取仓库，跨插件读订阅者非常别扭。而订阅者存储、transport、退订 token、前台管理页**都已在本插件**，扩展是唯一顺路的选择。

---

## 2. 现状调研（关键事实 + 源码位置）

### 2.1 EmDash 内置插件 cron —— 正是缺的那块

- **cron 是插件的标准 hook**：`hooks: { cron: async (event, ctx) => {...} }`。宿主对每个声明了 cron 的插件都注册（`node_modules/emdash/dist/menus-DL8IPIcm.mjs:1603`）。
- **注册任务**：`ctx.cron.schedule(name, { schedule, data })` —— 幂等 upsert，键为 `(plugin_id, task_name)`（`cron-C6ytTOLw.mjs:185`）；`ctx.cron.cancel(name)`、`ctx.cron.list()`。`ctx.cron` **始终可用、按插件隔离**，无需额外能力。
- **事件形状**：`CronEvent = { name, data?, scheduledAt }`（`types-C4P7F1Vq.d.mts:836`）。
- **状态**：`_emdash_cron_tasks` 表；Node 下由 `NodeCronScheduler`（croner，`menus-DL8IPIcm.mjs:3088`）驱动，`virtual:emdash/scheduler` 默认实现。
- **时区固定 UTC**（对齐 Workers，`cron-C6ytTOLw.mjs:15`）。支持 `@daily`/`@weekly`/`@monthly` 与 5/6 段 cron；**一次性任务 = ISO 时间串**（失败指数退避重试，最多 5 次）。
  - 本站 `Asia/Shanghai`（UTC+8，无 DST）：`0 0 * * 1` = **周一 08:00 CST**；`0 0 1 * *` = **每月 1 日 08:00 CST**。

### 2.2 订阅者没有 cadence 字段

`SubscriberRecord`（`plugins/pulse-subscriptions/src/subscribers.ts:32`）现有字段：`email` / `emailHash` / `status` / `token*` / `source` / `groups` / `createdAt` / `requestedAt` / `confirmedAt` / `unsubscribedAt` / `unsubscribeReason` / `paused*` / `lastSentAt` / `emailDelivered` / `pendingEmail`。**没有节奏字段**，需新增。

### 2.3 插件侧内容查询不支持日期区间

`ctx.content.list(collection, options)`（`types-C4P7F1Vq.d.mts:392`）的 `where` 只有 `status` / `locale` / `fieldFilters`（**索引字段**），**没有 `published_at` gte/lt** —— 那是站点侧 `getEmDashCollection` 的能力（见 `src/utils/edition.ts`）。
→ 摘要窗口在 JS 里过滤：取已发布文章 top-N（按 `published_at` 倒序），再按窗口裁剪。
→ 需给插件加 **`content:read`** 能力（manifest 用 `content:read`；`read:content` 已废弃）。`ContentItem` 含 `id` / `slug` / `status` / `data` / `publishedAt`（`types-C4P7F1Vq.d.mts`）。

### 2.4 受众（Segment）同步机制

`segments.ts`：分组 slug ↔ 远端受众，靠「组记录上的 `resendSegmentId` 缓存 + 按名字兜底查找」绑定；`syncSubscriber` 把 `confirmed` 联系人同步进**其分组的所有受众**（`audienceIds` 是**全量替换**语义），`paused`/`unsubscribed` 同步为 `unsubscribed:true` 并清空受众。**群发**（`broadcast.ts`）即向某个分组的受众 `transport.send({ audienceId, ... })`。

→ cadence 作为**平行受众维度**：`confirmed` 联系人除分组受众外，再并入其 cadence 受众。

### 2.5 前台管理页是「无 JS 表单 POST」

`src/themes/<t>/pages/subscribe/unsubscribe.astro` POST → `@utils/subscriptions` 的 `resolveManageOutcome` → 插件公开路由 `preferences`（token 即凭证）。加节奏 = 扩展该路由 + 页面加单选 + `PreferencesSnapshot`。

### 2.6 生命周期触发时机（关键约束）

`plugin:activate` **只在**「首次安装（DB 未记录该插件）」或「后台重新启用」时触发（`emdash-runtime-C4oFeVpN.mjs:1350` `installUnrecordedConfigPlugins`，:2010 调用；`setPluginStatus` 只在后台启用/禁用路径调用）。**不是每次启动都触发**。
→ cron 任务在 `plugin:activate` 注册（首次）+ 需要一个**自愈入口**（后台页 / 路由）应对任务行被删或库恢复。任务行落在绑定挂载的 PG 里，**重新部署不会丢**，所以正常运行无需每次重注册。

---

## 3. 设计

### 3.1 数据模型

**`SubscriberRecord` 新增**：

```ts
/** 投递节奏；缺省 = 插件设置 defaultCadence（默认 weekly）。 */
cadence?: Cadence;
```

```ts
export type Cadence = "weekly" | "monthly";
export const CADENCE_LABELS: Record<Cadence, string> = { weekly: "每周", monthly: "每月" };
export const isCadence = (v: unknown): v is Cadence => v === "weekly" || v === "monthly";
/** 未设置时按默认档位解释。 */
export const cadenceOf = (record: SubscriberRecord, fallback: Cadence): Cadence =>
  isCadence(record.cadence) ? record.cadence : fallback;
```

**新增集合 `digest_runs`**（运行留痕 + 幂等判据）：

```ts
interface DigestRunRecord {
  cadence: Cadence;
  windowSince: string;   // ISO
  windowUntil: string;   // ISO
  sentAt: string;        // ISO
  segmentId: string;
  transportId: string;   // transport.id
  count: number;         // 文章条数
  status: "sent" | "skipped" | "failed";
  error?: string;
}
```

manifest：`digest_runs: { indexes: ["cadence", "sentAt"] }`。
**注意**：`uniqueIndexes` 建的是含 `collection` 维度的唯一索引（`(plugin_id, collection, (data)::jsonb->>'field')`），跨集合同名字段不会互撞；但**本集合内该字段必须必然唯一**才可声明 —— `digest_runs` 的 `cadence` / `sentAt` 天然会重复，故**只声明 `indexes`、不声明 `uniqueIndexes`**。

### 3.2 插件设置（manifest `admin.settingsSchema`）

| key | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `digestEnabled` | boolean | `true` | 总开关（关时 `cancel` 两个任务） |
| `defaultCadence` | select(weekly/monthly) | `weekly` | 未显式选择的订阅者的档位 |
| `weeklySchedule` | string | `0 0 * * 1` | **UTC** cron（= 周一 08:00 CST） |
| `monthlySchedule` | string | `0 0 1 * *` | **UTC** cron（= 每月 1 日 08:00 CST） |
| `digestMaxArticles` | number | `12` | 单期最多条数 |
| `weeklySubject` | string | `本周回顾 · {site}` | 支持 `{site}` / `{count}` 占位 |
| `monthlySubject` | string | `本月回顾 · {site}` | 同上 |

> 采用**原始 cron 字符串**而非「本地小时」下拉：UTC 换算在跨日（周几/月几）时易错，交给运维用 cron 表达最直白；后台页把 `nextRunAt`（UTC）**转成本地时间展示**，兼顾可读性。

**能力**：`capabilities` 追加 `content:read`；`allowedHosts` 不变（仍 `api.resend.com`）。

### 3.3 前台：订阅节奏偏好

- **`preferences` 路由**（`plugin.ts`）：
  - 读：返回 `cadence`（含默认解释后的值）+ 现有 `groups` / `available` / `email` / `status`。
  - 写：入参接受可选 `cadence`；与 `groups` 同一次 POST 生效；写后 `syncSubscriber`（cadence 受众随之更新）。
- **`src/utils/subscriptions.ts`**：`PreferencesSnapshot` 增 `cadence`；`callPreferences(locals, token, { groups?, cadence? })`；`resolveManageOutcome` 的 `ManageRequest` 增 `cadence`，`intent: "cadence"`（或与 `groups` 合并为一个 `intent: "preferences"`）。
- **管理页**（两套主题的 `subscribe/unsubscribe.astro`）：新增「订阅节奏」区块 —— 单选（每周 / 每月），原生 `<form method="post">`，保存后回显 `notice: "saved"`。
- **`subscribe/request`**：入参增**可选** `cadence`（缺省走 `defaultCadence`）；**订阅表单不加节奏控件**（保持极简，新读者之后在管理页改）。

### 3.4 受众：cadence → 远端受众

- 新增 `cadenceAudienceId(ctx, transport, cadence, prefix)`：
  1. 先查 `ctx.kv.get("digest.segment." + cadence)`（缓存 id）；
  2. 否则 `transport.ensureAudience(segmentName(prefix, CADENCE_LABELS[cadence]))`，写回 KV。
- **`syncSubscriber` 扩展**：`confirmed` 时，`audienceIds = 分组受众 ∪ { cadence 受众 }`；`paused`/`unsubscribed` 仍为 `unsubscribed:true` 且清空受众。
- **Backfill**：新增后台动作 / 路由 `digest/resync` —— 遍历 `confirmed` 订阅者调用 `syncSubscriber`（老订阅者在功能上线前从未进过 cadence 受众）。返回 `{ scanned, synced, failed }`。

### 3.5 调度

- `ensureDigestSchedules(ctx)`（幂等 upsert）：
  - `digestEnabled` 为真 → `schedule("digest-weekly", { schedule: weeklySchedule })` + `schedule("digest-monthly", { schedule: monthlySchedule })`；
  - 为假 → `cancel` 两者。
- **任务名不含冒号**：宿主校验 `^[a-zA-Z][a-zA-Z0-9_-]*$`，故用 `digest-weekly` / `digest-monthly`。
- **注册时机**：`hooks["plugin:activate"]` 调用 `ensureDigestSchedules`；后台「摘要」页加载时再调一次（自愈）。
- **cron hook**：

```ts
hooks: {
  "plugin:activate": async (_event, ctx) => { await ensureDigestSchedules(ctx); },
  cron: async (event, ctx) => {
    const cadence = cadenceFromTaskName(event.name);
    if (cadence) await runDigest(ctx, cadence);
  },
}
```

### 3.6 内容生成（新 `digest.ts`）

- `digestWindow(cadence, now)` → `{ since, until }`：**上一个完整自然周期**（`Asia/Shanghai`，UTC+8 无 DST）。
  - 周报 = 上一个**自然周**（周一 00:00 → 本周一 00:00 CST）；月报 = 上一个**自然月**（上月 1 日 00:00 → 本月 1 日 00:00 CST）。
  - 算法：把 `now` 平移到 CST 墙钟（`+8h` 后用 `getUTC*` 读数）→ 求周期起点 → 减 `8h` 还原为真实 UTC ISO。默认 cron（周一 / 1 日 08:00 CST）触发时，窗口恰为「上一周 / 上一月」。
  - 因为窗口是**对齐周期**，同一周期只会算出一致的 `since/until` → 幂等判据直接用 `until`（见 §3.7）。
- `selectDigestArticles(ctx, window, max)`：
  1. `ctx.content.list("articles", { where: { status: "published" }, orderBy: { published_at: "desc" }, limit: 50 })`
     （**实现时核对** `orderBy` 键名：`published_at` vs `publishedAt`）
  2. JS 过滤 `publishedAt ∈ [since, until)`；
  3. 排序：`is_featured` 优先 → `priority`（lead > high > normal）→ 时间倒序；
  4. 取前 `max` 条。
- `buildDigestEmail({ cadence, articles, siteName, subject })` → 纯函数返回 `EmailMessage`（text + html），每条含标题（链接）、导语 / 摘要。链接优先 `ctx.content.getPublicUrl?.("articles", id)`，回退 `/articles/<slug>`。
- **窗口内 0 篇 → 跳过**（不发空摘要）。

### 3.7 运行与幂等（`runDigest`）

```
runDigest(ctx, cadence):
  1. 读设置；digestEnabled=false → return
  2. httpFetcher(ctx) 无 → 记 failed(no_http) return
  3. resolveTransport + isConfigured + fromAddress → 否则记 failed 并 return
  4. window = digestWindow(cadence, now)
  5. 幂等：取该 cadence 最近一条 digest_runs，若 last.windowUntil >= window.until → skipped return
  6. articles = selectDigestArticles(...); 若空 → 记 skipped return
  7. audienceId = cadenceAudienceId(...); 无 → 记 failed return
  8. email = buildDigestEmail(...)
  9. transport.send({ audienceId, subject, html, text, name })
  10. 记 digest_runs（sent / failed）+ 事件日志
```

### 3.8 后台页「摘要」（`/digest`，Block Kit）

- 顶部：开关状态、transport 与 From、两个任务的**下次运行时间（本地时区）**（`ctx.cron.list()`）。
- 中部：最近 `digest_runs`（档位 / 窗口 / 条数 / 状态）。
- 操作：**立即发送**（手动 `runDigest`，忽略幂等）、**重新同步受众**（`digest/resync`）。
- 遵循 Block Kit 约束：块与元素分层、字段 snake_case；后台页测试跑 `validateBlocks`。

---

## 4. 任务拆解

1. **数据与设置**：`SubscriberRecord.cadence`、`Cadence` 工具、`digest_runs` 集合、manifest（settings + `read:content`）。
2. **前台偏好**：`preferences` 路由读写 cadence、`PreferencesSnapshot`、管理页单选（两套主题）、`subscribe/request` 入参。
3. **受众**：`cadenceAudienceId` + `syncSubscriber` 扩展 + `digest/resync`。
4. **调度**：`ensureDigestSchedules` + `cron` hook + `plugin:activate`。
5. **内容**：`digest.ts`（窗口 / 取数 / 模板，纯函数）。
6. **运行**：`runDigest` + `digest_runs` 幂等。
7. **后台页**：`/digest` + 手动触发 + 重同步。
8. **测试**：单测（窗口 / 取数排序 / 模板 / 幂等）+ `npm run demo:data` 冒烟（真实 PG 唯一索引 / 触发器）+ `plugin:build` / `plugin:test` / `typecheck:all` / `build`。
9. **文档**：`07-plugins.md`、`docs/README.md` 索引与进度、`12-operations.md`（编辑 SOP）、`plugins/pulse-subscriptions/README.md` + `AGENTS.md`、根 `AGENTS.md`（若涉约束）。

---

## 5. 风险与坑

- **cron 时区是 UTC**，不是 CST；设置里写 UTC cron，后台页展示转本地。
- **`plugin:activate` 非每次启动触发** → 必须有自愈入口（后台页加载时 `ensureDigestSchedules`）。
- **插件 `ctx.content.list` 无 `published_at` 区间过滤** → JS 侧窗口裁剪（取 top-50 足够；若单窗口 > 50 篇再调大 limit）。
- **受众成员靠 `syncSubscriber` 维护** → 老订阅者需 backfill（`digest/resync`）。
- **`uniqueIndexes` 建的是含 `collection` 的唯一索引**（跨集合不互撞，但同集合内重复值会撞）→ `digest_runs` 的 `cadence`/`sentAt` 会重复，故不声明 unique 字段（实测见 [11-phase3 §14 更正](11-phase3-comments-subscriptions.md)）。
- **Resend Broadcasts 要求受众非空**；空受众时 `send` 可能报错，需按 `failed` 留痕而非抛错。
- **内存版测试宿主不校验索引 / 触发器** → 唯一索引类改动必须跑一次 `npm run demo:data` 或 dev。
- **`emdash-plugin build` 只内联 `emdash/plugin` + `zod`** → 新代码不要引入新的裸模块依赖。

---

## 6. 待确认 / 已定

**已定（2026-10-09）**：

- 窗口口径 = **自然周 / 自然月**（§3.6）。
- 订阅表单**不加**节奏控件（§3.3）。
- 老订阅者 backfill = **仅后台手动按钮**（§3.4）。

**仍待确认（不阻塞，可实施中定）**：

1. **发送时点**：周报默认周一 08:00 CST、月报默认 1 日 08:00 CST —— 采用默认即可，后续在设置里改 UTC cron。
2. 是否需要**周报 / 月报各自的主题模板**差异（如月报带「本期期号」链接）？（建议：先共用一套模板）

---

## 7. 验收标准

- 订阅者在前台管理页可切换「每周 / 每月」，刷新后保持；对应 cadence 受众同步更新。
- 到点后自动向该 cadence 受众发出摘要；同一窗口**不重复发送**。
- 窗口内无文章时**不发**空摘要。
- 后台「摘要」页能看到下次运行时间（本地）、运行历史，并可手动触发 / 重同步受众。
- `plugin:test` 全绿、`typecheck:all` 两套 0 error、`npm run build` 通过；`npm run demo:data` 冒烟无唯一索引冲突。
