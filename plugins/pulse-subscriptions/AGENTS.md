# Agent instructions

Before editing this plugin, read `.agents/skills/creating-plugins/SKILL.md` (and its `references/`) completely.
Keep `emdash-plugin.jsonc` aligned with the runtime implementation, declare every capability and host the plugin uses, and run the generated validation, test, and build scripts after changes.

## 本插件要点

- 订阅者存于插件存储 `subscribers`（唯一索引 `emailHash`），**不是** EmDash 用户。
- 状态机：`pending` → `confirmed` → `unsubscribed`，外加只能后台进出的 `paused`（暂停投递，记录保留；读者重新提交订阅不会自动恢复）。token（确认/退订）只存 SHA-256 哈希，明文仅在邮件链接里。
- 分组存 `groups`（**slug 即记录 id，创建后不可变**），订阅记录用 `groups: string[]` 引用；事件日志存 `events`（append-only，`recordEvent` 吞异常不连累主流程）。
- **事件记录里不要写 `emailHash`**：`subscribers` 声明了 `uniqueIndexes: ["emailHash"]`，宿主建的唯一索引键是 `(plugin_id, collection, json_extract(data,'$.emailHash'))` —— **`collection` 在键里，跨集合不会互撞**；真正会撞的是**同集合内的重复值**（`events` 里同一订阅者会有多条事件、`emailHash` 相同 → 第 2 条撞唯一约束 → `recordEvent` 吞异常 → 事件静默丢失）。内存版测试宿主不校验索引，测不出来；只有本地 seed / dev 才暴露。（2026-10-09 在 PG + emdash 1.2.0 上实测更正）
- 路由入参走 zod，**`z.object` 会剥掉未声明的键**：`groups/save` 的 `create` 开关漏声明过一次，`create: true` 被静默丢弃 → 新建退化成更新。要透传给内部函数的开关字段必须在 schema 里显式声明。
- 状态流转只有一份实现（`src/operations.ts`）：后台行级操作与私有路由 `subscribers/update` 共用，别各写一遍状态机。
- 公开路由（`subscribe/request|confirm`、`unsubscribe`、`preferences`、`groups/public`）为 `response: "raw"`，返回真实状态码（400/401/409/429），并自带限流 —— 但 `groups/public` 刻意**不加**限流（SSR 取不到真实 IP，加了会把所有页面挤进同一个桶）。
- 邮件走 `ctx.email`（`email:send` + 已配置 provider）；**provider 缺失或投递失败时不抛错**，落库为 `pendingEmail`。无邮件服务时可开 `autoConfirm`（单确认）。
- 后台四页（`/subscribers`、`/groups`、`/broadcast`、`/digest`）共用同一个 `admin` 路由，靠宿主补的 `input.page` 分派。宿主不回传上一次表单值 ⇒ 筛选状态必须内嵌进分页按钮 value；分组是数组字段建不了索引 ⇒ 列表走内存扫描（`MAX_SCAN` 护栏）。**新增 / 改动后台页必须过 `validateBlocks`**（`tests/admin.test.ts` 里有宿主同款复核）。
- **邮件投递走 transport 抽象**（`src/transport/`）：`segments.ts` / `broadcast.ts` / `plugin.ts` / `admin.ts` 只依赖 `BroadcastTransport` 接口，**不直接 import 具体服务**。当前唯一实现是 `src/transport/resend.ts`（底层 REST 客户端在 `src/resend.ts`）。新增 provider（Rilay 等）= 实现接口 + 在 `resolveTransport()` / `TRANSPORT_LABELS` 登记 + manifest 的 `broadcastProvider` 选项与 `allowedHosts` 加项。**同步是旁路**：`syncSubscriber` 永不抛错，失败只记 `resend_sync_failed` 事件。
- Resend 凭证复用「Resend」插件（id `emdash-resend`）的设置，跨插件读靠 `loadHost()` 动态 `import("emdash")`（在 `src/transport/resend.ts`）。**该 import 的 specifier 必须是运行时变量**（`const specifier = "emdash"; await import(specifier)`）：字面量会让 rolldown 静态解析失败（`Cannot find package 'emdash'`），也会让 `tsc` 把 EmDash 整张类型图拉进来直接 OOM。
- `resend/webhook` 声明 `request: { body: "text" }`（验签用原始字节）+ `headers: ["svix-id","svix-timestamp","svix-signature"]`（宿主只透传显式声明的头）；验签与载荷映射交给当前 transport 的 `verifyWebhook` / `mapWebhookEvent`（前者返回 `ok`/`invalid`/`disabled` 三态，`disabled` → 503、`invalid` → 401）。回执只落事件日志，**不自动改订阅状态**。
- **订阅摘要**（`src/digest.ts` + `src/schedule.ts`）：每档节奏一个 cron 任务，`ctx.cron.schedule("digest-weekly" / "digest-monthly", …)` 幂等注册。**任务名不能含冒号**（宿主校验 `^[a-zA-Z][a-zA-Z0-9_-]*$`）。**cron 时区固定 UTC**（本站 CST = UTC+8）。注册时机是 `plugin:activate`，但宿主**不是每次启动**都触发 activate ⇒ 后台「订阅摘要」页加载时会再调一次 `ensureDigestSchedules` 自愈。
- 摘要内容口径是**上一个完整自然周 / 自然月**（CST 对齐，`digestWindow`）。插件侧 `ctx.content.list` 的 `where` **没有 `published_at` 区间过滤**（只有 `status` / `locale` / `fieldFilters`）⇒ 取一批后在 JS 里按窗口裁剪。`orderBy` 用 snake_case `published_at`（内部映射成 `{field, direction}`）。
- 节奏（cadence）是**平行受众维度**：`syncSubscriber` 对 `confirmed` 同时并入分组 segment 与节奏 segment（`cadenceAudienceId`，id 缓存在 `ctx.kv`）。`digest_runs` 的 `cadence` / `sentAt` 天然会重复 ⇒ **只声明 `indexes`、不声明 `uniqueIndexes`**（`uniqueIndexes` 建的是含 `collection` 的唯一索引，同集合内重复值会撞）。
- 改 `capabilities` / `storage` / `admin.pages` 必须升 `package.json` 的 `version`（信任契约变更）。
- 改动后必须 `npm run plugin:build`（根目录），沙箱 entry 内嵌的是已构建的 `dist/*.mjs`。
